/**
 * The four record planners take field removals and tag replacements, and judge the record they LEAVE (bundle-272, Q-962).
 *
 * ## The rule
 *
 * A converge merges: tags union, properties shallow-merge, so by itself it can never take anything away. SPARQL Update removes a property or one
 * tag, and it must do so through the planners every write uses, so one rule decides the record and the removal can join one transaction (Q-760).
 * So each planner (`planEntity`, `planFact`, `planChrono`, `planEdge`) takes, beside its fields:
 *
 *  - `deleteFields`: dot paths applied AFTER the merge by `applyDeleteFields`, a whole removed field carried in the plan's `unset`, a pruned one
 *    re-set. Each path is refused by `validateDeleteFields` (a system field, an empty segment, an object-internal key), and the record the plan
 *    leaves is judged as a PATCH judges it (`recordAfterPatch`): a removal of a property the strict schema requires is refused.
 *  - `replaceTags`: the target tag array, written as it is. Never a union plus a deletion: the merge unions, and `$unset` would win.
 *
 * A removal on an INSERT is refused, never dropped: nothing is stored to take the field from, and "accepted and nothing happened" is the failure
 * `validateDeleteFields` exists to prevent.
 *
 * ## What it runs against
 *
 * Stored rows in the test MongoDB, read by the planners' own read set (`ReadSet`, its default reader): nothing stands in for the store.
 *
 * Each case names the mutation it is red on. Run: node --test testing/standalone/a-planners-take-field-removals-and-tag-replacements-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();
const SPACE = 'removalplan';
const ID = 'r1';
const ADA = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';
const STORED_TAGS = ['a', 'b', 'c'];

/** Strict, so a removal that breaks a required property is refused; `suppressEmbeddings` so no plan computes a vector. */
const META = {
  validationMode: 'strict', suppressEmbeddings: true,
  typeSchemas: {
    entity: { person: { propertySchemas: { born: { type: 'string', required: true }, nick: { type: 'string' }, note: { type: 'string' }, extra: { type: 'string' } } } },
    fact: { claim: { propertySchemas: { source: { type: 'string', required: true }, note: { type: 'string' }, extra: { type: 'string' } } } },
    chrono: { event: { propertySchemas: { place: { type: 'string', required: true }, note: { type: 'string' }, extra: { type: 'string' } } } },
    edge: { knows: { propertySchemas: { since: { type: 'string', required: true }, note: { type: 'string' }, extra: { type: 'string' } } } },
  },
};

/** Per kind: the stored row, the properties it holds, a property its strict schema REQUIRES, and a call that plans a converge onto it. */
const KINDS = {
  entity: {
    coll: 'entities', required: 'born', props: { born: '1815', nick: 'Countess', note: 'first programmer', extra: 'x' },
    row: (props) => build.entity(SPACE, ID, 3, { name: 'Ada', type: 'person', description: 'a mathematician', tags: STORED_TAGS, properties: props }),
    plan: async (m, extra) => {
      const input = { id: ID, name: 'Ada', type: 'person', ...extra };
      const view = new m.ReadSet(SPACE);
      await view.load(m.entity.entityWant(input));
      return m.entity.planEntity(SPACE, input, view);
    },
    insert: async (m, extra) => {
      const input = { name: 'New', type: 'person', properties: { born: '1900' }, ...extra };
      const view = new m.ReadSet(SPACE);
      await view.load(m.entity.entityWant(input));
      return m.entity.planEntity(SPACE, input, view);
    },
    refusedPaths: ['name', 'updatedAt.x', 'properties..note', 'properties.__proto__'],
  },
  fact: {
    coll: 'facts', required: 'source', props: { source: 'eyes', note: 'noon', extra: 'x' },
    row: (props) => build.fact(SPACE, ID, 3, { fact: 'the sky is blue', type: 'claim', description: 'observed', tags: STORED_TAGS, properties: props }),
    plan: async (m, extra) => {
      const input = { id: ID, fact: 'the sky is blue', type: 'claim', ...extra };
      const view = new m.ReadSet(SPACE);
      await view.load(m.fact.factWant(input));
      return m.fact.planFact(SPACE, input, view);
    },
    insert: async (m, extra) => {
      const input = { fact: 'a new fact', type: 'claim', properties: { source: 's' }, ...extra };
      const view = new m.ReadSet(SPACE);
      await view.load(m.fact.factWant(input));
      return m.fact.planFact(SPACE, input, view);
    },
    refusedPaths: ['id', 'createdAt', 'properties..note', 'properties.constructor'],
  },
  chrono: {
    coll: 'chrono', required: 'place', props: { place: 'room 1', note: 'weekly', extra: 'x' },
    row: (props) => build.chrono(SPACE, ID, 3, { title: 'Standup', type: 'event', endsAt: '2026-01-01T09:15:00.000Z', confidence: 0.5, description: 'daily', tags: STORED_TAGS, properties: props }),
    plan: async (m, extra) => {
      const { deleteFields, replaceTags, ...fields } = extra;
      const input = { fields: { id: ID, title: 'Standup', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', ...fields },
        ...(deleteFields ? { deleteFields } : {}), ...(replaceTags ? { replaceTags } : {}) };
      const view = new m.ReadSet(SPACE);
      await view.load(m.chrono.chronoWant(input));
      return m.chrono.planChrono(SPACE, input, view);
    },
    insert: async (m, extra) => {
      const input = { fields: { title: 'New', type: 'event', startsAt: '2026-02-01T09:00:00.000Z', properties: { place: 'p' } }, ...extra };
      const view = new m.ReadSet(SPACE);
      await view.load(m.chrono.chronoWant(input));
      return m.chrono.planChrono(SPACE, input, view);
    },
    refusedPaths: ['title', 'startsAt', 'status', 'properties..note'],
  },
  edge: {
    coll: 'edges', required: 'since', props: { since: '1840', note: 'letters', extra: 'x' },
    row: (props) => build.edge(SPACE, ID, 3, { from: ADA, to: BOB, label: 'knows', weight: 0.7, description: 'met', tags: STORED_TAGS, properties: props }),
    plan: async (m, extra) => {
      const input = { from: ADA, to: BOB, label: 'knows', opts: { fromKind: 'entity', toKind: 'entity' }, ...extra };
      const view = new m.ReadSet(SPACE);
      await view.load(m.edge.edgeWant(SPACE, input));
      return m.edge.planEdge(SPACE, input, view);
    },
    insert: async (m, extra) => {
      const input = { from: BOB, to: ADA, label: 'knows', properties: { since: '1' }, opts: { fromKind: 'entity', toKind: 'entity' }, ...extra };
      const view = new m.ReadSet(SPACE);
      await view.load(m.edge.edgeWant(SPACE, input));
      return m.edge.planEdge(SPACE, input, view);
    },
    refusedPaths: ['name', 'spaceId.x', 'properties..note', 'properties.__proto__'],
  },
};
const without = (props, key) => { const { [key]: _gone, ...rest } = props; return rest; };

describe('the planners take field removals and tag replacements', { skip }, () => {
  let door; let m;
  before(async () => {
    door = await openPushDoor({ suite: 'q962_removals', spaces: [{ id: SPACE, label: 'Removals', folders: [], meta: META }] });
    m = {
      ReadSet: (await import('../../server/dist/brain/write-plan/read-set.js')).ReadSet,
      dryPlan: (await import('../../server/dist/brain/write-plan/dry-plan.js')).dryPlan,
      entity: await import('../../server/dist/brain/write-plan/plan-entity.js'),
      fact: await import('../../server/dist/brain/write-plan/plan-fact.js'),
      chrono: await import('../../server/dist/brain/write-plan/plan-chrono.js'),
      edge: await import('../../server/dist/brain/write-plan/plan-edge.js'),
      SchemaViolationError: (await import('../../server/dist/brain/write-validation.js')).SchemaViolationError,
      RequestRefusal: (await import('../../server/dist/util/errors.js')).RequestRefusal,
    };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(SPACE);
    for (const k of Object.values(KINDS)) await door.coll(SPACE, k.coll).insertOne(k.row(k.props));
    // The edge's ends: a strict space refuses an edge whose end names no entity.
    for (const id of [ADA, BOB]) {
      await door.coll(SPACE, 'entities').insertOne(build.entity(SPACE, id, 1, { name: `End ${id}`, type: 'person', properties: { born: '1800' } }));
    }
  });

  for (const [kind, k] of Object.entries(KINDS)) {
    describe(kind, () => {
      it('a converge with deleteFields removes one property: gone from the result and from the pruned bag the plan sets, the others stay (red: the planner takes no deleteFields)', async () => {
        const { plan } = await k.plan(m, { deleteFields: ['properties.note'] });
        assert.equal(plan.op, 'converge');
        const left = without(k.props, 'note');
        assert.deepEqual(plan.result.properties, left, 'the property is still in the record the plan leaves');
        assert.deepEqual(plan.set.properties, left, 'the plan stores the pruned bag, so the stored one is replaced by it');
        assert.equal('properties' in plan.unset, false, 'a bag that still holds keys is set, not unset');
      });

      it('a whole removed field is carried in unset, gone from the result, and not also set (red: the planner takes no deleteFields)', async () => {
        const { plan } = await k.plan(m, { deleteFields: ['description'] });
        assert.ok('description' in plan.unset, `unset does not name description: ${JSON.stringify(plan.unset)}`);
        assert.equal('description' in plan.set, false, 'a path in both $set and $unset is rejected by the store');
        assert.equal('description' in plan.result, false);
      });

      it('the stored value and the removal meet in ONE plan: a property the write restates is still removed (red: the merge runs after the removal)', async () => {
        // The merge is a union, so restating `note` brings it back unless the removal runs after it.
        const { plan } = await k.plan(m, { properties: { note: 'restated', extra: 'y' }, deleteFields: ['properties.note'] });
        assert.deepEqual(plan.result.properties, { ...without(k.props, 'note'), extra: 'y' });
        assert.equal('note' in plan.set.properties, false);
      });

      it('a removal of a property the strict schema requires is refused as a schema violation; one it only declares is not (red: the result is not judged)', async () => {
        await assert.rejects(k.plan(m, { deleteFields: [`properties.${k.required}`] }), err => {
          assert.ok(err instanceof m.SchemaViolationError, `refused for another reason: ${err?.name}: ${err?.message}`);
          assert.match(err.message, new RegExp(k.required));
          return true;
        });
        const { plan } = await k.plan(m, { deleteFields: ['properties.extra'] });
        assert.equal(plan.op, 'converge');
      });

      it('a path no door lets through is refused as a request refusal, for each shape: a system field, a system field with a tail, an empty segment, an object-internal key (red: the paths are not validated)', async () => {
        for (const p of k.refusedPaths) {
          await assert.rejects(k.plan(m, { deleteFields: [p] }), err => {
            assert.ok(err instanceof m.RequestRefusal, `'${p}' was not refused by the path rule: ${err?.name}: ${err?.message}`);
            return true;
          });
        }
      });

      it('a removal on an INSERT is refused, never dropped (red: the planner ignores deleteFields)', async () => {
        await assert.rejects(k.insert(m, { deleteFields: ['properties.note'] }), err => {
          assert.ok(err instanceof m.RequestRefusal, `${err?.name}: ${err?.message}`);
          assert.match(err.message, /deleteFields/);
          return true;
        });
      });

      it('one tag of several is removed by a replacement and the rest stay, in the target\'s order (red: the planner takes no replaceTags)', async () => {
        const { plan } = await k.plan(m, { replaceTags: ['a', 'c'] });
        assert.deepEqual(plan.set.tags, ['a', 'c']);
        assert.deepEqual(plan.result.tags, ['a', 'c']);
        assert.equal('tags' in plan.unset, false);
      });

      it('the replacement is the target even when the write also states tags, and an empty target empties them (red: replaceTags is unioned)', async () => {
        const both = await k.plan(m, { tags: ['z'], replaceTags: ['b'] });
        assert.deepEqual(both.plan.result.tags, ['b'], 'a union with the stated tag would bring `a` and `c` back');
        const none = await k.plan(m, { replaceTags: [] });
        assert.deepEqual(none.plan.result.tags, []);
        assert.deepEqual(none.plan.set.tags, []);
      });

      it('without a replacement the tags still union, and without deleteFields nothing is removed (control)', async () => {
        const { plan } = await k.plan(m, { tags: ['z'] });
        assert.deepEqual(plan.result.tags, ['a', 'b', 'c', 'z']);
        assert.deepEqual(plan.result.properties, k.props);
        assert.equal('description' in plan.result, true);
        for (const field of ['description', 'tags', 'properties']) assert.equal(field in plan.unset, false);
      });
    });
  }

  describe('the dry plan takes the same inputs', () => {
    it('answers a removal as a converge with its unset, and what the planner refuses as rows with their reasons (red: the planners take none)', async () => {
      const view = new m.ReadSet(SPACE);
      const good = { id: ID, name: 'Ada', type: 'person', deleteFields: ['description', 'properties.nick'], replaceTags: ['b'] };
      const required = { id: ID, name: 'Ada', type: 'person', deleteFields: ['properties.born'] };
      const system = { id: ID, name: 'Ada', type: 'person', deleteFields: ['name'] };
      const items = [good, required, system].map(input => ({
        kind: 'entity', input, want: m.entity.entityWant(input), plan: v => m.entity.planEntity(SPACE, input, v),
      }));
      const { plans, refusals } = await m.dryPlan(items, view);
      assert.equal(plans[0]?.op, 'converge', JSON.stringify(refusals));
      assert.ok('description' in plans[0].unset);
      assert.deepEqual(plans[0].result.properties, without(KINDS.entity.props, 'nick'));
      assert.deepEqual(plans[0].result.tags, ['b']);
      assert.deepEqual(refusals.map(r => r.index), [1, 2]);
      assert.ok(refusals[0].violation, 'a schema refusal carries its body, as the planner raises it');
      assert.match(refusals[0].reason, /born/);
      assert.match(refusals[1].reason, /system field 'name'/);
    });
  });

  /*
   * The update writers reflect a removal through the helper the planners share. These rows are what they stored BEFORE the helper existed, written
   * down from the unchanged code: a green here on the base and after is the proof the extraction changed nothing a PATCH can see.
   */
  describe('the update writers answer a removal as they always did (pinned on the unchanged code)', () => {
    const WRITERS = {
      entity: (mod, paths) => mod('brain/entities.js').then(w => w.updateEntityById(SPACE, ID, {}, paths)),
      fact: (mod, paths) => mod('brain/fact.js').then(w => w.updateFact(SPACE, ID, {}, paths)),
      chrono: (mod, paths) => mod('brain/chrono.js').then(w => w.updateChrono(SPACE, ID, {}, paths)),
      edge: (mod, paths) => mod('brain/edges.js').then(w => w.updateEdgeById(SPACE, ID, {}, paths)),
    };
    const load = (file) => import(`../../server/dist/${file}`);
    for (const [kind, k] of Object.entries(KINDS)) {
      it(`${kind}: a property is pruned, a whole field is unset, an untouched field stays`, async () => {
        await WRITERS[kind](load, ['properties.note', 'description']);
        const row = await door.coll(SPACE, k.coll).findOne({ _id: ID });
        assert.deepEqual(row.properties, without(k.props, 'note'));
        assert.equal('description' in row, false, 'the whole field was not unset');
        assert.deepEqual(row.tags, STORED_TAGS);
        const nulls = Object.entries(row).filter(([, v]) => v === null).map(([f]) => f);
        assert.deepEqual(nulls, [], 'the write stored null for a field the record never had');
      });

      it(`${kind}: the tags field is unset whole and the properties stay`, async () => {
        await WRITERS[kind](load, ['tags']);
        const row = await door.coll(SPACE, k.coll).findOne({ _id: ID });
        assert.equal('tags' in row, false);
        assert.deepEqual(row.properties, k.props);
      });
    }
  });
});
