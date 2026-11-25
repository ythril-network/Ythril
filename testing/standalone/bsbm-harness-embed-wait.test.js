/**
 * The wait for the embed queue to drain before a measured run (Q-759): until the instance reports nothing pending, at
 * most a deadline, and the wait and what was left are recorded either way.
 *
 * Run: node --test testing/standalone/bsbm-harness-embed-wait.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDrain } from '../../benchmarks/rdf/embed-wait.mjs';

/** A clock the sleeps move: the wait is measured in the clock's own milliseconds, not in real ones. */
function clock() {
  let t = 1000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}
const queue = (...pending) => { let i = 0; return async () => ({ pending: pending[Math.min(i++, pending.length - 1)], processing: 0 }); };

test('a queue that is already empty is drained at once, with no wait', async () => {
  const c = clock();
  assert.deepEqual(await waitForDrain({ probe: queue(0), ...c, pollMs: 5000, deadlineMs: 60000 }), { waitedMs: 0, pending: 0, drained: true });
});

test('the wait is the time until the first report of nothing pending', async () => {
  const c = clock();
  const r = await waitForDrain({ probe: queue(900, 400, 0), ...c, pollMs: 5000, deadlineMs: 60000 });
  assert.deepEqual(r, { waitedMs: 10000, pending: 0, drained: true });
});

test('a job being processed is not drained: pending 0 with one processing waits on', async () => {
  const c = clock();
  const answers = [{ pending: 0, processing: 1 }, { pending: 0, processing: 0 }];
  let i = 0;
  const r = await waitForDrain({ probe: async () => answers[i++], ...c, pollMs: 1000, deadlineMs: 60000 });
  assert.deepEqual(r, { waitedMs: 1000, pending: 0, drained: true });
});

test('past the deadline the run goes on: the pending count at that time is recorded and drained is false', async () => {
  const c = clock();
  const r = await waitForDrain({ probe: queue(500, 400, 300, 200), ...c, pollMs: 1000, deadlineMs: 2500 });
  assert.equal(r.drained, false);
  assert.equal(r.pending, 200);
  assert.ok(r.waitedMs >= 2500 && r.waitedMs <= 3500, `waited ${r.waitedMs}`);
});

test('a probe that fails is not an empty queue', async () => {
  const c = clock();
  await assert.rejects(waitForDrain({ probe: async () => { throw new Error('stats unavailable'); }, ...c, pollMs: 1000, deadlineMs: 5000 }), /stats unavailable/);
  await assert.rejects(waitForDrain({ probe: async () => ({}), ...c, pollMs: 1000, deadlineMs: 5000 }), /pending/);
});
