/**
 * A planner takes a minted id only from the instance, and a dry plan writes nothing (bundle-270, slice S4; plan section 5, S4's spec).
 *
 * ## The rule
 *
 * ID IS ID (owner ruling, 2026-08-12; `04d-brain-ops-api.md`): a supplied id addresses an existing record and never becomes a new record's
 * identity. The RDF import needs the commit pass to be idempotent, so it mints each new record's id once and persists it: the planners take
 * that id as a TRUSTED argument (`trustedPlan(spaceId, { mintedId })`), passed by code and never read from a request body. Against the real
 * store:
 *
 *  - a trusted minted id is inserted under that id, and a second plan with the same id converges on the stored record (one record, the second
 *    plan's content), for each kind that mints (fact, entity, chrono);
 *  - at each door that takes an `id` (the entity, fact and chrono writers the REST and MCP doors call, and the bulk import), a body's id that
 *    names nothing is still not the new record's identity;
 *  - a dry plan of a whole import (`dryPlan`) writes nothing: every record collection holds what it held, and no minted id is stored.
 *
 * ## Red on the unchanged tree (1c41ddf04)
 *
 * `server/dist/brain/write-plan/trust.js` and `dry-plan.js` do not exist; the module import fails and every case is red (the door cases
 * included: they share the file's setup, and they hold the line this slice must not move).
 *
 * Run: in-docker.sh --own-db node --test testing/standalone/a-planner-takes-a-minted-id-only-from-the-instance-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-minted-id-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const M = 'abcdef01-2345-4678-8abc-def012345678';
const NAMES_NOTHING = 'fedcba98-7654-4321-8fed-cba987654321';
const RECORD_COLLECTIONS = ['facts', 'entities', 'chrono', 'edges', 'links', 'embed_jobs'];

let mongo, ReadSet, commitPlans, trustedPlan, dryPlan, plan, ents, facts, chrono, bulk;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('a planner takes a minted id only from the instance', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('mintedid');
    const loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'minted-id-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
    ({ commitPlans } = await import('../../server/dist/brain/write-plan/commit.js'));
    ({ trustedPlan } = await import('../../server/dist/brain/write-plan/trust.js'));
    ({ dryPlan } = await import('../../server/dist/brain/write-plan/dry-plan.js'));
    const pe = await import('../../server/dist/brain/write-plan/plan-entity.js');
    const pf = await import('../../server/dist/brain/write-plan/plan-fact.js');
    const pc = await import('../../server/dist/brain/write-plan/plan-chrono.js');
    plan = {
      entity: { want: pe.entityWant, plan: pe.planEntity, input: (d) => ({ name: 'Ada', type: 'person', description: d }), coll: 'entities' },
      fact: { want: pf.factWant, plan: pf.planFact, input: (d) => ({ fact: 'the fact', description: d }), coll: 'facts' },
      chrono: {
        want: pc.chronoWant, plan: pc.planChrono, coll: 'chrono',
        input: (d) => ({ fields: { title: 'the entry', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', description: d } }),
      },
    };
    ents = await import('../../server/dist/brain/entities.js');
    facts = await import('../../server/dist/brain/fact.js');
    chrono = await import('../../server/dist/brain/chrono.js');
    bulk = await import('../../server/dist/brain/bulk.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of [...RECORD_COLLECTIONS, 'tombstones']) await coll(c).deleteMany({});
  });

  /** Plan one record against a fresh read of the store and commit it, as `planAndCommitOne` does. */
  async function planAndCommit(kind, input, trust) {
    const view = new ReadSet(SPACE);
    await view.load(plan[kind].want(input, trust));
    const planned = await plan[kind].plan(SPACE, input, view, trust);
    const [outcome] = await commitPlans(SPACE, [planned.plan]);
    assert.ok(outcome.ok, `the ${kind} plan did not land: ${outcome.reason}`);
    return planned.plan;
  }

  for (const kind of ['entity', 'fact', 'chrono']) {
    it(`a trusted minted id inserts a ${kind} under that id, and a second plan with the same id converges on it`, async () => {
      const trust = trustedPlan(SPACE, { mintedId: M });
      const first = await planAndCommit(kind, plan[kind].input('first'), trust);
      assert.equal(first.op, 'insert');
      assert.deepEqual((await coll(plan[kind].coll).find({}).toArray()).map(d => d._id), [M]);

      const second = await planAndCommit(kind, plan[kind].input('second'), trustedPlan(SPACE, { mintedId: M }));
      assert.equal(second.op, 'converge');
      const stored = await coll(plan[kind].coll).find({}).toArray();
      assert.deepEqual(stored.map(d => d._id), [M], 'the second plan made a second record');
      assert.equal(stored[0].description, 'second');
    });
  }

  describe('a request body\'s id still only addresses, at each door that takes one', () => {
    it('the entity writer', async () => {
      const { entity } = await ents.upsertEntity(SPACE, 'Ada', 'person', [], {}, undefined, NAMES_NOTHING);
      assert.notEqual(entity._id, NAMES_NOTHING);
      assert.equal(await coll('entities').countDocuments({ _id: NAMES_NOTHING }), 0);
    });

    it('the fact writer', async () => {
      const fact = await facts.saveFact(SPACE, 'a fact', [], [], undefined, undefined, undefined, undefined, undefined, undefined, NAMES_NOTHING);
      assert.notEqual(fact._id, NAMES_NOTHING);
      assert.equal(await coll('facts').countDocuments({ _id: NAMES_NOTHING }), 0);
    });

    it('the chrono writer', async () => {
      const entry = await chrono.createChrono(SPACE, { title: 'e', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', id: NAMES_NOTHING });
      assert.notEqual(entry._id, NAMES_NOTHING);
      assert.equal(await coll('chrono').countDocuments({ _id: NAMES_NOTHING }), 0);
    });

    it('the bulk import', async () => {
      await bulk.bulkWrite(SPACE, {
        entities: [{ name: 'Ada', type: 'person', id: NAMES_NOTHING }],
        facts: [{ fact: 'a fact', id: NAMES_NOTHING }],
        chrono: [{ title: 'e', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', id: NAMES_NOTHING }],
      });
      for (const c of ['entities', 'facts', 'chrono']) {
        assert.equal(await coll(c).countDocuments({}), 1, `the bulk ${c} item was not written`);
        assert.equal(await coll(c).countDocuments({ _id: NAMES_NOTHING }), 0, `the bulk ${c} item took the body's id`);
      }
    });
  });

  it('a dry plan of a whole import writes nothing', async () => {
    const { entity: kept } = await ents.upsertEntity(SPACE, 'Kept', 'person');
    const before = {};
    for (const c of RECORD_COLLECTIONS) before[c] = await coll(c).find({}).toArray();

    const view = new ReadSet(SPACE);
    await view.seed('entity', [{ _id: M, type: 'person' }]);
    const items = [
      { kind: 'entity', input: { name: 'New', type: 'person' }, trust: trustedPlan(SPACE, { mintedId: M }) },
      { kind: 'entity', input: { name: 'Kept again', type: 'person', id: kept._id } },
      { kind: 'fact', input: { fact: 'about both', linkEntities: [M, kept._id] } },
      { kind: 'edge', input: { from: M, to: kept._id, label: 'knows' } },
    ];
    const { planEdge, edgeWant } = await import('../../server/dist/brain/write-plan/plan-edge.js');
    const planners = { ...plan, edge: { want: (input, trust) => edgeWant(SPACE, input, undefined, trust), plan: planEdge } };
    // Each item carries its own planner call with its trusted arguments, as an importer builds them.
    const { refusals, plans } = await dryPlan(items.map(({ kind, input, trust }) => ({
      kind, input, want: planners[kind].want(input, trust), plan: (v) => planners[kind].plan(SPACE, input, v, trust),
    })), view);
    assert.deepEqual(refusals, []);
    assert.deepEqual(plans.map(p => p.op), ['insert', 'converge', 'insert', 'insert'], 'the fixture must plan an insert and a converge of each shape');

    for (const c of RECORD_COLLECTIONS) {
      assert.deepEqual(await coll(c).find({}).toArray(), before[c], `the dry plan wrote to ${c}`);
    }
    assert.equal(await coll('entities').countDocuments({ _id: M }), 0);
  });
});
