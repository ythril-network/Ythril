/**
 * An embedder outage costs WAITING, not the attempt budget.
 *
 * ## The report, and the half #910 left
 *
 * Owner, live instance: *"after updating all space indexing failed and since has not been retried
 * automatically."* `MAX_EMBED_ATTEMPTS` is 5 with a backoff of 5s / 30s / 120s / 600s — about twelve and a
 * half minutes from the first failure to terminal `failed`, and a terminal job is never claimed again. That
 * budget is sized for a PER-RECORD failure. Applied to a systemic one, an embedder unreachable for a quarter
 * of an hour during an upgrade takes every queued job in every space terminal at once, and the instance stops
 * indexing without reporting a fault: every job did exactly what it was told to.
 *
 * #910 made that survivable — `reviveFailedEmbedJobs` gives everything one clean attempt per server version.
 * This is the other half: not spending the budget in the first place.
 *
 * ## Why two counters and not a flag
 *
 * `claimNextEmbedJob` increments `attempts` at CLAIM time, before anyone knows how the job went. So "hold the
 * attempt" has to mean giving it back. And the backoff is a function of the attempt number, so holding
 * `attempts` still would pin every retry at the first step — five seconds, forever, against a dead embedder.
 * `transientFailures` therefore drives the wait while `attempts` stays the budget.
 *
 * ## The line that must not move
 *
 * A `400` is not transient. A malformed input is exactly the per-record failure the budget exists to bound,
 * and retrying it forever would replace one silent failure with another: a job that never completes and never
 * gives up. Both directions are asserted here.
 *
 * Run: node --test testing/standalone/embed-outage-does-not-spend-the-budget.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let isTransientEmbedError;
before(async () => {
  ({ isTransientEmbedError } = await import('../../server/dist/brain/embed-queue.js'));
});

describe('what counts as the embedder being unavailable', () => {
  const TRANSIENT = [
    'connect ECONNREFUSED 127.0.0.1:8080',
    'read ECONNRESET',
    'connect ETIMEDOUT 10.0.0.5:443',
    'getaddrinfo EAI_AGAIN embedder.internal',
    'getaddrinfo ENOTFOUND embedder.internal',
    'socket hang up',
    'TypeError: fetch failed',
    'Embedding request timed out after 30000ms',
    'Embedder responded 503 Service Unavailable',
    'HTTP status 429 Too Many Requests',
    'Bad Gateway',
    'Gateway Timeout',
  ];

  for (const msg of TRANSIENT) {
    it(`treats "${msg.slice(0, 42)}" as the embedder's fault`, () => {
      assert.equal(isTransientEmbedError(msg), true);
    });
  }
});

describe('what stays the record\'s own fault', () => {
  // The budget has to keep meaning something. Each of these is answered the same way by every retry, so
  // spending an attempt is correct and giving up eventually is correct.
  const PERMANENT = [
    'Embedder responded 400 Bad Request: input exceeds maximum token length',
    'HTTP status 422: text field is empty',
    'Unsupported content type for embedding',
    'Record has no embeddable text',
    'TypeError: Cannot read properties of undefined (reading \'chunks\')',
  ];

  for (const msg of PERMANENT) {
    it(`spends an attempt on "${msg.slice(0, 42)}"`, () => {
      assert.equal(isTransientEmbedError(msg), false);
    });
  }

  it('does not read a 400 as transient just because a URL contains 503', () => {
    // The needle is ' 503' with a leading space, not '503', so a port or an id cannot look like an outage.
    assert.equal(isTransientEmbedError('POST http://embedder:8503/embed returned 400'), false);
  });

  it('is not fooled by an empty or meaningless message', () => {
    assert.equal(isTransientEmbedError(''), false);
    assert.equal(isTransientEmbedError('failed'), false);
  });
});

describe('the two counters answer different questions', () => {
  it('the source spends `attempts` only on a permanent failure', async () => {
    // Read from source rather than exercised against Mongo: the write shape is the claim, and the
    // integration suite covers the queue end to end. What matters here is that the transient branch gives
    // the attempt back and never sets `failed`.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('server/src/brain/embed-queue.ts', 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    const branch = src.slice(src.indexOf('isTransientEmbedError(errorMessage)'));
    const untilNextBranch = branch.slice(0, branch.indexOf('if (attempts < MAX_EMBED_ATTEMPTS)'));

    assert.match(untilNextBranch, /attempts: Math\.max\(0, attempts - 1\)/,
      'a transient failure must hand the attempt back — it was spent at claim time');
    assert.match(untilNextBranch, /transientFailures: failures/,
      'the wait needs its own counter, or the backoff pins at its first step');
    assert.doesNotMatch(untilNextBranch, /status: 'failed'/,
      'a transient failure must never go terminal — that is the whole point');
    assert.match(untilNextBranch, /claimableAfter: nextClaimableAfter\(failures\)/,
      'the backoff must climb with the transient count, not with the held attempts');
  });

  it('every place that resets `attempts` resets `transientFailures` too', async () => {
    // A new write is new content and must not inherit a half-hour backoff earned by an outage that has since
    // ended. Enqueue, revive-per-version and retry all reset the budget; all three must reset the wait.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('server/src/brain/embed-queue.ts', 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // ONE place resets the budget (`freshBudget`), and every path that grants a clean attempt takes it from there,
    // so the pair cannot be split: the rule is held by that one function resetting both, and by nothing else
    // writing `attempts: 0` beside it.
    const body = src.slice(src.indexOf('function freshBudget('));
    const fn = body.slice(0, body.indexOf('\n}') + 2);
    assert.ok(fn.length > 20, 'freshBudget moved — re-point this gate at wherever the attempt budget is reset');
    assert.match(fn, /attempts: 0/, 'freshBudget must reset attempts');
    assert.match(fn, /transientFailures: 0/, 'and the outage counter with it, or a new write inherits an old backoff');
    const outside = src.replace(fn, '');
    assert.doesNotMatch(outside, /attempts: 0/, 'an attempt reset written outside freshBudget can drop the wait');
    const uses = [...outside.matchAll(/freshBudget\(\)/g)].length;
    assert.ok(uses >= 3, `expected enqueue, revive and retry to take the budget from freshBudget, found ${uses} use(s)`);
  });
});
