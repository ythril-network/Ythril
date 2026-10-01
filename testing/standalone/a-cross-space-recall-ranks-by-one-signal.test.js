/**
 * A recall across spaces orders its merged results by ONE signal every one of them carries (`Q-82`).
 *
 * ## How this was found
 *
 * `stampFusion` fuses a space's candidates when that space's lexical channel found anything, and then EVERY
 * candidate of that space carries a `fusedScore` — or none does. So within one space the ordering is uniform.
 * Across spaces it was not: `recallGlobal` sorted the flattened results with `byRankThenId`, whose `rankOf` reads
 * `rerankScore ?? fusedScore ?? score`. A fused score is a rank score, at most about 0.033; a cosine `score` sits
 * between about 0.3 and 0.9. So without a reranker every result of a space whose text search found nothing
 * outranked every result of a space whose text search found something — whole spaces came back as blocks, and
 * the spaces that matched the query's words best came LAST. With a reranker the cap's unscored tail mixed the
 * same way. Two fused spaces were not right either: each space's ranks start at 1, so they interleaved
 * round-robin rather than by relevance.
 *
 * ## The fix, and what this holds
 *
 * The merged pool is fused once, over the merged lists: one vector channel — every candidate by its cosine
 * score, which IS comparable across spaces, one query vector against one model — and each space's per-type
 * lexical ranking as its own channel, the same rule `Q-159` set for types inside a space. After it, every merged
 * result carries a `fusedScore` from the same fusion, so `byRankThenId` compares like with like.
 *
 * Run: node --test testing/standalone/a-cross-space-recall-ranks-by-one-signal.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let lexical, shape;
before(async () => {
  lexical = await import('../../server/dist/brain/lexical-search.js');
  shape = await import('../../server/dist/brain/recall-shape.js');
});

const fact = (id, score) => ({ _id: id, type: 'fact', fact: id, score, tags: [] });

/**
 * Two spaces' answers as each `recall` hands them back: A's text search found `a3`, so A was fused on its own;
 * B's found nothing, so B was not. The cosine scores interleave: b1 0.66, a1 0.65, b2 0.61, a2 0.60, …
 */
function twoSpaces() {
  const a = [fact('a1', 0.65), fact('a2', 0.60), fact('a3', 0.55)];
  const b = [fact('b1', 0.66), fact('b2', 0.61), fact('b3', 0.56)];
  const aLexical = [['a3']];
  lexical.stampFusion(a, [], aLexical);   // what space A's own recall did
  return { answers: [{ results: a, lexicalPerType: aLexical }, { results: b, lexicalPerType: [] }] };
}

describe('the premise, pinned: ranking the per-space answers as they come back puts spaces in blocks', () => {
  it('every unfused result outranks every fused one', () => {
    const { answers } = twoSpaces();
    const order = answers.flatMap(x => x.results).sort(shape.byRankThenId).map(r => r._id);
    assert.deepEqual(order.slice(0, 3).sort(), ['b1', 'b2', 'b3'],
      'if this stops holding, byRankThenId changed — re-read what the merge below protects against');
  });
});

describe('the merged answer is ordered by one signal', () => {
  it('fuseAcrossSpaces exists', () => {
    assert.equal(typeof lexical.fuseAcrossSpaces, 'function', 'no cross-space fusion — the merge still sorts per-space scores');
  });

  it('every merged result carries a fusedScore from the one fusion', () => {
    const { answers } = twoSpaces();
    const { merged, fused } = lexical.fuseAcrossSpaces(answers);
    assert.equal(fused, true);
    assert.equal(merged.length, 6);
    assert.ok(merged.every(r => typeof r.fusedScore === 'number'), 'a result was left on its own space’s scale');
    // 5.6.x: main also asserts `vectorRank` here, a response field added after 5.6.0 that this patch does not carry.
  });

  it('results from a fused and an unfused space interleave by relevance', () => {
    const { answers } = twoSpaces();
    const order = lexical.fuseAcrossSpaces(answers).merged.sort(shape.byRankThenId).map(r => r._id);
    // a3 is the one text match, so it is lifted; everything else keeps its place by meaning.
    assert.equal(order[0], 'a3', 'the lexical match must be lifted to the top of the merged answer');
    assert.deepEqual(order.slice(1), ['b1', 'a1', 'b2', 'a2', 'b3'],
      'the rest must interleave by cosine score, not come back space by space');
  });

  it('with no lexical hit anywhere, nothing is stamped and the cosine order stands', () => {
    const a = [fact('a1', 0.65)], b = [fact('b1', 0.66)];
    const { merged, fused } = lexical.fuseAcrossSpaces([{ results: a, lexicalPerType: [] }, { results: b, lexicalPerType: [] }]);
    assert.equal(fused, false);
    assert.ok(merged.every(r => r.fusedScore === undefined));
    assert.deepEqual(merged.sort(shape.byRankThenId).map(r => r._id), ['b1', 'a1']);
  });
});

describe('recallGlobal fuses the merged pool before it reranks or orders it', () => {
  const src = stripComments(readFileSync('server/src/brain/recall.ts', 'utf8'));
  const i = src.indexOf('export async function recallGlobal(');
  const g = src.slice(i, src.indexOf('\nexport ', i + 10));

  it('each space hands back its lexical ranking', () => {
    assert.match(g, /observeLexical/, 'recallGlobal does not collect the per-space lexical rankings');
  });
  it('the merged pool is fused after the fan-out and before the rerank and the sort', () => {
    const fanOut = g.indexOf('Promise.all(');
    const fuse = g.indexOf('fuseAcrossSpaces(');
    const stage = g.indexOf('rerankStage(');
    const sort = g.indexOf('sort(byRankThenId)');
    assert.ok(fanOut >= 0 && fuse > fanOut, 'the merged pool must be fused after every space answered');
    assert.ok(stage > fuse && sort > fuse, 'and before the rerank chooses its candidates and the answer is ordered');
    assert.match(g, /rerankStage\([^;]*fused \? 'fused' : 'vector'/, 'the rerank must pick its candidates by the fused order when there is one');
  });
});
