/**
 * A space rename into a destination directory that already exists: it moves into what it can prove is not data, it refuses
 * what may be data, and its refusal names no path (bundle-95 review, D1 and D2).
 *
 * ## What it prevents
 *
 * `moveTree` (`files/remove-tree.ts`) refuses an existing destination at once. Two things followed from that:
 *
 *  - D1: its own `EEXIST` error carried a `code` and no `syscall`, so `isFileSystemError` read it as no file-system error at all
 *    and `refusalText` answered its message, which names `'<dataRoot>/.chunks/x' -> '<dataRoot>/.chunks/y'`. That sentence is the
 *    body of the REST `500`, the text of the MCP tool's result and the marker's `pendingOpStillFailingMessage`: the server's
 *    absolute data path, handed to a caller. The error is now built as node builds one, so the one wording module words it.
 *  - D2: a stale `.chunks/<new>` (an old Windows run's, a late writer's; the sweep takes it after 24 h) kept the rename's marker,
 *    with the collections and the files already under the new id and the config still on the old one, and the marker blocks every
 *    other space operation. The rename now moves into a destination it can prove is not data: an EMPTY directory (either tree),
 *    and for the chunk tree only, upload staging that no configured space owns (the rename refused a configured new id). A
 *    non-empty `files/<new>` is real bytes and is never deleted: it fails, worded, with the marker kept.
 *
 * ## Cases
 *
 *  1. a non-empty `files/<new>`: the rename answers 500 "incomplete" in our words with no absolute path in it (D1), keeps its
 *     marker, leaves the bytes alone, and once they are removed the next operation resumes it (first, so
 *     that on a build without the fix its failure is its own and not the blocked marker of an earlier case);
 *  2. an empty `files/<new>` and an empty `.chunks/<new>`: the rename completes, the tree is under the new id;
 *  3. a non-empty `.chunks/<new>`: the rename completes and the stale content is gone.
 *
 * ## Seen red
 *
 * At 1add3cb2f: 1 fails on the answer naming `<dataRoot>\files\...` (the marker it leaves then blocks 2 and 3, which on
 * their own answer 500 "rename incomplete" with the marker kept).
 *
 * Run: node --test testing/standalone/a-space-rename-into-a-leftover-destination-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rename-leftover-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const T = { timeout: 120_000 };
const IDS = ['empty-a', 'stale-a', 'real-a', 'next-a'];
const space = id => ({ id, label: id, folders: [], completeLinkage: true });
const dataPath = (...parts) => path.join(process.env['DATA_ROOT'], ...parts);
const answer = r => (r.status === 200 ? 'ok' : `${r.status} ${r.error}`);

describe('a space rename into a destination that already exists', { skip }, () => {
  let mongo, loader, renameMod;

  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'rename-leftover', instanceLabel: 'test', tokens: [], networks: [], spaces: IDS.map(space),
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('renameleftover');
    for (const id of IDS) {
      await mongo.col(`${id}_facts`).insertOne({ _id: `${id}-f`, spaceId: id, fact: 'x' });
      await fsp.mkdir(dataPath('files', id, 'sub'), { recursive: true });
      await fsp.writeFile(dataPath('files', id, 'sub', 'a.md'), 'x');
      await fsp.mkdir(dataPath('.chunks', id, 'u1'), { recursive: true });
      await fsp.writeFile(dataPath('.chunks', id, 'u1', 'part0'), 'x');
    }
    renameMod = await import('../../server/dist/spaces/rename.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('1. a non-empty files directory of the new id is real bytes: the rename fails in our words, names no path, keeps its marker', T, async () => {
    await fsp.mkdir(dataPath('files', 'real-b'), { recursive: true });
    await fsp.writeFile(dataPath('files', 'real-b', 'precious.md'), 'real bytes');
    const r = await renameMod.renameSpaceAct('real-a', { newId: 'real-b' });
    assert.equal(r.status, 500, `a rename onto real bytes answered ${answer(r)}`);
    const said = String(r.error);
    assert.match(said, /rename incomplete/);
    assert.ok(!said.includes(process.env['DATA_ROOT']) && !said.includes(tmpDir), `the answer names the data root: ${said}`);
    assert.doesNotMatch(said, /[A-Za-z]:[\\/]|[\\/](?:files|\.chunks)[\\/]/, `the answer names an absolute or data path: ${said}`);
    assert.match(said, /The file system refused this step \(EEXIST\)/, 'the refusal is not worded by the file-system words');
    assert.equal(loader.getConfig().pendingSpaceOp?.spaceId, 'real-a', 'the failed rename dropped its marker');
    assert.equal(fs.readFileSync(dataPath('files', 'real-b', 'precious.md'), 'utf8'), 'real bytes', 'the destination bytes were touched');
    assert.ok(fs.existsSync(dataPath('files', 'real-a', 'sub', 'a.md')), 'the source was moved anyway');
    // Once the destination is cleared by whoever owns it, the next operation resumes the rename.
    await fsp.rm(dataPath('files', 'real-b'), { recursive: true, force: true });
    const next = await renameMod.renameSpaceAct('next-a', { newId: 'next-b' });
    assert.equal(next.status, 200, `the next operation did not resume the pending rename: ${answer(next)}`);
    assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the pending rename was not resumed');
    assert.ok(loader.getConfig().spaces.some(s => s.id === 'real-b'), 'the resumed rename did not commit');
  });

  it('2. an empty destination directory, files and chunks, is moved into', T, async () => {
    await fsp.mkdir(dataPath('files', 'empty-b'), { recursive: true });
    await fsp.mkdir(dataPath('.chunks', 'empty-b'), { recursive: true });
    const r = await renameMod.renameSpaceAct('empty-a', { newId: 'empty-b' });
    assert.equal(r.status, 200, `the rename did not complete: ${answer(r)}`);
    assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the rename left its marker behind');
    assert.ok(fs.existsSync(dataPath('files', 'empty-b', 'sub', 'a.md')), 'the files did not move into the empty destination');
    assert.ok(fs.existsSync(dataPath('.chunks', 'empty-b', 'u1', 'part0')), 'the chunks did not move into the empty destination');
    assert.equal(fs.existsSync(dataPath('files', 'empty-a')), false, 'the old files directory is still there');
    assert.equal(fs.existsSync(dataPath('.chunks', 'empty-a')), false, 'the old chunk directory is still there');
  });

  it('3. a non-empty chunk directory of the new id is upload staging nobody owns: it is replaced', T, async () => {
    await fsp.mkdir(dataPath('.chunks', 'stale-b', 'old-upload'), { recursive: true });
    await fsp.writeFile(dataPath('.chunks', 'stale-b', 'old-upload', 'part0'), 'stale');
    const r = await renameMod.renameSpaceAct('stale-a', { newId: 'stale-b' });
    assert.equal(r.status, 200, `the rename did not complete: ${answer(r)}`);
    assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the rename left its marker behind');
    assert.ok(fs.existsSync(dataPath('.chunks', 'stale-b', 'u1', 'part0')), 'the renamed space chunks did not arrive');
    assert.equal(fs.existsSync(dataPath('.chunks', 'stale-b', 'old-upload')), false, 'the stale staging content is still there');
    assert.ok(fs.existsSync(dataPath('files', 'stale-b', 'sub', 'a.md')), 'the files did not move');
  });

});
