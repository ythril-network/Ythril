/**
 * The search-availability probe — against the REAL one, through its injectable factory.
 *
 * The previous version of this file was the deepest drift in the batch. It did not merely copy the
 * production code; it tested a **different algorithm that no longer exists**. Its subject was
 * `checkVectorSearch` / `isVectorSearchAvailable` — neither of which appears anywhere in `server/src` —
 * and its premise was that the probe runs a `$vectorSearch` aggregate and classifies the resulting
 * error: "unknown stage" meaning unsupported, anything else meaning supported.
 *
 * Production does none of that. It calls `listSearchIndexes()` on a throwaway collection, retries six
 * times with a 2s backoff, and gives up on the COLD-START window. It does not distinguish error kinds there —
 * a cold `mongot` and a permanently unsupported deployment look identical to it, and the retry is what tells
 * them apart in practice.
 *
 * So every assertion in the old file described behaviour the product had stopped having. It passed
 * throughout.
 *
 * ## What changed with Q-113, and what this file now pins
 *
 * The incident behind the memoisation is unchanged: `ensureVectorSearchIndex` runs once per collection per
 * space, so an unmemoised probe made a cold boot pay the full 12-second backoff five times per space. What
 * was WRONG was the cache keeping a NEGATIVE answer for the life of the process: a mongot that started thirteen
 * seconds late was never asked again, and semantic recall stayed empty until a restart.
 *
 * The contract is now: **callers do not re-probe while down — the watcher does.** The cold-start window is
 * still one per process and single-flight; after it, a `down` answer is read from the state by every caller and
 * the one place that probes is the watcher, on its own backoff (`a-late-search-service-is-retried.test.js`
 * pins that schedule, the absent state and the waiters; this file keeps the cold-start and memoisation
 * contract that the old file owned, expressed against the factory rather than a probe argument).
 *
 * Run: node --test testing/standalone/vector-search-check.test.js
 * (requires a prior `npm run build` in server/)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualTime, captureLog } from './_virtual-time.mjs';

let createSearchReadiness;
before(async () => { ({ createSearchReadiness } = await import('../../server/dist/spaces/search-readiness.js')); });

/** A probe that fails `failures` times and then succeeds, counting calls. */
function flakyProbe(failures) {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls <= failures) throw new Error('mongot is not answering yet');
    return [];
  };
  Object.defineProperty(fn, 'calls', { get: () => calls });
  return fn;
}

/** A readiness over virtual time: nothing waits for real. */
function make(probe) {
  const vt = createVirtualTime();
  const r = createSearchReadiness({ probe, sleep: vt.sleep, now: vt.now, scheduler: vt.scheduler, log: captureLog().log });
  return { r, vt };
}

describe('searchAvailable — answering', () => {
  it('returns true on the first successful probe, with no backoff', async () => {
    const probe = flakyProbe(0);
    const { r, vt } = make(probe);
    assert.equal(await vt.drive(r.searchAvailable()), true);
    assert.equal(probe.calls, 1);
    assert.deepEqual(vt.slept, [], 'a healthy database should not be made to wait');
  });
});

describe('searchAvailable — retrying past a cold start', () => {
  it('keeps trying and succeeds once search comes up', async () => {
    // The case the retry exists for: `mongot` is slower to start than the app. Failing immediately
    // would report the deployment as unsupported and leave recall silently empty.
    const probe = flakyProbe(3);
    const { r, vt } = make(probe);
    assert.equal(await vt.drive(r.searchAvailable()), true);
    assert.equal(probe.calls, 4);
    assert.deepEqual(vt.slept.filter(ms => ms === 2000), [2000, 2000, 2000]);
  });

  it('gives up the WINDOW after six attempts and reports unavailable', async () => {
    const probe = flakyProbe(Infinity);
    const { r, vt } = make(probe);
    assert.equal(await vt.drive(r.searchAvailable()), false);
    assert.equal(probe.calls, 6);
  });

  it('does not sleep after the final attempt', async () => {
    // Five waits for six attempts. A sixth would add two seconds of delay after the decision is
    // already made.
    const { r, vt } = make(flakyProbe(Infinity));
    await vt.drive(r.searchAvailable());
    assert.equal(vt.slept.filter(ms => ms === 2000).length, 5);
  });
});

describe('searchAvailable — callers do not re-probe while down; the watcher does', () => {
  it('probes ONCE however many callers ask at once', async () => {
    // ensureVectorSearchIndex awaits this per collection per space. Without the single flight a cold boot
    // paid the full backoff five times per space and delayed startup enough to break crash recovery.
    const probe = flakyProbe(0);
    const { r, vt } = make(probe);
    await vt.drive(Promise.all([r.searchAvailable(), r.searchAvailable(), r.searchAvailable()]));
    assert.equal(probe.calls, 1, 'concurrent callers must share one probe');
  });

  it('a NEGATIVE answer is read by later callers, not re-asked: the second call does not probe', async () => {
    // The expensive case. Re-probing after a failure would pay 12 seconds again per caller — the exact cost the
    // single flight exists to avoid, on the path where it hurts most. What changed is WHO may probe next: only
    // the watcher, below.
    const probe = flakyProbe(Infinity);
    const { r, vt } = make(probe);
    assert.equal(await vt.drive(r.searchAvailable()), false);
    assert.equal(await vt.drive(r.searchAvailable()), false);
    assert.equal(probe.calls, 6, 'the second caller must not probe');
  });

  it('the negative answer is NOT permanent: the watcher asks again and the next caller sees search up', async () => {
    // The defect. One caller-proof answer of `false` used to live for the whole process.
    const probe = flakyProbe(7);
    const { r, vt } = make(probe);
    assert.equal(await vt.drive(r.searchAvailable()), false);
    assert.equal(probe.calls, 6);
    await vt.advance(60_000);
    assert.ok(probe.calls >= 8, `the watcher never probed again (${probe.calls} calls)`);
    assert.equal(await vt.drive(r.searchAvailable()), true, 'a service that answers must be reported available without a restart');
  });

  it('reset clears the state, so a later call starts a fresh window', async () => {
    const probe = flakyProbe(0);
    const { r, vt } = make(probe);
    await vt.drive(r.searchAvailable());
    r.reset();
    await vt.drive(r.searchAvailable());
    assert.equal(probe.calls, 2);
  });
});
