/**
 * Database-level test: the tombstone prune deletes what every peer has applied, and NOTHING above that.
 *
 * ## Why the floor gate is not enough
 *
 * `tombstone-floor` proves the decision. This proves the delete, against a real MongoDB, because the two ways
 * this loses data both live in the query rather than the decision:
 *
 *   - `$lte` vs `$lt` — an off-by-one at the boundary deletes the tombstone the slowest peer is about to ask
 *     for. One document, and the record it protects comes back.
 *   - a filter that matches more than it should — a missing/`null` `seq`, a stringly-typed one, another space's
 *     collection. A hand-written matcher agrees with the author; the driver is the only authority.
 *
 * The direction that matters is the survival assertion, not the removal one: a prune that deletes too little is
 * housekeeping left undone, and a prune that deletes too much resurrects deleted records on the next sync.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/tombstone-prune-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'tspace';
const OTHER = 'ospace';

let mongo, pruneTombstonesToFloor, tombstoneFloor;

/** One tombstone per seq, so "which survived" reads directly off the seqs. */
const tombstone = (seq, spaceId = SPACE) => ({
  _id: `${spaceId}-doc-${seq}`,
  spaceId,
  type: 'fact',
  deletedAt: '2026-08-01T00:00:00.000Z',
  instanceId: 'self',
  seq,
});

const seqsIn = async (spaceId) => {
  const rows = await mongo.col(`${spaceId}_tombstones`).find({}).sort({ seq: 1 }).toArray();
  return rows.map(r => r.seq);
};

describe('tombstone prune (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('tombprune');
    ({ pruneTombstonesToFloor } = await import('../../server/dist/brain/tombstone-prune.js'));
    ({ tombstoneFloor } = await import('../../server/dist/sync/served-watermark.js'));
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => {
    await mongo.col(`${SPACE}_tombstones`).deleteMany({});
    await mongo.col(`${OTHER}_tombstones`).deleteMany({});
    await mongo.col(`${SPACE}_tombstones`).insertMany([10, 20, 30, 40, 50].map(s => tombstone(s)));
    await mongo.col(`${OTHER}_tombstones`).insertMany([10, 20].map(s => tombstone(s, OTHER)));
  });

  it('deletes at and below the floor, and keeps the rest', async () => {
    const removed = await pruneTombstonesToFloor(SPACE, { prune: true, upTo: 30, peers: 2 });
    assert.equal(removed, 3);
    assert.deepEqual(await seqsIn(SPACE), [40, 50]);
  });

  it('keeps the tombstone one above the floor — the boundary that loses a record', async () => {
    // `$lt` where `$lte` is meant (or the reverse) is invisible to a count assertion and deletes exactly the
    // document the slowest peer is about to ask for.
    await pruneTombstonesToFloor(SPACE, { prune: true, upTo: 39, peers: 1 });
    assert.deepEqual(await seqsIn(SPACE), [40, 50]);

    await pruneTombstonesToFloor(SPACE, { prune: true, upTo: 40, peers: 1 });
    assert.deepEqual(await seqsIn(SPACE), [50], 'seq 40 must go when the floor reaches it');
  });

  it('does not touch another space\'s tombstones', async () => {
    await pruneTombstonesToFloor(SPACE, { prune: true, upTo: Number.MAX_SAFE_INTEGER, peers: 0 });
    assert.deepEqual(await seqsIn(SPACE), []);
    assert.deepEqual(await seqsIn(OTHER), [10, 20], 'a sibling space was pruned by a per-space sweep');
  });

  it('deletes NOTHING when the floor says not to prune', async () => {
    // set-claim: the refusal REASONS this function can return, each exercised with its own fixture -- the
    // branch outcomes of the code under test rather than a list copied from it.
    for (const reason of ['member-never-pulled', 'peer-token-scoped', 'floor-at-zero']) {
      const removed = await pruneTombstonesToFloor(SPACE, { prune: false, reason });
      assert.equal(removed, -1, `${reason} reported a prune`);
      assert.deepEqual(await seqsIn(SPACE), [10, 20, 30, 40, 50], `${reason} deleted tombstones`);
    }
  });

  it('drops the whole collection for a space with no peers — the single-instance win', async () => {
    // End to end through the real decision rather than a hand-made floor: no members, no peer tokens.
    const floor = tombstoneFloor([], SPACE, []);
    assert.equal(floor.prune, true);
    const removed = await pruneTombstonesToFloor(SPACE, floor);
    assert.equal(removed, 5);
    assert.deepEqual(await seqsIn(SPACE), []);
  });

  it('leaves a space alone when one member has never pulled — through the real decision', async () => {
    const floor = tombstoneFloor(
      [{ instanceId: 'a', lastSeqServed: { [SPACE]: 50 } }, { instanceId: 'b' }],
      SPACE,
    );
    assert.equal(floor.prune, false);
    await pruneTombstonesToFloor(SPACE, floor);
    assert.deepEqual(await seqsIn(SPACE), [10, 20, 30, 40, 50]);
  });

  it('ignores a tombstone with no seq rather than deleting it as if it were zero', async () => {
    // A legacy or malformed document has no position, so it cannot be proven delivered. MongoDB does NOT match
    // a missing field against `$lte`, which is the behaviour relied on here — and precisely the kind of thing a
    // JS matcher gets wrong in the other direction.
    await mongo.col(`${SPACE}_tombstones`).insertOne({
      _id: 'legacy', spaceId: SPACE, type: 'fact', deletedAt: '2026-01-01T00:00:00.000Z', instanceId: 'self',
    });
    await pruneTombstonesToFloor(SPACE, { prune: true, upTo: Number.MAX_SAFE_INTEGER, peers: 0 });
    const left = await mongo.col(`${SPACE}_tombstones`).find({}).toArray();
    assert.deepEqual(left.map(r => r._id), ['legacy']);
  });

  it('is idempotent — a second sweep removes nothing and reports zero', async () => {
    await pruneTombstonesToFloor(SPACE, { prune: true, upTo: 30, peers: 1 });
    const second = await pruneTombstonesToFloor(SPACE, { prune: true, upTo: 30, peers: 1 });
    assert.equal(second, 0);
    assert.deepEqual(await seqsIn(SPACE), [40, 50]);
  });

  it('answers 0, not -1, on a collection that does not exist', async () => {
    // A space that has never deleted anything must not look like a failed prune in the log.
    const removed = await pruneTombstonesToFloor('never-used-space', { prune: true, upTo: 99, peers: 0 });
    assert.equal(removed, 0);
  });
});
