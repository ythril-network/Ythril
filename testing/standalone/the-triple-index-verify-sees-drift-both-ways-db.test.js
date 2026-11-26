/**
 * The drift verify of a triple index compares the index with the records in both directions, and counts no drift it saw while the index
 * was swapped under it (bundle-273, Q-764, review findings F9 and the unproven point U4).
 *
 * ## The rules
 *
 * 1. **F9: a record row whose record is gone is drift.** The verify walked the records and compared each with its record row; a record
 *    that was removed without a tombstone, with its rows left in the index, was never visited. It samples the record rows too (a cursor
 *    of its own in the verify row) and names each whose record is no longer stored.
 * 2. **U4: a verify that met a swap reports no drift.** The sample reads the live collections while another instance may rename a build
 *    onto them. A verify whose index state (status and build) is not the one it started from at its end counts no mismatch and gives no
 *    reason.
 *
 * ## Seen red
 *
 * On 42c51f330: case 1 names no record (the ghost row is never visited); case 2 asks for a rebuild (`verify`) over a swap.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-verify-sees-drift-both-ways-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule, verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixv-both';
const RECORDS = 30;
let d;

describe('the triple index verify sees drift both ways', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixv-both', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: RECORDS }, (_, i) => ['entities', entityDoc(S, `p${String(i).padStart(2, '0')}`, `Person ${i}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('F9: a record row whose record is not stored is named, and asks for a rebuild', async () => {
    const { verifyTripleIndex } = await verifyModule();
    const clean = await verifyTripleIndex(S);
    assert.deepEqual([clean.mismatched, clean.reason], [[], null], 'a clean index verifies clean');
    // The rows of a record that was removed with no tombstone and no journal row (a writer the index never saw).
    const other = await d.col(`${S}_rdf_records`).findOne({ _id: 'entity:p02' });
    await d.col(`${S}_rdf_records`).insertOne({ _id: 'entity:ghost', pos: 3, q: other.q });
    const named = new Set();
    let reason = null;
    for (let run = 0; run < 3; run++) {
      const r = await verifyTripleIndex(S);
      for (const key of r.mismatched) named.add(key);
      reason ??= r.reason;
    }
    assert.deepEqual([...named], ['entity:ghost'], 'the row without a record, and only it, is named');
    assert.equal(reason, 'verify', 'drift asks for a rebuild');
  });

  it('U4: a verify that meets a swap of the index while it samples reports no drift', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const { verifyTripleIndex } = await verifyModule();
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    // A mismatch the sample will see: a record row gone.
    await d.col(`${S}_rdf_records`).deleteOne({ _id: 'entity:p01' });
    const { getDb } = await import('../../server/dist/db/mongo.js');
    const proto = Object.getPrototypeOf(getDb().collection('probe'));
    const original = proto.countDocuments;
    let swapped = false;
    // Between the sample of the records and the terms' look-ups: another instance's swap changes the build the state names.
    proto.countDocuments = async function swapping(...args) {
      if (!swapped && this.collectionName === `${S}_rdf_quads`) {
        swapped = true;
        await d.col(`${S}_rdf_state`).updateOne({ _id: 'state' }, { $set: { buildId: 'f'.repeat(16) } });
      }
      return original.apply(this, args);
    };
    let r;
    try { r = await verifyTripleIndex(S); } finally { proto.countDocuments = original; }
    assert.equal(swapped, true, 'the swap happened while the verify sampled');
    assert.deepEqual([r.mismatched, r.reason], [[], null], 'a verify over a swap reports nothing');
    // Without the swap the same mismatch is drift: the control that the planted row is seen at all.
    const control = await (async () => { for (let i = 0; i < 3; i++) { const c = await verifyTripleIndex(S); if (c.reason) return c; } return null; })();
    assert.equal(control?.reason, 'verify', 'the planted missing row is drift when no swap meets the verify');
  });
});
