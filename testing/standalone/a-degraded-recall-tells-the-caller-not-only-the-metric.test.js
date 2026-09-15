/**
 * Every way a recall degrades reaches the CALLER, not only a Prometheus counter.
 *
 * ## What this is defending, and the receipt for it
 *
 * `recall` answers a 200 whether or not every stage ran. When the reranker does not run the results come
 * back ordered by meaning alone and look entirely reasonable — the changelog for the reranking-cost work
 * says so in as many words: *"the failure is silent: when the budget expires the search still answers,
 * ordered by meaning alone, and looks entirely reasonable... and nobody reports a result that looks fine."*
 *
 * That work documented the cost and wired the BUDGET case into `degraded`, so a caller can see it. The other
 * way the reranker fails to run — unreachable, a non-2xx, an unreadable body — only ever incremented the
 * metric. Two causes, one signature, and one of them invisible to the person holding the answer. Worse, the
 * integration guide lists `rerank_unavailable` among the reasons a caller will see in `degraded`: the
 * contract was documented and the code never met it.
 *
 * It was found by wiring a real cross-encoder to a bench instance for the first time. Every call came back
 * `413 Payload Too Large`, because one recall sends up to a hundred candidates and a stock
 * text-embeddings-inference server accepts 32 per request. The response carried `degraded: null` and
 * plausible results. The only trace was a WARN line in a log nobody was reading.
 *
 * ## Why it asserts the rule rather than the one site
 *
 * A case naming `rerank_unavailable` would pass the day somebody adds a third degradation and counts it
 * directly. The rule is that the counter is incremented in exactly one place — inside the helper that also
 * tells the caller — so a new reason cannot be metric-only without deleting this test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The shared helpers rather than hand-rolled ones. A stripper that removes block comments first opens a
// phantom block on a `/*` inside a line comment and swallows real code; a capped character window can only
// make a check see less than the thing it means to bound. Both are rules this repository already gates, and
// this file broke both on its first draft.
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, between } from './_structural-window.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const code = stripComments(readFileSync(join(repoRoot, 'server', 'src', 'brain', 'recall.ts'), 'utf8'));

describe('a degradation is reported once, in one place', () => {
  test('the counter is incremented exactly once in the whole file', () => {
    const hits = code.match(/recallDegradedTotal\s*\.labels/g) ?? [];
    assert.equal(hits.length, 1,
      `recallDegradedTotal is incremented ${hits.length} times. Every reason must go through the helper `
      + "that also pushes it onto the caller's `degraded` array, or a caller gets a plausible answer and no "
      + 'way to know a stage did not run.');
  });

  test('and that one place also tells the caller', () => {
    // Asserted together because either half alone is the bug: a metric with no caller signal is invisible to
    // whoever holds the answer, and a caller signal with no metric is invisible to whoever runs the instance.
    // `between`, not `bodyOf`: the helper is declared INSIDE `recall`, so it is not a top-level
    // declaration and the structural window for those cannot anchor on it. Both ends are markers the
    // language puts there, which is the property that matters — neither is a guess at a length.
    const helper = between(code, 'const noteDegraded', '};');
    assert.match(helper, /recallDegradedTotal\s*\.labels/, 'the helper does not increment the metric');
    assert.match(helper, /degraded/, 'the helper does not reach the caller');
  });

  test('the rerank step can report, rather than only counting', () => {
    /*
     * The specific hole this was written for. `applyRerank` took the query, the results and a budget, and
     * had no way to tell anybody what happened — so the one thing it knew, that the reranker gave no
     * opinion, went to a counter and stopped there.
     */
    const fn = bodyOf(code, 'applyRerank');
    assert.match(fn, /noteDegraded/,
      'applyRerank cannot report a degradation, so a reranker that is unreachable, refusing the batch size '
      + 'or answering nonsense is invisible in the response');
  });
});
