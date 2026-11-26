/**
 * A SPARQL Update's parts are applied in order, so what a later part states after an earlier part removed it is in the final state, and a
 * relation a later part re-states is never lost silently (bundle-272, Q-761, the finding of the edge removed and re-stated).
 *
 * ## The rules
 *
 * 1. **A relation an earlier part removed with its record and a later part states again is kept.** `DELETE WHERE { <edge> ?p ?o } ;
 *    INSERT DATA { <from> <label> <to> }` answers 200 and the edge is still stored under its id, without the properties the first part
 *    removed. The insert was judged against the starting state, where the relation is held, so it counted as a no-op and the edge was
 *    deleted: the client was told it succeeded while the relation it asked for was gone.
 * 2. **The same holds in one part** (`DELETE { ... } INSERT { ... } WHERE`), and for a relation stated before the record is removed.
 * 3. **An entity whose `rdf:type` a part removed and a later part states again still exists** (it is never answered as a 200 that deleted it).
 * 4. **A plain property removed and stated again keeps its value.**
 *
 * ## Seen red
 *
 * On 2aaed69f0, rules 1 and 2 answer 200 and the edge is gone (`edges.countDocuments` is 0).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-update-applies-its-parts-in-order-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spo-main';
const Y = 'https://w3id.org/ythril/ns#';
const STAMP = '2026-03-04T05:06:07.000Z';
const at = (kind, id) => `${baseOf(S)}${kind}/${id}`;
const vocab = (rest) => `${baseOf(S)}vocab/${rest}`;
const p = (prop) => vocab(`entity/person#${prop}`);
const KNOWS = vocab('edge/knows');
const PERSON_SCHEMA = { entity: { person: { propertySchemas: { nick: { type: 'string' } } } }, edge: { knows: { propertySchemas: { note: { type: 'string' } } } } };

let d;
let key;
const fmt = (a) => `${a.door} ${a.status} ${a.code} ${(a.text ?? '').slice(0, 500)}`;
const entities = () => d.col(d.spaceCollection(S, 'entities'));
const edges = () => d.col(d.spaceCollection(S, 'edges'));

/** Two people with a nick, one nothing names, and an edge between the first two with a note. */
async function seed() {
  await entities().deleteMany({});
  await edges().deleteMany({});
  const e = (id, name, properties = {}) => ({ _id: id, spaceId: S, name, type: 'person', properties, seq: 1, createdAt: STAMP, updatedAt: STAMP });
  await d.seed(S, 'entity', [e('e1', 'Ada', { nick: 'ada' }), e('e2', 'Bob', { nick: 'bob' }), e('e4', 'Dee')]);
  await d.seed(S, 'edge', [{ _id: 'k1', spaceId: S, from: 'e1', to: 'e2', label: 'knows', properties: { note: 'old' }, seq: 1, createdAt: STAMP, updatedAt: STAMP }]);
}

const relation = `<${at('entity', 'e1')}> <${KNOWS}> <${at('entity', 'e2')}>`;

describe('a SPARQL Update applies its parts in order', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q761-order', spaces: [{ id: S, meta: rdfMeta(S, { typeSchemas: PERSON_SCHEMA }) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    key = (await d.mint('spo-admin', {}, { admin: true })).key;
  });
  after(async () => { await d?.close(); });

  describe('an edge whose record a part removed and whose relation a later part states again', () => {
    it('is kept under its id, without the properties the first part removed', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', key, S, `DELETE WHERE { <${at('edge', 'k1')}> ?p ?o } ; INSERT DATA { ${relation} }`);
      assert.equal(a.status, 200, fmt(a));
      const stored = await edges().find({}).toArray();
      assert.deepEqual(stored.map(r => [r._id, r.from, r.to, r.label]), [['k1', 'e1', 'e2', 'knows']], `the relation the Update stated was lost: ${fmt(a)}`);
      assert.equal(stored[0].properties?.note, undefined, 'the removed property is still stored');
    });

    it('is kept on every door', async () => {
      for (const door of ['mcp', 'tool']) {
        await seed();
        const a = await d.sparqlUpdate(door, key, S, `DELETE WHERE { <${at('edge', 'k1')}> ?p ?o } ; INSERT DATA { ${relation} }`);
        assert.equal(a.status, 200, fmt(a));
        assert.equal(await edges().countDocuments({ _id: 'k1' }), 1, `${door}: the relation the Update stated was lost: ${fmt(a)}`);
      }
    });

    it('is kept when one part removes the record and states the relation', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', key, S,
        `DELETE { <${at('edge', 'k1')}> ?p ?o } INSERT { ${relation} } WHERE { <${at('edge', 'k1')}> ?p ?o }`);
      assert.equal(a.status, 200, fmt(a));
      assert.equal(await edges().countDocuments({ _id: 'k1' }), 1, `the relation the Update stated was lost: ${fmt(a)}`);
    });

    it('is kept when the relation is stated before the record is removed', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', key, S, `INSERT DATA { ${relation} } ; DELETE WHERE { <${at('edge', 'k1')}> ?p ?o }`);
      assert.equal(a.status, 200, fmt(a));
      assert.equal(await edges().countDocuments({ _id: 'k1' }), 1, `the relation the Update stated was lost: ${fmt(a)}`);
    });

    it('is deleted when no part states its relation (the record deletion stands)', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', key, S, `DELETE WHERE { <${at('edge', 'k1')}> ?p ?o }`);
      assert.equal(a.status, 200, fmt(a));
      assert.equal(await edges().countDocuments({}), 0, 'the edge is still stored');
    });
  });

  describe('an entity whose rdf:type a part removed and a later part states again', () => {
    it('still exists: the Update is never a 200 that deleted it', async () => {
      await seed();
      const e4 = at('entity', 'e4');
      const a = await d.sparqlUpdate('rest', key, S,
        `DELETE WHERE { <${e4}> a ?t } ; INSERT DATA { <${e4}> a <${Y}Entity>, <${vocab('entity/person')}> }`);
      assert.ok(a.status === 200 || a.status === 422, fmt(a));
      const e = await entities().findOne({ _id: 'e4' });
      assert.ok(e, `the entity whose type was stated again is gone: ${fmt(a)}`);
      assert.equal(e.name, 'Dee');
      assert.equal(e.type, 'person');
    });

    it('still exists when the whole record was removed and its type stated again: kept, or refused by a named reason', async () => {
      await seed();
      const e4 = at('entity', 'e4');
      const a = await d.sparqlUpdate('rest', key, S,
        `DELETE WHERE { <${e4}> ?p ?o } ; INSERT DATA { <${e4}> a <${Y}Entity>, <${vocab('entity/person')}> }`);
      assert.ok(a.status === 200 || a.status === 422, fmt(a));
      if (a.status === 422) assert.ok(a.code, `the refusal has no code: ${fmt(a)}`);
      assert.ok(await entities().findOne({ _id: 'e4' }), `the entity whose type was stated again is gone: ${fmt(a)}`);
    });
  });

  describe('a plain property a part removed and a later part states again', () => {
    it('keeps its value', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', key, S, `DELETE WHERE { <${at('entity', 'e1')}> <${p('nick')}> ?v } ; INSERT DATA { <${at('entity', 'e1')}> <${p('nick')}> "ada" }`);
      assert.equal(a.status, 200, fmt(a));
      assert.equal((await entities().findOne({ _id: 'e1' })).properties?.nick, 'ada', `the stated value was lost: ${fmt(a)}`);
    });

    it('takes the value the later part states instead', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', key, S, `DELETE WHERE { <${at('entity', 'e1')}> <${p('nick')}> ?v } ; INSERT DATA { <${at('entity', 'e1')}> <${p('nick')}> "lovelace" }`);
      assert.equal(a.status, 200, fmt(a));
      assert.equal((await entities().findOne({ _id: 'e1' })).properties?.nick, 'lovelace', `the stated value was lost: ${fmt(a)}`);
    });
  });
});
