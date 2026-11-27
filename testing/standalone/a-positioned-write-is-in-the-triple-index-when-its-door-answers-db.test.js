/**
 * A positioned write's statements are in the space's triple index by the time its door answers, equal to the record's form (bundle-273,
 * Q-764 slice S1; design-r2 R1; contract rows 1, 3, 5).
 *
 * ## The rules
 *
 * 1. **Every write door answers after the index holds the write.** A create, a converge, an update, a delete and a SPARQL Update's write
 *    group each leave, when their answer arrives, the index holding exactly the stored record's form (`recordTriples`, RDF 1.2 edge
 *    details, no agent memory), or no row for a record that is gone. Nothing waits or polls: the read follows the answer.
 * 2. **Every kind is indexed as its form.** An entity, a fact, a chrono entry, an edge, a link and a file, each written through the records
 *    stream (`withLandingStamp`), are in the index statement for statement.
 * 3. **The apply is idempotent.** A record applied again (the follower re-applies everything above `appliedPos`) leaves every count as it
 *    was: a statement five records share counts five, however often any of them is applied.
 *
 * ## Seen red
 *
 * On aae46da89 (no index): every case fails at its first read of the index (the record has no row, the state has no document).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-positioned-write-is-in-the-triple-index-when-its-door-answers-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';
import { buildIndexes } from './_triple-index-read.mjs';
import { assertIndexedAsStored, indexedStatements, formStatements, quadRow, indexState, allQuadRows } from './_triple-index.mjs';

const skip = await mongoSkipReason();
const S = 'tix-doors';
const K = 'tix-kinds';
const SCHEMA = { entity: { person: { propertySchemas: { nick: { type: 'string' } } } } };
const STAMP = '2026-03-04T05:06:07.000Z';
const AUTHOR = { instanceId: 'tix-author', instanceLabel: 'Tix' };

let d, stream, admin;
const col = (space, part) => d.col(d.spaceCollection(space, part));

/** Write `doc` into `collection` of `space` through the records stream, as every positioned writer does. */
async function landed(space, collection, doc) {
  await stream.withLandingStamp(space, [stream.localRow(1)], async ([patch]) => {
    await col(space, collection).replaceOne({ _id: doc._id }, { ...doc, ...patch }, { upsert: true });
  }, 'test.landing');
}

describe('a positioned write is in the triple index when its door answers', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({
      suite: 'b273-tix-doors',
      spaces: [{ id: S, meta: rdfMeta(S, { typeSchemas: SCHEMA }) }, { id: K, meta: rdfMeta(K) }],
    });
    stream = await import('../../server/dist/sync/record-position-stream.js');
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }, { id: K }]);
    // The follower applies to an index a rebuild built (pre-ship finding P2): build each space's, as the upkeep does.
    await buildIndexes([S, K]);
    admin = await d.mint('tix-admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  it('a create, a converge, an update and a delete each answer with the index holding the stored form', async () => {
    const created = await d.rest(admin.key, 'POST', `/api/brain/spaces/${S}/entities`, { name: 'Ada', type: 'person', properties: { nick: 'ada' }, tags: ['one'] });
    assert.equal(created.status, 201, created.text);
    const id = created.body._id ?? created.body.id;
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', id);
    assert.ok((await indexedStatements(d, S, 'entity', id)).length > 0, 'a created entity states something');

    const converged = await d.rest(admin.key, 'POST', `/api/brain/spaces/${S}/entities`, { id, name: 'Ada', type: 'person', properties: { nick: 'ada2' } });
    assert.ok(converged.status === 200 || converged.status === 201, converged.text);
    assert.equal(converged.body._id ?? converged.body.id, id, 'the second save converged onto the first record');
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', id);
    assert.ok((await indexedStatements(d, S, 'entity', id)).some(s => s.includes('ada2')), 'the converged value is indexed');

    const updated = await d.rest(admin.key, 'PATCH', `/api/brain/spaces/${S}/entities/${id}`, { description: 'patched here' });
    assert.equal(updated.status, 200, updated.text);
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', id);
    assert.ok((await indexedStatements(d, S, 'entity', id)).some(s => s.includes('patched here')), 'the updated description is indexed');

    const deleted = await d.rest(admin.key, 'DELETE', `/api/brain/spaces/${S}/entities/${id}`);
    assert.ok(deleted.status === 200 || deleted.status === 204, deleted.text);
    assert.equal(await indexedStatements(d, S, 'entity', id), null, 'a deleted record keeps no record row');
    for (const q of await allQuadRows(d, S)) assert.ok(q.nK + q.nF > 0, 'no quad row is left at a zero count');
  });

  it('a SPARQL Update lands its write group and answers with the index holding every record it wrote', async () => {
    const at = (kind, id) => `${baseOf(S)}${kind}/${id}`;
    const a = await d.sparqlUpdate('rest', admin.key, S, `INSERT DATA { <${at('entity', 'g1')}> <${baseOf(S)}vocab/entity/person#nick> "gee" . `
      + `<${at('entity', 'g1')}> a <${baseOf(S)}vocab/entity/person> . <${at('entity', 'g1')}> <http://www.w3.org/2000/01/rdf-schema#label> "Gee" }`);
    assert.equal(a.status, 200, a.text);
    const rows = await col(S, 'entities').find({ name: 'Gee' }).toArray();
    assert.equal(rows.length, 1, `the Update wrote one entity: ${a.text.slice(0, 300)}`);
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', rows[0]._id);
    assert.ok((await indexedStatements(d, S, 'entity', rows[0]._id)).some(s => s.includes('gee')), 'the written property is indexed');
  });

  it('every kind written through the records stream is indexed as its form', async () => {
    const base = { spaceId: K, seq: 1, createdAt: STAMP, updatedAt: STAMP, author: AUTHOR, tags: ['t'] };
    const records = [
      ['entity', 'entities', { ...base, _id: 'e1', name: 'Eve', type: 'thing', properties: { size: 3, note: 'n' }, description: 'an entity' }],
      ['entity', 'entities', { ...base, _id: 'e2', name: 'Fay', type: 'thing' }],
      ['fact', 'facts', { ...base, _id: 'f1', fact: 'a fact', type: 'claim' }],
      ['chrono', 'chrono', { ...base, _id: 'c1', title: 'a meeting', type: 'event', status: 'upcoming', startsAt: '2026-05-01T10:00:00Z', endsAt: '2026-05-01T11:00:00Z', confidence: 0.5 }],
      ['edge', 'edges', { ...base, _id: 'k1', from: 'e1', to: 'e2', label: 'knows', weight: 0.7, properties: { since: '2020' } }],
      ['link', 'links', { _id: 'l1', spaceId: K, from: 'f1', fromKind: 'fact', to: 'e1', toKind: 'entity', seq: 1 }],
      ['file', 'files', { _id: 'docs/a.txt', spaceId: K, path: 'docs/a.txt', sizeBytes: 12, sha256: 'ab'.repeat(32), createdAt: STAMP, updatedAt: STAMP, tags: ['f'], seq: 1 }],
    ];
    for (const [, collection, doc] of records) await landed(K, collection, doc);
    for (const [kind, collection, doc] of records) {
      const want = await formStatements(K, kind, await col(K, collection).findOne({ _id: doc._id }));
      assert.ok(want.length > 0, `the fixture's ${kind} states something`);
      await assertIndexedAsStored(assert, d, K, kind, collection, doc._id);
    }
    // An edge's own statement `<from> <label> <to>` is a triple term's subject too: the RDF 1.2 form is what is indexed.
    assert.ok((await indexedStatements(d, K, 'edge', 'k1')).some(s => s.includes('"T[')), 'the edge states its reifier with a triple term');
    const state = await indexState(d, K);
    assert.equal(state?.status, 'ready', `the index of a space that is caught up is ready: ${JSON.stringify(state)}`);
  });

  it('a record applied again leaves every count as it was', async () => {
    // The five authored records (e1, e2, f1, c1, k1) share their author's agent statements: one quad row, counted five times.
    const e1 = await indexedStatements(d, K, 'entity', 'e1');
    assert.ok(e1 !== null, 'the index holds no record row for entity e1');
    const shared = e1.filter(s => s.includes('prov#Agent'));
    assert.equal(shared.length, 1, 'the agent is typed once per record');
    const before = await quadRow(d, K, shared[0]);
    assert.equal(before?.nK, 5, `five records state the agent's type: ${JSON.stringify(before)}`);
    // The follower re-applies everything above `appliedPos`: move it back, and land a record that changes nothing the form reads.
    await d.col(`${K}_rdf_state`).updateOne({ _id: 'state' }, { $set: { appliedPos: 0 } });
    await landed(K, 'entities', { ...(await col(K, 'entities').findOne({ _id: 'e2' })) });
    const after = await quadRow(d, K, shared[0]);
    assert.equal(after?.nK, 5, `applied again, the agent's type is still counted five times: ${JSON.stringify(after)}`);
    for (const id of ['e1', 'e2']) await assertIndexedAsStored(assert, d, K, 'entity', 'entities', id);
    const state = await indexState(d, K);
    assert.ok(state.appliedPos > 0, 'the follower moved appliedPos on again');
  });
});
