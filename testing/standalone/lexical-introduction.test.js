/**
 * The lexical channel may introduce records, and only on a score it can prove.
 *
 * ## What changed and why
 *
 * Hybrid retrieval could reorder the vector pool but never add to it. The stated reason was that a
 * lexically-found record has no measured vector similarity, so admitting it would need a fabricated
 * score or a guessed reproduction of the search engine's normalisation — and `minScore` acts on that
 * number, so a wrong one silently changes which results a fixed threshold returns.
 *
 * The bound had a sharp edge: the lexical channel exists for opaque identifiers (part codes, clause
 * names, `event-qps`) whose embeddings are nearly arbitrary — which makes those records the *most*
 * likely to fall outside the vector over-fetch, i.e. exactly the ones it could not reach. The channel
 * was weakest where it was needed.
 *
 * Neither horn of the objection is forced. The embedding is one fetch away and the query vector is in
 * hand, so similarity is computed exactly; and the normalisation is checked rather than assumed, against
 * the engine's own output for records that appear in both channels.
 *
 * ## What is actually pinned here
 *
 * The arithmetic, and — more importantly — the three ways this must REFUSE. A feature that introduces
 * records on an unverified score is worse than one that introduces nothing, so the refusals are the
 * part worth testing.
 *
 * Run: node --test testing/standalone/lexical-introduction.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bodyOf } from './_structural-window.mjs';

const SRC = 'server/src/brain/vector-score.ts';
const RECALL_SRC = 'server/src/brain/recall.ts';

// Transpile the real module with the real compiler; a hand-rolled type-strip would change what is
// under test without saying so.
const vs = await (async () => {
  const ts = await import('typescript');
  const js = ts.default.transpileModule(readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
})();

const { dot, norm, cosineSimilarity, euclideanDistance, atlasVectorScore, atlasScoreFromParts, scoresAgree, SCORE_AGREEMENT_EPSILON } = vs;

describe('the arithmetic', () => {
  it('dot product', () => assert.equal(dot([1, 2, 3], [4, 5, 6]), 32));
  it('norm', () => assert.equal(norm([3, 4]), 5));

  it('cosine of identical vectors is 1', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
  });
  it('cosine of orthogonal vectors is 0', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it('cosine of opposed vectors is -1', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-12);
  });
  it('cosine divides by the real norms rather than assuming unit length', () => {
    // Stored vectors are normalised by the pipeline, but only to within float error, and a vector may
    // predate that guarantee. Scaling one input must not change the angle.
    assert.ok(Math.abs(cosineSimilarity([3, 0], [1, 0]) - 1) < 1e-12);
  });
  it('a zero vector yields 0 rather than NaN', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
  it('euclidean distance', () => assert.equal(euclideanDistance([0, 0], [3, 4]), 5));
});

describe('reproducing the engine score', () => {
  it('cosine maps to (1+cos)/2, so identical is 1 and opposed is 0', () => {
    assert.ok(Math.abs(atlasVectorScore([1, 0], [1, 0], 'cosine') - 1) < 1e-12);
    assert.ok(Math.abs(atlasVectorScore([1, 0], [-1, 0], 'cosine') - 0) < 1e-12);
    assert.ok(Math.abs(atlasVectorScore([1, 0], [0, 1], 'cosine') - 0.5) < 1e-12);
  });

  it('dotProduct maps to (1+dot)/2', () => {
    assert.ok(Math.abs(atlasVectorScore([1, 0], [1, 0], 'dotProduct') - 1) < 1e-12);
    assert.ok(Math.abs(atlasVectorScore([0.5, 0], [1, 0], 'dotProduct') - 0.75) < 1e-12);
  });

  it('euclidean maps to 1/(1+distance)', () => {
    assert.equal(atlasVectorScore([0, 0], [0, 0], 'euclidean'), 1);
    assert.equal(atlasVectorScore([0, 0], [3, 4], 'euclidean'), 1 / 6);
  });

  it('every mapping lands in (0, 1]', () => {
    // set-claim: the three similarity metrics Atlas vector search offers, an external vocabulary. The
    // parameter type is that union and is erased at runtime; a fourth would be Atlas adding one.
    for (const sim of ['cosine', 'dotProduct', 'euclidean']) {
      for (const [a, b] of [[[1, 0], [1, 0]], [[1, 0], [-1, 0]], [[1, 0], [0, 1]], [[0.6, 0.8], [0.8, 0.6]]]) {
        const s = atlasVectorScore(a, b, sim);
        assert.ok(s !== null && s >= 0 && s <= 1, `${sim} produced ${s}`);
      }
    }
  });
});

/**
 * The mapping is used by a caller that never holds both vectors.
 *
 * `matchFreshWrites` scores a few hundred documents inside an aggregation pipeline, because shipping that
 * many 768-dimension embeddings over the wire on every duplicate check is not a thing to do. It therefore
 * computes only `dot` and the document's norm, and maps them through `atlasScoreFromParts`.
 *
 * That split is only safe while the two entry points cannot disagree — the "one rule, two implementations"
 * shape this repo has been bitten by four times. These pin them together for every metric, including the
 * degenerate inputs where a shortcut would look right on ordinary vectors.
 */
describe('the mapping has one implementation, reachable two ways', () => {
  const PAIRS = [
    [[1, 0], [1, 0]], [[1, 0], [-1, 0]], [[1, 0], [0, 1]], [[0.6, 0.8], [0.8, 0.6]],
    [[3, 0], [1, 0]],          // unequal magnitudes — cosine must divide by the real norms
    [[0.1, -0.2, 0.3], [-0.4, 0.5, -0.6]],
  ];

  it('atlasVectorScore and atlasScoreFromParts agree on every metric', () => {
    // set-claim: the three similarity metrics Atlas vector search offers, an external vocabulary -- the
    // same closed set as the case above, asserted for the second scoring path.
    // Currently true by construction — atlasVectorScore delegates. That is the point: this fails the day
    // someone reintroduces a second implementation, which is exactly when it needs to.
    for (const sim of ['cosine', 'dotProduct', 'euclidean']) {
      for (const [a, b] of PAIRS) {
        const whole = atlasVectorScore(a, b, sim);
        const parts = atlasScoreFromParts(dot(a, b), norm(a), norm(b), sim);
        assert.ok(Math.abs(whole - parts) < 1e-12, `${sim} ${JSON.stringify([a, b])}: ${whole} vs ${parts}`);
      }
    }
  });

  it('euclidean reconstructs the distance from the primitives', () => {
    // |a-b|² = |a|² + |b|² - 2·dot. Worth its own case: it is the one metric whose identity is not
    // obvious, and getting it wrong yields plausible numbers rather than absurd ones.
    //
    // Held to 1e-7, not 1e-12, and that is the measurement rather than a shrug: forming the squares
    // before the cancellation instead of after costs about 1.5e-8. Four orders of magnitude inside
    // SCORE_AGREEMENT_EPSILON, and the price of one implementation instead of two.
    for (const [a, b] of PAIRS) {
      const viaParts = atlasScoreFromParts(dot(a, b), norm(a), norm(b), 'euclidean');
      assert.ok(Math.abs(viaParts - 1 / (1 + euclideanDistance(a, b))) < 1e-7);
    }
  });

  it('identical vectors do not fall through a negative square root', () => {
    // Float error pushes |a|² + |b|² - 2·dot below zero when a === b; unclamped that is NaN, and
    // `NaN >= threshold` is false, so the most obvious duplicate there is would be silently dropped.
    const v = [0.37, -0.91, 0.18];
    const s = atlasScoreFromParts(dot(v, v), norm(v), norm(v), 'euclidean');
    assert.ok(Number.isFinite(s), 'must not be NaN');
    assert.ok(s <= 1 && Math.abs(s - 1) < 1e-7, `identical vectors should score ~1, got ${s}`);
  });

  it('a zero norm yields the same score both ways rather than NaN', () => {
    assert.equal(atlasScoreFromParts(0, 0, 1, 'cosine'), atlasVectorScore([0, 0], [1, 1], 'cosine'));
  });

  it('an unrecognised metric yields null from the parts entry point too', () => {
    assert.equal(atlasScoreFromParts(1, 1, 1, 'jaccard'), null);
  });
});

describe('refusing to score rather than scoring wrongly', () => {
  it('mismatched dimensions yield null, not a truncated comparison', () => {
    // A corpus mid-migration between embedding models holds both shapes. A dot product over the
    // overlapping prefix is not a similarity at all.
    assert.equal(atlasVectorScore([1, 0, 0], [1, 0], 'cosine'), null);
  });
  it('an empty vector yields null', () => {
    assert.equal(atlasVectorScore([], [], 'cosine'), null);
  });
  it('an unrecognised metric yields null', () => {
    assert.equal(atlasVectorScore([1, 0], [1, 0], 'jaccard'), null);
  });
});

describe('the agreement check', () => {
  it('accepts float-level drift', () => {
    assert.equal(scoresAgree(0.8551234, 0.8551235), true);
  });
  it('rejects a genuinely different formula', () => {
    // The failure it guards against is off by a lot: e.g. raw cosine where the engine reports (1+cos)/2.
    assert.equal(scoresAgree(0.71, 0.855), false);
  });
  it('the epsilon is a same-formula test, not a precision test', () => {
    assert.ok(SCORE_AGREEMENT_EPSILON >= 1e-6 && SCORE_AGREEMENT_EPSILON <= 1e-2);
  });
});

// ── The wiring, so the refusals cannot be dropped without a test failing ─────

/**
 * The fresh-write scan is an ADDITION to the duplicate check, and must never be able to subtract.
 *
 * `checkDuplicates` runs both halves under one `Promise.all`, which rejects as a unit — so a throw from the
 * collection scan would reach the outer catch and return `[]` for the whole check, discarding index results
 * that were already in hand. That is strictly worse than not having the scan at all, and it is invisible:
 * an empty duplicate list reads as "no duplicates".
 */
describe('the fresh-write scan cannot take the index half down with it', () => {
  const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const recallSrc = strip(readFileSync(RECALL_SRC, 'utf8'));
  const freshSrc = strip(readFileSync('server/src/brain/fresh-writes.ts', 'utf8'));

  it('the call site catches, because Promise.all rejects as a unit', () => {
    assert.match(recallSrc, /matchFreshWrites\([^)]*\)\.catch\(\(\) => \[\]\)/);
  });

  it('the scan reads its own config INSIDE the try', () => {
    // getEmbeddingConfig() above the try was the one way this could throw past its own handler.
    const body = freshSrc.slice(freshSrc.indexOf('export async function matchFreshWrites'));
    const tryAt = body.indexOf('try {');
    const cfgAt = body.indexOf('getEmbeddingConfig()');
    assert.ok(tryAt > 0 && cfgAt > tryAt,
      'getEmbeddingConfig() must be inside the try, or a config failure discards the index results too');
  });

  it('every exit from the scan is a value, never a throw', () => {
    assert.match(freshSrc, /catch \(err\) \{[\s\S]*?return \[\];\s*\}/);
  });
});

describe('introduction is gated on evidence', () => {
  const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const src = strip(readFileSync(RECALL_SRC, 'utf8'));
  const fn = bodyOf(src, 'introduceLexicalOnly');

  it('the function exists and is reached from fusion', () => {
    assert.ok(fn.length > 100, 'introduceLexicalOnly should exist');
    assert.match(src, /introduceLexicalOnly\(/);
  });

  it('declines when there is no overlap to verify against', () => {
    // With no record in both channels there is no sample proving the mapping, so there is no evidence.
    assert.match(fn, /if \(overlapIds\.length === 0\) return \[\];/);
  });

  it('declines when the reproduction disagrees with the engine', () => {
    assert.match(fn, /scoresAgree\(local, known\)/);
    assert.match(fn, /Not introducing lexical-only records/);
  });

  it('declines a candidate whose vector cannot be compared', () => {
    assert.match(fn, /if \(score === null\) continue;/);
  });

  it('never lets the raw embedding into a result', () => {
    // Results are returned to API and MCP callers; a 768-float array per record would be a large,
    // silent payload regression on top of leaking an internal.
    assert.match(fn, /delete doc\['embedding'\]/);
  });

  it('applies the caller eligibility to the fetch', () => {
    // A channel that skipped tags/filter would resurrect records the caller excluded.
    assert.match(fn, /\$match: \{ \.\.\.eligibility/);
  });

  it('is capped, so a broad lexical match cannot flood the pool', () => {
    assert.match(fn, /newIds\.length < cap/);
  });

  it('introduced records join the pool BEFORE the fusion ranking is computed', () => {
    // Introducing after `vectorRanked` is built would add records that fusion never ranked, which is
    // how an introduced record would end up with no fusedScore and sort below everything.
    // The ranking moved into `stampFusion` (`Q-79`, so the floor results are ranked with the pool); the
    // order that matters is the call to it, inside `applyLexicalFusion`.
    const at = src.indexOf('async function applyLexicalFusion');
    const intro = src.indexOf('introduceLexicalOnly(', at);
    const fuse = src.indexOf('stampFusion(', at);
    assert.ok(intro > 0 && fuse > intro, 'introduction must precede the vector ranking');
  });

  it('the whole path stays behind the hybrid kill switch', () => {
    // Every call of the fusion step is guarded by the switch, in either spelling of the guard.
    const calls = [...src.matchAll(/applyLexicalFusion\(/g)].length - 1; // minus the declaration
    const guarded = [...src.matchAll(/hybridSearchEnabled\(\)\s*(?:&&\s*await\s+|\)\s*\{\s*await\s+)applyLexicalFusion\(/g)].length;
    assert.ok(calls >= 1, 'the fusion step is never called — re-point this gate');
    assert.equal(guarded, calls, 'a fusion call runs without the hybrid kill switch');
  });
});
