/**
 * Retry delays are jittered, so a herd of simultaneous failures does not retry in lockstep.
 *
 * Both retry queues already backed off exponentially — the half everyone remembers. But the delay was
 * identical for every job, so failures that happen together retry together. Upload twenty files while
 * the document sidecar is restarting: all twenty fail inside a second, all wait exactly 30 000 ms, all
 * hit the sidecar again on the same tick, at the moment it is least able to cope. If that knocks it
 * over they fail together again and re-synchronise on the next step of the schedule.
 *
 * Backoff spaces retries out over TIME. Jitter spaces them out across CLIENTS. The second one was
 * missing, and it is the one that breaks the herd.
 *
 * Run: node --test testing/standalone/retry-jitter.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bodyOf } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';

let withJitter;
before(async () => { ({ withJitter } = await import('../../server/dist/util/backoff.js')); });

describe('withJitter', () => {
  it('stays within [delay/2, delay] — the floor is the point of equal jitter', () => {
    // Full jitter (0..delay) would let a job retry almost immediately, throwing away the reason 30 s
    // was chosen. Half the nominal delay is guaranteed.
    for (const delay of [1_000, 30_000, 120_000, 3_600_000]) {
      for (let i = 0; i < 2_000; i++) {
        const v = withJitter(delay);
        assert.ok(v >= delay / 2, `${v} below the floor for ${delay}`);
        assert.ok(v <= delay, `${v} above the nominal delay ${delay}`);
      }
    }
  });

  it('actually scatters — this is the assertion the whole change exists for', () => {
    // A stub returning the delay unchanged passes the range check above. It must not pass this one.
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(withJitter(30_000));
    assert.ok(seen.size > 100,
      `expected a spread of retry times, got ${seen.size} distinct values — the herd would still be synchronised`);
  });

  it('spreads across the whole window, not just one end of it', () => {
    const vals = Array.from({ length: 2_000 }, () => withJitter(10_000));
    const lower = vals.filter(v => v < 7_500).length;
    const upper = vals.filter(v => v >= 7_500).length;
    assert.ok(lower > 200 && upper > 200, `lopsided distribution: ${lower} low / ${upper} high`);
  });

  it('a non-positive delay stays immediate rather than becoming a random small wait', () => {
    assert.equal(withJitter(0), 0);
    assert.equal(withJitter(-5), 0);
    assert.equal(withJitter(NaN), 0);
  });
});

describe('both retry queues use it', () => {
  it('the media job queue jitters its backoff', () => {
    const src = readFileSync('server/src/files/media/job-queue.ts', 'utf8');
    assert.match(src, /withJitter\(/, 'media retries must be jittered');
    // Pin it to the scheduling function specifically — importing the helper and not using it here
    // would leave the herd intact.
    const fn = bodyOf(src, 'nextClaimableAfter');
    assert.match(fn, /withJitter\(delay\)/);
  });

  it('the webhook dispatcher jitters its backoff', () => {
    const src = readFileSync('server/src/webhooks/dispatcher.ts', 'utf8');
    assert.match(src, /withJitter\(RETRY_DELAYS_MS\[/,
      'the scheduled retry time must be jittered, not the raw table value');
  });

  it('the backoff schedules themselves are still exponential', () => {
    // Jitter is added ON TOP of backoff, not instead of it — a flat schedule with jitter would spread
    // the herd and still hammer a dependency that needs time.
    const media = readFileSync('server/src/files/media/job-queue.ts', 'utf8');
    assert.match(media, /1: 30_000/);
    assert.match(media, /2: 120_000/);
    const hook = readFileSync('server/src/webhooks/dispatcher.ts', 'utf8');
    const delays = /RETRY_DELAYS_MS = \[([^\]]+)\]/.exec(hook)[1].split(',').map(x => Number(x.trim().replace(/_/g, '')));
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] > delays[i - 1], `webhook delays must increase: ${delays.join(', ')}`);
    }
  });
});

describe('the other retry loops share the one helper instead of carrying a copy (Q-113)', () => {
  // Three sites wanted "exponential, capped, equal jitter": the connect loop in db/mongo.ts, the embedding
  // endpoint's retry, and the search-readiness watcher. The second site is where it is extracted, not the third.
  it('the embedding retry has no private jitter formula', () => {
    const src = stripComments(readFileSync('server/src/brain/embedding.ts', 'utf8'));
    assert.doesNotMatch(src, /function jittered\b/, 'a private jittered() is a second copy of the jitter rule');
    assert.doesNotMatch(src, /Math\.random\(\)/, 'embedding.ts rolls its own jitter again');
    assert.match(src, /backoffDelayMs\(|withJitter\(/, 'the retry delay must come from util/backoff.ts');
    assert.match(src, /from '\.\.\/util\/backoff\.js'/);
  });

  it('the connect loop in db/mongo.ts has no private jitter or doubling', () => {
    const src = stripComments(readFileSync('server/src/db/mongo.ts', 'utf8'));
    assert.match(bodyOf(src, 'connectMongo'), /backoffDelayMs\(/);
    assert.doesNotMatch(src, /delay \* 2/, 'a doubling written by hand is the copy this extraction removed');
  });
});
