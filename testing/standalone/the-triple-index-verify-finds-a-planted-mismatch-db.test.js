/**
 * The drift verify of a space's triple index recomputes a rolling sample of records against their record rows and names each that
 * differs (bundle-273, Q-764 slice S4; contract row 5).
 *
 * ## The rules
 *
 * 1. **A clean index verifies clean.** Every record of the sample matches its record row: nothing is named, no rebuild is asked.
 * 2. **A planted mismatch is found.** A record row that states another record's statements, and a record whose row was deleted, are
 *    named, and the verify asks for a rebuild (`verify`).
 * 3. **The sample is bounded and rolls.** One run checks at most `VERIFY_SAMPLE_RECORDS` records; the next run goes on where it stopped,
 *    so two runs over a space of more records than one sample check every record.
 *
 * ## Seen red
 *
 * On 65080cae3 (no verify): every case fails at the import of `server/dist/rdf/triple-index/verify.js` (ERR_MODULE_NOT_FOUND).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-verify-finds-a-planted-mismatch-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule, verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-verify';
const RECORDS = 260;
let d;

describe('the triple index verify finds a planted mismatch', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-verify', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    const docs = [];
    for (let i = 0; i < RECORDS; i++) docs.push(['entities', entityDoc(S, `p${String(i).padStart(3, '0')}`, `Person ${i}`, 'person')]);
    await landAll(d, S, docs);
    const { rebuildTripleIndex } = await rebuildModule();
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('one run checks a bounded sample, and the next goes on where it stopped', async () => {
    const { verifyTripleIndex, VERIFY_SAMPLE_RECORDS } = await verifyModule();
    assert.ok(VERIFY_SAMPLE_RECORDS < RECORDS, 'the space holds more records than one sample');
    const one = await verifyTripleIndex(S);
    const two = await verifyTripleIndex(S);
    assert.equal(one.checked.length, VERIFY_SAMPLE_RECORDS, 'one run checks one sample');
    const seen = new Set([...one.checked, ...two.checked]);
    assert.equal(seen.size, RECORDS, 'two runs check every record');
    assert.deepEqual([...one.mismatched, ...two.mismatched], [], 'a clean index verifies clean');
    assert.equal(one.reason, null);
    assert.equal(two.reason, null);
  });

  it('a record row stating another record\'s statements, and a missing record row, are named and ask for a rebuild', async () => {
    const { verifyTripleIndex } = await verifyModule();
    const other = await d.col(`${S}_rdf_records`).findOne({ _id: 'entity:p002' });
    await d.col(`${S}_rdf_records`).updateOne({ _id: 'entity:p001' }, { $set: { q: other.q } });
    await d.col(`${S}_rdf_records`).deleteOne({ _id: 'entity:p004' });
    const named = new Set();
    let reason = null;
    for (let run = 0; run < 3; run++) {
      const r = await verifyTripleIndex(S);
      for (const key of r.mismatched) named.add(key);
      reason ??= r.reason;
    }
    assert.deepEqual([...named].sort(), ['entity:p001', 'entity:p004'], 'the planted mismatches, and only they, are named');
    assert.equal(reason, 'verify', 'a mismatch asks for a rebuild');
  });
});
