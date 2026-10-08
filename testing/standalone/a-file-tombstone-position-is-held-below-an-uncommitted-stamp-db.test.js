/**
 * A file tombstone's position is never handed out while an EARLIER one is still uncommitted, so no acknowledgement can
 * cover a row that has not landed (Q-346, bundle-71 D1).
 *
 * ## The defect
 *
 * A tombstone's position (`positionAt`) is stamped BEFORE its write commits (`publishOnePerPath`, and the boot pass
 * `positionLegacyFileTombstones`). A push acknowledges the highest position it SENT; the prune removes every row at or
 * below the acknowledged position, every six hours. So when a publish stamped T1, a later publish T2 committed and was
 * pushed, and only then did T1's write land, the next acknowledgement (at T2) covered T1 though no peer was ever sent it,
 * and the prune removed T1 unsent: the deleted file returns from the one peer that still holds it.
 *
 * ## The rule this file holds
 *
 * **No acknowledgement a push can record covers a position whose write has not committed.** Held as the order of events
 * the loss needs, driven through the real doors:
 *
 *  1. a write that stamps a position is PARKED after its stamp (`parkWrites`; the park is asserted reached, so a case whose
 *     write never got there fails instead of passing over nothing);
 *  2. a later tombstone is published and the push's first page is read (`sentThenAcknowledged`: the page, the rows a 200
 *     proves, and the position that acknowledgement records);
 *  3. the parked write is released, so T1 commits BELOW the acknowledgement;
 *  4. the prune runs at that acknowledgement: **T1 is still there.**
 *
 * It asserts what the prune does with whatever was acknowledged and never that T2 was sent: on the fixed code a published
 * tombstone is held back from the page while an earlier position is open (`settledPositionCap`), which is the point.
 * The own publish, the legacy stamp (`positionLegacyFileTombstones`) and — in the sibling file, whose door is another — a
 * relayed store are the three writers of a position; each is a case, and each is red on the unchanged code for the reason above.
 *
 * Run: node --test testing/standalone/a-file-tombstone-position-is-held-below-an-uncommitted-stamp-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { parkWrites, settleWithin } from './_write-faults.mjs';
import { writesAPosition, sentThenAcknowledged, pruneAt } from './_position-hold.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'poshold';
/** How long a parked write has to REACH its park before the fixture is called broken. */
const REACH_MS = 10_000;
/** How long the later publish may take: on the fixed code it may be held behind the parked one and that is allowed. */
const LATER_MS = 3_000;

let acts, tombstones, parks;
const COLL = `${S}_file_tombstones`;
const raw = () => acts.raw();
const rowOf = async (p) => (await raw()).find(t => t.path === p);

/** Park the next write to the tombstone collection that stamps a position; the park is asserted reached by `reached()`. */
function armStamp() {
  // Installed per case and put back after it (`parks.restore()` takes the wrappers off the prototype with the gates).
  parks = parkWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')));
  const park = parks.arm(COLL, { when: writesAPosition });
  return {
    release: park.release,
    async reached(what) {
      const r = await settleWithin(park.reached, REACH_MS);
      assert.ok(r.settled, `fixture: ${what} never reached its position stamp write within ${REACH_MS} ms — nothing was parked, so the case proves nothing`);
    },
  };
}

describe('a file tombstone position is held below an uncommitted stamp', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'poshold', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
  });
  after(async () => {
    parks?.restore();
    await acts?.close();
  });
  beforeEach(async () => { await acts.reset(); });
  afterEach(() => { parks?.restore(); parks = undefined; });

  it('the own publish: a later tombstone pushed and acknowledged while T1 is uncommitted never lets the prune take T1', async () => {
    await acts.seed('t1.txt');
    await acts.seed('t2.txt');
    const park = armStamp();
    let t1, t2;
    let upTo = null;
    try {
      t1 = acts.del('REST', 't1.txt');
      await park.reached('the first delete\'s publish');
      await sleep(5);   // the later stamp must differ from the parked one at millisecond resolution
      // On the unchanged code T2 publishes at once. On the fixed code it may wait behind T1 (one publisher at a time), and then
      // there is nothing yet to acknowledge: both are allowed, the prune below is what must hold.
      t2 = await settleWithin(acts.del('REST', 't2.txt'), LATER_MS);
      ({ upTo } = await sentThenAcknowledged(S));
    } finally {
      park.release();
    }
    const first = await t1;
    assert.ok(!acts.failed(first), `the first delete: ${JSON.stringify(first.body ?? first.text)}`);
    await t2.rest;
    const t1Row = await rowOf('t1.txt');
    assert.ok(t1Row && t1Row.pending === undefined && typeof t1Row.positionAt === 'string',
      `fixture: T1's tombstone never committed as a published row: ${JSON.stringify(t1Row)}`);
    if (upTo !== null) await pruneAt(S, upTo);
    const after = await rowOf('t1.txt');
    assert.ok(after, `T1 (position ${t1Row.positionAt}) was pruned although no push was ever sent it: the acknowledgement at ${upTo} was taken `
      + 'from a later tombstone while T1\'s write was uncommitted, so the deleted file returns from the one peer that holds it');
  });

  it('the legacy pass: a position stamped by positionLegacyFileTombstones is held below the same way', async () => {
    const T1 = { _id: 'legacy-1', spaceId: S, path: 'legacy.txt', deletedAt: '2026-01-01T00:00:00.000Z' };
    await acts.door.coll(S, 'file_tombstones').insertOne(T1);
    const park = armStamp();
    let pass;
    let upTo = null;
    try {
      pass = tombstones.positionLegacyFileTombstones(S);
      await park.reached('the legacy pass');
      await sleep(5);   // the later position must differ from the stamp at millisecond resolution
      const at = new Date().toISOString();
      await acts.door.coll(S, 'file_tombstones').insertOne({ _id: 'later-1', spaceId: S, path: 'later.txt', deletedAt: at, positionAt: at });
      ({ upTo } = await sentThenAcknowledged(S));
    } finally {
      park.release();
    }
    assert.equal(await pass, 1, 'fixture: the legacy pass stamped no row');
    const stamped = await rowOf('legacy.txt');
    assert.ok(stamped && typeof stamped.positionAt === 'string', `fixture: the legacy row was never stamped: ${JSON.stringify(stamped)}`);
    if (upTo !== null) await pruneAt(S, upTo);
    assert.ok(await rowOf('legacy.txt'),
      `the legacy row (position ${stamped.positionAt}) was pruned although no push was ever sent it: the acknowledgement at ${upTo} `
      + 'covered a position the pass had stamped and not yet written');
  });
});
