/**
 * A path through a regular file names nothing — on Linux as on Windows (bundle-30 I16, preship-4 P4-1).
 *
 * ## The defect
 *
 * `isMissingPath` read only `ENOENT` as "the path does not exist". Linux, the deployment, answers a path THROUGH a
 * regular file (`a.txt/x`, where `a.txt` is a file) with `ENOTDIR`, so `bytesPresent` threw it as "cannot look":
 *
 * - MCP `move_file` of `a.txt/x` answered `400` carrying `ENOTDIR … lstat '/data/files/<space>/a.txt/x'` — the server's
 *   absolute data path, to the caller — and REST answered `500`. Both were `404` before the bundle.
 * - The TTL sweep's settle left such a tombstone pending for ever, warning about it every cycle.
 *
 * Windows answers the same condition with `ENOENT`, so no run on Windows could see any of it.
 *
 * ## How the condition is reached on every OS
 *
 * `stat` and `lstat` answer as Linux does for the whole test (`linuxStat` below): a path whose nearest existing
 * ancestor is a regular file fails `ENOTDIR`. On Linux that is what the filesystem already says; on Windows it is
 * what makes the case reachable. The classifier itself is asked about both codes, with no filesystem at all, in
 * `are-the-bytes-here-has-one-answer.test.js`.
 *
 * ## What is asserted
 *
 * - A move and a delete of a path through a file answer `404` on both doors, with no data path in the answer, and
 *   write no tombstone.
 * - A stale pending tombstone whose path now runs through a file is settled as gone: published.
 *
 * Run: node --test testing/standalone/a-path-through-a-file-names-nothing-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'throughfile';

let acts, tombstones;
const real = { stat: fsp.stat, lstat: fsp.lstat };

/** `stat`/`lstat` as Linux answers them: through a regular file is ENOTDIR, never ENOENT. */
const linuxStat = (name) => function (p, ...rest) {
  for (let a = path.dirname(String(p)); a !== path.dirname(a); a = path.dirname(a)) {
    let st;
    try { st = fs.statSync(a); } catch { continue; }
    if (st.isFile()) {
      return Promise.reject(Object.assign(new Error(`ENOTDIR: not a directory, ${name} '${p}'`),
        { code: 'ENOTDIR', errno: -20, syscall: name, path: String(p) }));
    }
    break;
  }
  return real[name].call(fsp, p, ...rest);
};

describe('a path through a regular file names nothing', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'throughfile', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    fsp.stat = linuxStat('stat');
    fsp.lstat = linuxStat('lstat');
  });
  after(async () => {
    Object.assign(fsp, real);
    await acts?.close();
  });
  beforeEach(() => acts.reset());

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a move of a path through a file is 404, says no data path, and writes no tombstone`, async () => {
      await acts.seed('a.txt');
      const a = await acts.move(via, 'a.txt/x', 'y.txt');
      assert.equal(acts.statusOf(a), 404, `the move: ${JSON.stringify(a.body ?? a.text)}`);
      assert.ok(!JSON.stringify(a.body ?? a.text).includes(process.env['DATA_ROOT'].replaceAll('\\', '\\\\'))
        && !JSON.stringify(a.body ?? a.text).includes('ENOTDIR'),
      `the answer carries the filesystem's own text — the server's data path, to the caller: ${JSON.stringify(a.body ?? a.text)}`);
      assert.deepEqual(await acts.raw(), [], 'a move that found nothing wrote a tombstone');
      assert.ok(acts.onDisk('a.txt'), 'the file the path ran through went');
    });

    it(`${via}: a delete of a path through a file is 404, says no data path, and writes no tombstone`, async () => {
      await acts.seed('a.txt');
      const d = await acts.del(via, 'a.txt/x');
      assert.equal(acts.statusOf(d), 404, `the delete: ${JSON.stringify(d.body ?? d.text)}`);
      assert.ok(!JSON.stringify(d.body ?? d.text).includes('ENOTDIR'),
        `the answer carries the filesystem's own text: ${JSON.stringify(d.body ?? d.text)}`);
      assert.deepEqual(await acts.raw(), [], 'a delete that found nothing wrote a tombstone');
      assert.ok(acts.onDisk('a.txt'), 'the file the path ran through went');
    });
  }

  it('the settle reads a stale pending tombstone whose path runs through a file as gone, and publishes it', async () => {
    await acts.seed('d');   // `d` was a directory when its `d/f.txt` was deleted; a file took its name since
    const longAgo = new Date(Date.now() - 3_600_000).toISOString();
    await acts.door.coll(S, 'file_tombstones').insertOne({ _id: 'through-a-file', spaceId: S, path: 'd/f.txt', deletedAt: longAgo, pending: true });
    await tombstones.settleStalePendingFileTombstones(S);
    assert.deepEqual(await acts.published(), { served: ['d/f.txt'], pushed: ['d/f.txt'] },
      'a tombstone whose path names nothing was left pending — warned about every cycle, for ever');
  });
});
