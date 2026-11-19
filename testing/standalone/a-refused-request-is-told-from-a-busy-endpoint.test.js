/**
 * The embedder refused THIS REQUEST as too large: the verdict `ends` with the reason `refused_413` (Q-699, bundle-237; the decision by status since Q-931, bundle-351).
 *
 * ## The rule
 *
 * An embedder that answers HTTP 413 (payload too large) has refused the record's own input; it will answer the same on every retry, so
 * the embed job fails at once (`attempts` at the maximum, `ythril_embed_jobs_failed_total{reason="refused_413"}`), where it used to
 * spend five attempts and twelve minutes. A 400 keeps the attempt budget on purpose: a misconfigured embedder (a wrong model name, a
 * missing header, a mismatched width) answers 400 for EVERY record, and failing each at once would end a whole backlog on the first
 * claim; the size case of a 400 is prevented upstream (no chunk reaches the embedder over the ceiling).
 *
 * The refusal is told by the status of the `EmbeddingHttpError` the embed call threw, never by the words of its message: a 503 whose body
 * quotes `(HTTP 413)` is a busy endpoint, and the sentence `Embedding request failed (HTTP 413)` as a string or a plain `Error` (a child's
 * text, a body quoted by something else) is not a refusal at all.
 *
 * The truth table is here as data; the behaviour through a real stub endpoint and the worker is
 * `a-413-from-the-embedder-ends-the-embed-job-at-once-db`, and the verdict's every row is `an-embed-failure-gets-one-verdict`.
 *
 * Run: node --test testing/standalone/a-refused-request-is-told-from-a-busy-endpoint.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let errors;

before(async () => {
  errors = await import('../../server/dist/brain/embed-errors.js');
});

const BUSY_BODY = 'service unavailable, request too large';
const sentence = (status, body = '{"error":"x"}') => `Embedding request failed (HTTP ${status}): ${body}`;
const refused = (failure) => {
  const verdict = errors.classifyEmbedFailure(failure);
  return verdict.kind === 'ends' && verdict.reason === 'refused_413';
};

describe('the truth table, over the error object the embed call throws', () => {
  const TABLE = [
    ['a 413', 413, '{"error":"x"}', true],
    ['a 413 with an empty body', 413, '', true],
    ['a 413 whose body talks about a busy server', 413, BUSY_BODY, true],
    ['a 400 (keeps the budget: a misconfigured embedder answers 400 for every record)', 400, '{"error":"x"}', false],
    ['a 401', 401, '{"error":"x"}', false],
    ['a 422 (some embedders answer 422 for transient overload)', 422, '{"error":"x"}', false],
    ['a 429', 429, '{"error":"x"}', false],
    ['a 500', 500, '{"error":"x"}', false],
    ['a 503', 503, '{"error":"x"}', false],
    ['a 503 whose body says (HTTP 413)', 503, 'upstream said Embedding request failed (HTTP 413)', false],
    ['a 400 whose body says (HTTP 413)', 400, '(HTTP 413)', false],
    ['a status that only starts with 413', 4130, '{"error":"x"}', false],
  ];
  for (const [name, status, body, expected] of TABLE) {
    it(`${name}: ${expected}`, () => {
      assert.equal(refused(new errors.EmbeddingHttpError(status, body, null)), expected);
    });
  }
});

describe('the same words as a string or a plain Error are never a refusal', () => {
  const SENTENCES = [
    ['a 413', sentence(413)],
    ['a 413 whose body talks about a busy server', sentence(413, BUSY_BODY)],
    ['the words in the middle of another message', `wrapped: ${sentence(413)}`],
    ['lower case', 'embedding request failed (http 413): x'],
  ];
  for (const [name, text] of SENTENCES) {
    it(`${name}`, () => {
      assert.equal(refused(text), false, 'a string ended a job');
      assert.equal(refused(new Error(text)), false, 'a plain Error ended a job');
    });
  }

  it('a refusal is not also an outage, and a busy answer is not a refusal (the two never both answer)', () => {
    assert.deepEqual(errors.classifyEmbedFailure(new errors.EmbeddingHttpError(413, BUSY_BODY, null)), { kind: 'ends', reason: 'refused_413' });
    assert.deepEqual(errors.classifyEmbedFailure(new errors.EmbeddingHttpError(503, sentence(413), null)), { kind: 'outage', proven: true });
  });
});
