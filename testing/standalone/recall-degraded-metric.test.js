/**
 * Silent degradation is counted, and only where it can be counted honestly.
 *
 * Every other counter in the registry measures work done or work failed. This one measures the gap
 * between them: recall answered, 200, and the answer was quietly worse than the instance is configured
 * to produce. A reranker unreachable for a week generates no failed requests, no error rate and no
 * latency change worth noticing — every recall simply comes back in vector order and nobody is told.
 *
 * The tests worth having here are about **trustworthiness of the metric**, not the plumbing:
 *
 *  1. Both series exist from process start. "Absent" and "zero" render identically on a graph and mean
 *     opposite things — a scrape before the first degradation must say 0, not nothing.
 *  2. The label set is CLOSED. An unbounded `reason` is a cardinality bomb.
 *  3. Every declared reason is actually incremented somewhere. A label that can only ever read 0 is
 *     worse than no label: an operator reads it as "this never happens".
 *
 * Run: node --test testing/standalone/recall-degraded-metric.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let register, recallDegradedTotal;

before(async () => {
  ({ register, recallDegradedTotal } = await import('../../server/dist/metrics/registry.js'));
});

const REASONS = ['rerank_unavailable', 'rerank_skipped_budget', 'search_timeout'];

describe('ythril_recall_degraded_total', () => {
  it('exposes every reason at zero before anything has degraded', async () => {
    const metrics = await register.metrics();
    for (const reason of REASONS) {
      assert.match(metrics, new RegExp(`ythril_recall_degraded_total\\{reason="${reason}"\\} 0`),
        `${reason} must be pre-declared — an absent series and a zero series look the same on a graph`);
    }
  });

  it('counts up when a degradation is recorded', async () => {
    recallDegradedTotal.labels({ reason: 'rerank_unavailable' }).inc();
    const metrics = await register.metrics();
    assert.match(metrics, /ythril_recall_degraded_total\{reason="rerank_unavailable"\} 1/);
    // …and does not disturb its sibling.
    assert.match(metrics, /ythril_recall_degraded_total\{reason="rerank_skipped_budget"\} 0/);
  });

  it('every declared reason is incremented somewhere in the source', () => {
    // A label that can only ever read 0 tells an operator "this never happens", which is a stronger and
    // more misleading claim than saying nothing at all.
    //
    // Two accepted spellings, and the second is why this comment exists: the direct
    // `recallDegradedTotal.labels({ reason: 'x' })`, and `noteDegraded('x')` — the helper introduced with
    // the per-call deadline, which increments the counter AND records the reason on the response so a
    // partial answer can say so. When that helper replaced the direct calls this gate failed, correctly
    // noticing the literal was gone and wrongly concluding the reason was uncounted. Matching both keeps it
    // honest without forcing the code back into a shape that serves the test rather than the caller.
    // Both files: the rerank step reports from `rerank-pool.ts` since `P-35`, where both callers reach it.
    const recall = readFileSync('server/src/brain/recall.ts', 'utf8') + readFileSync('server/src/brain/rerank-pool.ts', 'utf8');
    for (const reason of REASONS) {
      const direct = recall.includes(`reason: '${reason}'`);
      const viaHelper = recall.includes(`noteDegraded('${reason}')`);
      assert.ok(direct || viaHelper, `${reason} is declared but never incremented`);
    }
  });

  it('the helper that records a reason also increments the counter', () => {
    // The failure this forecloses: `noteDegraded` gains a caller for a new reason, the response reports it,
    // and the metric never moves — so the dashboard says a degradation that operators are reading about in
    // API responses never happens. One helper, both jobs, asserted rather than assumed.
    const recall = readFileSync('server/src/brain/recall.ts', 'utf8');
    // `degradedNoter` builds every `noteDegraded` since `P-35`, because the cross-space rerank reports too.
    const at = recall.indexOf('function degradedNoter(');
    assert.ok(at > 0, 'degradedNoter not found — this gate is measuring nothing');
    const helper = recall.slice(at, recall.indexOf('\n}', at));
    assert.match(helper, /recallDegradedTotal\.labels\(\{ reason \}\)\.inc\(\)/,
      'noteDegraded must increment the metric, not only collect the reason for the response');
    assert.match(helper, /collector\.push\(reason\)/, 'noteDegraded must also record the reason for the caller');
    assert.match(recall, /const noteDegraded = degradedNoter\(opts\?\.degraded\)/,
      "recall must hand the caller's collector to the helper, or the reason reaches the metric and nobody else");
  });

  it('the lexical channel is deliberately NOT counted, and the reason is recorded', () => {
    // `applyLexicalFusion` cannot tell "no text index" from "nothing matched" — both are an empty
    // result. Counting it would fire on ordinary queries and report degradation where there is none.
    // A metric an operator learns to ignore will not be read on the day it matters.
    const registrySrc = readFileSync('server/src/metrics/registry.ts', 'utf8');
    assert.ok(!registrySrc.includes("'lexical_unavailable'"),
      'the lexical reason must not be declared until it can be distinguished from a normal empty result');
    assert.match(registrySrc, /deliberately NOT counted/,
      'the omission must be explained, or someone will "fix" it by adding a misleading counter');
  });
});
