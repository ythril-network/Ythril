/**
 * A transient refusal from the embedding endpoint is retried, and a permanent one is not.
 *
 * ## What happened
 *
 * An operator moved their text embedder onto a shared GPU endpoint. While a reindex saturated it, **every**
 * recall from their platform instance failed:
 *
 *     [WARN] MCP global tool 'recall' error in space 'global':
 *            Embedding request failed (HTTP 429): {"error":"Too many requests"}
 *
 * No retry, no jitter, no backoff. One busy moment and the user's query was simply gone. The rejections came
 * back in **under 3ms** — the upstream was refusing instantly rather than queueing — so there was nothing to
 * wait for except a concurrent burst to clear. Their words: *"a single retry with a little jitter would absorb
 * this entirely."*
 *
 * The file pipeline already had all of this: persisted jobs, backoff, a terminal `failed` state, and a
 * `retry_embed_file` recovery path. Recall had none of it, against the same dependency.
 *
 * ## Why this drives the retry directly and not an HTTP server
 *
 * The property is *how many attempts happen, and under what delay*. The retry takes the attempt as a callback,
 * so a counting fake gives that exactly — deterministically, with no network and no clock luck.
 *
 * The first version of this test stood up a real endpoint and needed a `setConfigForTest` seam on the config
 * loader to aim the embedder at it. No such seam exists, so every case would have skipped: a green run that
 * never called the code, which is the worst possible outcome for a gate. A production file growing a test-only
 * export to make that work would have been the wrong trade for a property this test can observe directly.
 *
 * Run: node --test testing/standalone/embedder-429-is-retried.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let embedViaHttpWithRetry, EmbeddingHttpError;

before(async () => {
  ({ embedViaHttpWithRetry, EmbeddingHttpError } = await import('../../server/dist/brain/embedding.js'));
});

const OK = { vector: [0.1, 0.2], model: 'test', dimensions: 2 };

/**
 * An attempt that refuses with the scripted statuses in order, then succeeds.
 * Records the time of every call, so the delay between attempts is observable.
 */
function scripted(statuses, retryAfterSeconds = null) {
  const calls = [];
  const queue = [...statuses];
  const fn = async () => {
    calls.push(Date.now());
    const status = queue.shift();
    if (status === undefined) return OK;
    throw new EmbeddingHttpError(status, '{"error":"scripted"}',
      retryAfterSeconds === null ? null : retryAfterSeconds * 1000);
  };
  return { fn, calls };
}

describe('a transient refusal is retried', () => {
  it('the retry and its error type are exported', () => {
    // A gate that silently skipped because it could not reach its subject is worse than no gate.
    assert.equal(typeof embedViaHttpWithRetry, 'function');
    assert.equal(typeof EmbeddingHttpError, 'function');
  });

  it('a 429 then a success makes TWO attempts and returns the vector', async () => {
    const { fn, calls } = scripted([429]);
    const out = await embedViaHttpWithRetry(fn);
    assert.equal(calls.length, 2, 'the refusal must be retried exactly once here — not zero, not twice');
    assert.deepEqual(out, OK, 'the caller must get the vector, not the 429');
  });

  it('waits between attempts rather than hammering', async () => {
    const { fn, calls } = scripted([429]);
    await embedViaHttpWithRetry(fn);
    const gap = calls[1] - calls[0];
    // Jitter is half the base, so the floor is base/2 = 60ms. An instant retry hits the same busy endpoint and
    // turns one rejection into two.
    assert.ok(gap >= 40, `retried after only ${gap}ms — that is hammering, not backing off`);
    // The ceiling matters as much: this runs inside recall's deadline, which the operator set and the caller
    // may have lowered. A textbook 1s/2s/4s backoff would trade a clear failure for a slow partial answer.
    assert.ok(gap < 1_000, `waited ${gap}ms, which eats a deadline somebody set`);
  });

  it('backs off FURTHER on the second retry', async () => {
    const { fn, calls } = scripted([429, 429]);
    await embedViaHttpWithRetry(fn);
    assert.equal(calls.length, 3);
    // Not equal delays: a burst that is still clearing needs longer the second time. Compared with the jitter
    // floor of the larger base (360/2 = 180) against the ceiling of the smaller (120), which cannot overlap.
    assert.ok(calls[2] - calls[1] > calls[1] - calls[0],
      `second gap ${calls[2] - calls[1]}ms was not longer than the first ${calls[1] - calls[0]}ms`);
  });

  it('gives up after a bounded number of attempts', async () => {
    const { fn, calls } = scripted([429, 429, 429, 429, 429]);
    await assert.rejects(() => embedViaHttpWithRetry(fn), /HTTP 429/);
    assert.equal(calls.length, 3, 'three attempts total — an unbounded retry is a slow failure, not a fix');
  });

  it('surfaces the ORIGINAL message when it gives up', async () => {
    const { fn } = scripted([503, 503, 503]);
    // Operators have this string in their runbooks and their log searches. A wrapper that replaced it with
    // "all retries failed" would break every alert anyone had written against it.
    await assert.rejects(() => embedViaHttpWithRetry(fn), /Embedding request failed \(HTTP 503\)/);
  });

  it('retries the other busy/unavailable statuses too', async () => {
    for (const status of [502, 503, 504]) {
      const { fn, calls } = scripted([status]);
      await embedViaHttpWithRetry(fn);
      assert.equal(calls.length, 2, `HTTP ${status} should be retried`);
    }
  });
});

describe('a permanent refusal is NOT retried', () => {
  it('a 400 fails on the first attempt', async () => {
    const { fn, calls } = scripted([400, 400, 400]);
    await assert.rejects(() => embedViaHttpWithRetry(fn), /HTTP 400/);
    assert.equal(calls.length, 1,
      'a 400 means the request is wrong and will be wrong every time — retrying burns the caller deadline to '
      + 'arrive at the same answer more slowly');
  });

  it('a 401 is not retried either', async () => {
    const { fn, calls } = scripted([401, 401]);
    await assert.rejects(() => embedViaHttpWithRetry(fn), /HTTP 401/);
    assert.equal(calls.length, 1, 'a retried 401 is a lockout waiting to happen');
  });

  it('a 413 is not retried', async () => {
    const { fn, calls } = scripted([413, 413]);
    await assert.rejects(() => embedViaHttpWithRetry(fn), /HTTP 413/);
    assert.equal(calls.length, 1, 'the input is too large; it will still be too large in 120ms');
  });

  it('a non-HTTP failure is not retried', async () => {
    // A thrown TypeError is a bug in our own request building, not a busy server. Retrying it three times
    // just makes the same bug take longer to report.
    let calls = 0;
    const fn = async () => { calls++; throw new TypeError('bad init'); };
    await assert.rejects(() => embedViaHttpWithRetry(fn), /bad init/);
    assert.equal(calls, 1);
  });
});

describe('Retry-After', () => {
  it('a short one is honoured and still retried', async () => {
    const { fn, calls } = scripted([429], 0);
    await embedViaHttpWithRetry(fn);
    assert.equal(calls.length, 2);
  });

  it('a LONG one is a refusal to wait, not an instruction to', async () => {
    // 30 seconds, inside a request whose budget is measured in hundreds of milliseconds. Sleeping it would
    // miss the deadline and answer partially, which is worse than a clear refusal the caller can see.
    const { fn, calls } = scripted([429], 30);
    const started = Date.now();
    await assert.rejects(() => embedViaHttpWithRetry(fn), /HTTP 429/);
    assert.equal(calls.length, 1, 'we must not retry when the server names a wait we will not take');
    assert.ok(Date.now() - started < 2_000, 'and we must not have slept it either');
  });
});
