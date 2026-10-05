/**
 * Fixture for the timing-reporter gates — NOT a test of the repo. Run only by explicit path from
 * `testing/standalone/_timing-runs.mjs`; its name is not `*.test.js` on purpose (see that module).
 *
 * Passes, in a suite with a nested suite, with a measurable duration so a file's figure can be compared with
 * its tests'.
 */
import { describe, it } from 'node:test';
import { sleep } from '../../_shared/sleep.mjs';

describe('pass suite', () => {
  it('passes after a wait', async () => { await sleep(60); });
  it('passes at once', () => {});
  describe('nested suite', () => {
    it('passes nested', () => {});
  });
});
