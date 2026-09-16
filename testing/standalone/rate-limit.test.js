/**
 * Integration tests: Rate-limit enforcement
 *
 * Covers (each limiter keeps its own per-IP counter, so the bursts don't
 * cross-contaminate):
 *  - authRateLimit (10/min): POST /api/tokens bursts 11 times → at least one 429
 *  - RateLimit-* headers present in responses
 *  - POST /api/invite/apply (authRateLimit, unauth) rate-limited after threshold
 *  - bulkWipeRateLimit (5/min): the destructive bulk-delete limiter actually 429s
 *  - globalRateLimit (300/min): general API limiter actually 429s
 *  - syncRateLimit (2000/min): sync-surface limiter actually 429s
 *
 * IMPORTANT: These tests consume from the rate-limit window for the test
 * runner's IP. Run with:
 *   node --test testing/rate-limit.test.js
 *
 * Do NOT include in parallel test runs — windows are shared per IP.
 *
 * Note: Rate-limit windows are per-minute. Tests use instance C (port 3202)
 * so they don't affect tests on A and B — and any test hitting instance C
 * within a minute of this file must expect residual 429s.
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE_C = path.join(__dirname, '..', 'sync', 'configs', 'c', 'token.txt');

let tokenC;

describe('authRateLimit on POST /api/tokens', () => {
  before(() => {
    tokenC = fs.readFileSync(TOKEN_FILE_C, 'utf8').trim();
  });

  it('Returns RateLimit headers on token create', async () => {
    const r = await fetch(`${INSTANCES.c}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenC}` },
      body: JSON.stringify({ name: 'rl-probe' }),
    });
    // Should be 201 on first request
    assert.ok(r.status === 201 || r.status === 429, `Expected 201 or 429, got ${r.status}`);
    // express-rate-limit with standardHeaders:'draft-7' sends a combined 'RateLimit' header
    const limit = r.headers.get('ratelimit') ?? r.headers.get('ratelimit-limit') ?? r.headers.get('x-ratelimit-limit');
    assert.ok(limit !== null, 'Should have RateLimit (draft-7) or RateLimit-Limit header');
  });

  it('Burst 11 token creates → at least one 429 (authRateLimit = 10/min)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        fetch(`${INSTANCES.c}/api/tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenC}` },
          body: JSON.stringify({ name: `rl-burst-${i}` }),
        })
      )
    );
    const statuses = responses.map(r => r.status);
    const got429 = statuses.includes(429);
    assert.ok(got429, `Expected at least one 429 in ${JSON.stringify(statuses)}`);
  });
});

describe('authRateLimit on POST /api/invite/apply (unauthenticated)', () => {
  it('Returns 400 or rate-limited on repeated calls without a valid handshakeId', async () => {
    const results = await Promise.all(
      Array.from({ length: 11 }, () =>
        fetch(`${INSTANCES.c}/api/invite/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            handshakeId: 'invalid-id-00000',
            networkId: 'nonexistent',
            rsaPublicKeyPem: '---invalid---',
          }),
        })
      )
    );
    const statuses = results.map(r => r.status);
    // Each should be 400 (bad input) or eventually 429 (rate limit)
    assert.ok(statuses.every(s => s === 400 || s === 404 || s === 429),
      `Unexpected status codes: ${JSON.stringify(statuses)}`);
    // After 10 requests the 11th must be 429 — rate limit must be enforced
    const got429 = statuses.includes(429);
    assert.ok(got429,
      `Expected at least one 429 (rate limit) in ${JSON.stringify(statuses)}. ` +
      `If all are 400, the rate limiter may not be active on /api/invite/apply.`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S8.1 — the remaining limiters had NO 429 test: swap any of them for a
// different limiter (or remove them) and nothing failed. Each burst asserts
// a real 429 plus a positive control that the first request reached the
// route (i.e. the 429 comes from the limiter under test, not from an earlier
// guard or a polluted window).
//
// The limiter fires BEFORE auth/validation and counts failed requests, so
// the bursts below deliberately use requests that cannot mutate anything.
// ═══════════════════════════════════════════════════════════════════════════

/** Fire `count` requests in bounded-concurrency batches; returns all statuses. */
async function burstStatuses(count, makeRequest, concurrency = 100) {
  const statuses = [];
  for (let i = 0; i < count; i += concurrency) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(concurrency, count - i) }, (_, j) =>
        makeRequest(i + j).then(r => r.status)),
    );
    statuses.push(...batch);
  }
  return statuses;
}

/**
 * Wait until a limiter's fixed per-minute window is fresh, then return the
 * status of the confirming (non-429) request.
 *
 * These limiters share the runner's IP with any prior run within the same
 * minute — so a re-run inside 60s would find the window already saturated and
 * defeat the "first request is not 429" positive control. express-rate-limit's
 * default store is a FIXED window (extra requests don't extend it), so polling
 * rides out the original window's expiry. Returns quickly (one request) when
 * the window is already clean, which is the normal single-pass case.
 */
async function waitForFreshWindow(makeRequest, timeoutMs = 70_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = (await makeRequest()).status;
    if (s !== 429) return s;
    if (Date.now() >= deadline) {
      throw new Error(`rate-limit window never cleared within ${timeoutMs}ms — cannot run a clean burst`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

describe('bulkWipeRateLimit on bulk DELETE (5/min)', () => {
  before(() => {
    tokenC = fs.readFileSync(TOKEN_FILE_C, 'utf8').trim();
  });

  it('reaches the route once, then 429s within the limit (5/min)', async () => {
    // Non-existent space + missing confirm body: the request is counted by the
    // limiter but can never delete anything.
    const bulkDelete = () => fetch(`${INSTANCES.c}/api/brain/spaces/rl-bulkwipe-probe/facts`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenC}` },
      body: JSON.stringify({}),
    });

    // Positive control on a guaranteed-fresh window (consumes slot 1 of 5).
    const first = await waitForFreshWindow(bulkDelete);
    assert.notEqual(first, 429, `First bulk delete must reach the route, got ${first}`);

    // Slots 2..7 → the limit (5) is crossed, so a 429 must appear. A swap to
    // globalRateLimit (300/min) would yield NO 429 here — that is the mechanism
    // this catches.
    const rest = [];
    for (let i = 0; i < 6; i++) rest.push((await bulkDelete()).status);
    assert.ok(rest.includes(429),
      `Expected a 429 within the limit (5/min), got first=${first} rest=${JSON.stringify(rest)}. ` +
      `If none, bulkWipeRateLimit is not enforced on the bulk-delete routes.`);
  });
});

describe('globalRateLimit (300/min)', () => {
  before(() => {
    tokenC = fs.readFileSync(TOKEN_FILE_C, 'utf8').trim();
  });

  it('Burst past 300 GET /api/networks → first succeeds, at least one 429', async () => {
    const req = () => fetch(`${INSTANCES.c}/api/networks`, { headers: { 'Authorization': `Bearer ${tokenC}` } });
    const first = await waitForFreshWindow(req);
    assert.equal(first, 200, `First request must succeed (positive control), got ${first}`);

    const statuses = await burstStatuses(305, req);
    const count429 = statuses.filter(s => s === 429).length;
    assert.ok(count429 >= 1,
      `Expected at least one 429 after 300 requests (globalRateLimit), got statuses: ` +
      `${JSON.stringify([...new Set(statuses)])} (429 count: ${count429})`);
  });
});

describe('syncRateLimit (2000/min)', () => {
  before(() => {
    tokenC = fs.readFileSync(TOKEN_FILE_C, 'utf8').trim();
  });

  it('Burst past 2000 GET /api/sync/facts → first reaches the route, at least one 429', async () => {
    // No spaceId → fast 400 from the handler; the limiter counts it anyway.
    const req = () => fetch(`${INSTANCES.c}/api/sync/facts`, { headers: { 'Authorization': `Bearer ${tokenC}` } });
    const first = await waitForFreshWindow(req);
    assert.equal(first, 400, `First request must reach the handler (positive control), got ${first}`);

    const statuses = await burstStatuses(2005, req, 200);
    const count429 = statuses.filter(s => s === 429).length;
    assert.ok(count429 >= 1,
      `Expected at least one 429 after 2000 requests (syncRateLimit), got statuses: ` +
      `${JSON.stringify([...new Set(statuses)])} (429 count: ${count429})`);
  });
});
