/**
 * Every rate limiter the server makes is timed as the request's `rate` phase: made through `timedRateLimit` (`rate-limit/middleware.ts`),
 * never by a bare `rateLimit(` of `express-rate-limit` (bundle-378, Q-976, S1).
 *
 * ## What it prevents
 *
 * A limiter made bare runs outside the phase timer, so its time is counted in `door` and the `Server-Timing` header says the route's own
 * work cost what the limiter cost. The scope is every tracked server source (`git ls-files`), so a new file is covered without editing
 * this check; the one bare call allowed is the one inside `timedRateLimit`.
 *
 * Run: node --test testing/standalone/a-rate-limiter-is-made-only-timed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, SERVER_SOURCE_ROOT, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HELPER = 'server/src/rate-limit/middleware.ts';

describe('a rate limiter is made only timed', () => {
  it('no tracked server source calls rateLimit( outside timedRateLimit', () => {
    const bare = [];
    let helperCalls = 0;
    for (const file of trackedSources([SERVER_SOURCE_ROOT], { untracked: true })) {
      const text = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      const calls = [...text.matchAll(/(?<![\w.])rateLimit\s*\(/g)].length;
      if (file === HELPER) helperCalls = calls;
      else if (calls > 0) bare.push(`${file}: ${calls}`);
    }
    assert.equal(helperCalls, 1, `${HELPER} makes a limiter outside timedRateLimit (${helperCalls} bare calls)`);
    assert.deepEqual(bare, [], 'a module makes a rate limiter the phase timer does not time');
  });
});
