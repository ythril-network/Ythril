/**
 * Recall has an end-to-end budget, and the reranker is what it spends last.
 *
 * ## The gap
 *
 * Every hop on the recall path runs in series and each carried its own timeout, with nothing watching
 * the total: embed the query (30 s), the per-type vector searches (Mongo), the lexical channel (Mongo),
 * then the cross-encoder (20 s). Worst case is comfortably past the ~30 s an MCP client waits — so the
 * server finishes the work and hands it to a caller that stopped listening, which is the same as not
 * doing it, except slower and for everyone else's CPU too.
 *
 * ## Why the reranker is the right hop to cut
 *
 * It is last, it is the only OPTIONAL one, and the pipeline already knows how to live without it — an
 * unreachable reranker returns null and the fused order stands. So a deadline that bites here converts
 * a client-side timeout (no results at all) into a slightly worse ranking delivered on time.
 *
 * Cutting anywhere earlier would mean returning nothing, which is strictly worse than returning
 * something imperfect.
 *
 * Run: node --test testing/standalone/recall-timeout-budget.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let RECALL_BUDGET_MS, RERANK_MIN_BUDGET_MS;

before(async () => {
  ({ RECALL_BUDGET_MS, RERANK_MIN_BUDGET_MS } = await import('../../server/dist/brain/recall.js'));
});

describe('the budget is sized against a real caller', () => {
  it('sits under the ~30s an MCP client typically waits', () => {
    assert.ok(RECALL_BUDGET_MS > 0);
    assert.ok(RECALL_BUDGET_MS < 30_000,
      'a budget at or above the caller\'s own timeout cannot prevent the thing it exists to prevent');
  });

  it('leaves enough headroom that the skip threshold is meaningful', () => {
    assert.ok(RERANK_MIN_BUDGET_MS > 0);
    assert.ok(RERANK_MIN_BUDGET_MS < RECALL_BUDGET_MS / 2,
      'if the skip threshold approaches the whole budget the reranker would almost never run');
  });
});

describe('the deadline is threaded through the pipeline', () => {
  const recall = readFileSync('server/src/brain/recall.ts', 'utf8');

  it('the clock starts before the first hop, not after it', () => {
    // Starting it after the embed would hide the slowest single hop from the budget entirely.
    const startAt = recall.indexOf('const startedAt = Date.now()');
    const embedAt = recall.indexOf("await embed(query, 'query')");
    assert.ok(startAt > 0 && embedAt > 0);
    assert.ok(startAt < embedAt, 'the budget must include the embedding call');
  });

  it('the reranker is skipped when too little budget remains', () => {
    assert.match(recall, /remaining < RERANK_MIN_BUDGET_MS/,
      'there must be a skip, not merely a shortened timeout — starting a doomed pass still burns the time');
    assert.match(recall, /skipping the reranker/, 'the skip must be logged; a silent downgrade is unexplainable');
  });

  it('the remaining budget is passed to the reranker, not just checked', () => {
    // The budget must be the argument after the results, and the list is left OPEN on purpose: this
    // assertion is about `remaining` reaching the reranker, not about how many parameters the call has.
    // Pinned to the exact argument list, it failed the day the step gained a way to report a degradation —
    // a passing gate broken by a change it has no opinion about.
    assert.match(recall, /rerankPool\(query, guaranteed, pool, remaining[,)]/);
    const client = readFileSync('server/src/brain/rerank-client.ts', 'utf8');
    // `rerankTimeout()` rather than a `TIMEOUT_MS` constant: the reranker's own ceiling became
    // operator-settable, so it is resolved per call. A module constant would ignore a config reload, and this
    // assertion is about the CAP still being applied, not about where the number comes from.
    assert.match(client, /Math\.min\(rerankTimeout\(\), budgetMs!\)/,
      'the reranker must cap its own timeout to what is left, never exceed it');
  });

  it('an absent budget still gets the full timeout — the parameter is optional', () => {
    // `rerank()` is called from find_similar too, which has no budget of its own. It must not
    // accidentally get a zero-length timeout.
    const client = readFileSync('server/src/brain/rerank-client.ts', 'utf8');
    assert.match(client, /Number\.isFinite\(budgetMs\) && budgetMs! > 0 \? .* : rerankTimeout\(\)/);
  });

  it('the searches DO carry a deadline now, and a partial answer says so', () => {
    // ── This test used to assert the OPPOSITE, and it kept passing after the code changed ──
    //
    // It was: "the vector and lexical hops are NOT cancelled by the budget", checked by asserting that
    // Phase 2's source slice does not contain the literal `RECALL_BUDGET_MS`. When the per-call `maxTimeMS`
    // landed, the searches started carrying a deadline derived from `effectiveBudgetMs` — a different
    // identifier — so the assertion stayed green while the property it described became false. A test that
    // pins a NAME rather than a BEHAVIOUR cannot notice the behaviour changing, which is the whole failure
    // this suite exists to prevent.
    //
    // The original reasoning was sound on its own terms — cutting the hop that produces the results returns
    // nothing, which is worse than an imperfect order — and it is superseded rather than wrong. Two things
    // changed it: a per-call deadline whose largest hop is unbounded cannot be honoured at all, and
    // returning nothing is no longer the alternative. A timed-out collection is dropped, the ones that
    // answered are returned, and the response carries `search_timeout` so the caller knows the answer is
    // thin. Partial and labelled beats unbounded.
    const phase2 = recall.slice(recall.indexOf('// Phase 2:'), recall.indexOf('// Phase 3'));
    assert.match(phase2, /searchDeadline\(\)/,
      'the per-type searches must receive a deadline, or a per-call maxTimeMS bounds nothing that matters');

    assert.match(recall, /\.maxTimeMS\(maxTimeMS\)/,
      'the deadline must reach the Mongo aggregation, not merely be computed');
    assert.match(recall, /settleSearches/,
      'a timed-out collection must not discard the collections that answered');
    assert.match(recall, /search_timeout/,
      'a partial answer must be labelled — an unlabelled short answer is indistinguishable from an empty corpus');
  });

  it('a per-call deadline can only LOWER the instance budget', () => {
    // Letting a request body raise the ceiling hands any caller a denial-of-service lever, and how long the
    // server may spend is the operator's decision. Asserted on the arithmetic rather than on prose.
    assert.match(recall, /Math\.min\(maxTimeMS \?\? RECALL_BUDGET_MS, RECALL_BUDGET_MS\)/,
      'the effective budget must be a min() against the instance ceiling');
    assert.match(recall, /MIN_RECALL_BUDGET_MS/,
      'a floor must exist, or maxTimeMS: 1 is a guaranteed empty answer that reads as a broken parameter');
  });

  it('the rerank skip uses the CALL budget, not the instance one', () => {
    // Otherwise a caller asking for 5s would still have a 20s cross-encoder started at 22s, and the
    // parameter would bound nothing the caller can feel.
    assert.match(recall, /const remaining = effectiveBudgetMs - \(Date\.now\(\) - startedAt\)/,
      'the remaining-budget arithmetic must be against the effective (per-call) budget');
  });
});
