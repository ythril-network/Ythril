/**
 * Reranker — dialect resolution, response parsing, bounds, and the degrade-never-fail contract.
 *
 * The reranker sits on the READ path of every semantic search. Two properties carry the weight:
 *
 *  1. **It can only make search worse, never broken.** Every failure returns `null`, which the caller
 *     reads as "keep the vector order". A reranker that threw would turn a sidecar restart into failed
 *     searches; one that returned zeros would silently reorder every result set by nothing.
 *  2. **A provider's answer is not trusted.** A non-finite score or an out-of-range index would move the
 *     WRONG passage, which is a wrong answer rather than a missing one — so both are dropped.
 *
 * Run: node --test testing/standalone/rerank.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let resolveEndpoint, buildBody, parseScores, MAX_CANDIDATES,
    MIN_CANDIDATE_MULTIPLIER, MAX_CANDIDATE_MULTIPLIER, DEFAULT_CANDIDATE_MULTIPLIER,
    planBatches, DEFAULT_MAX_PASSAGES_PER_REQUEST, MAX_PASSAGES_PER_REQUEST_MAX;

before(async () => {
  ({
    resolveEndpoint, buildBody, parseScores, MAX_CANDIDATES,
    MIN_CANDIDATE_MULTIPLIER, MAX_CANDIDATE_MULTIPLIER, DEFAULT_CANDIDATE_MULTIPLIER,
    planBatches, DEFAULT_MAX_PASSAGES_PER_REQUEST, MAX_PASSAGES_PER_REQUEST_MAX,
  } = await import('../../server/dist/brain/rerank-client.js'));
});

describe('resolveEndpoint — the operator URL declares the dialect', () => {
  it('appends /v1/rerank to a bare host and reads it as Cohere', () => {
    assert.deepEqual(resolveEndpoint('http://reranker:8080'),
      { url: 'http://reranker:8080/v1/rerank', dialect: 'cohere' });
  });

  it('leaves an explicit /v1/rerank alone', () => {
    assert.deepEqual(resolveEndpoint('https://api.example.com/v1/rerank'),
      { url: 'https://api.example.com/v1/rerank', dialect: 'cohere' });
  });

  it('reads a bare /rerank as the TEI shape', () => {
    // text-embeddings-inference is the usual way bge-reranker-v2-m3 gets self-hosted, and its request
    // body is NOT the Cohere one. Sending the wrong shape produces a 422 that reads as "reranker broken".
    assert.deepEqual(resolveEndpoint('http://tei:80/rerank'),
      { url: 'http://tei:80/rerank', dialect: 'tei' });
  });

  it('strips trailing slashes rather than producing a double slash', () => {
    assert.equal(resolveEndpoint('http://reranker:8080/').url, 'http://reranker:8080/v1/rerank');
    assert.equal(resolveEndpoint('http://tei:80/rerank//').dialect, 'tei');
  });
});

describe('buildBody — one shape per dialect, never a union', () => {
  it('Cohere: model + documents + top_n', () => {
    const b = buildBody('cohere', 'bge-reranker-v2-m3', 'q', ['a', 'b']);
    assert.equal(b.model, 'bge-reranker-v2-m3');
    assert.equal(b.query, 'q');
    assert.deepEqual(b.documents, ['a', 'b']);
    assert.equal(b.top_n, 2);
    assert.equal(b.texts, undefined, 'must not smuggle the TEI field in as well');
  });

  it('TEI: texts, and no model field', () => {
    const b = buildBody('tei', 'bge-reranker-v2-m3', 'q', ['a', 'b']);
    assert.deepEqual(b.texts, ['a', 'b']);
    assert.equal(b.documents, undefined);
    assert.equal(b.model, undefined, 'TEI serves one model; sending another server\'s field risks a 422');
  });
});

describe('parseScores — a provider answer is not trusted', () => {
  it('reads the Cohere shape ({results:[{index, relevance_score}]})', () => {
    const out = parseScores({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }, 2);
    assert.deepEqual(out, [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
  });

  it('reads the TEI shape (a bare array of {index, score})', () => {
    assert.deepEqual(parseScores([{ index: 0, score: 2.5 }], 1), [{ index: 0, score: 2.5 }]);
  });

  it('returns null for a body that is neither', () => {
    // null means "no opinion" and the vector order stands. An empty array would mean "every passage
    // scored nothing", which is a different and much worse claim.
    assert.equal(parseScores({ nope: true }, 3), null);
    assert.equal(parseScores('a string', 3), null);
    assert.equal(parseScores(null, 3), null);
  });

  it('DROPS an out-of-range index instead of clamping it', () => {
    // Clamping would apply one passage's score to a different passage — a wrong answer, silently.
    assert.deepEqual(parseScores({ results: [{ index: 7, relevance_score: 0.9 }] }, 3), []);
    assert.deepEqual(parseScores({ results: [{ index: -1, relevance_score: 0.9 }] }, 3), []);
  });

  it('DROPS a non-finite or missing score instead of defaulting it to 0', () => {
    // A defaulted 0 sorts the passage to the bottom, which looks like a confident judgement.
    assert.deepEqual(parseScores({ results: [{ index: 0 }] }, 1), []);
    assert.deepEqual(parseScores({ results: [{ index: 0, score: 'high' }] }, 1), []);
    assert.deepEqual(parseScores([{ index: 0, score: Number.NaN }], 1), []);
  });

  it('keeps the good rows when only some are unusable', () => {
    const out = parseScores({ results: [{ index: 0, score: 0.5 }, { index: 9, score: 0.9 }] }, 2);
    assert.deepEqual(out, [{ index: 0, score: 0.5 }]);
  });
});

describe('bounds', () => {
  it('the multiplier floor is above 1', () => {
    // At 1 the reranker reorders exactly the results that would have been returned anyway — the whole
    // mechanism is the over-fetch, so a multiplier of 1 is a setting that silently does nothing.
    assert.ok(MIN_CANDIDATE_MULTIPLIER >= 2);
    assert.ok(DEFAULT_CANDIDATE_MULTIPLIER >= MIN_CANDIDATE_MULTIPLIER);
    assert.ok(DEFAULT_CANDIDATE_MULTIPLIER <= MAX_CANDIDATE_MULTIPLIER);
  });

  it('there is an absolute candidate cap, independent of topK', () => {
    // Cross-encoder cost is linear in the candidate count. Without this, a large topK turns one search
    // into a several-hundred-passage batch on the request path.
    assert.ok(Number.isInteger(MAX_CANDIDATES) && MAX_CANDIDATES > 0 && MAX_CANDIDATES <= 500);
  });
});

/**
 * `Q-42`. The cap above bounds the candidate COUNT and said nothing about how many go in one request, so
 * a hundred passages were sent as one body. A stock text-embeddings-inference server accepts 32 and
 * answers `413`, which reaches the caller as `rerank_unavailable` — a permanently unreranked search that
 * looks exactly like a working one.
 *
 * The split is a pure function on purpose: the failure it prevents is an index from the second batch
 * being read as an index into the first, which moves the WRONG passage. That is a wrong answer rather
 * than a missing one — the same class `parseScores` drops out-of-range indices for — and it is
 * arithmetic, so it is testable without a server.
 */
describe('planBatches — one request per batch, and the indices stay global', () => {
  it('splits a hundred passages into batches no larger than the limit', () => {
    const b = planBatches(100, 32);
    assert.equal(b.length, 4);
    assert.deepEqual(b[0], { start: 0, end: 32 });
    assert.deepEqual(b[3], { start: 96, end: 100 }, 'the last batch is the remainder, not a padded one');
    assert.ok(b.every(x => x.end - x.start <= 32));
  });

  it('leaves a set that already fits as ONE batch', () => {
    // The common case must not gain a round trip: below the limit this has to be exactly what it was.
    assert.deepEqual(planBatches(20, 32), [{ start: 0, end: 20 }]);
    assert.deepEqual(planBatches(32, 32), [{ start: 0, end: 32 }]);
  });

  it('covers every passage exactly once, with no gap and no overlap', () => {
    for (const [total, size] of [[100, 32], [7, 3], [1, 1], [64, 32], [65, 32]]) {
      const seen = planBatches(total, size).flatMap(({ start, end }) =>
        Array.from({ length: end - start }, (_, i) => start + i));
      assert.deepEqual(seen, Array.from({ length: total }, (_, i) => i),
        `planBatches(${total}, ${size}) must cover 0..${total - 1} once each`);
    }
  });

  it('returns nothing for an empty set', () => {
    assert.deepEqual(planBatches(0, 32), []);
  });

  it('refuses a junk size rather than looping or sending one passage per request', () => {
    // A zero or negative batch size is what a half-finished edit looks like. Slicing by it would either
    // never advance or make one request per passage — both worse than the behaviour being replaced.
    for (const junk of [0, -1, Number.NaN, 0.5]) {
      const b = planBatches(10, junk);
      assert.ok(b.length >= 1 && b.length <= 10, `size ${junk} produced ${b.length} batches`);
      assert.ok(b.every(x => x.end > x.start), 'every batch must contain at least one passage');
    }
  });
});

describe('maxPassagesPerRequest — bounded, and a default a stock server accepts', () => {
  it('defaults to something text-embeddings-inference takes in one request', () => {
    assert.ok(Number.isInteger(DEFAULT_MAX_PASSAGES_PER_REQUEST));
    assert.ok(DEFAULT_MAX_PASSAGES_PER_REQUEST >= 1);
    assert.ok(DEFAULT_MAX_PASSAGES_PER_REQUEST <= 32,
      'a stock TEI server answers 413 above 32, and the default has to work against one');
  });

  it('never exceeds the absolute candidate cap', () => {
    // A batch larger than the whole candidate set would be a setting that cannot take effect.
    assert.ok(MAX_PASSAGES_PER_REQUEST_MAX <= MAX_CANDIDATES);
  });
});

describe('the source keeps its contracts', () => {
  const src = readFileSync(new URL('../../server/src/brain/rerank-client.ts', import.meta.url), 'utf8');

  it('guards a non-local endpoint with ssrfSafeFetch', () => {
    // The URL is admin-settable; a plain fetch would follow a redirect into link-local metadata.
    // Since F-33 the local/remote split and the guard are ONE module, `util/model-fetch.ts`, shared with the assist
    // model — so the reranker must reach its endpoint through it, under its OWN slot: a widened embedding endpoint
    // says nothing about where the reranker may point, and vice versa.
    assert.match(src, /modelFetch\([^)]*'rerank'\)/, 'must fetch through modelFetch under the rerank slot');
    const shared = readFileSync(new URL('../../server/src/util/model-fetch.ts', import.meta.url), 'utf8');
    assert.ok(shared.includes('ssrfSafeFetch('), 'modelFetch must guard a non-local endpoint with ssrfSafeFetch');
    assert.ok(shared.includes('allowPrivate: allowPrivateForSlot(slot)'),
      'the operator private-endpoint policy must reach the fetch, or a self-hosted reranker on a cluster address silently never works');
    assert.ok(shared.includes('isLocalModelEndpoint('), 'the local/remote split must use the shared predicate');
  });

  it('never throws out of rerank() — every path returns null', () => {
    const body = src.slice(src.indexOf('export async function rerank('));
    assert.ok(body.includes('catch'), 'the network call must be caught');
    assert.ok(!/\bthrow\b/.test(body), 'a reranker outage must degrade search, not break it');
  });

  it('logs neither the query nor the passages', () => {
    // Both are user content and this goes to the log. Same rule the NLI client follows.
    const body = src.slice(src.indexOf('export async function rerank('));
    assert.ok(!/log\.[a-z]+\([^)]*\bquery\b/.test(body), 'the query must never be logged');
    assert.ok(!/log\.[a-z]+\([^)]*\bpassages\b/.test(body), 'the passages must never be logged');
  });
});

describe('recall wiring', () => {
  // recall.ts holds the database work; the pure merge/rank/text functions moved to recall-shape.ts when that
  // file was split to pay back its god-file ratchet raise. Both halves are the recall implementation, so the
  // source these assertions read is both — a gate that followed only one half would go quietly vacuous the
  // next time a function moves between them.
  const src = readFileSync(new URL('../../server/src/brain/recall.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../server/src/brain/recall-shape.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../server/src/brain/rerank-pool.ts', import.meta.url), 'utf8');

  it('over-fetches when a reranker is configured', () => {
    // Reranking exactly topK candidates returns the same set in a different order and buys nothing.
    assert.ok(src.includes('reranking ? candidateMultiplier() : 1.5'),
      'the candidate pool must widen only when reranking is on');
  });

  it('orders by rerankScore when present, and NEVER filters minScore on it', async () => {
    // The two are different scales. Reinterpreting a caller's vector-similarity threshold against a
    // cross-encoder logit would change what a fixed threshold returns without anyone touching it.
    //
    // Asserted BEHAVIOURALLY, not by grepping the sort expression. The grep that used to live here
    // (`r.rerankScore ?? r.score`) broke the moment hybrid retrieval inserted `fusedScore` between the
    // two — a correct change failing a test that was only ever watching a string.
    const { mergeRecallResults } = await import('../../server/dist/brain/recall-shape.js');
    const rec = (id, score, rerankScore) => ({ _id: id, type: 'fact', score, rerankScore, fact: id });

    // Ordering follows the cross-encoder even when it inverts the vector order.
    const ordered = mergeRecallResults([], [rec('weak', 0.9, 0.1), rec('strong', 0.1, 0.9)], 10);
    assert.deepEqual(ordered.map(r => r._id), ['strong', 'weak']);

    // …and a vector-similarity floor still drops `strong`, because minScore never sees the rerank score.
    const filtered = mergeRecallResults([], [rec('weak', 0.9, 0.1), rec('strong', 0.1, 0.9)], 10, 0.5);
    assert.deepEqual(filtered.map(r => r._id), ['weak']);
  });

  it('reranks the passage text, not the truncated summary', () => {
    // summariseRecall cuts a memory to 120 chars for a log line. Scoring a stub of the passage would
    // judge a different text from the one that gets returned — worse than not reranking, and invisible.
    assert.ok(src.includes('rerankTextOf('), 'a dedicated passage builder must exist');
    const start = src.indexOf('export function rerankTextOf(');
    const fn = src.slice(start, src.indexOf('\n}', start));
    assert.ok(!fn.includes('summariseRecall'), 'must not reuse the truncating summary');
    assert.ok(fn.includes('RERANK_TEXT_MAX_CHARS'), 'the passage must still be capped to the model window');
  });

  it('a null from the reranker leaves every result untouched', () => {
    // Asserted as a PROPERTY, not as literal source. This used to match `if (!scores) return;`
    // character-for-character and broke when a metrics counter was added inside the same branch —
    // the behaviour was identical and the test failed anyway. What must hold is that a falsy `scores`
    // returns before anything is assigned to `rerankScore`.
    const fn = src.slice(src.indexOf('export async function rerankPool('));
    const guard = fn.indexOf('if (!scores)');
    const assigns = fn.indexOf('rerankScore =');
    assert.ok(guard > 0, 'a falsy rerank result must be guarded');
    assert.ok(assigns > guard, 'the guard must come before any score is applied');
    const branch = fn.slice(guard, assigns);
    assert.ok(/\breturn\b/.test(branch), 'no opinion must mean the vector order stands — return early');
  });
});
