/**
 * A restore that stopped part-way while the seq counter is still behind what it restored answers the family as
 * errors — `Q-252`, 5.6.3.
 *
 * ## The defect
 *
 * `importDocuments` has two failure branches. When the writer's counter bump failed and nothing else did
 * (`counterBehind`), the whole family is answered as errors: the records are stored, but the counter may sit below
 * them, so the next local write could sort beneath a restored record every peer holds, and re-running the import (a
 * restore replaces, so it is idempotent) is what repairs it. When the writer STOPPED part-way (`ArrivalWriteError`
 * with a partial outcome), the branch reported the committed chunks as inserted and only the rest as errors — and
 * never read `partial.counterBehind`. So a counter that could not be moved past chunk 1, followed by a fault in
 * chunk 2, answered "500 inserted" over a counter still below them, with nothing telling the operator to re-run.
 *
 * ## The rule
 *
 *  - **The counter fault persists across both chunks** (a validator on the counter collection refuses any seq above
 *    100 for this space; chunk 1 restores seqs 1001-1500) and chunk 2's write fails: every document is an error.
 *  - **Control, a transient fault** (the validator is lifted when chunk 2 starts, so chunk 2's bump moves the counter
 *    past everything received): the partial counts stand, 500 inserted and 1 error.
 *
 * Faults are real where they can be: the counter refusal is a collection validator, and chunk 2's write fails below
 * the driver API with an error that is not the document's (so the writer stops rather than refusing a document).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-partial-restore-with-the-counter-behind-is-an-error-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'restore-partial';
const CHUNK = 500;   // the writer's chunk (`READ_CHUNK`), re-anchored below
let door, importDocuments;

/** 501 facts, seqs 1001..1501: chunk 1 is the first 500, chunk 2 the last one. */
const payload = () => ({ facts: Array.from({ length: CHUNK + 1 }, (_, i) => build.fact(S, `p-${String(i).padStart(4, '0')}`, 1001 + i)) });

/**
 * Restore `payload()` with the counter refusing seqs above 100 for this space from the start, and every write to the
 * facts collection failing from chunk 2 on. `lift` removes the counter fault as chunk 2 starts.
 */
async function restoreWithFaults({ lift }) {
  const db = door.mongo.getDb();
  await db.command({ collMod: 'ythril_counters', validationLevel: 'strict', validationAction: 'error',
    validator: { $or: [{ _id: { $ne: S } }, { seq: { $lte: 100 } }] } });
  const proto = Object.getPrototypeOf(door.mongo.col('probe'));
  const originals = { bulkWrite: proto.bulkWrite, updateOne: proto.updateOne };
  let bulkCalls = 0, failing = false, injected = 0;
  proto.bulkWrite = async function chunked(...args) {
    if (this.collectionName === `${S}_facts` && ++bulkCalls >= 2) {
      failing = true;
      if (lift) await db.command({ collMod: 'ythril_counters', validator: {} });
    }
    if (failing && this.collectionName === `${S}_facts`) { injected++; throw new Error(`injected: ${S}_facts bulkWrite failed`); }
    return originals.bulkWrite.apply(this, args);
  };
  proto.updateOne = async function chunked(...args) {
    if (failing && this.collectionName === `${S}_facts`) { injected++; throw new Error(`injected: ${S}_facts updateOne failed`); }
    return originals.updateOne.apply(this, args);
  };
  try {
    const res = await importDocuments(S, payload());
    return { res, bulkCalls, injected };
  } finally {
    Object.assign(proto, originals);
    await db.command({ collMod: 'ythril_counters', validator: {} });
  }
}

describe('a partial restore with the counter behind is answered as errors', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'restorepartial', spaces: [{ id: S, label: 'Restore partial', folders: [] }] });
    ({ importDocuments } = await import('../../server/dist/api/admin-import.js'));
    const { READ_CHUNK } = await import('../../server/dist/db/read-by-id.js');
    assert.equal(READ_CHUNK, CHUNK, `the writer chunks at ${READ_CHUNK}, not ${CHUNK} — re-anchor the payload`);
    // The counter collection must exist for collMod; a bump creates it.
    await door.setCounter('restore-partial-probe', 1);
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the counter fault persists across both chunks and chunk 2 fails: every document is an error', async () => {
    const { res, bulkCalls, injected } = await restoreWithFaults({ lift: false });
    assert.ok(bulkCalls >= 2 && injected > 0, `fixture check: chunk 2 never failed (bulk calls ${bulkCalls}, injected ${injected})`);
    assert.equal(await door.coll(S, 'facts').countDocuments(), CHUNK, 'fixture check: chunk 1 did not land');
    assert.ok(await door.counter(S) < 1001, `fixture check: the counter moved to ${await door.counter(S)}, so it is not behind`);
    assert.deepEqual(
      { inserted: res.results.facts.inserted, updated: res.results.facts.updated, errors: res.results.facts.errors },
      { inserted: 0, updated: 0, errors: CHUNK + 1 },
      'a restore that stopped part-way with the counter still below chunk 1 reported chunk 1 as restored: the next '
      + 'local write can sort below a restored record, and nothing tells the operator to re-run the import');
  });

  it('control: a transient counter fault (chunk 1 only) keeps the partial counts', async () => {
    const { res, injected } = await restoreWithFaults({ lift: true });
    assert.ok(injected > 0, 'fixture check: chunk 2 never failed');
    assert.ok(await door.counter(S) >= 1501, `fixture check: the counter is at ${await door.counter(S)}, not past every restored seq`);
    assert.deepEqual(
      { inserted: res.results.facts.inserted, updated: res.results.facts.updated, errors: res.results.facts.errors },
      { inserted: CHUNK, updated: 0, errors: 1 },
      'a partial restore whose counter WAS moved past everything it received did not report what landed');
  });
});
