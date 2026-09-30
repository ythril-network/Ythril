/**
 * `backoffDelayMs` — the one place an exponential, capped, jittered retry delay is computed (Q-113).
 *
 * ## Why it is a module
 *
 * The same rule was written twice and a third site was about to write it: `db/mongo.ts` connect doubled a local
 * `delay` (250 -> 4000) and jittered it through `withJitter`; `brain/embedding.ts` carried its own copy of the
 * equal-jitter formula as `jittered()`; and the search-readiness watcher needs "5 s, doubling, forever, capped at
 * 5 min". Three copies of "half is a floor, half is random" is how one of them ends up with full jitter, or
 * without a cap, or with an exponent that overflows to Infinity after a thousand attempts.
 *
 * ## What this pins
 *
 *  - the rule itself: growth by doubling from `attempt 0 = base`, a cap that holds for ever (including an
 *    attempt so large that 2 ** attempt is Infinity), equal jitter inside [half, full], the injected `random`;
 *  - that the NEW helper yields exactly the delays the two hand-rolled copies yielded, for the same seeded
 *    random — so moving the callers onto it changes no retry schedule an operator has tuned against.
 *
 * The OLD formulas below are literal fixtures, on purpose: a fixture that derived its expectation from the
 * helper would assert the helper equals itself.
 *
 * Run: node --test testing/standalone/backoff-delay-grows-to-a-cap.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let backoffDelayMs;
before(async () => { ({ backoffDelayMs } = await import('../../server/dist/util/backoff.js')); });

/** A small seeded PRNG (mulberry32) so two sequences can be compared draw for draw. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The hand-rolled originals, copied literally from the base commit.
/** db/mongo.ts connectMongo: `let delay = 250; wait = withJitter(delay); delay = Math.min(delay * 2, 4_000)`. */
function oldConnectSequence(rand, n) {
  const out = [];
  let delay = 250;
  for (let i = 0; i < n; i++) {
    const half = delay / 2;
    out.push(Math.round(half + rand() * half));
    delay = Math.min(delay * 2, 4_000);
  }
  return out;
}
/** brain/embedding.ts jittered(): `Math.round(baseMs / 2 + Math.random() * (baseMs / 2))`. */
const oldEmbeddingJittered = (baseMs, rand) => Math.round(baseMs / 2 + rand() * (baseMs / 2));

describe('backoffDelayMs — the rule', () => {
  it('attempt 0 is the base: the first retry waits what the caller said it should', () => {
    assert.equal(backoffDelayMs(0, 250, 4_000, () => 1), 250);
    assert.equal(backoffDelayMs(0, 250, 4_000, () => 0), 125);
  });

  it('doubles per attempt until the cap, then holds the cap', () => {
    const top = Array.from({ length: 8 }, (_, n) => backoffDelayMs(n, 250, 4_000, () => 1));
    assert.deepEqual(top, [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000]);
  });

  it('the cap holds for ever — an attempt so large that 2 ** attempt is Infinity still returns the cap', () => {
    // A watcher that retries every 5 minutes for a year is at attempt ~100 000. Infinity * 0 is NaN, and a NaN
    // timer fires at once: the cap is what stops a dead service being hammered in a tight loop.
    for (const attempt of [60, 1_100, 100_000, Number.MAX_SAFE_INTEGER]) {
      assert.equal(backoffDelayMs(attempt, 5_000, 300_000, () => 1), 300_000, `attempt ${attempt}`);
      const low = backoffDelayMs(attempt, 5_000, 300_000, () => 0);
      assert.equal(low, 150_000, `attempt ${attempt} at the floor`);
    }
  });

  it('equal jitter: always inside [delay/2, delay], never outside whatever the draw', () => {
    const rand = seeded(7);
    for (let attempt = 0; attempt < 40; attempt++) {
      const nominal = Math.min(5_000 * 2 ** attempt, 300_000);
      for (let i = 0; i < 50; i++) {
        const v = backoffDelayMs(attempt, 5_000, 300_000, rand);
        assert.ok(v >= nominal / 2 - 1 && v <= nominal, `${v} outside [${nominal / 2}, ${nominal}] at attempt ${attempt}`);
      }
    }
  });

  it('actually scatters with the default random, so a herd does not retry in lockstep', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) seen.add(backoffDelayMs(3, 5_000, 300_000));
    assert.ok(seen.size > 100, `only ${seen.size} distinct delays`);
  });

  it('uses the random it is given and no other', () => {
    const a = backoffDelayMs(2, 1_000, 60_000, () => 0.25);
    const b = backoffDelayMs(2, 1_000, 60_000, () => 0.25);
    assert.equal(a, b);
    assert.equal(a, Math.round(2_000 + 0.25 * 2_000));
  });

  it('NaN and non-positive inputs never produce NaN, Infinity or a negative wait', () => {
    // NaN in a setTimeout means "now" — a retry loop with no delay at all.
    for (const v of [backoffDelayMs(NaN, 250, 4_000, () => 0.5), backoffDelayMs(-3, 250, 4_000, () => 0.5),
      backoffDelayMs(Infinity, 250, 4_000, () => 0.5)]) {
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 4_000, `got ${v}`);
    }
    assert.equal(backoffDelayMs(2, NaN, 4_000, () => 0.5), 0, 'a NaN base stays immediate, like withJitter(NaN)');
    assert.equal(backoffDelayMs(2, 0, 4_000, () => 0.5), 0);
    assert.equal(backoffDelayMs(2, -5, 4_000, () => 0.5), 0);
    assert.ok(Number.isFinite(backoffDelayMs(2, 250, NaN, () => 0.5)), 'a NaN cap must not poison the delay');
  });
});

describe('backoffDelayMs — the delays the hand-rolled copies produced', () => {
  it('db/mongo.ts connect: 250 doubling to 4000, the same sequence for the same random', () => {
    for (const seed of [1, 2, 3, 42, 2026, 99_999]) {
      const old = oldConnectSequence(seeded(seed), 12);
      const rand = seeded(seed);
      const now = Array.from({ length: 12 }, (_, n) => backoffDelayMs(n, 250, 4_000, rand));
      assert.deepEqual(now, old, `seed ${seed}: the connect retry schedule changed`);
    }
  });

  it('brain/embedding.ts jittered(): a flat base jittered once, the same value for the same random', () => {
    // The embedding retry never doubles (its table is [120, 360] and a Retry-After), so it is one jitter of a
    // given base: attempt 0 with the base as its own cap.
    for (const base of [120, 360, 1_000, 2_500, 4_000]) {
      for (const seed of [5, 6, 7]) {
        assert.equal(backoffDelayMs(0, base, base, seeded(seed)), oldEmbeddingJittered(base, seeded(seed)),
          `base ${base}, seed ${seed}`);
      }
    }
  });
});
