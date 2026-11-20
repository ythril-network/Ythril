/**
 * The dry plan refuses a record that no door would create (bundle-270 review F2, amendment A5).
 *
 * ## The rule
 *
 * An import is judged whole by the dry plan and committed without a refusal, so the dry plan must refuse every record the store's doors refuse
 * at create. The shared record checks asked shape, link caps and size only: requiredness was left to each door ("a create and an update
 * differ on it"), so `<y> a ythril:Entity .` planned as an entity insert with no name and no type, and a chrono with no title, no start, a type
 * the space does not allow and a recurrence with no frequency was planned as well. The planners now ask one create-time question of a record
 * built from a document (`createError`, `brain/record-checks.ts`: the required fields, the chrono type allowlist, the recurrence parse) when
 * they are handed the trusted arguments of an import, and refuse with the door's own words.
 *
 * ## Where the cases come from (never a list typed beside the check)
 *
 *  - REQUIRED FIELDS: every `missing required field: <field>` the bulk door answers is read from its source (`brain/bulk.ts`) with the record
 *    kind it answers for, so a required field added to a door and not to the shared check is a derived case the dry plan accepts, and fails;
 *  - THE CHRONO TYPE: the allowlist is the one the door asks (`getAllowedChronoTypes`): a type outside it is refused, every type inside it is
 *    taken, and a plan schema that defines chrono types is the allowlist;
 *  - THE RECURRENCE: candidate blocks are put to the door's own parser (`parseRecurrence`); every one it refuses is refused by the dry plan
 *    with its words, and every one it takes is taken.
 *
 * Every refused case is paired with its control: the same record with the defect repaired is planned, so the refusal is the defect's.
 *
 * Run: node --test testing/standalone/a-dry-plan-refuses-what-no-door-would-create.test.js (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';

const SPACE = 'create-space';
const S = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const M = '55555555-5555-4555-8555-555555555555';

let dir;
let ReadSet, trustedPlan, dryPlan, planMetaFor, getAllowedChronoTypes, parseRecurrence, planners;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ythril-create-plan-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'i-1', instanceLabel: 'Test', tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'Import', folders: [], meta: { validationMode: 'warn', strictLinkage: true, typeSchemas: { entity: { person: {} }, edge: { manages: {} } } } }],
  }), 'utf8');
  process.env['CONFIG_PATH'] = cfgPath;
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
  ({ trustedPlan } = await import('../../server/dist/brain/write-plan/trust.js'));
  ({ dryPlan } = await import('../../server/dist/brain/write-plan/dry-plan.js'));
  ({ planMetaFor } = await import('../../server/dist/spaces/schema-stamp.js'));
  ({ getAllowedChronoTypes } = await import('../../server/dist/spaces/schema-validation.js'));
  ({ parseRecurrence } = await import('../../server/dist/brain/chrono.js'));
  planners = {
    entity: await import('../../server/dist/brain/write-plan/plan-entity.js').then(m => ({ want: m.entityWant, plan: m.planEntity })),
    fact: await import('../../server/dist/brain/write-plan/plan-fact.js').then(m => ({ want: m.factWant, plan: m.planFact })),
    chrono: await import('../../server/dist/brain/write-plan/plan-chrono.js').then(m => ({ want: m.chronoWant, plan: m.planChrono })),
    edge: await import('../../server/dist/brain/write-plan/plan-edge.js')
      .then(m => ({ want: (input, trust) => m.edgeWant(SPACE, input, undefined, trust), plan: m.planEdge })),
  };
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** What the importer hands a planner for a new record: the id it minted, and the plan schema when it proposes one. */
const trustOf = (kind, planMeta) => trustedPlan(SPACE, { ...(kind === 'edge' ? {} : { mintedId: M }), ...(planMeta ? { planMeta } : {}) });

/** The dry plan of one record as an importer builds the item; a throw is a failure of its own, never a refusal. */
async function planOne(kind, input, planMeta) {
  const view = new ReadSet(SPACE, async () => []);
  await view.seed('entity', [{ _id: S, type: 'person' }, { _id: T1, type: 'person' }]);
  const trust = trustOf(kind, planMeta);
  try {
    return await dryPlan([{ kind, input, want: planners[kind].want(input, trust), plan: v => planners[kind].plan(SPACE, input, v, trust) }], view);
  } catch (err) {
    return assert.fail(`the dry plan threw ${err?.name}: ${err?.message} instead of refusing the ${kind}`);
  }
}

const VALID = {
  fact: () => ({ fact: 'a fact', tags: [] }),
  entity: () => ({ name: 'Ada', type: 'person', tags: [], properties: {} }),
  chrono: () => ({ fields: { title: 'Standup', type: 'event', startsAt: '2026-01-01T09:00:00Z' } }),
  edge: () => ({ from: S, to: T1, label: 'manages', opts: { fromKind: 'entity', toKind: 'entity' } }),
};
/** The field of a kind's planner input a required field is stated in: a chrono's sit under `fields`. */
const fieldsOf = (kind, input) => (kind === 'chrono' ? input.fields : input);

async function assertRefusedWithControl(kind, input, control, words, why, planMeta) {
  const refused = await planOne(kind, input, planMeta);
  assert.equal(refused.plans[0], null, `a ${kind} that ${why} was planned: no door would create it`);
  assert.equal(refused.refusals.length, 1, `${why}: ${JSON.stringify(refused.refusals)}`);
  assert.match(refused.refusals[0].reason, words, `${why}: refused for another reason: ${refused.refusals[0].reason}`);
  const taken = await planOne(kind, control, planMeta);
  assert.deepEqual(taken.refusals, [], `${why}: the repaired ${kind} is refused too (${JSON.stringify(taken.refusals)}), so the case proves nothing`);
  assert.equal(taken.plans[0]?.op, 'insert');
}

/** Every `missing required field: <field>` the bulk door answers, with the kind it answers for, read from its source. */
function requiredFieldsOfTheDoor() {
  const source = stripComments(readFileSync(path.join(REPO_ROOT, 'server/src/brain/bulk.ts'), 'utf8'));
  const found = [];
  for (const m of source.matchAll(/reject\('(fact|entity|chrono)', i, item, 'missing required field: (\w+)'\)/g)) found.push([m[1], m[2]]);
  for (const m of source.matchAll(/refuse\('missing required field: (\w+)'\)/g)) found.push(['edge', m[1]]);
  return found;
}

describe('a record no door would create is refused by the dry plan', () => {
  it('the doors\' required fields are read from the door, and there are some', () => {
    const found = requiredFieldsOfTheDoor();
    for (const kind of ['fact', 'entity', 'chrono', 'edge']) {
      assert.ok(found.some(([k]) => k === kind), `no required field of a ${kind} was read from the bulk door: the derivation found nothing to hold the dry plan to`);
    }
  });

  it('every required field of every kind, missing, null, empty or blank, is refused naming the field', async () => {
    for (const [kind, field] of requiredFieldsOfTheDoor()) {
      for (const [how, value] of [['missing', undefined], ['null', null], ['empty', ''], ['blank', '   ']]) {
        const input = VALID[kind]();
        const target = fieldsOf(kind, input);
        if (value === undefined) delete target[field]; else target[field] = value;
        await assertRefusedWithControl(kind, input, VALID[kind](), new RegExp(field), `has its required \`${field}\` ${how}`);
      }
    }
  });

  it('the review\'s entity: an entity with no name and no type is refused', async () => {
    const refused = await planOne('entity', { tags: [], properties: {} });
    assert.equal(refused.plans[0], null);
    assert.equal(refused.refusals.length, 1);
    assert.match(refused.refusals[0].reason, /name/);
  });

  it('a chrono type outside the allowlist is refused in any validation mode, every type inside it is taken', async () => {
    for (const allowed of getAllowedChronoTypes(undefined)) {
      const input = VALID.chrono();
      input.fields.type = allowed;
      assert.deepEqual((await planOne('chrono', input)).refusals, [], `the allowed chrono type ${allowed} was refused`);
    }
    const bad = VALID.chrono();
    bad.fields.type = 'meeting';
    await assertRefusedWithControl('chrono', bad, VALID.chrono(), /type.*must be one of/, 'has a type outside the allowlist');
  });

  it('a plan schema that defines chrono types is the allowlist: a built-in type outside it is refused, one of its own is taken', async () => {
    const planMeta = planMetaFor(SPACE, { chrono: { meeting: {} }, entity: { person: {} }, edge: { manages: {} } });
    const builtin = VALID.chrono();
    const own = VALID.chrono();
    own.fields.type = 'meeting';
    await assertRefusedWithControl('chrono', builtin, own, /type.*must be one of: meeting/, 'has a built-in type the plan schema does not allow', planMeta);
  });

  it('every recurrence block the door\'s parser refuses is refused with its words, and every one it takes is taken', async () => {
    const candidates = [
      {}, { interval: 0 }, { freq: 'hourly' }, { freq: 'daily', interval: 0 }, { freq: 'daily', interval: 1.5 }, { freq: 'weekly', interval: '2' },
      { freq: 'daily', until: 'not a date' }, { freq: 'daily', until: 5 }, 'weekly', ['daily'], { freq: ['daily'] },
      { freq: 'daily' }, { freq: 'weekly', interval: 2 }, { freq: 'monthly', interval: 3, until: '2027-01-01T00:00:00Z' }, { freq: 'yearly' },
    ];
    const refused = candidates.filter(c => !parseRecurrence(c).ok);
    const taken = candidates.filter(c => parseRecurrence(c).ok);
    assert.ok(refused.length >= 8 && taken.length >= 3, 'the door\'s parser must split the candidates, or the case checks nothing');
    for (const recurrence of refused) {
      const input = VALID.chrono();
      input.fields.recurrence = recurrence;
      const words = parseRecurrence(recurrence).error;
      await assertRefusedWithControl('chrono', input, VALID.chrono(), new RegExp(escapeRegExp(words)),
        `has the recurrence ${JSON.stringify(recurrence)}`);
    }
    for (const recurrence of taken) {
      const input = VALID.chrono();
      input.fields.recurrence = recurrence;
      assert.deepEqual((await planOne('chrono', input)).refusals, [], `the recurrence ${JSON.stringify(recurrence)} the door takes was refused`);
    }
  });
});
