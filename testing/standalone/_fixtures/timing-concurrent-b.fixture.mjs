/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * The other file of the concurrent pair (see `timing-concurrent-a.fixture.mjs`).
 */
import { test } from 'node:test';
import { elapse } from '../../_shared/sleep.mjs';

test('concurrent b quick', async () => { await elapse(20, 'simulated latency: a quick test of measurable duration the reporter must keep to this file'); });
test('concurrent b medium', async () => { await elapse(150, 'simulated latency: a medium test of measurable duration the reporter must keep to this file'); });
