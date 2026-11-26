/**
 * A SPARQL Update changes records through the normal write rules, whole or not at all, and every way it can end is answered by its own
 * code (bundle-272, Q-761; design h, r2 R4, R8, vet-1 S5, vet-2 S3, S4, vet-3 S13; owner D-91).
 *
 * ## The rules
 *
 * 1. **Three doors, one act.** `POST /api/brain/spaces/:spaceId/sparql/update` (`application/sparql-update`), MCP `sparql_update` and
 *    `POST /api/sparql_update` land the same writes: INSERT DATA makes a record under a minted id, DELETE DATA removes exactly the value it
 *    names, DELETE/INSERT WHERE renames a property across records, an edge's annotation is changed in place.
 * 2. **Whole or nothing.** A statement a strict schema refuses among valid ones lands nothing, and the refusal names the record and the rule.
 *    An Update that deletes an entity something still names is refused naming the blockers (no cascade, D-91).
 * 3. **Bounded.** More records changed than `sparql.maxRecordsChanged` is `413 sparql_too_many_changes` naming the cap, nothing landed;
 *    the key is held to 1..GROUP_MAX_RECORDS at load.
 * 4. **A lost race is run again, at most three times**, then `409 sparql_update_conflict` naming the record that kept moving.
 * 5. **An unknown outcome is said as itself** (`503 write_group_outcome_unknown`), never "nothing landed".
 * 6. **An effect after the commit that failed** answers `500 sparql_update_cascade_incomplete`, naming the effect and what landed.
 *
 * ## Seen red
 *
 * On 4fc52d8a9 (the base) no route answers `.../sparql/update` and no tool `sparql_update` exists: every door case fails on its status.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-update-lands-whole-or-is-refused-by-its-code-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loseNextCommitReply, injectStoreFault } from './_write-faults.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const DOORS = ['rest', 'mcp', 'tool'];
const spaceOf = (door) => `spu-${door}`;
const STRICT = 'spu-strict';
const BOUNDS = 'spu-bounds';
const Y = 'https://w3id.org/ythril/ns#';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const STAMP = '2026-03-04T05:06:07.000Z';
const at = (space, kind, id) => `${baseOf(space)}${kind}/${id}`;
const vocab = (space, rest) => `${baseOf(space)}vocab/${rest}`;
const PERSON_SCHEMA = { entity: { person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' }, alias: { type: 'string' } } } }, edge: { knows: { propertySchemas: { note: { type: 'string' } } } } };

let d;
const tokens = {};
const fmt = (a) => `${a.door} ${a.status} ${a.code} ${(a.text ?? '').slice(0, 400)}`;
const entities = (space) => d.col(d.spaceCollection(space, 'entities'));
const edges = (space) => d.col(d.spaceCollection(space, 'edges'));

/** The records every space starts with: two people with a nick, a third, a fourth nothing names, and an edge between the first two. */
async function seedPeople(space) {
  // Shaped as a write stores them: the space they belong to (a delete and a triplet are read under it), a version, the edge's end kinds.
  const e = (id, name, properties = {}) => ({ _id: id, spaceId: space, name, type: 'person', properties, seq: 1, createdAt: STAMP, updatedAt: STAMP });
  await d.seed(space, 'entity', [e('e1', 'Ada', { nick: 'ada' }), e('e2', 'Bob', { nick: 'bob' }), e('e3', 'Cy'), e('e4', 'Dee')]);
  await d.seed(space, 'edge', [{ _id: 'k1', spaceId: space, from: 'e1', to: 'e2', fromKind: 'entity', toKind: 'entity', label: 'knows', properties: { note: 'old' }, seq: 1, createdAt: STAMP, updatedAt: STAMP }]);
}

describe('a SPARQL Update lands whole through the write rules, or is refused by its code', { skip }, () => {
  before(async () => {
    const people = { typeSchemas: PERSON_SCHEMA };
    d = await openSparqlDoors({
      suite: 'q761-update',
      spaces: [
        ...DOORS.map(door => ({ id: spaceOf(door), meta: rdfMeta(spaceOf(door), people) })),
        { id: STRICT, meta: rdfMeta(STRICT, { ...people, validationMode: 'strict' }) },
        { id: BOUNDS, meta: rdfMeta(BOUNDS, people) },
      ],
    });
    const links = await import('../../server/dist/brain/links-conversion.js');
    for (const s of [...DOORS.map(spaceOf), STRICT, BOUNDS]) { await seedPeople(s); await links.convertSpaceLinks(s); }
    // A token per door: an Update that deletes pays a destructive call, five a minute per caller.
    for (const t of [...DOORS, 'bounds']) tokens[t] = await d.mint(`spu-admin-${t}`, {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  for (const door of DOORS) {
    describe(`on the ${door} door`, () => {
      const S = spaceOf(door);
      const p = (prop) => vocab(S, `entity/person#${prop}`);
      const key = () => tokens[door].key;

      it('INSERT DATA makes a record under a minted id', async () => {
        const a = await d.sparqlUpdate(door, key(), S,
          `INSERT DATA { <${at(S, 'entity', 'brand-new')}> a <${Y}Entity>, <${vocab(S, 'entity/person')}> ; <${LABEL}> "Newcomer" }`);
        assert.equal(a.status, 200, fmt(a));
        const made = await entities(S).find({ name: 'Newcomer' }).toArray();
        assert.equal(made.length, 1, 'the inserted record is stored once');
        assert.notEqual(made[0]._id, 'brand-new', 'an address names no new identity: the id is minted');
      });

      it('DELETE DATA removes exactly the value it names', async () => {
        const a = await d.sparqlUpdate(door, key(), S, `DELETE DATA { <${at(S, 'entity', 'e1')}> <${p('nick')}> "ada" }`);
        assert.equal(a.status, 200, fmt(a));
        const e1 = await entities(S).findOne({ _id: 'e1' });
        assert.equal(e1.properties?.nick, undefined, 'the named value is still stored');
        assert.equal(e1.name, 'Ada', 'a value nobody named was changed');
        assert.equal((await entities(S).findOne({ _id: 'e2' })).properties?.nick, 'bob', 'another record was changed');
      });

      it('DELETE/INSERT WHERE renames a property across records', async () => {
        await entities(S).updateOne({ _id: 'e3' }, { $set: { 'properties.nick': 'cy' } });
        const a = await d.sparqlUpdate(door, key(), S, `DELETE { ?s <${p('nick')}> ?v } INSERT { ?s <${p('alias')}> ?v } WHERE { ?s <${p('nick')}> ?v }`);
        assert.equal(a.status, 200, fmt(a));
        for (const [id, v] of [['e2', 'bob'], ['e3', 'cy']]) {
          const e = await entities(S).findOne({ _id: id });
          assert.equal(e.properties?.alias, v, `${id} was not given the renamed property`);
          assert.equal(e.properties?.nick, undefined, `${id} still holds the old property`);
        }
      });

      it('an edge annotation is changed in place', async () => {
        const note = vocab(S, 'edge/knows#note');
        const a = await d.sparqlUpdate(door, key(), S,
          `DELETE DATA { <${at(S, 'edge', 'k1')}> <${note}> "old" } ; INSERT DATA { <${at(S, 'edge', 'k1')}> <${note}> "new" }`);
        assert.equal(a.status, 200, fmt(a));
        const k1 = await edges(S).find({}).toArray();
        assert.equal(k1.length, 1, 'the edge was written twice or lost');
        assert.deepEqual([k1[0]._id, k1[0].properties?.note], ['k1', 'new']);
      });

      it('an Update deleting an entity still referenced is refused, naming its blockers', async () => {
        const a = await d.sparqlUpdate(door, key(), S, `DELETE WHERE { <${at(S, 'entity', 'e2')}> ?p ?o }`);
        assert.equal(a.code, 'sparql_update_referenced', fmt(a));
        if (door !== 'mcp') assert.equal(a.status, 409, fmt(a));
        assert.ok(a.text.includes('k1'), `the refusal does not name the edge that blocks it: ${fmt(a)}`);
        assert.ok(await entities(S).findOne({ _id: 'e2' }), 'the referenced entity was deleted');
      });

      it('an entity nothing names is deleted, behind its tombstone', async () => {
        const a = await d.sparqlUpdate(door, key(), S, `DELETE WHERE { <${at(S, 'entity', 'e4')}> ?p ?o }`);
        assert.equal(a.status, 200, fmt(a));
        assert.equal(await entities(S).findOne({ _id: 'e4' }), null, 'the entity is still stored');
        assert.ok(await d.col(d.spaceCollection(S, 'tombstones')).findOne({ _id: { $regex: 'e4' } }) ?? await d.col(d.spaceCollection(S, 'tombstones')).findOne({ recordId: 'e4' }), 'no tombstone was written');
      });

      it('a strict violation among valid statements lands nothing and names the statement and the rule', async () => {
        const a = await d.sparqlUpdate(door, key(), STRICT,
          `INSERT DATA { <${at(STRICT, 'entity', 'e1')}> <${LABEL}> "Renamed" . <${at(STRICT, 'entity', 'e2')}> <${vocab(STRICT, 'entity/person#age')}> "old" }`);
        assert.equal(a.code, 'sparql_update_refused', fmt(a));
        if (door !== 'mcp') assert.equal(a.status, 422, fmt(a));
        assert.ok(a.text.includes('e2'), `the refusal does not name the statement's record: ${fmt(a)}`);
        assert.ok(a.text.includes('age'), `the refusal does not name the rule's field: ${fmt(a)}`);
        assert.equal((await entities(STRICT).findOne({ _id: 'e1' })).name, 'Ada', 'a valid statement of the refused Update landed');
      });
    });
  }

  describe('its bounds and its endings', () => {
    const S = BOUNDS;
    const p = (prop) => vocab(S, `entity/person#${prop}`);
    const key = () => tokens.bounds.key;

    it('sparql.maxRecordsChanged is held to 1..5000 at load, and an Update past it is 413 sparql_too_many_changes naming the cap', async () => {
      const limits = await import('../../server/dist/config/sparql-limits.js');
      const group = await import('../../server/dist/brain/write-plan/write-group.js');
      assert.throws(() => limits.validateSparqlLimits({ sparql: { maxRecordsChanged: 0 } }), /maxRecordsChanged/);
      assert.throws(() => limits.validateSparqlLimits({ sparql: { maxRecordsChanged: group.GROUP_MAX_RECORDS + 1 } }), /maxRecordsChanged/);
      limits.validateSparqlLimits({ sparql: { maxRecordsChanged: group.GROUP_MAX_RECORDS } });
      await d.loader.mutateConfig(cfg => { cfg.sparql = { ...(cfg.sparql ?? {}), maxRecordsChanged: 2 }; });
      try {
        const a = await d.sparqlUpdate('rest', key(), S, `INSERT DATA { ${['e1', 'e2', 'e3'].map(id => `<${at(S, 'entity', id)}> <${p('age')}> 7 .`).join(' ')} }`);
        assert.equal(a.status, 413, fmt(a));
        assert.equal(a.code, 'sparql_too_many_changes', fmt(a));
        assert.ok(/\b2\b/.test(a.body?.error ?? ''), `the refusal does not name the cap: ${fmt(a)}`);
        assert.equal(await entities(S).countDocuments({ 'properties.age': 7 }), 0, 'a record of the refused Update landed');
      } finally {
        await d.loader.mutateConfig(cfg => { delete cfg.sparql.maxRecordsChanged; });
      }
    });

    it('a lost race is run again at most three times, then 409 naming the record that kept moving', async () => {
      const act = await import('../../server/dist/spaces/sparql-update-act.js');
      let runs = 0;
      act.setSparqlUpdateKnobsForTest({ beforeCommit: async () => { runs++; await entities(S).updateOne({ _id: 'e3' }, { $inc: { seq: 1 } }); } });
      try {
        const a = await d.sparqlUpdate('rest', key(), S, `INSERT DATA { <${at(S, 'entity', 'e3')}> <${p('nick')}> "raced" }`);
        assert.equal(a.status, 409, fmt(a));
        assert.equal(a.code, 'sparql_update_conflict', fmt(a));
        assert.equal(runs, 3, 'the Update was not run exactly three times');
        assert.deepEqual([a.body?.record?.kind, a.body?.record?.id], ['entity', 'e3'], fmt(a));
        assert.equal((await entities(S).findOne({ _id: 'e3' })).properties?.nick, undefined, 'a lost attempt landed');
      } finally {
        act.setSparqlUpdateKnobsForTest(null);
      }
    });

    it('an outcome nobody can read back is answered as itself, 503 write_group_outcome_unknown', async () => {
      const lost = await loseNextCommitReply(d.door.mongo);
      try {
        const a = await d.sparqlUpdate('rest', key(), S, `INSERT DATA { <${at(S, 'entity', 'e1')}> <${p('alias')}> "unknown" }`);
        assert.ok(lost.fired(), 'the commit reply was never lost: the case tested nothing');
        assert.equal(a.status, 503, fmt(a));
        assert.equal(a.code, 'write_group_outcome_unknown', fmt(a));
      } finally {
        lost.restore();
      }
    });

    it('an effect after the commit that failed answers 500 sparql_update_cascade_incomplete, naming it and what landed', async () => {
      const proto = Object.getPrototypeOf(d.col('probe'));
      const fault = await injectStoreFault(proto, ['deleteMany', 'updateMany', 'bulkWrite'], d.spaceCollection(S, 'embedJobs'));
      let a;
      try {
        a = await d.sparqlUpdate('rest', key(), S, `DELETE WHERE { <${at(S, 'entity', 'e4')}> ?p ?o }`);
      } finally {
        fault.restore();
      }
      assert.ok(fault.fired() > 0, 'no effect after the commit reached the faulted collection: the case tested nothing');
      assert.equal(a.status, 500, fmt(a));
      assert.equal(a.code, 'sparql_update_cascade_incomplete', fmt(a));
      assert.ok(Array.isArray(a.body?.failedEffects) && a.body.failedEffects.length > 0, `the failed effect is not named: ${fmt(a)}`);
      assert.equal(a.body?.deleted?.entity, 1, `what landed is not said: ${fmt(a)}`);
      assert.equal(await entities(S).findOne({ _id: 'e4' }), null, 'the delete did not land');
    });
  });
});
