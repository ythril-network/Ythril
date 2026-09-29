/**
 * A result the cross-encoder scored always ranks above one it did not — whatever the two numbers are.
 *
 * ## How this was found
 *
 * Reported by the platform canary on the 5.4.3 roll, 2026-09-27T0824Z (`Q-79`). An unfiltered single-space
 * recall came back with no `rerankScore` on any of its five results and no `degraded`, while every rerank
 * batch had answered 200; a `types: [file]` recall of the same space reranked. Their guess was a pass that
 * outlived its deadline and was dropped without saying so. Every path that drops a pass already says so —
 * the cause was two facts that were each correct alone:
 *
 * - the pool is scored up to `MAX_CANDIDATES` (100), a cost ceiling, and an unfiltered recall over five types
 *   gathers more than that, so a tail of candidates keeps no `rerankScore`;
 * - the ranking read `rerankScore ?? fusedScore ?? score`, and a cross-encoder's relevance (often below 0.1)
 *   and a cosine similarity (0.3–0.9) are unrelated scales, so every unscored candidate outranked every
 *   scored one. The reranker ran, and its answer was ranked out of the result.
 *
 * ## What is asserted, and why at these levels
 *
 * The comparator and the pool are pure, so the rule is exercised on them directly with an injected scorer:
 * the ORDER is the defect, and the order is fully decided here. The floor results and the lexical rescues
 * are asserted to be INSIDE the scored set, because a tier that ranks unscored results last would otherwise
 * sink exactly the records the floor and the lexical channel exist to keep. The wiring that passes the
 * candidate order is asserted on the source, because it needs a live Mongo to run.
 *
 * Run: node --test testing/standalone/a-reranked-result-always-outranks-an-unscored-one.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let rerankPool, MAX_CANDIDATES, mergeRecallResults, byRankThenId, stampFusion;
before(async () => {
  ({ rerankPool } = await import('../../server/dist/brain/rerank-pool.js'));
  ({ MAX_CANDIDATES } = await import('../../server/dist/brain/rerank-client.js'));
  ({ mergeRecallResults, byRankThenId } = await import('../../server/dist/brain/recall-shape.js'));
  ({ stampFusion } = await import('../../server/dist/brain/lexical-search.js'));
});

const pad = (i) => String(i).padStart(3, '0');
const fact = (id, score, extra = {}) => ({ _id: id, type: 'fact', fact: `fact ${id}`, score, tags: [], ...extra });
/** Candidates with falling vector scores, well inside the cosine range. */
const poolOf = (n, prefix = 'r') => Array.from({ length: n }, (_, i) => fact(`${prefix}${pad(i)}`, 0.9 - i * 0.004));
/** A cross-encoder whose relevance sits far BELOW the cosine range — the shape that exposed the defect. */
const lowScorer = async (_q, passages) => passages.map((_, index) => ({ index, score: 0.05 - index * 0.0001 }));

describe('the comparator: scored beats unscored, then the number', () => {
  it('a reranked result at 0.01 outranks an unreranked one at 0.9', () => {
    const scored = fact('b', 0.2, { rerankScore: 0.01 });
    const unscored = fact('a', 0.9);
    assert.deepEqual([unscored, scored].sort(byRankThenId).map(r => r._id), ['b', 'a'],
      'the result the cross-encoder judged was ranked below one it never saw, on a number from another scale');
  });

  it('among scored results the rerank score decides, among unscored ones the rest of the chain', () => {
    const rows = [
      fact('u-low', 0.3), fact('s-low', 0.9, { rerankScore: 0.2 }),
      fact('u-high', 0.8), fact('s-high', 0.1, { rerankScore: 0.7 }),
    ];
    assert.deepEqual(rows.sort(byRankThenId).map(r => r._id), ['s-high', 's-low', 'u-high', 'u-low']);
  });

  it('with nothing reranked the order is exactly what it was', () => {
    const rows = [fact('x', 0.5, { fusedScore: 0.02 }), fact('y', 0.9, { fusedScore: 0.03 }), fact('z', 0.7, { fusedScore: 0.01 })];
    assert.deepEqual(rows.sort(byRankThenId).map(r => r._id), ['y', 'x', 'z']);
  });
});

describe('a pool larger than the cap', () => {
  it('returns reranked results on top, not the unscored tail (the canary\'s recall)', async () => {
    const pool = poolOf(MAX_CANDIDATES + 20);
    const noted = [];
    await rerankPool('q', [], pool, 10_000, r => noted.push(r), lowScorer);
    const top = mergeRecallResults([], pool, 5);
    assert.ok(top.every(r => typeof r.rerankScore === 'number'),
      `the top 5 came back unreranked with nothing saying so: ${top.map(r => `${r._id}:${r.rerankScore}`).join(', ')}`);
    // Nothing was skipped — the cap is a cost ceiling — so this is not a degradation.
    assert.deepEqual(noted, []);
  });

  it('keeps the unscored tail in the answer, below every scored result, when topK reaches past the cap', async () => {
    const pool = poolOf(MAX_CANDIDATES + 20);
    await rerankPool('q', [], pool, 10_000, () => {}, lowScorer);
    const all = mergeRecallResults([], pool, MAX_CANDIDATES + 20);
    assert.equal(all.length, MAX_CANDIDATES + 20, 'the tail was dropped instead of ranked');
    const firstUnscored = all.findIndex(r => r.rerankScore === undefined);
    assert.equal(firstUnscored, MAX_CANDIDATES, 'an unscored result sits among the scored ones');
  });

  it('a partial provider answer ranks the rows it dropped below the ones it scored', async () => {
    const pool = poolOf(10);
    // The provider scores the even indices only.
    const partial = async (_q, passages) => passages.map((_, index) => ({ index, score: 0.01 })).filter(s => s.index % 2 === 0);
    await rerankPool('q', [], pool, 10_000, () => {}, partial);
    const ranked = mergeRecallResults([], pool, 10);
    assert.ok(ranked.slice(0, 5).every(r => r.rerankScore !== undefined), ranked.map(r => r._id).join(','));
  });
});

describe('what the cap keeps', () => {
  it('scores every floor result, even one whose vector score is below the cut', async () => {
    const pool = poolOf(MAX_CANDIDATES + 20);
    const floor = fact('floor-1', 0.01);
    await rerankPool('q', [floor], pool, 10_000, () => {}, lowScorer);
    assert.equal(typeof floor.rerankScore, 'number', 'a guaranteed result was left unscored, so it now sinks');
  });

  it('orders more floor results than the cap by the same key, deterministically', async () => {
    const floors = poolOf(MAX_CANDIDATES + 5, 'g');
    await rerankPool('q', floors, [], 10_000, () => {}, lowScorer);
    const unscored = floors.filter(r => r.rerankScore === undefined).map(r => r._id);
    assert.deepEqual(unscored, ['g100', 'g101', 'g102', 'g103', 'g104']);
  });

  it('in a fused single-space pool, scores the lexical rescue the vector order would cut', async () => {
    const pool = poolOf(MAX_CANDIDATES + 20).map((r, i) => ({ ...r, fusedScore: 0.02 - i * 0.0001 }));
    // Lowest vector score in the pool, highest fused rank: an exact-token hit the lexical channel lifted.
    const rescue = fact('rescue', 0.05, { fusedScore: 0.05 });
    pool.push(rescue);
    await rerankPool('q', [], pool, 10_000, () => {}, lowScorer, { order: 'fused' });
    assert.equal(typeof rescue.rerankScore, 'number', 'the record lexical fusion rescued was cut from the scored set');
  });

  it('in a cross-space pool, orders the cap by vector score, which is comparable across spaces', async () => {
    // RRF is rank-based: every space's rank 1 fuses to the same value, so a fused key across spaces would
    // take the top few of every space regardless of relevance.
    const a = poolOf(60, 'a').map((r, i) => ({ ...r, spaceId: 'A', fusedScore: 1 / (61 + i) }));
    const b = poolOf(60, 'b').map((r, i) => ({ ...r, score: r.score - 0.5, spaceId: 'B', fusedScore: 1 / (61 + i) }));
    const pool = [...a, ...b];
    await rerankPool('q', [], pool, 10_000, () => {}, lowScorer, { order: 'vector' });
    assert.ok(a.every(r => r.rerankScore !== undefined), 'the more relevant space lost cap slots to the less relevant one');
  });
});

describe('floor results are fused with the pool', () => {
  it('a floor copy of a pool record, and a floor record outside the pool, both carry a fused score', () => {
    const pool = [fact('p1', 0.9), fact('p2', 0.8)];
    const floors = [fact('p1', 0.9), fact('f1', 0.3)];
    const fused = stampFusion(pool, floors, [['f1', 'p2']]);
    assert.equal(fused, true);
    for (const r of [...pool, ...floors]) {
      assert.equal(typeof r.fusedScore, 'number', `${r._id} kept only a vector score, so it competes on another scale`);
    }
    assert.equal(floors[0].fusedScore, pool[0].fusedScore, 'two copies of one record fused differently');
  });

  it('stamps nothing when the lexical channel found nothing', () => {
    const pool = [fact('p1', 0.9)];
    assert.equal(stampFusion(pool, [], [[]]), false);
    assert.equal(pool[0].fusedScore, undefined);
  });
});

describe('the wiring (source)', () => {
  const recallSrc = stripComments(readFileSync(new URL('../../server/src/brain/recall.ts', import.meta.url), 'utf8'));

  it('single-space recall hands the pool order to the rerank stage, and fuses the floor results', () => {
    const body = recallSrc.slice(recallSrc.indexOf('export async function recall('), recallSrc.indexOf('export async function recallGlobal('));
    assert.match(body, /applyLexicalFusion\([^;]*guaranteed/, 'the floor results are left out of fusion');
    assert.match(body, /rerankStage\([^;]*fused \? 'fused' : 'vector'/, 'the rerank stage is not told whether one fusion ranked the pool');
  });

  it('the cross-space pass orders its cap by vector score', () => {
    const body = recallSrc.slice(recallSrc.indexOf('export async function recallGlobal('));
    assert.match(body, /rerankStage\([^;]*'vector'/, 'the merged pool is capped on a key that does not compare across spaces');
  });
});

describe('every multi-space recall goes through recallGlobal (Q-81)', () => {
  it('no door fans recall() out over members by hand', () => {
    /*
     * A fan-out written at the door skips the ONE embedding and the ONE rerank pass `recallGlobal` makes:
     * the proxy branch of the MCP tool did exactly that after P-35 fixed the no-space branch, so a recall on
     * a proxy of thirteen members still sent thirteen rerank requests. REST reaches the same tool.
     */
    for (const file of ['../../server/src/mcp/tools/search.ts', '../../server/src/api/brain/search.ts']) {
      const src = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'));
      assert.doesNotMatch(src, /\.map\(\s*\w+\s*=>\s*recall\(/, `${file} fans recall() out over spaces by hand`);
    }
  });
});
