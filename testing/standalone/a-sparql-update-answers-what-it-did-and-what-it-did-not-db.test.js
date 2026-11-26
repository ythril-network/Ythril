/**
 * A SPARQL Update answers what it did and what it did not, and never concludes from a record other than the one stored (bundle-272, Q-761,
 * the review of 96be09a1c: B1, B3, B4, B5, B10, the data-integrity gap of lens A, the reliability and metric specs lens A and B asked for).
 *
 * ## The rules
 *
 * 1. **A removal the record does not hold is a no-op** (B1, amending design-r2 R5): an ordinary template `DELETE { ?s :p "x" } WHERE { ... }`
 *    instantiates a statement for every match, held or not. It is stale only when its record's stored version differs from the one the
 *    evaluation read, or the record was read and is gone (B10).
 * 2. **A record planned at another version than the evaluation read is a lost race**, also when it moved between the first read of the
 *    records a change set names and the planners' own read (the data-integrity gap).
 * 3. **The answer says which statements were not taken** (B3): `statements` counts `taken`, `noops` and `notTaken`; `inserted` and `removed`
 *    count only what was taken; `reasons` names a statement a warn-mode space dropped, by its subject and predicate and the value's kind.
 * 4. **A lost attempt is one record of one cause** (B4): the final 409 names what the last attempt lost to, never a mix of attempts.
 * 5. **An Update that throws is counted and audited** (B5): outcome `failed`, one audit row of counts.
 * 6. **An edge's asserted triple is never removed silently**: removing it is refused with a named reason (the edge is deleted by deleting
 *    its record), and an edge deleted by its record is gone.
 * 7. **The endings the review found unspecified**: a shutdown between attempts (`shutting_down`), the budget that does not cover another
 *    attempt, the busy slot (`sparql_busy`), the destructive-call limit (`429 sparql_update_rate_limited`), the counter `ythril_sparql_update_total`.
 *
 * ## Seen red
 *
 * On 96be09a1c: rule 1 answers `409 sparql_update_conflict` after three runs; rule 2 lands at the newer version (1 attempt); rule 3 has no
 * `notTaken` and counts the dropped statement as inserted; rule 4 names `lostAt: 'stale'`; rule 5 writes a row without an outcome and counts
 * nothing; rule 6 answers 200 and removes nothing. Rules 7 are green there and are shown by a mutation of the built server (their each case fails).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-update-answers-what-it-did-and-what-it-did-not-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const DOORS = ['rest', 'mcp', 'tool'];
const S = 'spr-main';
const OP = 'brain.sparql_update';
const STAMP = '2026-03-04T05:06:07.000Z';
const at = (kind, id) => `${baseOf(S)}${kind}/${id}`;
const vocab = (rest) => `${baseOf(S)}vocab/${rest}`;
const p = (prop) => vocab(`entity/person#${prop}`);
const PERSON_SCHEMA = { entity: { person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' }, alias: { type: 'string' } } } }, edge: { knows: { propertySchemas: { note: { type: 'string' } } } } };

let d, act, planModule, metrics;
const tokens = {};
const fmt = (a) => `${a.door} ${a.status} ${a.code} ${(a.text ?? '').slice(0, 500)}`;
const entities = () => d.col(d.spaceCollection(S, 'entities'));
const edges = () => d.col(d.spaceCollection(S, 'edges'));
const fields = (row) => Object.fromEntries((row.changes ?? []).map(c => [c.field, c.to]));
const counterOf = async (outcome) => ((await metrics.sparqlUpdateTotal.get()).values.find(v => v.labels.outcome === outcome)?.value ?? 0);

/** The records every case starts from: people with nicks, one without, loose ones to delete, and an edge between the first two. */
async function seed() {
  await entities().deleteMany({});
  await edges().deleteMany({});
  const e = (id, name, properties = {}) => ({ _id: id, spaceId: S, name, type: 'person', properties, seq: 1, createdAt: STAMP, updatedAt: STAMP });
  await d.seed(S, 'entity', [e('e1', 'Ada', { nick: 'ada' }), e('e2', 'Bob', { nick: 'bob' }), e('e3', 'Cy'), e('e4', 'Dee'),
    ...[1, 2, 3, 4, 5, 6].map(i => e(`z${i}`, `Zed ${i}`))]);
  await d.seed(S, 'edge', [{ _id: 'k1', spaceId: S, from: 'e1', to: 'e2', label: 'knows', properties: { note: 'old' }, seq: 1, createdAt: STAMP, updatedAt: STAMP }]);
}

describe('a SPARQL Update answers what it did and what it did not', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q761-answers', spaces: [{ id: S, meta: rdfMeta(S, { typeSchemas: PERSON_SCHEMA }) }] });
    act = await import('../../server/dist/spaces/sparql-update-act.js');
    planModule = await import('../../server/dist/rdf/sparql-update-plan.js');
    metrics = await import('../../server/dist/metrics/sparql-update-metrics.js');
    // Converted AND marked (`completeLinkage`), as every space is after its first boot: a delete reads the links naming its record.
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'rate']) tokens[t] = await d.mint(`spr-admin-${t}`, {}, { admin: true });
  });
  after(async () => {
    act?.setSparqlUpdateKnobsForTest(null);
    planModule?.setPlanChangeSetKnobsForTest(null);
    await d?.close();
  });

  describe('a removal the record does not hold', () => {
    it('is a no-op on every door: an ordinary template DELETE of an absent value answers 200 in one run, changing nothing', async () => {
      await seed();
      for (const door of DOORS) {
        const a = await d.sparqlUpdate(door, tokens.a.key, S, `DELETE { ?s <${p('nick')}> "nobody" } WHERE { ?s <${p('nick')}> ?v }`);
        assert.equal(a.status, 200, fmt(a));
        assert.equal(a.body?.attempts, 1, `the Update ran more than once: ${fmt(a)}`);
        assert.equal(a.body?.recordsChanged, 0, fmt(a));
        assert.equal(a.body?.statements?.noops, 2, `the two statements no record holds are not counted as no-ops: ${fmt(a)}`);
        assert.equal(a.body?.statements?.removed, 0, fmt(a));
      }
      assert.deepEqual((await entities().find({ _id: { $in: ['e1', 'e2'] } }).sort({ _id: 1 }).toArray()).map(e => [e.properties?.nick, e.seq]), [['ada', 1], ['bob', 1]]);
    });

    it('beside a removal the record holds: the held one is taken, the absent one is a no-op', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', tokens.a.key, S, `DELETE { ?s <${p('nick')}> ?v . ?s <${p('alias')}> "nope" } WHERE { ?s <${p('nick')}> ?v }`);
      assert.equal(a.status, 200, fmt(a));
      assert.deepEqual([a.body?.statements?.removed, a.body?.statements?.noops, a.body?.statements?.taken], [2, 2, 2], fmt(a));
      assert.equal(await entities().countDocuments({ 'properties.nick': { $exists: true } }), 0, 'a held removal was not made');
    });

    it('is stale when its record was read and is gone: the whole Update runs again, and mints no record of what it read', async () => {
      await seed();
      let hooked = 0;
      act.setSparqlUpdateKnobsForTest({ afterEvaluation: async (attempt) => { if (attempt === 1) { hooked++; await entities().deleteOne({ _id: 'e1' }); } } });
      try {
        const a = await d.sparqlUpdate('rest', tokens.b.key, S, `INSERT { ?s <${p('alias')}> "x" } WHERE { ?s <${p('nick')}> ?v }`);
        assert.equal(hooked, 1, 'the record was never removed between the evaluation and the plan');
        assert.equal(a.status, 200, fmt(a));
        assert.equal(a.body?.attempts, 2, `a record read and removed was not taken for a lost race: ${fmt(a)}`);
        assert.deepEqual((await entities().find({ 'properties.alias': 'x' }).toArray()).map(e => e._id), ['e2'], 'a record was minted for the one that is gone');
      } finally {
        act.setSparqlUpdateKnobsForTest(null);
      }
    });
  });

  describe('a record planned at another version than the evaluation read', () => {
    it('is a lost race also when it moved between the first read and the planners\' own: the Update runs again', async () => {
      await seed();
      let moved = 0;
      planModule.setPlanChangeSetKnobsForTest({ betweenReads: async () => { if (moved++ === 0) await entities().updateOne({ _id: 'e3' }, { $inc: { seq: 1 } }); } });
      try {
        const a = await d.sparqlUpdate('rest', tokens.c.key, S, `DELETE WHERE { <${at('entity', 'e3')}> ?p ?o }`);
        assert.equal(a.status, 200, fmt(a));
        assert.equal(a.body?.attempts, 2, `the record was deleted at a version the Update did not read: ${fmt(a)}`);
        assert.ok(moved >= 2, 'the planner did not run again');
        assert.equal(await entities().findOne({ _id: 'e3' }), null, 'the delete did not land');
      } finally {
        planModule.setPlanChangeSetKnobsForTest(null);
      }
    });
  });

  describe('the answer', () => {
    it('counts what it took and names what a warn-mode space dropped, by subject and predicate, never its value', async () => {
      await seed();
      const dropped = 'http://elsewhere.example/unmapped';
      const a = await d.sparqlUpdate('rest', tokens.d.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('alias')}> "kept" . <${at('entity', 'e3')}> <${dropped}> "zq7valuemark" }`);
      assert.equal(a.status, 200, fmt(a));
      assert.deepEqual(a.body?.statements, { removed: 0, inserted: 1, taken: 1, noops: 0, notTaken: 1 }, fmt(a));
      const named = JSON.stringify(a.body?.reasons ?? []);
      assert.ok(named.includes(dropped), `the dropped statement's predicate is not named: ${fmt(a)}`);
      assert.ok(!a.text.includes('zq7valuemark'), `the answer repeats the dropped value: ${fmt(a)}`);
      assert.equal((await entities().findOne({ _id: 'e3' })).properties?.alias, 'kept');
    });

    it('an Update whose every statement was dropped lands nothing and says none was taken', async () => {
      await seed();
      const a = await d.sparqlUpdate('mcp', tokens.d.key, S, `INSERT DATA { <${at('entity', 'e3')}> <http://elsewhere.example/unmapped> "v" }`);
      assert.equal(a.status, 200, fmt(a));
      assert.deepEqual([a.body?.recordsChanged, a.body?.statements?.inserted, a.body?.statements?.notTaken], [0, 0, 1], fmt(a));
    });
  });

  describe('a lost attempt', () => {
    it('is one record of one cause: the final 409 names what the last attempt lost to, not a mix', async () => {
      await seed();
      let runs = 0;
      act.setSparqlUpdateKnobsForTest({
        // The first attempt loses at the commit (e3), the later ones in their evaluation (e4).
        beforeCommit: async () => { runs++; await entities().updateOne({ _id: 'e3' }, { $inc: { seq: 1 } }); },
        afterEvaluation: (attempt, changes) => { if (attempt > 1) changes.lostRace = { space: S, kind: 'entity', id: 'e4', seqs: [1, 2] }; },
      });
      try {
        const a = await d.sparqlUpdate('rest', tokens.e.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('nick')}> "raced" }`);
        assert.equal(a.status, 409, fmt(a));
        assert.equal(a.code, 'sparql_update_conflict', fmt(a));
        assert.equal(runs, 1, 'only the first attempt reaches its commit');
        assert.deepEqual([a.body?.lostAt, a.body?.record?.kind, a.body?.record?.id], ['evaluation', 'entity', 'e4'], fmt(a));
      } finally {
        act.setSparqlUpdateKnobsForTest(null);
      }
    });
  });

  describe('an Update that throws', () => {
    it('is counted failed and audited by its counts, on REST and MCP', async () => {
      await seed();
      const before_ = (await auditRowsOf(d.door.mongo, { operation: OP })).length;
      const counted = await counterOf('failed');
      act.setSparqlUpdateKnobsForTest({ beforeCommit: async () => { throw new Error('a defect nobody mapped'); } });
      let rest, mcp;
      try {
        rest = await d.sparqlUpdate('rest', tokens.f.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('nick')}> "boom" }`);
        mcp = await d.sparqlUpdate('mcp', tokens.f.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('nick')}> "boom" }`);
      } finally {
        act.setSparqlUpdateKnobsForTest(null);
      }
      assert.equal(rest.status, 500, fmt(rest));
      assert.equal(mcp.status, 'refused', fmt(mcp));
      assert.equal(await counterOf('failed'), counted + 2, 'the failed Updates were not counted');
      const rows = (await auditRowsOf(d.door.mongo, { operation: OP })).slice(before_);
      assert.equal(rows.length, 2, `rows of ${OP}: ${rows.length}`);
      for (const r of rows) {
        assert.deepEqual([fields(r).outcome, fields(r).attempts, fields(r).recordsChanged], ['failed', 1, 0], `${r.method}: ${JSON.stringify(fields(r))}`);
      }
    });
  });

  describe('an edge', () => {
    it('is deleted by deleting its record', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', tokens.g.key, S, `DELETE WHERE { <${at('edge', 'k1')}> ?p ?o }`);
      assert.equal(a.status, 200, fmt(a));
      assert.equal(a.body?.deleted?.edge, 1, fmt(a));
      assert.equal(await edges().countDocuments({}), 0, 'the edge is still stored');
    });

    it('is never changed silently by removing its asserted triple: the Update is refused, naming its reason, and the edge stays', async () => {
      await seed();
      const a = await d.sparqlUpdate('rest', tokens.g.key, S, `DELETE DATA { <${at('entity', 'e1')}> <${vocab('edge/knows')}> <${at('entity', 'e2')}> }`);
      assert.equal(a.status, 422, fmt(a));
      assert.equal(a.code, 'sparql_update_refused', fmt(a));
      assert.ok((a.body?.reasons ?? []).some(r => r.code === 'edge-ends-change'), `no reason names the edge: ${fmt(a)}`);
      assert.equal(await edges().countDocuments({ _id: 'k1' }), 1, 'the edge was removed');
    });
  });

  describe('its endings', () => {
    it('counts every ending in ythril_sparql_update_total by its outcome', async () => {
      await seed();
      const [landed, noUpdate] = [await counterOf('landed'), await counterOf('sparql_update_refused')];
      const ok = await d.sparqlUpdate('rest', tokens.a.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('alias')}> "counted" }`);
      const refused = await d.sparqlUpdate('rest', tokens.a.key, S, `DELETE DATA { <${at('entity', 'e1')}> <${vocab('edge/knows')}> <${at('entity', 'e2')}> }`);
      assert.equal(ok.status, 200, fmt(ok));
      assert.equal(refused.status, 422, fmt(refused));
      assert.equal(await counterOf('landed'), landed + 1, 'a landed Update was not counted');
      assert.equal(await counterOf('sparql_update_refused'), noUpdate + 1, 'a refused Update was not counted by its code');
    });

    it('a shutdown begun between attempts ends the Update as shutting_down, with nothing of it written', async () => {
      await seed();
      const lifecycle = await import('../../server/dist/lifecycle.js');
      let runs = 0;
      act.setSparqlUpdateKnobsForTest({ beforeCommit: async () => { runs++; await entities().updateOne({ _id: 'e3' }, { $inc: { seq: 1 } }); lifecycle.beginShutdown(); } });
      try {
        const a = await d.sparqlUpdate('rest', tokens.a.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('nick')}> "late" }`);
        assert.equal(a.status, 503, fmt(a));
        assert.equal(a.code, 'shutting_down', fmt(a));
        assert.equal(runs, 1, 'a second attempt started on a server that is shutting down');
        assert.equal((await entities().findOne({ _id: 'e3' })).properties?.nick, undefined, 'a record was written');
      } finally {
        act.setSparqlUpdateKnobsForTest(null);
        lifecycle.resetLifecycleForTests();
      }
    });

    it('an attempt starts only while the time left covers the last one: a budget it exceeds ends the Update after the run it had', async () => {
      await seed();
      let runs = 0;
      await d.loader.mutateConfig(cfg => { cfg.sparql = { ...(cfg.sparql ?? {}), timeoutMs: 1000 }; });
      act.setSparqlUpdateKnobsForTest({ beforeCommit: async () => { runs++; await new Promise(r => setTimeout(r, 700)); await entities().updateOne({ _id: 'e3' }, { $inc: { seq: 1 } }); } });
      try {
        const a = await d.sparqlUpdate('rest', tokens.a.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('nick')}> "slow" }`);
        assert.equal(a.status, 409, fmt(a));
        assert.equal(a.code, 'sparql_update_conflict', fmt(a));
        assert.equal(runs, 1, 'a second attempt started with less time left than the first took');
      } finally {
        act.setSparqlUpdateKnobsForTest(null);
        await d.loader.mutateConfig(cfg => { delete cfg.sparql.timeoutMs; });
      }
    });

    it('a second Update of one caller while one runs is 503 sparql_busy, and the first still lands', async () => {
      await seed();
      let held; const gate = new Promise(r => { held = r; });
      let reached; const inHook = new Promise(r => { reached = r; });
      act.setSparqlUpdateKnobsForTest({ beforeCommit: async () => { reached(); await gate; } });
      try {
        const first = d.sparqlUpdate('rest', tokens.a.key, S, `INSERT DATA { <${at('entity', 'e3')}> <${p('alias')}> "first" }`);
        await inHook;
        const second = await d.sparqlUpdate('rest', tokens.a.key, S, `INSERT DATA { <${at('entity', 'e4')}> <${p('alias')}> "second" }`);
        assert.equal(second.status, 503, fmt(second));
        assert.equal(second.code, 'sparql_busy', fmt(second));
        held();
        const landed = await first;
        assert.equal(landed.status, 200, fmt(landed));
        assert.equal((await entities().findOne({ _id: 'e4' })).properties?.alias, undefined, 'the refused Update wrote');
      } finally {
        held?.();
        act.setSparqlUpdateKnobsForTest(null);
      }
    });

    it('the sixth Update that deletes in a minute is 429 sparql_update_rate_limited, and deletes nothing', async () => {
      await seed();
      const statuses = [];
      for (let i = 1; i <= 6; i++) {
        const a = await d.sparqlUpdate('rest', tokens.rate.key, S, `DELETE WHERE { <${at('entity', `z${i}`)}> ?p ?o }`);
        statuses.push([a.status, a.code]);
      }
      assert.deepEqual(statuses.slice(0, 5).map(s => s[0]), [200, 200, 200, 200, 200], JSON.stringify(statuses));
      assert.deepEqual(statuses[5], [429, 'sparql_update_rate_limited'], JSON.stringify(statuses));
      assert.ok(await entities().findOne({ _id: 'z6' }), 'the refused Update deleted');
    });
  });
});
