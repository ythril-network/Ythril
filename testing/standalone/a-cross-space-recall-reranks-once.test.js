/**
 * A recall across many spaces asks the reranker ONCE, over the merged candidate pool.
 *
 * ## How this was found
 *
 * Reported by the platform operator, 2026-09-23T1842Z. One `recall` naming no space, on an instance that
 * reaches 15 spaces, produced THIRTEEN concurrent `POST /v1/rerank` — ten of which timed out under one shared
 * deadline, so the answer came back `degraded: ["rerank_unavailable"]` with 2 of 10 rows reranked. Their
 * inference: stage 3 fans out per space the way the query EMBEDDING used to, before
 * `recall-embeds-the-query-once.test.js`.
 *
 * Confirmed in source: `recallGlobal` called `recall` once per space, and every `recall` ran its own
 * cross-encoder pass over its own pool. N spaces, N rerank requests of up to `MAX_CANDIDATES` passages each,
 * and N sets of scores that were then merged as if one pass had produced them.
 *
 * ## Why the assertion is on the CALL COUNT
 *
 * Same reason as the embedding test: the results look right either way — the rows come back ordered — so
 * the only property that separates the fan-out from the fix is how many times the reranker is asked. Two
 * halves: the pool function scores any number of spaces' candidates in one call (behaviour, via an injected
 * scorer), and `recallGlobal` routes through it instead of letting each space rerank (structure, because the
 * wiring needs a live Mongo to run).
 *
 * Run: node --test testing/standalone/a-cross-space-recall-reranks-once.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let rerankPool, MAX_CANDIDATES;
before(async () => {
  ({ rerankPool } = await import('../../server/dist/brain/rerank-pool.js'));
  ({ MAX_CANDIDATES } = await import('../../server/dist/brain/rerank-client.js'));
});

const fact = (id, score) => ({ _id: id, type: 'fact', fact: `fact ${id}`, score, tags: [] });

/** Thirteen spaces' worth of candidates, forty each — the operator's shape. */
const poolOf = (spaces, perSpace) => {
  const out = [];
  for (let s = 0; s < spaces; s++) {
    for (let i = 0; i < perSpace; i++) out.push(fact(`s${s}-r${i}`, 0.9 - i * 0.01 - s * 0.0001));
  }
  return out;
};

describe('the pool is scored in one request, however many spaces fed it', () => {
  it('thirteen spaces, one scorer call', async () => {
    const calls = [];
    const scorer = async (query, passages) => {
      calls.push(passages.length);
      return passages.map((_, index) => ({ index, score: 1 - index / 1000 }));
    };
    await rerankPool('q', [], poolOf(13, 40), 10_000, () => {}, scorer);
    assert.equal(calls.length, 1, `the reranker was asked ${calls.length} times for one recall`);
    assert.ok(calls[0] <= MAX_CANDIDATES,
      `${calls[0]} passages in one request — the absolute cap is ${MAX_CANDIDATES}, and it is a cost ceiling`);
  });

  it('the cap keeps the most plausible candidates, not an arbitrary slice', async () => {
    let sent = [];
    const scorer = async (q, passages) => { sent = passages; return passages.map((_, index) => ({ index, score: 0 })); };
    const pool = poolOf(13, 40);
    await rerankPool('q', [], pool, 10_000, () => {}, scorer);
    const best = [...pool].sort((a, b) => b.score - a.score)[0];
    assert.ok(sent.some(p => p.includes(best._id)), 'the highest-scoring candidate must be among those reranked');
  });

  it('a record reached twice is scored once and both references carry the score', async () => {
    const a = fact('dup', 0.8), b = fact('dup', 0.8);
    const scorer = async (q, passages) => passages.map((_, index) => ({ index, score: 7 }));
    await rerankPool('q', [a], [b], 10_000, () => {}, scorer);
    assert.equal(a.rerankScore, 7);
    assert.equal(b.rerankScore, 7);
  });

  it('no answer from the reranker is reported, not hidden', async () => {
    const reasons = [];
    const pool = poolOf(2, 3);
    await rerankPool('q', [], pool, 10_000, r => reasons.push(r), async () => null);
    assert.deepEqual(reasons, ['rerank_unavailable']);
    assert.ok(pool.every(r => r.rerankScore === undefined), 'a failed pass must leave the fused order untouched');
  });
});

describe('recallGlobal reranks the merged pool, and the spaces do not', () => {
  const src = stripComments(readFileSync('server/src/brain/recall.ts', 'utf8'));
  const fn = (name) => {
    const i = src.indexOf(`export async function ${name}(`);
    assert.ok(i >= 0, `${name} is gone from recall.ts — re-point this test`);
    const next = src.indexOf('\nexport ', i + 10);
    return src.slice(i, next < 0 ? undefined : next);
  };

  it('each space is asked for its pool with the rerank deferred', () => {
    // On the CALL, not anywhere in the function: a `const deferRerank` that never reaches `recall` would
    // satisfy a bare name match while every space still reranked.
    assert.match(fn('recallGlobal'), /recall\(id,[^;]*\.\.\.opts, embedded, deferRerank \}/,
      'recallGlobal must tell the per-space calls not to rerank, or every space still asks the reranker itself');
  });

  it('and the merged pool is reranked once, after the fan-out', () => {
    const g = fn('recallGlobal');
    const fanOut = g.indexOf('Promise.all(');
    const stage = g.indexOf('rerankStage(');
    assert.ok(fanOut >= 0 && stage > fanOut,
      'the rerank stage must run AFTER the per-space results are gathered, over all of them');
    assert.equal([...g.matchAll(/rerankStage\(/g)].length, 1, 'exactly one rerank stage per cross-space recall');
  });

  it('recall skips its own stage when the caller will rerank', () => {
    assert.match(fn('recall'), /opts\?\.deferRerank/,
      'recall must honour deferRerank, or the pool is reranked N times and then once more');
  });
});
