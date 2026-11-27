/**
 * Each cause a space's triple index is rebuilt for leads to a ready index that holds exactly what its records state (bundle-273, Q-764
 * slice S4; contract rows 3 and 4).
 *
 * ## The rules
 *
 * The upkeep of a space (`verify.ts` `upkeepTripleIndex`, the housekeeping job's step per space) rebuilds its index when:
 *  1. the index is missing (a restore dropped it), or was started by the follower and never built whole: a row without `pos` is then in no
 *     index, and the rebuild states it;
 *  2. the index is `stale`;
 *  3. the journal holds a `*` row (a write no record row could name); the rebuild deletes it, as every journal row done before it started;
 *  4. the index was built for another form;
 *  5. the rolling verify finds a record whose statements differ from its record row;
 *  6. more than half of the dictionary is terms no statement uses (counted by the verify over its passes).
 * After each, the index is `ready`, names its build, and every record's statements are its export form (compared record by record).
 *
 * ## Seen red
 *
 * On 65080cae3 (no rebuild): every case fails at the import of `server/dist/rdf/triple-index/verify.js` (ERR_MODULE_NOT_FOUND).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-is-rebuilt-on-each-trigger-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, bendState, entityDoc, edgeDoc } from './_triple-index-read.mjs';
import { indexedStatements } from './_triple-index.mjs';
import { assertIndexEqualsRecords, dropIndex, verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-trigger';
const LEGACY = 'legacy-no-pos';
let d;

/** Run the upkeep with its verify, and assert it rebuilt for `reason` and left an index equal to the records. */
async function rebuiltFor(reason) {
  const { upkeepTripleIndex } = await verifyModule();
  const r = await upkeepTripleIndex(S, { verify: true });
  assert.equal(r.rebuilt, reason, `the upkeep rebuilds for ${reason}: ${JSON.stringify(r)}`);
  return assertIndexEqualsRecords(assert, d, S);
}

describe('the triple index is rebuilt on each trigger', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-trigger', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    const docs = [];
    for (let i = 0; i < 30; i++) docs.push(['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]);
    for (let i = 0; i < 10; i++) docs.push(['edges', edgeDoc(S, `k${i}`, `p${i}`, `p${i + 1}`, 'knows')]);
    await landAll(d, S, docs);
    // A row stored before positions: no `pos`, and no journal row names it (the journal row its insert wrote is taken away).
    await d.col(d.spaceCollection(S, 'entities')).insertOne(entityDoc(S, LEGACY, 'Old Timer', 'person'));
    await d.col(`${S}_rdf_dirty`).deleteMany({});
  });
  after(async () => { await d?.close(); });

  it('a missing index is built, the row without a position included', async () => {
    await dropIndex(d, S);
    await rebuiltFor('missing');
    assert.ok((await indexedStatements(d, S, 'entity', LEGACY))?.length > 0, 'the row without a position is stated');
  });

  it('an index a follower started and nobody built whole is rebuilt', async () => {
    await dropIndex(d, S);
    // The state a follower that started its own index left (the follower no longer starts one, so an upgrade from such a build plants it).
    await d.col(`${S}_rdf_state`).insertOne({ _id: 'state', status: 'ready', appliedPos: 0, formKey: 'older-build' });
    assert.equal(await indexedStatements(d, S, 'entity', LEGACY), null, 'that index states nothing of the row without a position');
    await rebuiltFor('missing');
  });

  it('a stale index is rebuilt', async () => {
    await bendState(d, S, { status: 'stale' });
    await rebuiltFor('stale');
  });

  it('a journal row that names no record starts a rebuild, which deletes it', async () => {
    await d.col(`${S}_rdf_dirty`).insertOne({ _id: 'tixb-star', key: '*', done: true, at: Date.now() - 1_000 });
    await rebuiltFor('journal');
    assert.equal(await d.col(`${S}_rdf_dirty`).countDocuments({ _id: 'tixb-star' }), 0, 'the row done before the rebuild started is deleted');
  });

  it('an index built for another form is rebuilt', async () => {
    await bendState(d, S, { formKey: 'another-form' });
    const state = await rebuiltFor('form');
    assert.notEqual(state.formKey, 'another-form');
  });

  it('a record whose statements differ from its record row starts a rebuild', async () => {
    const a = await d.col(`${S}_rdf_records`).findOne({ _id: 'entity:p1' });
    const b = await d.col(`${S}_rdf_records`).findOne({ _id: 'entity:p2' });
    await d.col(`${S}_rdf_records`).updateOne({ _id: 'entity:p1' }, { $set: { q: b.q } });
    assert.ok(a && b, 'both record rows exist before the plant');
    await rebuiltFor('verify');
  });

  it('a dictionary more than half unused starts a rebuild, and the new one holds no unused term', async () => {
    const { upkeepTripleIndex } = await verifyModule();
    const top = (await d.col(`${S}_rdf_terms`).findOne({ _id: -1 })).top;
    const planted = Array.from({ length: 3 * top }, (_, i) => ({ _id: top + 1 + i, k: `Ihttp://unused.example/t${i}` }));
    await d.col(`${S}_rdf_terms`).insertMany(planted);
    await d.col(`${S}_rdf_terms`).updateOne({ _id: -1 }, { $set: { top: top + planted.length } });
    let r;
    for (let run = 0; run < 100; run++) {
      r = await upkeepTripleIndex(S, { verify: true });
      if (r.rebuilt !== null) break;
    }
    assert.equal(r.rebuilt, 'unused-terms', `the verify's passes over the dictionary start a rebuild: ${JSON.stringify(r)}`);
    await assertIndexEqualsRecords(assert, d, S);
    assert.equal(await d.col(`${S}_rdf_terms`).countDocuments({ k: /^Ihttp:\/\/unused\.example\// }), 0, 'the new dictionary holds no planted term');
  });

  it('an index that is ready, of its form and verified clean is left as it is', async () => {
    const { upkeepTripleIndex } = await verifyModule();
    const before = await d.col(`${S}_rdf_state`).findOne({ _id: 'state' });
    const r = await upkeepTripleIndex(S, { verify: true });
    assert.equal(r.rebuilt, null, JSON.stringify(r));
    assert.equal((await d.col(`${S}_rdf_state`).findOne({ _id: 'state' })).buildId, before.buildId, 'no rebuild ran');
  });
});
