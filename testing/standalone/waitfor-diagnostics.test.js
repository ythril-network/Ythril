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
import { waitFor } from '../_shared/wait-for.mjs';

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
