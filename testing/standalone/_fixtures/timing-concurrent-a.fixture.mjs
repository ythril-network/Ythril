/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * One of two files run side by side: every event must keep its own file, whatever order they arrive in.
 */
import { test } from 'node:test';
import { elapse } from '../../_shared/sleep.mjs';

test('concurrent a slow', async () => { await elapse(400, 'simulated latency: a test of measurable duration the reporter must keep to this file'); });
test('concurrent a skipped', (t) => { t.skip('concurrent a skip reason'); });
