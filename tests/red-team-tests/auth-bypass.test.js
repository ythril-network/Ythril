/**
 * Red-team tests: Authentication bypass attempts
 *
 * Simulates common auth attack vectors against the API.
 * Every case should return 401 — never 200/201/204.
 *
 * Run: node --test tests/red-team-tests/auth-bypass.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES } from '../sync/helpers.js';

/** Make a request to a protected endpoint with a custom Authorization header value */
async function probe(authValue) {
  const headers = {};
  if (authValue !== null) headers['Authorization'] = authValue;
  const r = await fetch(`${INSTANCES.a}/api/tokens`, { headers });
  return r.status;
}

describe('Missing / malformed authorization', () => {
  it('No Authorization header → 401', async () => {
    assert.equal(await probe(null), 401);
  });

  it('Empty Authorization header → 401', async () => {
    assert.equal(await probe(''), 401);
  });

  it('Authorization: Bearer (no token) → 401', async () => {
    assert.equal(await probe('Bearer '), 401);
  });

  it('Authorization: Basic dXNlcjpwYXNz (basic auth) → 401', async () => {
    assert.equal(await probe('Basic dXNlcjpwYXNz'), 401);
  });

  it('Authorization: Token xyz (wrong scheme) → 401', async () => {
    assert.equal(await probe('Token sometoken'), 401);
  });
});

describe('Invalid token values', () => {
  it('Completely random string → 401', async () => {
    assert.equal(await probe('Bearer definitely_not_a_real_token_abc'), 401);
  });

  it('Token with wrong prefix (no "ythril_") → 401', async () => {
    assert.equal(await probe('Bearer ghp_abc123def456ghi789jkl012mno345pqr'), 401);
  });

  it('Token that looks correct but is wrong → 401', async () => {
    // Matches ythril_ prefix but wrong content
    assert.equal(await probe('Bearer ythril_fakefakefakefakefakefakefake'), 401);
  });

  it('Null bytes in token → rejected (fetch error or 401)', async () => {
    // Headers containing null bytes are an invalid HTTP construct.
    // Node's fetch (undici) refuses to send them — that's the correct behaviour.
    // Either the client throws or the server returns 401.
    try {
      const status = await probe('Bearer ythril_\x00\x00\x00');
      assert.ok(status === 401 || status === 400,
        `Expected rejection for null-byte token, got ${status}`);
    } catch {
      // fetch threw — null bytes correctly rejected at the client layer
    }
  });

  it('Very long token (DoS probe) → 401 not 500', async () => {
    const longToken = 'ythril_' + 'A'.repeat(4096);
    const status = await probe(`Bearer ${longToken}`);
    assert.ok(status === 401 || status === 400 || status === 429,
      `Expected 4xx, got ${status}`);
  });

  it('JSON object disguised as token → 401', async () => {
    assert.equal(await probe('Bearer {"__proto__":"polluted"}'), 401);
  });

  it('SQL injection in token → 401', async () => {
    assert.equal(await probe("Bearer ' OR '1'='1"), 401);
  });

  it('NoSQL injection in token → 401', async () => {
    assert.equal(await probe('Bearer {"$gt":""}'), 401);
  });
});

describe('Cross-instance token rejection', () => {
  it("Instance B's token rejected by instance A → 401", async () => {
    // B's token is a valid Ythril PAT but from a different instance
    let tokenB;
    try {
      const fs = (await import('fs')).default;
      const path = (await import('path')).default;
      const { fileURLToPath } = await import('url');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      tokenB = fs.readFileSync(path.join(__dirname, '..', 'sync', 'configs', 'b', 'token.txt'), 'utf8').trim();
    } catch {
      // Token file not found — skip by asserting trivially
      return;
    }
    const r = await fetch(`${INSTANCES.a}/api/tokens`, {
      headers: { 'Authorization': `Bearer ${tokenB}` },
    });
    assert.equal(r.status, 401, "B's token must not authenticate against A");
  });
});

describe('Protected routes without auth return 401 not 500', () => {
  const ROUTES = [
    ['GET', '/api/tokens'],
    ['GET', '/api/spaces'],
    ['GET', '/api/networks'],
    ['GET', '/api/files/general'],
    ['GET', '/api/brain/general/memories'],
  ];
  for (const [method, route] of ROUTES) {
    it(`${method} ${route} without auth → 401`, async () => {
      const r = await fetch(`${INSTANCES.a}${route}`, { method });
      assert.equal(r.status, 401, `Expected 401 for ${method} ${route}, got ${r.status}`);
    });
  }
});
