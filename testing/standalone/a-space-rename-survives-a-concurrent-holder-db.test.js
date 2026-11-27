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
 *  - (c) a directory move that stays refused for longer than the retry window (a handle held on Windows, a non-empty directory under
 *    the new id elsewhere): the rename answers 500 "was not renamed", moves back what it moved, leaves no marker and ends its act, and the same
 *    rename, once the cause is lifted, completes. Every platform.
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
// Listed in testing/_shared/expected-in-ci.mjs: CI's Linux runner cannot produce the failure (a), (b) retry through.
const SKIPPED = 'expected-in-ci: a directory rename here does not fail on an open handle';
const windowsOnly = process.platform === 'win32' ? false : SKIPPED;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rename-holder-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const T = { timeout: 120_000 };
const IDS = ['held-a', 'held-b', 'held-c', 'by-a', 'by-b', 'by-c'];
const space = id => ({ id, label: id, folders: [], completeLinkage: true });
const dataPath = (...parts) => path.join(process.env['DATA_ROOT'], ...parts);

describe('a space rename and a concurrent holder', { skip }, () => {
  let mongo, loader, lifecycle, renameMod, actsMod;

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
    actsMod = await import('../../server/dist/spaces/space-act-runner.js');
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

  it('(c) a handle held longer than the retry window fails the rename, which moves back what it moved, and the same rename then completes', T, async () => {
    // The files directory cannot be moved until THIS case lifts the cause, which is after the rename has answered: longer than any retry
    // window. On Windows the cause is an open handle. Elsewhere a held handle does not stop a directory rename, so the same refusal is made
    // by a non-empty directory under the new id, which the rename never overwrites: the promise asserted below holds on every platform.
    let release;
    if (process.platform === 'win32') {
      const fh = await fsp.open(dataPath('files', 'held-c', 'transcripts', 'a.md'), 'r');
      release = () => fh.close();
    } else {
      await fsp.mkdir(dataPath('files', 'held-c2'), { recursive: true });
      await fsp.writeFile(dataPath('files', 'held-c2', 'keep.txt'), 'not this space\'s');
      release = () => fsp.rm(dataPath('files', 'held-c2'), { recursive: true, force: true });
    }
    let r;
    try {
      r = await renameMod.renameSpaceAct('held-c', { newId: 'held-c2' });
    } finally {
      await release();
    }
    assert.equal(r.status, 500, `a rename that could not move the files answered ${answer(r)}`);
    assert.match(String(r.error), /was not renamed/);
    assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the failed rename kept its marker although everything moved back');
    // The act ended with the refusal: nothing is owed or queued for the space, so it takes writes and nothing retries behind the caller's back.
    assert.equal(actsMod.spaceActStands(loader.getConfig(), 'held-c'), null, 'the refused rename that moved fully back still stands as an act');
    assert.ok(fs.existsSync(dataPath('files', 'held-c', 'transcripts', 'a.md')), 'the refused rename left the files away from the old id');
    assert.ok(loader.getConfig().spaces.some(s => s.id === 'held-c') && !loader.getConfig().spaces.some(s => s.id === 'held-c2'), 'the refused rename changed the config');
    assert.equal((await mongo.col('held-c_facts').findOne({ _id: 'held-c-f' }))?.spaceId, 'held-c', 'the refused rename left the collections away from the old id');
    // The cause is lifted: the same rename, asked again, completes.
    const again = await renameMod.renameSpaceAct('held-c', { newId: 'held-c2' });
    assert.equal(again.status, 200, `the same rename did not complete once the cause was lifted: ${answer(again)}`);
    const next = await renameMod.renameSpaceAct('by-c', { newId: 'by-c2' });
    assert.equal(next.status, 200, `the next rename of another space was refused: ${answer(next)}`);
    const cfg = loader.getConfig();
    assert.equal(cfg.pendingSpaceOp, undefined, 'a marker is left after the renames completed');
    assert.ok(cfg.spaces.some(s => s.id === 'held-c2') && !cfg.spaces.some(s => s.id === 'held-c'), 'the repeated rename did not commit');
    assert.ok(fs.existsSync(dataPath('files', 'held-c2', 'transcripts', 'a.md')), 'the repeated rename did not move the files');
  });
});
