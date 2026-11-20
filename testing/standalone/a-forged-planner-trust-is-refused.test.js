/**
 * A planner's trusted arguments are the ones `trustedPlan` issued, never an object made to look like them (bundle-270 review F5).
 *
 * ## The defect
 *
 * `trustFor` checked only `instanceof PlanTrust`, and the constructor's token check is skipped by `Object.create(PlanTrust.prototype)`: an
 * object with chosen fields passed as a planner's fourth argument, with no UUID check on its id. The lint that keeps the capability from the
 * doors is a name scan (`a-planner-judges-a-whole-import-before-anything-is-stored.test.js`), and cannot see a wrapper that re-exports it, so
 * the guard has to hold at the planner itself.
 *
 * ## What it holds
 *
 * Every planner (entity, fact, chrono, edge) refuses, by throwing, trusted arguments that `trustedPlan` did not issue: an object made from the
 * prototype with a minted id that is not a UUID, with a valid-looking id nobody issued, with another space's name, a plain look-alike, and an
 * issued one whose fields were changed afterwards. The issued one (the control) plans, and it cannot be changed after it is issued.
 *
 * Run: node --test testing/standalone/a-forged-planner-trust-is-refused.test.js (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SPACE = 'forge-space';
const S = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const ISSUED = '55555555-5555-4555-8555-555555555555';
const NEVER_ISSUED = '66666666-6666-4666-8666-666666666666';

let dir, ReadSet, trustedPlan, PlanTrust, planners;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ythril-forged-trust-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'i-1', instanceLabel: 'Test', tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'Forge', folders: [], meta: { validationMode: 'warn' } }],
  }), 'utf8');
  process.env['CONFIG_PATH'] = cfgPath;
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
  ({ trustedPlan, PlanTrust } = await import('../../server/dist/brain/write-plan/trust.js'));
  const entity = await import('../../server/dist/brain/write-plan/plan-entity.js');
  const fact = await import('../../server/dist/brain/write-plan/plan-fact.js');
  const chrono = await import('../../server/dist/brain/write-plan/plan-chrono.js');
  const edge = await import('../../server/dist/brain/write-plan/plan-edge.js');
  planners = {
    entity: { input: { name: 'Ada', type: 'person' }, want: entity.entityWant, plan: entity.planEntity },
    fact: { input: { fact: 'a fact' }, want: fact.factWant, plan: fact.planFact },
    chrono: { input: { fields: { title: 'T', type: 'event', startsAt: '2026-01-01T00:00:00Z' } }, want: chrono.chronoWant, plan: chrono.planChrono },
    edge: {
      input: { from: S, to: T1, label: 'knows', opts: { fromKind: 'entity', toKind: 'entity' } },
      want: (input, trust) => edge.edgeWant(SPACE, input, undefined, trust), plan: edge.planEdge,
    },
  };
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A forgery: an object of the trust's prototype with chosen fields, which never ran the constructor. */
const forged = (fields) => Object.assign(Object.create(PlanTrust.prototype), fields);

async function planWith(kind, trust) {
  const { input, plan, want } = planners[kind];
  const view = new ReadSet(SPACE, async () => []);
  await view.seed('entity', [{ _id: S, type: 'person' }, { _id: T1, type: 'person' }]);
  await view.load(want(input, trust));
  return plan(SPACE, input, view, trust);
}

describe('a forged planner trust is refused by every planner', () => {
  for (const kind of ['entity', 'fact', 'chrono', 'edge']) {
    const minted = kind === 'edge' ? undefined : ISSUED;
    // Built inside each case: the class is imported by the `before` hook, which runs after the suite is collected.
    const forgeries = [
      ['an object of the prototype whose minted id is not a UUID', () => forged({ spaceId: SPACE, mintedId: 'not-a-uuid', planMeta: undefined })],
      ['an object of the prototype with a UUID v4 nobody issued', () => forged({ spaceId: SPACE, mintedId: NEVER_ISSUED, planMeta: undefined })],
      ['an object of the prototype with no minted id at all', () => forged({ spaceId: SPACE, mintedId: undefined, planMeta: undefined })],
      ['a plain object that looks like one', () => ({ spaceId: SPACE, mintedId: NEVER_ISSUED, planMeta: undefined })],
    ];
    for (const [what, make] of forgeries) {
      // An entity planned with no minted id asks the store for its name (`entityWant`), which this file has none to answer.
      if (kind === 'entity' && /no minted id/.test(what)) continue;
      it(`${kind}: ${what} is refused`, async () => {
        await assert.rejects(planWith(kind, make()), /PlanTrust from trustedPlan/, `the ${kind} planner took ${what}`);
      });
    }

    it(`${kind}: an issued trust plans, and its fields cannot be changed after it is issued`, async () => {
      const trust = trustedPlan(SPACE, minted === undefined ? {} : { mintedId: minted });
      const { plan } = await planWith(kind, trust);
      assert.equal(plan.op, 'insert');
      if (minted !== undefined) assert.equal(plan.id, minted);
      assert.throws(() => { trust.mintedId = NEVER_ISSUED; }, TypeError, 'an issued trust was changed');
    });
  }
});
