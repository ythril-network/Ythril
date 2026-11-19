/**
 * An embed failure gets ONE verdict, decided by what the failure IS and never by words an endpoint wrote in a body (Q-931, bundle-351).
 *
 * ## The defect that bought this
 *
 * The embed queue read a failure's fate from its MESSAGE: a needle such as `timeout` or the lost-process marker anywhere in it. An
 * embedding endpoint's error body is text a third party writes, and it is part of the message `EmbeddingHttpError` builds. So a 400, 401,
 * 404 or 500 whose body held `timeout` made a job wait for ever, and one whose body held `embedding process lost` was counted as a crashed
 * inference process and ended after three. Measured on a build of main with the real `embed()`: every HTTP answer reaches the queue as an
 * `EmbeddingHttpError` with a numeric `status`, and a closed port as an `EmbedUnreachableError`.
 *
 * ## The rule
 *
 * `classifyEmbedFailure` (embed-errors.ts) answers `lost`, `ends`, `outage` (proven, or by words) or `record`, by the class and the status of
 * the object the server itself built:
 *
 *  - an `EmbeddingHttpError` is NEVER asked for words: 413 ends the job, a status of the wait set is an outage, every other status is the
 *    record's, whatever the body says;
 *  - a string or a plain `Error` is judged by words only and can never be `ends` or `lost`;
 *  - the in-call retry keeps its own, smaller set.
 *
 * Every row below is written by hand, and the status sweep derives its expectation from a list that is not the code's.
 *
 * Run: node --test testing/standalone/an-embed-failure-gets-one-verdict.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let errors, queue, embedding;

before(async () => {
  errors = await import('../../server/dist/brain/embed-errors.js');
  queue = await import('../../server/dist/brain/embed-queue.js');
  embedding = await import('../../server/dist/brain/embedding.js');
});

/** A body holding every needle the words rule reads and both markers: the worst thing an endpoint can write. */
const HOSTILE_BODY = () => `timeout; timed out; econnrefused; fetch failed; service unavailable; bad gateway; ${errors.LOST_MARKER}; ${errors.NOT_SENT_MARKER}; status 503; (HTTP 413)`;
const http = (status, body = HOSTILE_BODY()) => new errors.EmbeddingHttpError(status, body, null);
const verdict = (failure) => errors.classifyEmbedFailure(failure);

/** The wait set as the design records it, written here by hand. */
const WAITS = [408, 429, 502, 503, 504, 520, 521, 522, 523, 524, 529, 530];

describe('the verdict, row by row', () => {
  it('the request the lost inference process was holding is `lost`', () => {
    assert.deepEqual(verdict(new errors.LostChildError('code=139 signal=null')), { kind: 'lost' });
  });

  it('a request the lost process was never sent is a proven outage', () => {
    assert.deepEqual(verdict(new errors.LostChildError('code=139 signal=null', { inFlight: false })), { kind: 'outage', proven: true });
  });

  it('an unreachable endpoint is a proven outage', () => {
    assert.deepEqual(verdict(new errors.EmbedUnreachableError('Could not reach embedding endpoint at http://x')), { kind: 'outage', proven: true });
  });

  it('a 413 ends the job as refused, whatever its body says', () => {
    for (const body of ['too large', '', HOSTILE_BODY(), 'service unavailable, request too large']) {
      assert.deepEqual(verdict(http(413, body)), { kind: 'ends', reason: 'refused_413' }, `body: ${body.slice(0, 40)}`);
    }
  });

  it('an over-ceiling passage ends the job', () => {
    assert.deepEqual(verdict(new errors.OverCeilingError(9_000, 8_000)), { kind: 'ends', reason: 'over_ceiling' });
  });

  it('a status of the wait set is a proven outage with ANY body', () => {
    for (const status of WAITS) {
      for (const body of ['', 'plain', HOSTILE_BODY()]) {
        assert.deepEqual(verdict(http(status, body)), { kind: 'outage', proven: true }, `${status}: ${body.slice(0, 30)}`);
      }
    }
  });

  it('every other HTTP status is the record\'s, with a body holding every needle and both markers', () => {
    for (const status of [400, 401, 403, 404, 405, 409, 410, 415, 422, 500, 501, 505, 507, 525, 526, 527]) {
      assert.deepEqual(verdict(http(status)), { kind: 'record' }, `a ${status} was judged by its body`);
    }
  });

  it('the status sweep: of 400 to 599, exactly the wait set waits, 413 ends, nothing else', () => {
    for (let status = 400; status <= 599; status++) {
      const expected = WAITS.includes(status) ? { kind: 'outage', proven: true }
        : status === 413 ? { kind: 'ends', reason: 'refused_413' } : { kind: 'record' };
      assert.deepEqual(verdict(http(status)), expected, `status ${status}`);
    }
  });

  it('a failure that is none of the classes is judged by its words, and is never proven', () => {
    assert.deepEqual(verdict(new Error('connect ECONNREFUSED 127.0.0.1:11434')), { kind: 'outage', proven: false });
    assert.deepEqual(verdict('Embedding request failed (HTTP 503): down'), { kind: 'outage', proven: false });
    assert.deepEqual(verdict(new Error('unsupported input shape')), { kind: 'record' });
    assert.deepEqual(verdict(undefined), { kind: 'record' });
    assert.deepEqual(verdict(null), { kind: 'record' });
  });
});

describe('words can never end a job or count a crash', () => {
  // Lazy: the module under test is imported in `before`, which runs after the cases are collected.
  const SENTENCES = [
    ['the 413 sentence', () => 'Embedding request failed (HTTP 413): input is too large for this model'],
    ['the 413 sentence with a busy body', () => 'Embedding request failed (HTTP 413): service unavailable'],
    ['the lost marker at the start', () => `${errors.LOST_MARKER} (code=139 signal=null)`],
    ['the lost marker in the middle', () => `tokenizer said: ${errors.LOST_MARKER} (code=1)`],
    ['the lost marker at the end', () => `child text: ${errors.LOST_MARKER}`],
    ['the over-ceiling words at their start', () => new errors.OverCeilingError(9_000, 8_000).message],
  ];
  for (const [name, sentenceOf] of SENTENCES) {
    for (const [shape, make] of [['a string', (s) => s], ['a plain Error', (s) => new Error(s)]]) {
      it(`${name}, as ${shape}, is neither \`ends\` nor \`lost\``, () => {
        const sentence = sentenceOf();
        const v = verdict(make(sentence));
        assert.notEqual(v.kind, 'ends', `${name} ended a job by its words`);
        assert.notEqual(v.kind, 'lost', `${name} counted a crash by its words`);
        assert.equal(v.kind === 'outage', errors.isTransientEmbedError(sentence), 'a failure of no class is judged by the words rule alone');
        if (v.kind === 'outage') assert.equal(v.proven, false);
      });
    }
  }

  it('an EmbeddingHttpError is never asked for words: a 400 holding the lost marker is the record\'s and never `lost`', () => {
    assert.deepEqual(verdict(http(400, errors.LOST_MARKER)), { kind: 'record' });
    assert.deepEqual(verdict(http(413, errors.LOST_MARKER)), { kind: 'ends', reason: 'refused_413' });
    assert.deepEqual(verdict(http(503, 'nothing a needle reads')), { kind: 'outage', proven: true });
  });
});

describe('isEmbedderUnavailable: only a proven outage', () => {
  it('is true for the unreachable class, a wait status and a request never sent to the lost process', () => {
    assert.equal(errors.isEmbedderUnavailable(new errors.EmbedUnreachableError('x')), true);
    assert.equal(errors.isEmbedderUnavailable(http(503, '')), true);
    assert.equal(errors.isEmbedderUnavailable(new errors.LostChildError('c', { inFlight: false })), true);
  });

  it('is false for the request the lost process held, a 413, a 400, an over-ceiling passage and words alone', () => {
    assert.equal(errors.isEmbedderUnavailable(new errors.LostChildError('c')), false);
    assert.equal(errors.isEmbedderUnavailable(http(413)), false);
    assert.equal(errors.isEmbedderUnavailable(http(400)), false);
    assert.equal(errors.isEmbedderUnavailable(new errors.OverCeilingError(9_000, 8_000)), false);
    assert.equal(errors.isEmbedderUnavailable(new Error('connect ECONNREFUSED 127.0.0.1:1')), false);
    assert.equal(errors.isEmbedderUnavailable('fetch failed'), false);
  });
});

describe('the in-call retry keeps its own set, and the class has one identity', () => {
  it('the call retries exactly the four busy statuses: a second attempt follows each', async () => {
    for (const status of [429, 502, 503, 504]) {
      let calls = 0;
      const result = await embedding.embedViaHttpWithRetry(async () => {
        calls++;
        if (calls === 1) throw new embedding.EmbeddingHttpError(status, 'busy', null);
        return { vector: [1], model: 'm', dimensions: 1 };
      });
      assert.equal(calls, 2, `a ${status} was not retried inside the call`);
      assert.deepEqual(result.vector, [1]);
    }
  });

  it('a status that waits in the queue but is not a busy one is not retried in the call', async () => {
    for (const status of [408, 520, 522, 529, 530]) {
      let calls = 0;
      await assert.rejects(() => embedding.embedViaHttpWithRetry(async () => { calls++; throw new embedding.EmbeddingHttpError(status, 'x', null); }));
      assert.equal(calls, 1, `a ${status} was retried inside the call`);
    }
  });

  it('instanceof holds across both import paths', async () => {
    assert.equal(embedding.EmbeddingHttpError, errors.EmbeddingHttpError);
    assert.ok(new embedding.EmbeddingHttpError(503, 'x', null) instanceof errors.EmbeddingHttpError);
    assert.ok(new errors.EmbeddingHttpError(503, 'x', null) instanceof embedding.EmbeddingHttpError);
    assert.deepEqual(verdict(new embedding.EmbeddingHttpError(413, 'x', null)), { kind: 'ends', reason: 'refused_413' });
  });

  it('the message is the sentence operators have always seen, and carries the status and the body', () => {
    const err = new errors.EmbeddingHttpError(429, 'slow down', 2_000);
    assert.equal(err.message, 'Embedding request failed (HTTP 429): slow down');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 2_000);
  });
});

describe('the queue takes the words half from the verdict\'s module', () => {
  it('the queue re-exports the words rule and the message derivation, one function each', () => {
    assert.equal(queue.isTransientEmbedError, errors.isTransientEmbedError);
    assert.equal(queue.embedFailureMessage, errors.embedFailureMessage);
    assert.equal(errors.embedFailureMessage(new Error('a')), 'a');
    assert.equal(errors.embedFailureMessage('b'), 'b');
  });

  it('embed-errors.ts imports nothing', () => {
    const src = stripComments(fs.readFileSync('server/src/brain/embed-errors.ts', 'utf8'));
    assert.doesNotMatch(src, /^\s*import\b/m, 'embed-errors.ts imports a module');
    assert.doesNotMatch(src, /\bfrom\s+['"]/, 'embed-errors.ts re-exports from a module');
    assert.doesNotMatch(src, /\brequire\s*\(|\bimport\s*\(/, 'embed-errors.ts loads a module');
  });
});

describe('does this verdict end a job with these counters', () => {
  const max = () => queue.MAX_EMBED_ATTEMPTS;
  const maxLost = () => queue.MAX_LOST_CHILD_FAILURES;
  const ends = (v, counters) => queue.embedVerdictEndsJob(v, counters);

  it('`record` ends a job exactly when its budget is spent', () => {
    assert.equal(ends({ kind: 'record' }, { attempts: max() - 1, lostChildFailures: 0 }), false);
    assert.equal(ends({ kind: 'record' }, { attempts: max(), lostChildFailures: 0 }), true);
  });

  it('`lost` ends a job on the failure that makes the lost-process count reach its maximum, whatever its attempts are', () => {
    assert.equal(ends({ kind: 'lost' }, { attempts: 0, lostChildFailures: maxLost() - 2 }), false);
    assert.equal(ends({ kind: 'lost' }, { attempts: 0, lostChildFailures: maxLost() - 1 }), true, 'the third lost process is the job\'s last try');
    assert.equal(ends({ kind: 'lost' }, { attempts: max(), lostChildFailures: 0 }), false, 'a lost process does not spend the attempts');
  });

  it('`ends` always ends a job', () => {
    assert.equal(ends({ kind: 'ends', reason: 'refused_413' }, { attempts: 0, lostChildFailures: 0 }), true);
    assert.equal(ends({ kind: 'ends', reason: 'over_ceiling' }, { attempts: 0, lostChildFailures: 0 }), true);
  });

  it('`outage` never ends a job, whatever its counters are', () => {
    for (const proven of [true, false]) {
      assert.equal(ends({ kind: 'outage', proven }, { attempts: max(), lostChildFailures: maxLost() }), false);
      assert.equal(ends({ kind: 'outage', proven }, { attempts: max() + 10, lostChildFailures: maxLost() + 10 }), false);
    }
  });
});

describe('failEmbedJob decides by the verdict and reads no words', () => {
  const failEmbedJobBody = (src) => {
    const head = src.indexOf('export async function failEmbedJob(');
    assert.ok(head >= 0, 'no failEmbedJob');
    let depth = 0;
    for (let i = src.indexOf('{', src.indexOf(': Promise<void>', head)); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(head, i);
    }
    return assert.fail('no end of failEmbedJob');
  };
  const READS_WORDS = /\.(?:includes|startsWith|endsWith|indexOf|match|search|test)\s*\(|\bisTransientEmbedError\s*\(|\bLOST_MARKER\b|\bNOT_SENT_MARKER\b/;
  const body = () => failEmbedJobBody(stripComments(fs.readFileSync('server/src/brain/embed-queue.ts', 'utf8')));

  it('asks the verdict and the one ending function, and reads no text', () => {
    const b = body();
    assert.match(b, /\bclassifyEmbedFailure\s*\(\s*failure\s*\)/);
    assert.match(b, /\bembedVerdictEndsJob\s*\(/);
    assert.doesNotMatch(b, READS_WORDS, 'failEmbedJob reads the words of a failure');
  });

  it('seen red on a planted copy: a read of the message inside failEmbedJob', () => {
    const b = body();
    assert.match(`${b}\n const x = errorMessage.includes(LOST_MARKER);`, READS_WORDS);
    assert.match(`${b}\n if (isTransientEmbedError(errorMessage)) {}`, READS_WORDS);
  });
});
