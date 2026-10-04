/**
 * A file tombstone is published once ITS OWN path's bytes are gone — per path, not per act (bundle-30 I16, preship-4
 * P4-2 and P4-3).
 *
 * ## The defects
 *
 * One act tombstones several paths whose bytes go at different steps, and I15 treated the act as one unit:
 *
 * - **A step that fails part way** (P4-2). A directory delete removes its tree with one recursive remove, which can
 *   stop after it has unlinked some of the files. The act's failure dropped EVERY pending tombstone, and its retry lists
 *   only the files that remain — so the files it had removed lost their tombstones for good, and a peer's manifest
 *   pushed them straight back.
 * - **Paths whose bytes go at a later step** (P4-3). A move's sidecars (`_converted/…`, `_extracted/…`) are moved
 *   after the file, and a directory delete's are removed after the tree, each surviving its own failure. Their
 *   tombstones were published with the act's first step — so a sidecar that did not go was still here under a
 *   published tombstone, which a peer applies, stores and serves back to delete our copy.
 *
 * ## The rule
 *
 * Every path in an act's pending set is published only after its own bytes are gone. A step that fails is resolved
 * per path from the disk at once — no bytes, published; bytes, dropped — exactly as the TTL sweep's settle resolves a
 * leftover. For one file's unlink or rename that is the same answer as "drop them all".
 *
 * ## How the failures are reached
 *
 * - The partial tree removal: `rm` on the directory unlinks part of the tree itself and then fails `EACCES`, as a
 *   recursive remove that meets a subtree it may not remove does.
 * - The move's sidecar: its destination is a directory holding a file, so the sidecar's rename fails on every OS.
 * - The directory delete's sidecars: `rm` on the `_converted/` subtree fails `EACCES`.
 *
 * Run: node --test testing/standalone/a-file-tombstone-is-published-after-its-own-bytes-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors, NOTHING } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'ownbytes';

let acts, cascade, tombstones;
const realRm = fsp.rm;
/** `rm` of `rel` fails after unlinking the first `unlinks` files under it (sorted), as a recursive remove can. */
function rmFailsUnder(rel, unlinks = 0) {
  const target = path.join(acts.root(), rel);
  fsp.rm = async function (p, ...rest) {
    if (path.resolve(String(p)) !== path.resolve(target)) return realRm.call(fsp, p, ...rest);
    const files = fs.readdirSync(target, { recursive: true }).map(f => path.join(target, String(f)))
      .filter(f => fs.statSync(f).isFile()).sort();
    for (const f of files.slice(0, unlinks)) fs.unlinkSync(f);
    throw Object.assign(new Error(`EACCES: permission denied, rmdir '${p}'`), { code: 'EACCES', syscall: 'rmdir' });
  };
}
const settled = () => tombstones.whenPendingFileTombstoneDropsSettle?.();
const pendingPaths = async () => (await acts.raw()).filter(t => t.pending).map(t => t.path).sort();

describe('a file tombstone is published after its own path\'s bytes', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'ownbytes', space: S });
    cascade = await import('../../server/dist/files/delete-cascade.js');
    tombstones = await import('../../server/dist/files/tombstones.js');
  });
  after(async () => {
    fsp.rm = realRm;
    await acts?.close();
  });
  beforeEach(() => acts.reset());
  afterEach(() => { fsp.rm = realRm; });

  it('a directory delete that stops part way publishes the files it removed, and its retry the rest', async () => {
    const all = ['t/1.txt', 't/2.txt', 't/3.txt', 't/4.txt', 't/5.txt', 't/6.txt'];
    for (const p of all) await acts.seed(p);
    rmFailsUnder('t', 3);
    await assert.rejects(cascade.deleteDirectoryCascade(S, 't'), /EACCES/, 'the tree removal did not fail — the case is not reached');
    await settled();
    const removed = all.filter(p => !acts.onDisk(p));
    assert.equal(removed.length, 3, 'the removal did not stop part way');
    assert.deepEqual(await acts.published(), { served: removed, pushed: removed },
      'the files the failed delete DID remove lost their tombstones: the retry lists only what remains, and a peer pushes these back');
    assert.deepEqual(await pendingPaths(), [], 'a failed act left tombstones pending that the disk could already answer');

    fsp.rm = realRm;
    await cascade.deleteDirectoryCascade(S, 't');
    const served = (await acts.served()).map(t => t.path).sort();
    assert.deepEqual(served, all, 'after the retry, not every removed file has exactly one published tombstone');
  });

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a move whose sidecar cannot move publishes no tombstone for the sidecar still here`, async () => {
      await acts.seed('a.txt');
      await acts.files.writeFile(S, '_converted/a.txt.md', '# converted');
      fs.mkdirSync(path.join(acts.root(), '_converted', 'b.txt.md', 'inside'), { recursive: true });
      fs.writeFileSync(path.join(acts.root(), '_converted', 'b.txt.md', 'inside', 'x'), 'x');
      const m = await acts.move(via, 'a.txt', 'b.txt');
      assert.ok(!acts.failed(m), `the move: ${JSON.stringify(m.body ?? m.text)}`);
      assert.ok(acts.onDisk('_converted/a.txt.md'), 'the sidecar moved after all — the case is not reached');
      await settled();
      assert.deepEqual(await acts.published(), { served: ['a.txt'], pushed: ['a.txt'] },
        'the sidecar still here has a published tombstone: a peer applies it, stores it, and serves it back to delete ours');
      assert.deepEqual(await pendingPaths(), [], 'the sidecar\'s tombstone was left pending once its move had failed');
    });

    it(`${via}: a move whose sidecar moves publishes the sidecar's tombstone too`, async () => {
      await acts.seed('a.txt');
      await acts.files.writeFile(S, '_converted/a.txt.md', '# converted');
      const m = await acts.move(via, 'a.txt', 'c.txt');
      assert.ok(!acts.failed(m), `the move: ${JSON.stringify(m.body ?? m.text)}`);
      assert.ok(!acts.onDisk('_converted/a.txt.md') && acts.onDisk('_converted/c.txt.md'), 'the sidecar did not move');
      assert.deepEqual(await acts.published(), { served: ['_converted/a.txt.md', 'a.txt'], pushed: ['_converted/a.txt.md', 'a.txt'] },
        'a path the move left behind has no published tombstone');
    });
  }

  it('a directory delete whose sidecars cannot be removed publishes no tombstone for them', async () => {
    await acts.seed('d/f.txt');
    await acts.files.writeFile(S, '_converted/d/f.txt.md', '# converted');
    rmFailsUnder('_converted/d');
    await cascade.deleteDirectoryCascade(S, 'd');
    assert.ok(acts.onDisk('_converted/d/f.txt.md'), 'the sidecar went after all — the case is not reached');
    assert.ok(!acts.onDisk('d/f.txt'), 'the tree did not go');
    await settled();
    assert.deepEqual(await acts.published(), { served: ['d/f.txt'], pushed: ['d/f.txt'] },
      'a sidecar still here has a published tombstone');
    assert.deepEqual(await pendingPaths(), [], 'the sidecar\'s tombstone was left pending once its removal had failed');
  });

  it('a directory delete whose sidecars go publishes them', async () => {
    await acts.seed('e/f.txt');
    await acts.files.writeFile(S, '_converted/e/f.txt.md', '# converted');
    await cascade.deleteDirectoryCascade(S, 'e');
    assert.notDeepEqual(await acts.published(), NOTHING);
    assert.deepEqual(await acts.published(), { served: ['_converted/e/f.txt.md', 'e/f.txt'], pushed: ['_converted/e/f.txt.md', 'e/f.txt'] },
      'a path the delete removed has no published tombstone');
  });
});
