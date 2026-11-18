/**
 * The page a conversion run reads is served by the `(type field, _id)` index on every stamped collection (Q-746, bundle-284 design r5 section
 * 5.2 "Index", finding S16).
 *
 * ## The rule
 *
 * The run reads one type at a time in `_id` order: `{ <type field>: T, forkOf: null, schemaFingerprint: { $ne: toFp } }`, sorted by `_id`,
 * a page at a time. On each of the four stamped collections (entities, facts and chrono by `type`, edges by `label`) the planner answers it from
 * the index the run declares, `{ <type field>: 1, _id: 1 }`, with no in-memory sort: `{ type: 1 }` has no `_id` suffix for the keyset, the stamp
 * index is partial on a present stamp, and edges had no index led by `label`.
 *
 * The page is the run module's own (`schemaConvertPageSpec`), so the test explains the read the run makes, never a copy of it.
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/the-selection-is-index-served-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';

const skip = await mongoSkipReason();
const S = 'selection';
const KINDS = [['entity', 'entities', 'person', 'type'], ['fact', 'facts', 'claim', 'type'], ['chrono', 'chrono', 'event', 'type'], ['edge', 'edges', 'knows', 'label']];

/** Every stage of a winning plan, flattened. */
function stagesOf(plan, out = []) {
  if (!plan) return out;
  out.push(plan);
  for (const child of [plan.inputStage, ...(plan.inputStages ?? [])]) stagesOf(child, out);
  return out;
}

describe('the selection is index-served (real MongoDB)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284selection', spaces: [S] });
    run = await door.runModule();
    // The run's index is built by the background pass, as the stamp index is.
    const { ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js');
    await ensureQueryIndexes();
    for (const [, part, type, field] of KINDS) {
      await door.seed(S, part, Array.from({ length: 30 }, (_, i) => ({ _id: `${part}-${String(i).padStart(3, '0')}`, [field]: i % 3 === 0 ? type : `other-${i % 3}`,
        ...(part === 'edges' ? { from: `a${i}`, to: `b${i}` } : {}), ...(part === 'facts' ? { fact: `f${i}`, entityIds: [] } : {}) })));
    }
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  for (const [kind, part, type, field] of KINDS) {
    it(`${part}: the page read uses the (${field}, _id) index with no in-memory sort`, async () => {
      const spec = run.schemaConvertPageSpec(S, kind, type, 'f'.repeat(64));
      assert.equal(spec.collection, `${S}_${part}`);
      const cursor = door.mongo.col(spec.collection).find(spec.filter, { projection: spec.projection, sort: { _id: 1 }, limit: spec.size, ...(spec.hint ? { hint: spec.hint } : {}) });
      const explained = await cursor.explain('queryPlanner');
      const stages = stagesOf(explained.queryPlanner.winningPlan.queryPlan ?? explained.queryPlanner.winningPlan);
      const scans = stages.filter(s => s.stage === 'IXSCAN');
      assert.ok(scans.some(s => JSON.stringify(s.keyPattern) === JSON.stringify({ [field]: 1, _id: 1 })),
        `the page read is not served by { ${field}: 1, _id: 1 }: ${JSON.stringify(stages.map(s => s.stage + (s.indexName ? `(${s.indexName})` : '')))}`);
      assert.ok(!stages.some(s => s.stage === 'SORT'), 'the page read sorts in memory');
    });
  }
});
