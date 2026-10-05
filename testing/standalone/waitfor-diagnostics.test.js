/**
 * Standalone tests: waitFor diagnostics + trigger probe.
 *
 * A bare "waitFor timed out after 90000ms" is worse than useless — it makes a
 * persistent, actionable error look like a random flake. That is precisely how the
 * notify rate-limit bug survived three wrong fixes: every sync trigger was coming back
 * 429, the tests swallowed it with `.catch(() => {})`, and all anyone ever saw was a
 * timeout.
 *
 * These tests pin the guard so that failure mode cannot silently return:
 *  - waitFor — the one wait, `testing/_shared/wait-for.mjs` — appends its `diagnose` output to the timeout message
 *  - the stack helper's `waitFor` (`testing/sync/helpers.js`) is that wait, so the same holds at every call site
 *    that imports it from there
 *  - waitFor bounds its own diagnosis (round X, W2): a `diagnose` that reads something a lock can stall never keeps a
 *    FAILED wait from failing, whichever caller wrote it
 *  - makeTriggerProbe tolerates failures (one bad poll must not fail a test) but
 *    REMEMBERS the last one and reports it
 *
 * Run: node --test testing/standalone/waitfor-diagnostics.test.js
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, waitFor as stackWaitFor, makeTriggerProbe } from '../sync/helpers.js';
import { waitFor, DIAGNOSE_MS } from '../_shared/wait-for.mjs';

describe('waitFor — timeout diagnostics', () => {
  it('appends the diagnose string to the timeout message', async () => {
    await assert.rejects(
      () => waitFor(async () => false, 300, 100, 'because the widget never arrived'),
      (err) => {
        assert.match(err.message, /timed out after 300ms/);
        assert.match(err.message, /because the widget never arrived/);
        return true;
      },
    );
  });

  it('accepts a diagnose function evaluated at timeout', async () => {
    let polls = 0;
    await assert.rejects(
      () => waitFor(async () => { polls++; return false; }, 300, 100, () => `polled ${polls} times`),
      (err) => {
        assert.match(err.message, /polled \d+ times/);
        return true;
      },
    );
  });

  describe('the diagnosis is bounded by the wait itself (round X, W2)', () => {
    // A failed wait must FAIL. `diagnose` is awaited so it may go and look at something, and what it looks at can be what the
    // wait was waiting on (a counter write behind a lock): unbounded, the failure never came and the test ended at the runner's
    // timeout with a message about the runner. The bound is the wait's, so no caller has to remember to write one.
    const never = () => new Promise(() => {});
    const outcome = async (run, limitMs) => {
      let timer;
      const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('HUNG'), limitMs); });
      const started = Date.now();
      try {
        const settled = await Promise.race([run().then(() => ({ error: null }), (error) => ({ error })), hung]);
        return settled === 'HUNG' ? 'HUNG' : { ...settled, ms: Date.now() - started };
      } finally {
        clearTimeout(timer);
      }
    };

    it('a diagnose that never resolves still rejects the wait, within the bound and a margin, and says the diagnosis did not answer', async () => {
      assert.ok(Number.isInteger(DIAGNOSE_MS) && DIAGNOSE_MS > 0 && DIAGNOSE_MS <= 5_000, `the bound is a short stated number, got ${DIAGNOSE_MS}`);
      const r = await outcome(() => waitFor(async () => false, 50, 10, never, { what: 'a thing' }), DIAGNOSE_MS + 3_000);
      assert.notEqual(r, 'HUNG');
      assert.ok(r.error, 'the wait resolved although its condition never held');
      assert.match(r.error.message, /timed out after 50ms waiting for a thing/, 'the timeout itself is still what is said');
      assert.match(r.error.message, /diagnosis did not answer/);
      assert.ok(r.ms < DIAGNOSE_MS + 2_000, `took ${r.ms} ms with a ${DIAGNOSE_MS} ms bound`);
    });

    it('the bound is a parameter of the wait, for a caller that knows its diagnosis is quick', async () => {
      const r = await outcome(() => waitFor(async () => false, 30, 10, never, { diagnoseMs: 80 }), 3_000);
      assert.notEqual(r, 'HUNG');
      assert.match(r.error.message, /diagnosis did not answer within 80ms/);
      assert.ok(r.ms < 1_500, `took ${r.ms} ms`);
    });

    it('a diagnose that throws does not replace the timeout with its own error', async () => {
      const r = await outcome(() => waitFor(async () => false, 30, 10, () => { throw new Error('the probe exploded'); }), 3_000);
      assert.match(r.error.message, /timed out after 30ms/);
      assert.match(r.error.message, /the probe exploded/);
    });

    it('a diagnose that answers in time is appended as before, async or not', async () => {
      for (const diagnose of [() => 'sync said', async () => 'async said']) {
        const r = await outcome(() => waitFor(async () => false, 30, 10, diagnose), 3_000);
        assert.match(r.error.message, /timed out after 30ms — (?:a)?sync said/);
        assert.doesNotMatch(r.error.message, /did not answer/);
      }
    });
  });

  it('still resolves normally when the condition passes (no diagnosis emitted)', async () => {
    const ok = await waitFor(async () => true, 1000, 50, 'should never be seen');
    assert.equal(ok, true);
  });

  it('the stack helper appends it too — it is the same wait, not a copy that can drift', async () => {
    await assert.rejects(
      () => stackWaitFor(async () => false, 300, 100, 'because the widget never arrived'),
      (err) => {
        assert.match(err.message, /timed out after 300ms/);
        assert.match(err.message, /because the widget never arrived/);
        return true;
      },
    );
  });
});

describe('makeTriggerProbe — surfaces a persistently-failing trigger', () => {
  it('records the failure and reports it instead of a bare timeout', async () => {
    // A deliberately invalid token: every trigger is rejected (401). Before this guard
    // the rejection was swallowed and the test died with an unexplained timeout.
    const probe = makeTriggerProbe(INSTANCES.a, 'ythril_totally-invalid-token', 'nonexistent-net', 'A');

    await assert.rejects(
      () => waitFor(async () => { await probe(); return false; }, 600, 150, probe.diagnose),
      (err) => {
        assert.match(err.message, /every sync trigger to A was failing/);
        assert.match(err.message, /triggerSync failed: 401/, `expected the real cause, got: ${err.message}`);
        return true;
      },
    );

    assert.ok(probe.failCount > 0, 'probe must have recorded failures');
    assert.ok(probe.lastError, 'probe must retain the last error');
  });

  it('a probe whose triggers all succeed says so — pointing at the peer, not the trigger', async () => {
    const probe = makeTriggerProbe(INSTANCES.a, 'ythril_totally-invalid-token', 'nonexistent-net', 'A');
    // Never invoked, so nothing failed: the diagnosis must not blame the trigger.
    assert.match(probe.diagnose(), /all succeeded/);
  });
});
