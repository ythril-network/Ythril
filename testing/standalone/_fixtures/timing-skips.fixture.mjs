/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * Every way node:test lets a test or a suite be skipped, plus the two near-misses a reporter must NOT count:
 * a todo, and a test that prints "SKIPPED" and returns (a plain pass to node, so invisible to any reporter).
 * The skipped suites matter most: node's own `skipped` total leaves them out, and their children are never
 * reported at all.
 */
import { test, describe } from 'node:test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('skip via option true', { skip: true }, () => {});
test('skip via option reason', { skip: 'because option reason' }, () => {});
test('skip via t.skip() inside', async (t) => { await sleep(20); t.skip('because t.skip reason'); });
test('skip via t.skip() without a reason', (t) => { t.skip(); });
test('skip via t.skip() then return', async (t) => { t.skip('t.skip then return'); return; });
test.skip('skip via test.skip', () => {});
test.todo('a todo');
test('print and return', async () => { console.log('SKIPPED: nothing to check'); });
describe('skipped suite via option', { skip: 'suite skipped reason' }, () => {
  test('child of a skipped suite', () => {});
});
describe.skip('skipped suite via describe.skip', () => {
  test('child of describe.skip', () => {});
});
describe('suite with a skipping child', () => {
  test('inner t.skip', (t) => { t.skip('inner reason'); });
  test('inner passes', () => {});
});
