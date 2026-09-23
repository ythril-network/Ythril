/**
 * Hybrid retrieval — RRF fusion and the boundaries it must not cross.
 *
 * The gap this closes: vector search compares meaning, so an opaque identifier (`NMK-240C`, a form id, a
 * clause name) has no useful semantic neighbourhood and the right chunk ranks below plausible prose. The
 * failure is silent — the answer is simply assembled from the wrong passages.
 *
 * Two properties carry the weight, and both are about NOT overreaching:
 *
 *  1. **Fusion reorders; it never filters.** `minScore` stays on the vector score. Reinterpreting a
 *     caller's threshold against a fused rank would change what a fixed threshold returns without anyone
 *     touching it.
 *  2. **A missing lexical channel is survivable.** A space created before the text index existed must
 *     keep searching, just without the lexical half.
 *
 * Run: node --test testing/standalone/hybrid-retrieval.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readGuide, readSplit } from './_docs.mjs';
import { readFileSync } from 'node:fs';

let rrfFuse, RRF_K, hybridSearchEnabled, mergeRecallResults;

before(async () => {
  ({ rrfFuse, RRF_K, hybridSearchEnabled } = await import('../../server/dist/brain/lexical-search.js'));
  ({ mergeRecallResults } = await import('../../server/dist/brain/recall-shape.js'));
});

const ids = m => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

describe('rrfFuse — rank fusion, not score addition', () => {
  it('a document ranked well by BOTH channels beats one that wins a single channel', () => {
    // The entire point of fusing. `b` is 2nd in both; `a` is 1st in one and absent from the other.
    // Agreement between an exact-token match and a semantic match is the strongest signal either gives.
    const fused = rrfFuse([['a', 'b', 'c'], ['d', 'b', 'e']]);
    assert.equal(ids(fused)[0], 'b');
  });

  it('lifts an exact-token match that the vector channel buried — the case this exists for', () => {
    // The article-number scenario: the right chunk IS in the over-fetched pool but sits 5th by
    // similarity, behind plausible-looking prose, while the lexical channel puts it 1st. With a topK of
    // 3 it would not have been in the answer at all.
    const vector = ['prose1', 'prose2', 'prose3', 'prose4', 'NMK-240C'];
    const lexical = ['NMK-240C', 'unrelated-but-wordy'];
    const order = ids(rrfFuse([vector, lexical]));
    assert.equal(order[0], 'NMK-240C');
    assert.ok(order.indexOf('NMK-240C') < 3, 'it must land inside a topK of 3');
  });

  it('but a document with evidence in BOTH channels can still outrank it — by design', () => {
    // Deliberately pinned, because it looks like a bug and is not. Here `prose3` is 3rd by vector AND
    // 2nd lexically; the target is 5th and 1st. Combined evidence wins over a single strong signal —
    // that is what fusing is for. A scheme where "lexical rank 1" always won would just be lexical
    // search with extra steps.
    const fused = rrfFuse([['prose1', 'prose2', 'prose3', 'prose4', 'target'], ['target', 'prose3']]);
    assert.equal(ids(fused)[0], 'prose3');
    // The target still rises from 5th to 2nd, which is the behaviour that matters.
    assert.equal(ids(fused)[1], 'target');
  });

  it('reduces to the other channel\'s order when one channel is empty', () => {
    // A space with no text index contributes nothing. That must be a no-op, not a reshuffle.
    const only = ['a', 'b', 'c'];
    assert.deepEqual(ids(rrfFuse([only, []])), only);
    assert.deepEqual(ids(rrfFuse([[], only])), only);
  });

  it('uses RANK, never magnitude — a runaway score cannot dominate', () => {
    // textScore is unbounded and grows with term rarity; cosine is bounded. Any score-additive scheme
    // would let one channel swamp the other, and the calibration would drift as the corpus grows.
    // Identical rankings must therefore produce identical fused scores regardless of any input score.
    const f1 = rrfFuse([['a', 'b'], ['a', 'b']]);
    const f2 = rrfFuse([['a', 'b'], ['a', 'b']]);
    assert.deepEqual([...f1.entries()], [...f2.entries()]);
    // And the arithmetic is exactly 1/(k+rank), 1-based.
    assert.equal(f1.get('a'), 2 * (1 / (RRF_K + 1)));
    assert.equal(f1.get('b'), 2 * (1 / (RRF_K + 2)));
  });

  it('k damps the top ranks — a bigger k flattens the gap between rank 1 and rank 2', () => {
    const tight = rrfFuse([['a', 'b']], 1);
    const flat = rrfFuse([['a', 'b']], 1000);
    assert.ok(tight.get('a') - tight.get('b') > flat.get('a') - flat.get('b'));
  });
});

describe('the kill switch', () => {
  it('is on by default and off only for the exact env value', () => {
    const prev = process.env['YTHRIL_HYBRID_SEARCH'];
    try {
      delete process.env['YTHRIL_HYBRID_SEARCH'];
      assert.equal(hybridSearchEnabled(), true);
      process.env['YTHRIL_HYBRID_SEARCH'] = 'off';
      assert.equal(hybridSearchEnabled(), false);
      // Not a fuzzy truthiness check: a typo must fail SAFE (hybrid stays on), never silently disable
      // retrieval quality in a way nobody would notice.
      process.env['YTHRIL_HYBRID_SEARCH'] = 'false';
      assert.equal(hybridSearchEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env['YTHRIL_HYBRID_SEARCH'];
      else process.env['YTHRIL_HYBRID_SEARCH'] = prev;
    }
  });
});

describe('minScore stays on the VECTOR score', () => {
  const rec = (id, score, fusedScore) => ({ _id: id, type: 'fact', score, fusedScore, fact: id });

  it('orders by the fused score but filters by the vector score', () => {
    // `low` wins the fused order and is still dropped by a vector-similarity floor. Both halves matter:
    // if minScore used the fused score, a caller's fixed threshold would start returning a different set
    // the moment hybrid shipped, with nobody having touched the threshold.
    const out = mergeRecallResults([], [rec('low', 0.10, 0.99), rec('high', 0.90, 0.01)], 10, 0.5);
    assert.deepEqual(out.map(r => r._id), ['high']);
  });

  it('without minScore, the fused order is what comes back', () => {
    const out = mergeRecallResults([], [rec('low', 0.10, 0.99), rec('high', 0.90, 0.01)], 10);
    assert.deepEqual(out.map(r => r._id), ['low', 'high']);
  });

  it('a rerank score outranks a fused score', () => {
    // Precedence is how much each signal actually knows: the cross-encoder read the query and the
    // passage together; fusion only saw two rankings.
    const a = { ...rec('a', 0.1, 0.99), rerankScore: 0.1 };
    const b = { ...rec('b', 0.1, 0.01), rerankScore: 0.9 };
    assert.deepEqual(mergeRecallResults([], [a, b], 10).map(r => r._id), ['b', 'a']);
  });
});

describe('the source keeps its contracts', () => {
  const lex = readFileSync(new URL('../../server/src/brain/lexical-search.ts', import.meta.url), 'utf8');
  // recall.ts holds the database work; the pure merge/rank/text functions moved to recall-shape.ts when that
  // file was split to pay back its god-file ratchet raise. Both halves are the recall implementation, so the
  // source these assertions read is both — a gate that followed only one half would go quietly vacuous the
  // next time a function moves between them.
  const rec = readFileSync(new URL('../../server/src/brain/recall.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../server/src/brain/recall-shape.ts', import.meta.url), 'utf8');

  it('the lexical query applies the caller\'s eligibility match', () => {
    // Without it, a tag- or filter-scoped recall would resurrect records the caller excluded — a
    // filter bypass, not a ranking bug.
    assert.ok(/find\(\{ \.\.\.eligibility, \$text/.test(lex),
      'eligibility must be merged into the $text query itself, not applied afterwards');
    assert.ok(/eligibility\['tags'\] = \{ \$all: tags \}/.test(rec),
      'tags must use the same $all match the vector path builds');
    assert.ok(rec.includes('buildMongoFilter(filter)'), 'the filter must go through the shared builder');
  });

  it('lexicalSearch never throws — a missing text index degrades to vector-only', () => {
    const body = lex.slice(lex.indexOf('export async function lexicalSearch('), lex.indexOf('export function rrfFuse'));
    assert.ok(body.includes('catch'), 'the query must be caught');
    assert.ok(!/\bthrow\b/.test(body), 'a space without the index must still search');
    assert.ok(body.includes('text index required'),
      'the expected pre-index case must be recognised rather than logged as an error every query');
  });

  it('fusion runs BEFORE the reranker, so the cross-encoder sees the fused pool', () => {
    const body = rec.slice(rec.indexOf('export async function recall('));
    const fuse = body.indexOf('applyLexicalFusion(');
    const rerank = body.indexOf('rerankStage(');
    assert.ok(fuse > 0 && rerank > 0, 'both stages must run');
    assert.ok(fuse < rerank, 'fusion must widen/reorder the pool before the cross-encoder reads it');
  });

  it('fusion may introduce records, but only on a MEASURED score', () => {
    // This assertion used to read "does not introduce records", on the reasoning that a lexically-found
    // record would need a fabricated vector `score` — which `minScore` would then act on. The reasoning
    // was right; the conclusion was avoidable. The embedding is one fetch away and the query vector is
    // in hand, so the similarity is computed rather than invented, and the engine's normalisation is
    // verified against its own output for records present in both channels (see `vector-score.ts`).
    //
    // The bound mattered: the lexical channel exists for opaque identifiers, whose embeddings are
    // nearly arbitrary — so the records it exists to rescue are the ones most likely to sit outside the
    // vector pool, where the old rule could not reach them.
    const fn = rec.slice(rec.indexOf('async function applyLexicalFusion('), rec.indexOf('async function applyRerank('));
    assert.ok(fn.includes('inPool.get(hit._id)'), 'pooled records are still scored in place');
    assert.ok(fn.includes('introduceLexicalOnly('), 'introduction runs from the fusion stage');
    // The guarantee that replaces "never introduces": never introduce a score we cannot prove.
    const intro = rec.slice(rec.indexOf('async function introduceLexicalOnly('));
    assert.ok(intro.includes('if (overlapIds.length === 0) return [];'),
      'with no overlap there is no sample proving the score mapping, so nothing may be introduced');
    assert.ok(intro.includes('scoresAgree(local, known)'),
      'the local reproduction must be checked against the engine on every query');
  });

  it('the text index is on matchedText — the same text the vector channel embedded', () => {
    const life = readFileSync(new URL('../../server/src/spaces/lifecycle.ts', import.meta.url), 'utf8');
    assert.ok(life.includes("{ matchedText: 'text' }"),
      'indexing display fields instead would make records findable through text that is not in their vector');
    assert.ok(life.includes('lexical_text'), 'the index needs a stable name so it can be replaced later');
  });
});

describe('the behaviour change is documented where callers actually look', () => {
  // Shipping a ranking change without updating the docs that describe ranking leaves a guide that is
  // confidently wrong — worse than one that is silent. `minScore` is the sharpest case: it now means
  // something narrower than "the score", and a caller who does not know that will misread their results.
  const guide = readGuide();
  // The user guide is a directory of chapters with a link-list index at the old path, so reading that
  // path alone would check the table of contents for a sentence that lives in a chapter.
  const userguide = readSplit('docs/userguide.md');
  // The authored prose moved to help-sections.ts when `help` gained its `query` parameter: one section list feeds both
  // the full read and the searched read. This gate follows the TEXT, not the tool -- pointed at help.ts it would have
  // gone green on a file that no longer contains a retrieval guide at all.
  const help = readFileSync(new URL('../../server/src/mcp/tools/help-sections.ts', import.meta.url), 'utf8');
  const search = readFileSync(new URL('../../server/src/mcp/tools/search.ts', import.meta.url), 'utf8');

  it('the integration guide no longer claims results are ranked by vector similarity alone', () => {
    assert.ok(!/ranked by vector similarity across all types/.test(guide),
      'that sentence was true before hybrid ranking and is now wrong');
    assert.ok(/Reciprocal\s+Rank\s+Fusion/.test(guide), 'the fusion stage must be explained');
    assert.ok(guide.includes('lexicalScore') && guide.includes('fusedScore'),
      'the new response fields must be documented');
  });

  it('the integration guide states which score minScore filters on', () => {
    assert.ok(/`minScore` always filters on `score`/.test(guide));
  });

  it('the MCP retrieval guide no longer routes exact tokens away from recall', () => {
    assert.ok(!/Rule of thumb: exact criteria → query; fuzzy meaning → recall; both/.test(help),
      'the old rule of thumb predates hybrid ranking and now misroutes callers');
    assert.ok(/HYBRID search/.test(help), 'recall must be described as hybrid');
  });

  it('the recall tool description says it matches exact tokens too', () => {
    assert.ok(!/description: 'Semantically search all knowledge types/.test(search),
      'the description must not still claim purely semantic matching');
    assert.ok(/lexical \(BM25\) ranking/.test(search));
    // …and must not promise per-stage scores the MCP response does not carry. It returns `score` only,
    // on purpose: every field is multiplied by topK and paid for in tokens by whoever called the tool.
    assert.ok(!/plus `lexicalScore`\/`fusedScore`\/`rerankScore`/.test(search),
      'the MCP description must not advertise fields the MCP response omits');
  });

  it('the user guide explains it without jargon', () => {
    assert.ok(/matches meaning \*and\* exact wording/.test(userguide));
  });
});

describe('every aggregation site orders by rankOf, not by raw score', () => {
  // The bug this pins: `recall()` orders each space's results by the best signal it has, and BOTH
  // aggregation sites then re-sorted the merged list by raw `.score` — throwing the fused and reranked
  // ordering away at the last step. It was not a proxy-space edge case: a single-space REST recall still
  // passes through the member merge with one member, so hybrid ranking and reranking were undone on
  // effectively every request that was not the MCP global path. Nothing errored; results were just
  // ordered as if neither feature had shipped.
  const rest = readFileSync(new URL('../../server/src/api/brain/search.ts', import.meta.url), 'utf8');
  const mcp = readFileSync(new URL('../../server/src/mcp/tools/search.ts', import.meta.url), 'utf8');
  // Both halves of the recall implementation: recall.ts kept the database work, recall-shape.ts took the
  // pure merge/rank/text functions when the file was split. rankOf is in the second one now.
  const recall = readFileSync(new URL('../../server/src/brain/recall.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../server/src/brain/recall-shape.ts', import.meta.url), 'utf8');

  const sortsByRawScore = src =>
    (src.match(/\.sort\(\([^)]*\)\s*=>\s*\(?[a-z]\.score\s*\?\?\s*0\)?\s*-/g) ?? []).length;

  // The expression this used to spell out is now `byRankThenId`, the shared comparator — same rule, plus a
  // deterministic tie-break. Rewritten rather than renumbered: asserting the old literal would now be
  // asserting the absence of the tie-break, and this member merge is the LAST sort before the response, so a
  // tie left to the database order here is what a paging caller sees as a repeated record.
  it('the REST recall route merges member spaces by rank, not raw score', () => {
    /*
     * The REST route merges NOTHING now — `POST /api/brain/recall` hands its body to `callTool`, so the
     * member fan-out and its comparator live once, in the tool, and the case below is what checks them.
     * Demanding `all.sort(byRankThenId)` in this file would be demanding the duplicate back.
     *
     * The second half of the claim survives the collapse and is the half worth keeping: whatever this file
     * still does, none of it may sort by raw score. A route that grows a merge again is caught by it.
     */
    if (/all\.sort\(/.test(rest)) {
      assert.ok(/all\.sort\(byRankThenId\)/.test(rest),
        'the member merge must use the shared rank comparator');
    }
    assert.equal(sortsByRawScore(rest), 0, 'no recall path in this file may sort by raw score');
  });

  it('the MCP recall tool merges member spaces by rank, not raw score', () => {
    assert.ok(/all\.sort\(byRankThenId\)/.test(mcp),
      'the member merge must use the shared rank comparator');
    assert.equal(sortsByRawScore(mcp), 0, 'no recall path in this file may sort by raw score');
  });

  it('rankOf is exported, so there is one ordering rule rather than three', () => {
    assert.ok(/export function rankOf\(/.test(recall),
      'a private rankOf is what let two callers invent their own ordering');
  });

  it('the raw-score sorts left in recall.ts are the ones that MUST be raw', () => {
    // Each of the three now ends in `|| byIdAsc(a, b)`, which does not change WHICH signal orders them — it
    // only makes a tie land the same way twice. The count below is unaffected: the pattern matches the head of
    // the comparator.
    // Three survive on purpose, and none of them is an output ordering:
    //   1. the pre-fusion sort, which ESTABLISHES the vector ranking fusion consumes;
    //   2. the vector channel handed to RRF, which must be the vector order by definition;
    //   3. `findSimilar`, which starts from a stored vector with no query text — there is no lexical
    //      or cross-encoder signal to prefer, so raw similarity is the only signal there is.
    // A fourth raw-score sort exists in `applyRerank` (choosing which candidates survive the cap) but
    // reads through a Map, so it does not match this pattern. Counted rather than listed so a NEW raw
    // sort appearing anywhere in this file fails here.
    assert.equal(sortsByRawScore(recall), 3);
  });
});
