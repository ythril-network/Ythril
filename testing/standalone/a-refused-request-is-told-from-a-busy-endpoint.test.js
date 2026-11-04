/**
 * `isRequestRefusal`: the one predicate that says "the embedder refused THIS REQUEST as too large" (Q-699, bundle-237).
 *
 * ## The rule
 *
 * An embedder that answers HTTP 413 (payload too large) has refused the record's own input; it will answer the same on every retry, so
 * the embed job fails at once (`attempts` at the maximum, `ythril_embed_jobs_failed_total{reason="refused_413"}`), where it used to
 * spend five attempts and twelve minutes. A 400 keeps the attempt budget on purpose: a misconfigured embedder (a wrong model name, a
 * missing header, a mismatched width) answers 400 for EVERY record, and failing each at once would end a whole backlog on the first
 * claim; the size case of a 400 is prevented upstream (no chunk reaches the embedder over the ceiling).
 *
 * The message is the one `EmbeddingHttpError` builds (`Embedding request failed (HTTP 413): <body>`, kept for runbooks), so the
 * predicate is ANCHORED to its start: a 503 whose body quotes `(HTTP 413)`, or a message that merely contains the words, is not a
 * refusal. It is decided BEFORE `isTransientEmbedError`, which reads the same text for needles.
 *
 * The truth table is here as data; the order is held on the source of `failEmbedJob`; the behaviour through a real stub endpoint and
 * the worker is `a-413-from-the-embedder-ends-the-embed-job-at-once-db`.
 *
 * Run: node --test testing/standalone/a-refused-request-is-told-from-a-busy-endpoint.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let isRequestRefusal, isTransientEmbedError;

before(async () => {
  ({ isRequestRefusal } = await import('../../server/dist/brain/embed-errors.js'));
  ({ isTransientEmbedError } = await import('../../server/dist/brain/embed-queue.js'));
});

const msg = (status, body = '{"error":"x"}') => `Embedding request failed (HTTP ${status}): ${body}`;

describe('the truth table', () => {
  const TABLE = [
    ['a 413', msg(413), true],
    ['a 413 with an empty body', msg(413, ''), true],
    ['a 413 whose body talks about a busy server', msg(413, 'service unavailable, request too large'), true],
    ['a 400 (keeps the budget: a misconfigured embedder answers 400 for every record)', msg(400), false],
    ['a 401', msg(401), false],
    ['a 422 (some embedders answer 422 for transient overload)', msg(422), false],
    ['a 429', msg(429), false],
    ['a 500', msg(500), false],
    ['a 503', msg(503), false],
    ['a 503 whose body says (HTTP 413)', msg(503, 'upstream said Embedding request failed (HTTP 413)'), false],
    ['a 400 whose body says (HTTP 413)', msg(400, '(HTTP 413)'), false],
    ['the words in the middle of another message', `wrapped: ${msg(413)}`, false],
    ['a status that only starts with 413', msg(4130), false],
    ['lower case', 'embedding request failed (http 413): x', false],
    ['an unreachable endpoint', 'Could not reach embedding endpoint at http://x. Make sure an embedding server is running.', false],
    ['a lost inference process', 'embedding process lost (code=139 signal=null)', false],
    ['nothing', '', false],
  ];
  for (const [name, message, expected] of TABLE) {
    it(`${name}: ${expected}`, () => {
      assert.equal(typeof isRequestRefusal, 'function', 'embed-errors.ts exports no isRequestRefusal');
      assert.equal(isRequestRefusal(message), expected);
    });
  }

  it('a refusal is not also transient, and a transient message is not a refusal (the two never both answer)', () => {
    assert.equal(isTransientEmbedError(msg(413)), false);
    assert.equal(isRequestRefusal(msg(503)), false);
    assert.equal(isTransientEmbedError(msg(503)), true);
  });
});

describe('the order is held where the decision is made', () => {
  const src = () => stripComments(fs.readFileSync('server/src/brain/embed-queue.ts', 'utf8'));
  it('failEmbedJob asks isRequestRefusal before isTransientEmbedError, and the refusal branch writes attempts = MAX_EMBED_ATTEMPTS', () => {
    const s = src();
    const head = s.indexOf('export async function failEmbedJob(');
    assert.ok(head >= 0, 'no failEmbedJob');
    let depth = 0, end = -1;
    for (let i = s.indexOf('{', s.indexOf(': Promise<void>', head)); i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) { end = i; break; }
    }
    const body = s.slice(head, end);
    const refusal = body.search(/\bisRequestRefusal\s*\(/);
    const transient = body.search(/\bisTransientEmbedError\s*\(/);
    assert.ok(refusal >= 0, 'failEmbedJob never asks isRequestRefusal');
    assert.ok(transient >= 0, 'failEmbedJob no longer asks isTransientEmbedError (the transient branch was dropped?)');
    assert.ok(refusal < transient, 'the refusal is asked AFTER the transient needles, which read the same text and can match a 413 body');
    const refusalBranch = body.slice(refusal, transient);
    assert.match(refusalBranch, /status:\s*'failed'/);
    assert.match(refusalBranch, /attempts:\s*MAX_EMBED_ATTEMPTS/);
  });
});
