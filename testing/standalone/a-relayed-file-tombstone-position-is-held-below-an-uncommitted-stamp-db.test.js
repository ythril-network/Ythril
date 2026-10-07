/**
 * A RELAYED file tombstone's position is held below an uncommitted stamp too, so an acknowledgement never covers a
 * relayed row whose write has not landed (Q-346, bundle-71 D1; the sibling of
 * `a-file-tombstone-position-is-held-below-an-uncommitted-stamp-db`, whose door is the act doors).
 *
 * ## The defect, on the writer a peer's deletion arrives through
 *
 * `storeRelayedFileTombstones` stamps the RECEIVE time (`positionAt`) before its bulk write commits, exactly as an own
 * publish stamps its own. A relay hop that keeps a peer's deletion to serve it onward is a middle node: its own push
 * acknowledges the highest position it sent, and its prune removes everything at or below the acknowledgement. A later
 * relayed page that committed while an earlier one was still writing therefore carried the acknowledgement over a row no
 * peer had been sent.
 *
 * ## The rule this file holds
 *
 * Driven through the REAL peer apply door (`POST /api/sync/file-tombstones`, the one a peer's push lands on), in a space served
 * onward so the tombstones are kept at all: the first page's store is PARKED after its stamp (asserted reached), a second page
 * is delivered and the push's first page read (`sentThenAcknowledged`), the park is released, and the prune runs at the
 * acknowledgement: **the first page's row is still there.** As in the sibling file, it asserts what the prune does with
 * whatever was acknowledged, never that the second page was sent.
 *
 * Run: node --test testing/standalone/a-relayed-file-tombstone-position-is-held-below-an-uncommitted-stamp-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { parkWrites, settleWithin } from './_write-faults.mjs';
import { writesAPosition, sentThenAcknowledged, pruneAt } from './_position-hold.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'relhold';
const REACH_MS = 10_000;
const LATER_MS = 5_000;

let door, parks;
const COLL = `${S}_file_tombstones`;
const tombs = () => door.coll(S, 'file_tombstones').find({}).toArray();
const rowOf = async (p) => (await tombs()).find(t => t.path === p);

async function seedFile(path) {
  door.writeLocalFile(S, path, `bytes of ${path}`);
  await door.coll(S, 'files').insertOne(build.filemeta(S, path, 3, { author: PEER_AUTHOR, sizeBytes: 11 }));
}
const tomb = (path) => ({ _id: `rt-${path}`, spaceId: S, path, deletedAt: '2026-09-01T00:00:05.000Z', issuer: PEER, rowSeq: 3 });
/** A peer's push of these tombstones, through the door a peer's push lands on. */
const deliver = (tombstones) => door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) });

describe('a relayed file tombstone position is held below an uncommitted stamp', { skip }, () => {
  before(async () => { door = await openPullDoor({ suite: 'relhold', spaces: [S], files: true }); });
  after(async () => { parks?.restore(); await door?.close(); });
  beforeEach(async () => { await door.reset(); door.configure({ lateral: true }); });
  afterEach(() => { parks?.restore(); parks = undefined; });

  it('a later relayed page pushed and acknowledged while the first is uncommitted never lets the prune take the first', async () => {
    await seedFile('first.txt');
    await seedFile('second.txt');
    parks = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
    const park = parks.arm(COLL, { when: writesAPosition });
    let first, second;
    let upTo = null;
    try {
      first = deliver([tomb('first.txt')]);
      const reached = await settleWithin(park.reached, REACH_MS);
      assert.ok(reached.settled, `fixture: the first page's store never reached its position stamp write within ${REACH_MS} ms — nothing was parked`);
      await sleep(5);   // the second page's receive time must differ from the parked stamp at millisecond resolution
      second = await settleWithin(deliver([tomb('second.txt')]), LATER_MS);
      assert.ok(second.settled, `fixture: the second page was not applied within ${LATER_MS} ms while the first was parked`);
      ({ upTo } = await sentThenAcknowledged(S));
    } finally {
      park.release();
    }
    const answered = await first;
    assert.equal(answered.code, 200, `the first page: ${JSON.stringify(answered.body)}`);
    const stored = await rowOf('first.txt');
    assert.ok(stored && typeof stored.positionAt === 'string', `fixture: the first page's tombstone was never stored: ${JSON.stringify(stored)}`);
    assert.ok(await rowOf('second.txt'), 'fixture: the second page\'s tombstone was never stored');
    if (upTo !== null) await pruneAt(S, upTo);
    assert.ok(await rowOf('first.txt'),
      `the relayed tombstone (position ${stored.positionAt}) was pruned although no push was ever sent it: the acknowledgement at ${upTo} `
      + 'was taken from a later page while its write was uncommitted');
  });
});
