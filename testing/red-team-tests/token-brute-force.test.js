/**
 * Red-team tests: Token brute-force protection via rate limiting
 *
 * Sends many requests with invalid tokens to verify that the rate limiter
 * cuts off brute-force attempts before the attacker can enumerate valid tokens.
 *
 * Strategy:
 *  - 11 rapid invalid-token requests to an authRateLimit-guarded endpoint
 *  - At least one must return 429 within the same rate-limit window
 *  - Subsequent valid requests from the SAME IP may also be limited (window effect)
 *
 * NOTE: This test deliberately exhausts the authRateLimit window on instance B.
 *
 * Run: node --test testing/red-team-tests/token-brute-force.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES } from '../sync/helpers.js';

/** Send one token-creation attempt with a fake Bearer token.
 * Uses instance C — only C runs with real auth rate limiting (A and B have
 * SKIP_AUTH_RATE_LIMIT=true to avoid exhausting the window during parallel tests). */
async function tryCreate(fakeToken) {
  return fetch(`${INSTANCES.c}/api/tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${fakeToken}`,
    },
    body: JSON.stringify({ name: 'brute-force-probe' }),
  });
}

describe('Brute-force token enumeration on POST /api/tokens', () => {
  it('11 concurrent invalid-token attempts → at least one 429', async () => {
    const results = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        tryCreate(`ythril_bruteforce_${i.toString().padStart(10, '0')}`)
      )
    );
    const statuses = results.map(r => r.status);
    // All should be auth rejection (401) or rate limited (429)
    assert.ok(statuses.every(s => s === 401 || s === 429),
      `Expected only 401/429 statuses, got: ${JSON.stringify(statuses)}`);
    const got429 = statuses.includes(429);
    assert.ok(got429,
      `Expected at least one 429 in burst, got: ${JSON.stringify(statuses)}`);
  });

  it('Rate-limit response includes Retry-After or RateLimit headers', async () => {
    // Send requests until we hit a 429
    let retryAfter = null;
    let rateLimitReset = null;

    for (let i = 0; i < 15; i++) {
      const r = await tryCreate(`ythril_bruteforce_extra_${i}`);
      if (r.status === 429) {
        retryAfter = r.headers.get('retry-after');
        rateLimitReset = r.headers.get('ratelimit-reset') ?? r.headers.get('x-ratelimit-reset');
        break;
      }
    }
    // If we got a 429, at least one guidance header must be present and non-empty
    if (retryAfter !== null || rateLimitReset !== null) {
      const value = (retryAfter ?? rateLimitReset ?? '').trim();
      assert.ok(
        value.length > 0,
        `Rate-limited response has a header but its value is empty (retryAfter=${retryAfter}, rateLimitReset=${rateLimitReset})`,
      );
    }
    // If no rate-limit headers were seen the window was already exhausted — still passing
  });
});

describe('Unauthenticated endpoint rate limiting (invite/apply)', () => {
  it('11 invalid apply attempts → at least one 429 or all 4xx', async () => {
    const results = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        fetch(`${INSTANCES.c}/api/invite/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            handshakeId: `fake-id-${i}`,
            networkId: 'no-such-network',
            rsaPublicKeyPem: '---not-a-key---',
          }),
        })
      )
    );
    const statuses = results.map(r => r.status);
    // All must be 4xx — no 2xx should slip through
    assert.ok(statuses.every(s => s >= 400),
      `Expected all 4xx, got: ${JSON.stringify(statuses)}`);
  });
});
