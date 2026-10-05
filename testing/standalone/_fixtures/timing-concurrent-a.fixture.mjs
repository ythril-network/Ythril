/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * One of two files run side by side: every event must keep its own file, whatever order they arrive in.
 */
import { test } from 'node:test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('concurrent a slow', async () => { await sleep(400); });
test('concurrent a skipped', (t) => { t.skip('concurrent a skip reason'); });
