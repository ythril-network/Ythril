/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * A run that is going to be KILLED part-way: one test finishes at once, then a second announces itself on
 * stdout and waits far longer than the gate does. The gate kills the runner on the announcement and reads what
 * the timing file held — a run cut off by a CI timeout looks exactly like that.
 */
import { test } from 'node:test';
import { READY } from './timing-constants.mjs';
import { elapse } from '../../_shared/sleep.mjs';

test('finishes before the kill', () => {});

test('is still running when the kill comes', async () => {
  // Long enough for the report of the first test to have reached the reporter, short enough that the orphaned
  // worker (the gate kills the runner, not this process) goes away by itself.
  await elapse(1500, 'simulated latency: a run that reaches the reporter before it announces itself');
  console.log(READY);
  await elapse(8000, 'simulated latency: a test still running when the gate kills its runner');
});
