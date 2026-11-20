/**
 * A plan schema answers every schema question a planner asks, embedding suppression included (bundle-270 review F7).
 *
 * ## The defect
 *
 * The planners judge, stamp and guard with the plan schema an import proposes (`planMetaFor`), but whether the record they leave embeds was
 * asked of the STORED meta (`suppressedAfterWrite` read `getSpaceMeta`). A proposed type that says `suppressEmbeddings` was ignored in the dry
 * plan, whose plans say whether an embed job is queued, so the interfaces' note that the plan schema reaches "every schema question" was
 * wrong.
 *
 * ## What it holds
 *
 * For each kind, a plan made with a plan schema whose type for the record suppresses embeddings queues no embed job (`enqueue` false), and the
 * same record planned without that plan schema does (the control), so it is the plan schema that decided. A plan schema never changes the
 * answer for a write that hands none (every door).
 *
 * Run: node --test testing/standalone/a-plan-schema-decides-embedding-suppression.test.js (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SPACE = 'suppress-space';
const S = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const M = '55555555-5555-4555-8555-555555555555';

let dir, ReadSet, trustedPlan, planMetaFor, planners;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ythril-plan-suppress-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'i-1', instanceLabel: 'Test', tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'Suppress', folders: [], meta: { validationMode: 'warn', typeSchemas: { entity: { person: {} } } } }],
  }), 'utf8');
  process.env['CONFIG_PATH'] = cfgPath;
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
  ({ trustedPlan } = await import('../../server/dist/brain/write-plan/trust.js'));
  ({ planMetaFor } = await import('../../server/dist/spaces/schema-stamp.js'));
  const entity = await import('../../server/dist/brain/write-plan/plan-entity.js');
  const fact = await import('../../server/dist/brain/write-plan/plan-fact.js');
  const chrono = await import('../../server/dist/brain/write-plan/plan-chrono.js');
  const edge = await import('../../server/dist/brain/write-plan/plan-edge.js');
  planners = {
    entity: { input: { name: 'Ada', type: 'person' }, want: entity.entityWant, plan: entity.planEntity },
    fact: { input: { fact: 'a fact', type: 'note' }, want: fact.factWant, plan: fact.planFact },
    chrono: { input: { fields: { title: 'T', type: 'event', startsAt: '2026-01-01T00:00:00Z' } }, want: chrono.chronoWant, plan: chrono.planChrono },
    edge: {
      input: { from: S, to: T1, label: 'knows', opts: { fromKind: 'entity', toKind: 'entity' } },
      want: (input, trust) => edge.edgeWant(SPACE, input, undefined, trust), plan: edge.planEdge,
    },
  };
});
after(() => rmSync(dir, { recursive: true, force: true }));

const SUPPRESSING = { entity: { person: { suppressEmbeddings: true } }, fact: { note: { suppressEmbeddings: true } },
  chrono: { event: { suppressEmbeddings: true } }, edge: { knows: { suppressEmbeddings: true } } };

async function planned(kind, typeSchemas) {
  const { input, want, plan } = planners[kind];
  const trust = trustedPlan(SPACE, { ...(kind === 'edge' ? {} : { mintedId: M }), ...(typeSchemas ? { planMeta: planMetaFor(SPACE, typeSchemas) } : {}) });
  const view = new ReadSet(SPACE, async () => []);
  await view.seed('entity', [{ _id: S, type: 'person' }, { _id: T1, type: 'person' }]);
  await view.load(want(input, trust));
  return (await plan(SPACE, input, view, trust)).plan;
}

describe('a plan schema decides embedding suppression', () => {
  it('every planner hands the plan schema to the suppression question (the edge planner, which needs a store to build its text, is read here)', () => {
    for (const planner of ['entity', 'fact', 'chrono', 'edge']) {
      const source = stripComments(readFileSync(path.join(REPO_ROOT, `server/src/brain/write-plan/plan-${planner}.ts`), 'utf8'));
      assert.match(source, /vectorBeforeWrite\(\{[\s\S]*?planMeta:\s*trusted\?\.planMeta\s*!==\s*undefined\s*\?\s*write\.meta\s*:\s*undefined/,
        `plan-${planner}.ts asks whether the record is suppressed without the plan schema`);
    }
  });

  // The edge's text is built from its ends' names, which needs a store: its suppressed plan is read in the case above.
  for (const kind of ['entity', 'fact', 'chrono']) {
    it(`${kind}: the proposed type's suppression queues no embed job, and without the plan schema one is queued`, async () => {
      const control = await planned(kind, undefined);
      assert.equal(control.enqueue, true, `the control ${kind} must queue an embed job, or the case proves nothing`);
      const proposed = await planned(kind, SUPPRESSING);
      assert.equal(proposed.enqueue, false, `the ${kind} plan queued an embed job though its plan schema suppresses embeddings`);
    });
  }
});
