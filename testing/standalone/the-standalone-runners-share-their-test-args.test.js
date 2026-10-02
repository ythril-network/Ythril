/**
 * Both runners of the standalone batches start `node` with the same arguments, read from one module.
 *
 * `scripts/preflight.mjs` and `testing/_init/run-standalone.mjs` both run standalone batches. A flag on one and not
 * the other is a preflight that passes where CI hangs: `--test-force-exit` (see `testing/_shared/node-test-args.mjs`)
 * is what stops one leaked handle from holding a batch, and CI's Build & Test for PR #1475 sat for an hour without
 * it. So neither runner may spell its own `--test` invocation; each takes `NODE_TEST_ARGS`.
 *
 * Seen red by mutation, restored by hand: one preflight call put back to a bare `node --test`.
 *
 * Run: node --test testing/standalone/the-standalone-runners-share-their-test-args.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NODE_TEST_ARGS } from '../_shared/node-test-args.mjs';

const RUNNERS = ['scripts/preflight.mjs', 'testing/_init/run-standalone.mjs'];

/** Source with comments removed, so a docblock that mentions `node --test` is neither a hit nor a pass. */
function code(path) {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the standalone runners share their test arguments', () => {
  it('the shared arguments end a file once it has reported', () => {
    assert.ok(NODE_TEST_ARGS.includes('--test'), 'NODE_TEST_ARGS no longer starts the test runner');
    assert.ok(NODE_TEST_ARGS.includes('--test-force-exit'),
      'NODE_TEST_ARGS dropped --test-force-exit, so one leaked handle can hold a whole batch again');
  });

  for (const runner of RUNNERS) {
    it(`${runner} takes them from the shared module and spells no invocation of its own`, () => {
      const src = code(runner);
      assert.match(src, /import\s*\{[^}]*\bNODE_TEST_ARGS\b[^}]*\}\s*from\s*['"][^'"]*node-test-args\.mjs['"]/,
        `${runner} does not import NODE_TEST_ARGS`);
      const own = [...src.matchAll(/node --test\b|['"]--test['"]/g)].map(m => m[0]);
      assert.deepEqual(own, [], `${runner} starts the test runner with arguments of its own: ${own.join(', ')}`);
      assert.match(src, /NODE_TEST_ARGS/g, `${runner} imports NODE_TEST_ARGS and never uses it`);
    });
  }
});
