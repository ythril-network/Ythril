/**
 * A SPARQL Update answers the write group's own refusals by their own codes, and counts only the writes that landed (bundle-272, Q-761,
 * the wiring of the fix round; design h, r2 R4, R8).
 *
 * ## The rules
 *
 * 1. **A record planned twice is `409 write_group_record_planned_twice`**, naming the record (`record: {kind, id}`), on every door. It is
 *    no lost race (never run again) and no `sparql_update_conflict`.
 * 2. **More link rows to remove than were counted before the session opened is `413 write_group_too_large`**, the code the group's own
 *    ceilings answer before a session (`WriteGroupTooLarge`), on every door; nothing is removed.
 * 3. **A delete the group drops is no landed write.** A batch that deletes an edge and plans the same triplet again writes ONE record,
 *    converged in place (the group drops the delete): `recordsChanged` is 1, `converged.edge` 1 and `deleted.edge` 0, the record is stored
 *    once and has no tombstone. No Update's text plans that pair, so the case hands the act that batch through its `afterPlan` seam.
 *
 * ## Seen red
 *
 * On baf6b9724: (1) the group's refusal is no `GroupAborted`, so it surfaces as a thrown error: a 500 with no code of the group's; (2) the
 * `too_large` abort is answered by the generic branch as `409 sparql_update_conflict`; (3) the answer counts the dropped delete:
 * `recordsChanged` 2 and `deleted.edge` 1 for one record written.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-update-answers-the-write-groups-refusals-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const DOORS = ['rest', 'mcp', 'tool'];
const S = 'spw-main';
const STAMP = '2026-03-04T05:06:07.000Z';
const at = (kind, id) => `${baseOf(S)}${kind}/${id}`;
const vocab = (rest) => `${baseOf(S)}vocab/${rest}`;
const PERSON_SCHEMA = { entity: { person: { propertySchemas: { nick: { type: 'string' } } } }, edge: { knows: { propertySchemas: { note: { type: 'string' } } } } };
const FACT = 'ffffffff-0000-4000-8000-000000000001';

let d, act;
const tokens = {};
const fmt = (a) => `${a.door} ${a.status} ${a.code} ${(a.text ?? '').slice(0, 500)}`;
const col = (kind) => d.col(d.spaceCollection(S, kind));

/** The records every case starts from: two people, a loose one, an edge between the first two, and a fact with two link rows. */
async function seed() {
  for (const k of ['entities', 'edges', 'facts', 'links', 'tombstones']) await col(k).deleteMany({});
  const e = (id, name, properties = {}) => ({ _id: id, spaceId: S, name, type: 'person', properties, seq: 1, createdAt: STAMP, updatedAt: STAMP });
  await d.seed(S, 'entity', [e('e1', 'Ada'), e('e2', 'Bob'), e('e4', 'Dee')]);
  await d.seed(S, 'edge', [{ _id: 'k1', spaceId: S, from: 'e1', to: 'e2', label: 'knows', properties: { note: 'old' }, seq: 1, createdAt: STAMP, updatedAt: STAMP }]);
  await d.seed(S, 'fact', [{ _id: FACT, spaceId: S, fact: 'a fact', entityIds: ['e1', 'e2'], author: { instanceId: 'x', instanceLabel: 'x' }, seq: 1, createdAt: STAMP, updatedAt: STAMP }]);
  await d.seed(S, 'link', await linkRows(['e1', 'e2']));
}

async function linkRows(entityIds) {
  const { linkIdFor } = await import('../../server/dist/brain/link-id.js');
  return entityIds.map(to => ({
    _id: linkIdFor(FACT, 'fact', to, 'entity'), spaceId: S, from: FACT, fromKind: 'fact', to, toKind: 'entity',
    author: { instanceId: 'x', instanceLabel: 'x' }, createdAt: STAMP, updatedAt: STAMP, seq: 1,
  }));
}

describe('a SPARQL Update answers the write group\'s refusals by their codes', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q761-wire', spaces: [{ id: S, meta: rdfMeta(S, { typeSchemas: PERSON_SCHEMA }) }] });
    act = await import('../../server/dist/spaces/sparql-update-act.js');
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    for (const door of DOORS) tokens[door] = await d.mint(`spw-admin-${door}`, {}, { admin: true });
  });
  after(async () => { act?.setSparqlUpdateKnobsForTest(null); await d?.close(); });

  for (const door of DOORS) {
    describe(`on the ${door} door`, () => {
      it('a record planned twice is 409 write_group_record_planned_twice, naming the record, and is not run again', async () => {
        await seed();
        let runs = 0;
        // An Update's own planner never plans a record twice, so a plan is added after the Update's planning, as a planner's defect would.
        act.setSparqlUpdateKnobsForTest({ afterPlan: (plans) => { runs++; return [...plans, plans[0]]; } });
        let a;
        try {
          a = await d.sparqlUpdate(door, tokens[door].key, S, `INSERT DATA { <${at('entity', 'e4')}> <${vocab('entity/person#nick')}> "dee" }`);
        } finally {
          act.setSparqlUpdateKnobsForTest(null);
        }
        assert.equal(runs, 1, 'the Update was run again, as a lost race is');
        assert.equal(a.code, 'write_group_record_planned_twice', fmt(a));
        if (door !== 'mcp') assert.equal(a.status, 409, fmt(a));
        assert.deepEqual([a.body?.record?.kind, a.body?.record?.id], ['entity', 'e4'], `the refusal does not name the record: ${fmt(a)}`);
        assert.equal((await col('entities').findOne({ _id: 'e4' })).properties?.nick, undefined, 'a record of the refused Update was written');
      });

      it('a link row written after the count aborts the group too large: 413 write_group_too_large, nothing removed', async () => {
        await seed();
        const [extra] = await linkRows(['e4']);
        const proto = Object.getPrototypeOf(col('links'));
        const countOriginal = proto.countDocuments;
        let armed = false;
        let planted = false;
        // Another writer's row lands right after the group counted the rows its delete removes, and before its transaction reads them.
        proto.countDocuments = async function plantAfterTheCount(...args) {
          const counted = await countOriginal.apply(this, args);
          if (armed && !planted && this.collectionName === d.spaceCollection(S, 'links')) { planted = true; await this.insertOne(extra); }
          return counted;
        };
        act.setSparqlUpdateKnobsForTest({ beforeCommit: async () => { armed = true; } });
        let a;
        try {
          a = await d.sparqlUpdate(door, tokens[door].key, S, `DELETE WHERE { <${at('fact', FACT)}> ?p ?o }`);
        } finally {
          proto.countDocuments = countOriginal;
          act.setSparqlUpdateKnobsForTest(null);
        }
        assert.ok(planted, 'fixture: no row was written after the count: the case tested nothing');
        assert.equal(a.code, 'write_group_too_large', fmt(a));
        if (door !== 'mcp') assert.equal(a.status, 413, fmt(a));
        assert.ok(await col('facts').findOne({ _id: FACT }), 'the fact of the refused Update was removed');
        assert.equal(await col('links').countDocuments({}), 3, 'a link row of the refused Update was removed');
      });

      it('an edge deleted and stated again is ONE record converged: the dropped delete is no landed write', async () => {
        await seed();
        const { ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js');
        const { planDelete } = await import('../../server/dist/brain/write-plan/plan-delete.js');
        const { planEdge, edgeWant } = await import('../../server/dist/brain/write-plan/plan-edge.js');
        // No Update's text plans a delete and a converge of one edge (a statement about a deleted record is refused `no-kind`), so the
        // planners are run as a batch that deletes the edge and states it again plans: the group drops the delete (`droppedDeletes`).
        let premise = '';
        act.setSparqlUpdateKnobsForTest({
          afterPlan: async (plans) => {
            premise = plans.map(p => `${p.op} ${p.kind} ${p.id}`).join(', ');
            const input = { from: 'e1', to: 'e2', label: 'knows', tags: ['new'] };
            const rs = new ReadSet(S);
            await rs.load({ records: { edge: ['k1'] }, triplets: [{ from: 'e1', to: 'e2', label: 'knows' }] });
            await rs.load(edgeWant(S, input));
            return [planDelete(rs, 'edge', 'k1'), (await planEdge(S, input, rs)).plan];
          },
        });
        let a;
        try {
          a = await d.sparqlUpdate(door, tokens[door].key, S, `DELETE WHERE { <${at('edge', 'k1')}> ?p ?o }`);
        } finally {
          act.setSparqlUpdateKnobsForTest(null);
        }
        assert.equal(premise, 'delete edge k1', 'fixture: the Update did not plan the delete of the edge');
        assert.equal(a.status, 200, fmt(a));
        const edges = await col('edges').find({}).toArray();
        assert.deepEqual(edges.map(e => [e._id, [...(e.tags ?? [])]]), [['k1', ['new']]], 'the edge is not stored once, converged');
        assert.equal(await col('tombstones').countDocuments({ _id: 'k1' }), 0, 'a tombstone was written for the edge that stayed');
        assert.deepEqual([a.body?.recordsChanged, a.body?.converged?.edge, a.body?.deleted?.edge, a.body?.inserted?.edge],
          [1, 1, 0, 0], `the answer counts a write the group dropped: ${fmt(a)}`);
      });
    });
  }
});
