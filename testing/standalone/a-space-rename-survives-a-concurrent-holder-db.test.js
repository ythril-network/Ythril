/**
 * A space rename completes while something still holds a file open under the space's directories, and a rename that cannot
 * complete says so and is resumed by the next operation (Q-171).
 *
 * ## What it prevents
 *
 * On Windows a directory cannot be renamed while any handle is open under it: `fs.rename` answers `EPERM` at once. A counted
 * writer is drained before an act runs (`awaitSpaceTransfersDrained`), but a download stream, a media read, ffmpeg or an indexer on
 * the host is not counted, and any of them is enough. The rename's directory moves had no retry:
 *
 *  - the files move failed the whole rename (`500 "rename incomplete ... EPERM"`, marker kept, and for the tens of seconds until
 *    the runner's retry the collections already sat under the new id while config still said the old one, so reads answered empty);
 *  - the `.chunks/<old>` move sat inside a bare `catch {}`, so the same handle answered `200` and left `.chunks/<old>` behind with
 *    `.chunks/<new>` absent: the upload was lost and a later space of the old id would have inherited its chunks.
 *
 * Both moves now go through `moveTree` (`files/remove-tree.ts`), which shares `removeTree`'s retry rule, and a `.chunks` move that
 * fails for any reason but a missing source is a failed step like the files move.
 *
 * ## Cases
 *
 *  - (a) a handle held 600 ms under `files/<old>`: the rename answers 200, the tree is under the new id, no marker is left, and
 *    the next rename and delete of other spaces complete. Windows only: a Linux directory rename does not fail on an open handle.
 *  - (b) the same under `.chunks/<old>`: `.chunks/<new>` exists and `.chunks/<old>` does not. Windows only, for the same reason.
 *  - (c) a handle held for longer than the retry window: the rename answers 500 "incomplete" with the marker kept, and the next
 *    operation, once the handle is released, resumes it. Every platform.
 *
 * ## Seen red
 *
 * At the base (a71370b0d): (a) answers 500 `rename incomplete ... EPERM` with the marker kept; (b) answers 200 with
 * `.chunks/<old>` stranded; (c) passes (it is the regression for the failure path). The behavioural cases are Windows-only, so
 * the cross-platform red is `every-space-directory-move-goes-through-move-tree.test.js`.
 *
 * Run: node --test testing/standalone/a-space-rename-survives-a-concurrent-holder-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const windowsOnly = process.platform === 'win32' ? false : 'a Linux directory rename does not fail on an open handle';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rename-holder-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const T = { timeout: 120_000 };
const IDS = ['held-a', 'held-b', 'held-c', 'by-a', 'by-b', 'by-c'];
const space = id => ({ id, label: id, folders: [], completeLinkage: true });
const dataPath = (...parts) => path.join(process.env['DATA_ROOT'], ...parts);

describe('a space rename and a concurrent holder', { skip }, () => {
  let mongo, loader, lifecycle, renameMod;

  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'rename-holder', instanceLabel: 'test', tokens: [], networks: [], spaces: IDS.map(space),
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('renameholder');
    for (const id of IDS) {
      await mongo.col(`${id}_facts`).insertOne({ _id: `${id}-f`, spaceId: id, fact: 'x' });
      await fsp.mkdir(dataPath('files', id, 'transcripts'), { recursive: true });
      await fsp.writeFile(dataPath('files', id, 'transcripts', 'a.md'), 'x');
      await fsp.mkdir(dataPath('.chunks', id, 'u1'), { recursive: true });
      await fsp.writeFile(dataPath('.chunks', id, 'u1', 'part0'), 'x');
    }
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    renameMod = await import('../../server/dist/spaces/rename.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** Hold `file` open for `ms`, then close it; the returned promise settles once it is closed. */
  async function holdFor(file, ms) {
    const fh = await fsp.open(file, 'r');
    return elapse(ms, 'simulated latency: a holder outside the act keeps its handle open for a while').then(() => fh.close());
  }
  const answer = r => (r.status === 200 ? 'ok' : `${r.status} ${r.error}`);

  it('(a) a handle held under the files directory for 600 ms does not fail the rename', { ...T, skip: skip || windowsOnly }, async () => {
    const released = holdFor(dataPath('files', 'held-a', 'transcripts', 'a.md'), 600);
    const r = await renameMod.renameSpaceAct('held-a', { newId: 'held-a2' });
    await released;
    assert.equal(r.status, 200, `the rename did not complete: ${answer(r)}`);
    assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the rename left its marker behind');
    assert.ok(fs.existsSync(dataPath('files', 'held-a2', 'transcripts', 'a.md')), 'the files did not move to the new id');
    assert.equal(fs.existsSync(dataPath('files', 'held-a')), false, 'the old files directory is still there');
    const next = await renameMod.renameSpaceAct('by-a', { newId: 'by-a2' });
    assert.equal(next.status, 200, `the next rename was refused: ${answer(next)}`);
    assert.equal(await lifecycle.removeSpace('by-b'), true, 'the next delete did not complete');
  });

  it('(b) a handle held under the chunk directory for 600 ms does not strand the chunks', { ...T, skip: skip || windowsOnly }, async () => {
    const released = holdFor(dataPath('.chunks', 'held-b', 'u1', 'part0'), 600);
    const r = await renameMod.renameSpaceAct('held-b', { newId: 'held-b2' });
    await released;
    assert.equal(r.status, 200, `the rename did not complete: ${answer(r)}`);
    assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the rename left its marker behind');
    assert.ok(fs.existsSync(dataPath('.chunks', 'held-b2', 'u1', 'part0')), 'the chunks did not move to the new id');
    assert.equal(fs.existsSync(dataPath('.chunks', 'held-b')), false, 'the old chunk directory was stranded and the rename answered success');
  });

  it('(c) a handle held longer than the retry window fails the rename, keeps its marker, and the next operation resumes it', T, async () => {
    // Held until THIS case releases it, which is after the rename has answered: longer than any retry window.
    const fh = await fsp.open(dataPath('files', 'held-c', 'transcripts', 'a.md'), 'r');
    let r;
    try {
      r = await renameMod.renameSpaceAct('held-c', { newId: 'held-c2' });
    } finally {
      await fh.close();
    }
    if (process.platform === 'win32') {
      // Elsewhere a held handle does not stop a directory rename, so there is no failure to keep.
      assert.equal(r.status, 500, `a rename held by an open handle answered ${answer(r)}`);
      assert.match(String(r.error), /rename incomplete/);
      assert.equal(loader.getConfig().pendingSpaceOp?.spaceId, 'held-c', 'the failed rename dropped its marker');
      assert.ok(fs.existsSync(dataPath('files', 'held-c', 'transcripts', 'a.md')), 'the failed rename moved the files anyway');
    } else {
      assert.equal(r.status, 200, answer(r));
    }
    const next = await renameMod.renameSpaceAct('by-c', { newId: 'by-c2' });
    assert.equal(next.status, 200, `the next operation did not resume the pending rename: ${answer(next)}`);
    const cfg = loader.getConfig();
    assert.equal(cfg.pendingSpaceOp, undefined, 'the pending rename was not resumed');
    assert.ok(cfg.spaces.some(s => s.id === 'held-c2') && !cfg.spaces.some(s => s.id === 'held-c'), 'the resumed rename did not commit');
    assert.ok(fs.existsSync(dataPath('files', 'held-c2', 'transcripts', 'a.md')), 'the resumed rename did not move the files');
  });
});
