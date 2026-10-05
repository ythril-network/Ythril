/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * The other file of the concurrent pair (see `timing-concurrent-a.fixture.mjs`).
 */
import { test } from 'node:test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('concurrent b quick', async () => { await sleep(20); });
test('concurrent b medium', async () => { await sleep(150); });
