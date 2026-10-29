/**
 * A pending delete whose path cannot be looked at fails ONLY its own path, never the page of metadata it arrives in (bundle-88, Q-411
 * half 2).
 *
 * ## The defect
 *
 * A metadata arrival is compared with the tombstones held for its path, and a PENDING tombstone counts when its act has removed the
 * path's bytes (Q-348): that is a look at the disk. When the look fails (EACCES, EIO) the arrival the tombstone would shadow was
 * `undecided`, and `shadowedArrivals` threw a retryable 503 for the WHOLE page: one path made every document of the batch a
 * `StoreTimeout`, and the pull stopped at that page, so every later page from that peer was never read while the fault lasted.
 *
 * ## The rule this file states
 *
 * The row answers what the disk cannot (rows go LAST in every act that writes a pending tombstone). With a pending tombstone at
 * `rowSeq 5` that cannot be looked at: no live row, the arrival is `tombstoned`; a live row at seq 5, the arrival is `skipped` by the
 * writer's seq guard and the row stands; either way the other documents of the page land and the answer is a 200. A page held up by
 * no path, on the push door and on the pull door alike.
 *
 * ## Seen red
 *
 * On the base (1e430410c): the push answers 503 and `b.txt` is not stored; the pull stops at the page and stores nothing.
 *
 * Run: node --test testing/standalone/an-unlookable-pending-delete-fails-only-its-own-path-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'unlookable';
const T = '2026-09-01T00:00:05.000Z';

let door, tombstones;
const realLstat = fsp.lstat;
let unlookable = null;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const meta = (p, seq, extra = {}) => build.filemeta(S, p, seq, { author: PEER_AUTHOR, ...extra });
/** A pending tombstone whose act is under way: it names the version it erases. */
const plantPending = (p, rowSeq) => door.coll(S, 'file_tombstones').insertOne({
  _id: `pending-${p}`, spaceId: S, path: p, deletedAt: T, writtenAt: T, settleAt: T, pending: true, rowSeq });

const DOORS = {
  push: { async deliver(docs) { return door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token: peerToken(PEER) }); } },
  pull: { async deliver(docs) { door.state.records[S] = { filemeta: docs }; await door.sync(); return undefined; } },
};

describe('a pending delete that cannot be looked at fails only its own path', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'unlookable', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    tombstones = await import('../../server/dist/files/tombstones.js');
    // The look at a path fails for `unlookable` alone: EACCES, which is no answer to "is it there".
    fsp.lstat = function (p, ...rest) {
      if (unlookable !== null && String(p).endsWith(`${path.sep}${unlookable}`)) {
        return Promise.reject(Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES', syscall: 'lstat' }));
      }
      return realLstat.call(fsp, p, ...rest);
    };
  });
  after(async () => { fsp.lstat = realLstat; await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    for (const part of ['files', 'file_tombstones']) await door.coll(S, part).deleteMany({});
    unlookable = 'a.txt';
  });
  afterEach(() => { unlookable = null; });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(`${name}`, () => {
      it('no live row at the path: the arrival is tombstoned and the rest of the page lands', async () => {
        await plantPending('a.txt', 5);
        const answer = await d.deliver([meta('a.txt', 3), meta('b.txt', 1)]);
        if (name === 'push') {
          assert.equal(answer.code, 200, `one unlookable path failed the page: ${JSON.stringify(answer.body)}`);
          assert.equal(answer.body.filemeta.tombstoned, 1, JSON.stringify(answer.body.filemeta));
        }
        assert.ok(await row('b.txt'), 'the document of another path was not stored: the page was held up by one path');
        assert.equal(await row('a.txt'), null, 'the arrival the pending delete would shadow was written');
      });

      it('a live row at the tombstone\'s version: the arrival is skipped by the seq guard, the row stands, the rest of the page lands', async () => {
        await plantPending('a.txt', 5);
        await door.coll(S, 'files').insertOne(meta('a.txt', 5, { description: 'the row the act has not removed yet' }));
        const answer = await d.deliver([meta('a.txt', 3, { description: 'older' }), meta('b.txt', 1)]);
        if (name === 'push') {
          assert.equal(answer.code, 200, `one unlookable path failed the page: ${JSON.stringify(answer.body)}`);
          assert.equal(answer.body.filemeta.tombstoned ?? 0, 0, JSON.stringify(answer.body.filemeta));
        }
        assert.ok(await row('b.txt'), 'the document of another path was not stored: the page was held up by one path');
        assert.equal((await row('a.txt'))?.description, 'the row the act has not removed yet', 'the older arrival replaced the row');
      });
    });
  }

  it('a sidecar of the unlookable path with no row for its parent is shadowed too (decideArrivals)', async () => {
    // A sidecar follows its parent's tombstone only when that one erased real content (it carries the hash of the row it removed).
    await plantPending('a.txt', 5);
    await door.coll(S, 'file_tombstones').updateOne({ _id: 'pending-a.txt' }, { $set: { contentHash: 'd'.repeat(64) } });
    const verdicts = await tombstones.decideArrivals(S, [{ id: '_converted/a.txt.md', path: '_converted/a.txt.md', kind: 'meta', seq: 3 }]);
    assert.deepEqual([...verdicts.shadowed], ['_converted/a.txt.md'], `the sidecar was not decided from its parent's row: ${JSON.stringify([...verdicts.undecided])}`);
    assert.equal(verdicts.undecided.size, 0);
  });

  it('a BYTES arrival at an unlookable path stays undecided (the manifest pull leaves it for the next cycle)', async () => {
    await plantPending('a.txt', 5);
    await door.coll(S, 'file_tombstones').updateOne({ _id: 'pending-a.txt' }, { $set: { contentHash: 'c'.repeat(64) } });
    const verdicts = await tombstones.decideArrivals(S, [{ id: 'a.txt', path: 'a.txt', kind: 'bytes', sha256: 'c'.repeat(64) }]);
    assert.deepEqual([...verdicts.undecided], ['a.txt']);
  });
});
