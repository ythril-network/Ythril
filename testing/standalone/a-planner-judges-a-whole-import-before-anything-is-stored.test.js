/**
 * The write planners judge a whole import before anything is stored (bundle-270, slice S4; plan section 3 (b) and (c), amendments A2, A4).
 *
 * ## The rule
 *
 * An import into a strict space is all or nothing, so every record is planned once without writing (the dry plan) and committed afterwards.
 * For that the planners take three things no request can hand them:
 *
 *  - a MINTED ID (`trustedPlan(spaceId, { mintedId })`): the record is inserted under it, and a second plan with the same id converges on it.
 *    A request's `id` still only addresses (`plan-entity.ts`, ID IS ID); the minted one is the instance's own;
 *  - a PLAN SCHEMA (`planMetaFor(spaceId, typeSchemas)`): the type schemas the import proposes judge in place of the stored ones, through every
 *    question a planner asks of them (a type's rules, whether a label is one-only) and the stamp the record carries, so a record is never judged
 *    by one schema and stamped with another;
 *  - a SEEDED READ SET (`ReadSet.seed`): a record that exists only in the import counts as present for an edge or a link that names it, and
 *    anything neither stored nor seeded is still absent, never guessed. An id nobody loaded or seeded still throws (the read set's own rule).
 *
 * The dry plan (`dryPlan`) answers every refusal with its reason and writes nothing; it also refuses a record at its version ceiling, which the
 * commit would refuse after the dry plan passed it (the amendments' last section). What a converge would change is computable without writing
 * (`convergeChanges`), so a caller can pass the stored fields it must keep (A4).
 *
 * The trusted arguments are unreachable from a request: `PlanTrust` is constructed only by `trustedPlan`, and the last case holds that no server
 * source outside the write planners and the RDF import names it.
 *
 * ## Red on the unchanged tree (1c41ddf04)
 *
 * `server/dist/brain/write-plan/trust.js`, `dry-plan.js` and `converge-changes.js` do not exist and `ReadSet` has no `seed`, so the module
 * imports fail and every case is red.
 *
 * Run: node --test testing/standalone/a-planner-judges-a-whole-import-before-anything-is-stored.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, SERVER_CODE_ROOTS, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SPACE = 'import-space';
const OTHER = 'other-space';
const S = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const T2 = '33333333-3333-4333-8333-333333333333';
const NOWHERE = '44444444-4444-4444-8444-444444444444';
const M = '55555555-5555-4555-8555-555555555555';
const STORED = '66666666-6666-4666-8666-666666666666';

/** The stored schema: strict, strict linkage, a person type with no rule and a label that is NOT one-only. */
const STORED_TYPES = { entity: { person: {} }, edge: { manages: {} } };
/** What the import proposes: `manages` one-only, and a person must state `born`. */
const PROPOSED_TYPES = {
  entity: { person: { propertySchemas: { born: { type: 'string', required: true } } } },
  edge: { manages: { functional: true } },
};

let dir;
let ReadSet, trustedPlan, PlanTrust, dryPlan, convergeChanges, planEntity, entityWant;
let planMetaFor, readMetaForWrite, SCHEMA_FINGERPRINT_FIELD, MAX_INGEST_SEQ;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ythril-import-plan-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'i-1', instanceLabel: 'Test', tokens: [], networks: [],
    spaces: [
      { id: SPACE, label: 'Import', folders: [], meta: { validationMode: 'strict', strictLinkage: true, typeSchemas: STORED_TYPES } },
      { id: OTHER, label: 'Other', folders: [], meta: { validationMode: 'strict', typeSchemas: STORED_TYPES } },
    ],
  }), 'utf8');
  // Imported AFTER CONFIG_PATH is set: the loader reads it once, at module load.
  process.env['CONFIG_PATH'] = cfgPath;
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
  ({ trustedPlan, PlanTrust } = await import('../../server/dist/brain/write-plan/trust.js'));
  ({ dryPlan } = await import('../../server/dist/brain/write-plan/dry-plan.js'));
  ({ convergeChanges } = await import('../../server/dist/brain/write-plan/converge-changes.js'));
  ({ planEntity, entityWant } = await import('../../server/dist/brain/write-plan/plan-entity.js'));
  planners = {
    entity: { want: entityWant, plan: planEntity },
    fact: await import('../../server/dist/brain/write-plan/plan-fact.js').then(m => ({ want: m.factWant, plan: m.planFact })),
    chrono: await import('../../server/dist/brain/write-plan/plan-chrono.js').then(m => ({ want: m.chronoWant, plan: m.planChrono })),
    edge: await import('../../server/dist/brain/write-plan/plan-edge.js')
      .then(m => ({ want: (input, trust) => m.edgeWant(SPACE, input, undefined, trust), plan: m.planEdge })),
  };
  ({ planMetaFor, readMetaForWrite, SCHEMA_FINGERPRINT_FIELD } = await import('../../server/dist/spaces/schema-stamp.js'));
  ({ MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

let planners;
/** The dry plan of `{ kind, input, trust }` items, each carrying its own planner call with its trusted arguments, as an importer builds them. */
const planAll = (items, view) => dryPlan(items.map(({ kind, input, trust }) => ({
  kind, input, want: planners[kind].want(input, trust), plan: (v) => planners[kind].plan(SPACE, input, v, trust),
})), view);

/** A read set over no database: every by-id read answers with what `stored` holds for the ids asked, nothing else. */
const viewOver = (stored = []) => new ReadSet(SPACE, async (_coll, ids) => stored.filter(d => ids.includes(d._id)));

const person = (name, extra = {}) => ({ name, type: 'person', tags: [], properties: {}, ...extra });
const edge = (from, to) => ({ from, to, label: 'manages', opts: { fromKind: 'entity', toKind: 'entity' } });

describe('a plan schema judges in place of the stored one', () => {
  it('a label one-only only in the plan schema refuses the second edge of a subject in the dry plan, and only that one', async () => {
    const planMeta = planMetaFor(SPACE, PROPOSED_TYPES);
    const trust = trustedPlan(SPACE, { planMeta });
    const items = [{ kind: 'edge', input: edge(S, T1), trust }, { kind: 'edge', input: edge(S, T2), trust }];

    const view = viewOver();
    await view.seed('entity', [{ _id: S, type: 'person' }, { _id: T1, type: 'person' }, { _id: T2, type: 'person' }]);
    const { refusals, plans } = await planAll(items, view);
    assert.deepEqual(refusals.map(r => r.index), [1], `the second edge of ${S} under the one-only label is the refusal: ${JSON.stringify(refusals)}`);
    assert.match(refusals[0].reason, /functional|one/i);
    assert.equal(plans[0]?.op, 'insert');

    // The same items under the STORED schema pass: it is the plan schema that refused, not the store.
    const stored = viewOver();
    await stored.seed('entity', [{ _id: S, type: 'person' }, { _id: T1, type: 'person' }, { _id: T2, type: 'person' }]);
    const control = await planAll(items.map(i => ({ kind: i.kind, input: i.input })), stored);
    assert.deepEqual(control.refusals, [], 'the stored schema has no one-only label, so neither edge is refused by it');
  });

  it('a type rule only in the plan schema refuses a record the stored schema takes', async () => {
    const trust = trustedPlan(SPACE, { planMeta: planMetaFor(SPACE, PROPOSED_TYPES) });
    const { refusals } = await planAll([{ kind: 'entity', input: person('Ada'), trust: trustedPlan(SPACE, { planMeta: trust.planMeta, mintedId: M }) }], viewOver());
    assert.equal(refusals.length, 1, 'a person without `born` is refused by the proposed schema');
    assert.match(refusals[0].reason, /born/);
    const control = await planAll([{ kind: 'entity', input: person('Ada'), trust: trustedPlan(SPACE, { mintedId: M }) }], viewOver());
    assert.deepEqual(control.refusals, []);
  });

  it('the plan schema reaches the stamp: the planned record carries the proposed schema\'s fingerprint, never the stored one', async () => {
    const planMeta = planMetaFor(SPACE, PROPOSED_TYPES);
    const input = person('Ada', { properties: { born: '1815' } });
    const view = viewOver();
    const trust = trustedPlan(SPACE, { planMeta, mintedId: M });
    await view.load(entityWant(input, trust));
    const { plan } = await planEntity(SPACE, input, view, trust);
    assert.equal(plan.doc[SCHEMA_FINGERPRINT_FIELD], planMeta.stamp.fp);
    assert.notEqual(planMeta.stamp.fp, readMetaForWrite(SPACE).stamp.fp, 'the fixture\'s two schemas must differ');
  });
});

describe('a seeded read set knows the records the import brings', () => {
  it('an edge whose end exists only in the seeded set is planned; one whose end is nowhere is refused under strict linkage', async () => {
    const view = viewOver();
    await view.seed('entity', [{ _id: S, type: 'person' }, { _id: T1, type: 'person' }]);
    const { refusals, plans } = await planAll([{ kind: 'edge', input: edge(S, T1) }, { kind: 'edge', input: edge(S, NOWHERE) }], view);
    assert.equal(plans[0]?.op, 'insert', 'the edge between two seeded records is planned');
    assert.deepEqual(refusals.map(r => r.index), [1]);
    assert.ok(refusals[0].reason.includes(NOWHERE), `the refusal names the end that is nowhere: ${refusals[0].reason}`);
  });

  it('an id neither loaded nor seeded still throws, as it always did', () => {
    assert.throws(() => viewOver().stored('entity', NOWHERE), /never loaded/);
  });

  it('a seed that names a stored record is refused: it would hide the stored record from every plan', async () => {
    const view = viewOver([{ _id: STORED, spaceId: SPACE, name: 'Kept', type: 'person', seq: 3 }]);
    await assert.rejects(view.seed('entity', [{ _id: STORED, type: 'person' }]), /stored/);
  });
});

describe('a trusted minted id', () => {
  it('inserts under the minted id, and a second plan with the same id converges on it', async () => {
    const view = viewOver();
    const trust = trustedPlan(SPACE, { mintedId: M });
    await view.load(entityWant(person('Ada'), trust));
    const first = await planEntity(SPACE, person('Ada'), view, trust);
    assert.equal(first.plan.op, 'insert');
    assert.equal(first.plan.id, M);
    assert.equal(first.plan.doc._id, M);
    const second = await planEntity(SPACE, person('Ada', { description: 'again' }), view, trust);
    assert.equal(second.plan.op, 'converge');
    assert.equal(second.plan.id, M);
  });

  it('a seeded minted id is still inserted by its own plan (the seed is what others see, not a stored record)', async () => {
    const view = viewOver();
    await view.seed('entity', [{ _id: M, type: 'person' }]);
    const trust = trustedPlan(SPACE, { mintedId: M });
    await view.load(entityWant(person('Ada'), trust));
    const { plan } = await planEntity(SPACE, person('Ada'), view, trust);
    assert.equal(plan.op, 'insert');
    assert.equal(plan.id, M);
  });

  it('is refused when it is not a UUID v4, when it comes with a request id, and the plan schema of another space is refused', async () => {
    assert.throws(() => trustedPlan(SPACE, { mintedId: 'not-a-uuid' }), /UUID/);
    assert.throws(() => new PlanTrust(), /trustedPlan/);
    const view = viewOver();
    const trust = trustedPlan(SPACE, { mintedId: M });
    await view.load({ records: { entity: [M, STORED] } });
    await assert.rejects(planEntity(SPACE, person('Ada', { id: STORED }), view, trust), /minted/);
    // A plan schema is judged by the one read every write makes (`readMetaForWrite`), which takes only a pair made for its own space.
    const plan = (planMeta) => planEntity(SPACE, person('Ada'), view, trustedPlan(SPACE, { planMeta, mintedId: M }));
    await assert.rejects(plan(planMetaFor(OTHER, PROPOSED_TYPES)), /other-space/);
    await assert.rejects(plan({ meta: {}, stamp: { fp: 'x', text: '' } }), /planMetaFor/);
  });
});

describe('the dry plan', () => {
  it('answers every refusal with its reason, in item order, and plans the rest', async () => {
    const view = viewOver();
    await view.seed('entity', [{ _id: S, type: 'person' }]);
    const items = [
      { kind: 'fact', input: { fact: 'x'.repeat(50_001) } },
      // An import mints every new record's id, so its entities ask the store for nothing by name.
      { kind: 'entity', input: person('Ada'), trust: trustedPlan(SPACE, { mintedId: M }) },
      { kind: 'edge', input: edge(S, NOWHERE) },
      { kind: 'fact', input: { fact: 'fine', linkEntities: [S] }, trust: trustedPlan(SPACE, { mintedId: T1 }) },
      { kind: 'entity', input: person('Bob', { tags: Array.from({ length: 101 }, (_, i) => `t${i}`) }), trust: trustedPlan(SPACE, { mintedId: T2 }) },
    ];
    const { refusals, plans } = await planAll(items, view);
    assert.deepEqual(refusals.map(r => r.index), [0, 2, 4]);
    for (const r of refusals) assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `refusal ${r.index} has no reason`);
    assert.match(refusals[0].reason, /50 000/);
    assert.match(refusals[2].reason, /tags/);
    assert.equal(plans[1]?.op, 'insert');
    assert.equal(plans[3]?.op, 'insert');
    assert.equal(plans[0], null);
  });

  it('refuses a converge onto a record at its version ceiling, as the commit would after the dry plan passed it', async () => {
    const view = viewOver([{ _id: STORED, spaceId: SPACE, name: 'Old', type: 'person', tags: [], properties: {}, seq: MAX_INGEST_SEQ }]);
    const { refusals } = await planAll([{ kind: 'entity', input: person('Old', { id: STORED }) }], view);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].code, 'record_version_at_ceiling');
  });
});

describe('what a converge would change is computable without writing', () => {
  it('names the stored fields a converge overwrites and the links it takes away, and nothing it keeps', async () => {
    const stored = { _id: STORED, spaceId: SPACE, name: 'Old', type: 'person', tags: ['a'], properties: { k: 'v' }, description: 'd', seq: 4 };
    const view = viewOver([stored]);
    const input = person('New', { id: STORED, tags: ['b'] });
    await view.load(entityWant(input));
    const { plan } = await planEntity(SPACE, input, view);
    const changes = convergeChanges(stored, plan);
    assert.deepEqual(changes.changed, ['name', 'tags'], JSON.stringify(changes));
    assert.deepEqual(changes.removed, [], 'tags merge and properties merge: nothing stored is taken away');

    const fact = { _id: M, spaceId: SPACE, fact: 'f', tags: [], seq: 2 };
    const withLinks = convergeChanges(fact, { kind: 'fact', op: 'converge', id: M, set: { fact: 'f' }, unset: {}, result: fact,
      links: { fromKind: 'fact', desired: { entity: [S] }, author: { instanceId: 'i-1' } } }, { entity: [S, T1] });
    assert.deepEqual(withLinks.linksTakenAway, { entity: [T1] });
  });
});

describe('the trusted arguments are unreachable from a request', () => {
  it('no server source outside the write planners and the RDF import names trustedPlan or PlanTrust', () => {
    const allowed = (f) => f.startsWith('server/src/brain/write-plan/') || f.startsWith('server/src/rdf/');
    const offenders = trackedSources(SERVER_CODE_ROOTS, { untracked: true })
      .filter(f => !allowed(f))
      .filter(f => /\b(trustedPlan|PlanTrust)\b/.test(stripComments(readFileSync(path.join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(offenders, [], 'a door that can build the trusted arguments can mint an id from a request');
    // The rule must have a subject: the factory exists where the scan expects it.
    assert.match(readFileSync(path.join(REPO_ROOT, 'server/src/brain/write-plan/trust.ts'), 'utf8'), /export function trustedPlan\b/);
  });
});
