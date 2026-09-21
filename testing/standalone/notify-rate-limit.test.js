/**
 * Standalone tests: the notify limiter honours the test kill-switch.
 *
 * `notifyRateLimit` allows 60/min per IP — and every request from the harness shares a single source IP,
 * so the sync suites collectively exhausted the window and started getting 429s. The trigger call swallows
 * errors, so a 429 meant the sync cycle silently never ran, and load-sensitive sync assertions timed out
 * looking like flakes (this is what made the signed-vote relay test intermittently fail in CI).
 *
 * **IT WAS DRIVEN THROUGH `POST /api/notify/trigger`, WHICH 5.0 REMOVED.** The harness now triggers a sync
 * through `POST /api/networks/:id/sync`, which is guarded by `globalRateLimit` and its own
 * `SKIP_GLOBAL_RATE_LIMIT` — so the original flake would now arrive through a different limiter, and the
 * test stack sets that switch too. The subject HERE is unchanged and still needs covering: the notify
 * limiter still guards `GET /api/notify` and `POST /api/notify`, which peers call, and a limiter with no
 * kill-switch is what this file exists to prevent shipping again.
 *
 * notifyRateLimit was the ONLY limiter with no `skip:` clause. These tests pin both
 * halves of the fix:
 *   - instance A (SKIP_SYNC_RATE_LIMIT=true) must serve well past 60 triggers/min
 *   - instance C (no kill-switch) must still enforce the real 429
 *
 * Run: node --test testing/standalone/notify-rate-limit.test.js
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

const tokenFor = (inst) => fs.readFileSync(path.join(CONFIGS, inst, 'token.txt'), 'utf8').trim();

/** Fire n sequential notify reads, returning the status codes seen. */
async function hammerNotify(baseUrl, token, n) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    // A READ, deliberately: it goes through the same limiter and changes nothing, so the probe cannot
    // leave state behind on an instance the sync suites also use.
    const res = await fetch(`${baseUrl}/api/notify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    codes.push(res.status);
  }
  return codes;
}

describe('notify rate limit — kill-switch', () => {
  it('instance A (SKIP_SYNC_RATE_LIMIT set) serves far more than 60 notify calls/min', async () => {
    // 90 > the 60/min ceiling. Before the fix this produced 30x 429 on A, which is
    // precisely how the harness lost its sync triggers under load.
    const codes = await hammerNotify(INSTANCES.a, tokenFor('a'), 90);
    const tooMany = codes.filter(c => c === 429).length;
    assert.equal(
      tooMany, 0,
      `notify triggers on A must not be rate-limited when the kill-switch is set (got ${tooMany}x 429)`,
    );
    assert.ok(codes.every(c => c === 200), `expected all 200s, saw: ${[...new Set(codes)].join(',')}`);
  });

  it('instance C (no kill-switch) still enforces the real 60/min limit', async () => {
    // C deliberately omits the SKIP_* envs so the genuine 429 behaviour stays covered.
    const codes = await hammerNotify(INSTANCES.c, tokenFor('c'), 75);
    assert.ok(
      codes.includes(429),
      'C must still rate-limit notify — the kill-switch must not weaken real deployments',
    );
  });
});
