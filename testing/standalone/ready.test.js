/**
 * Standalone tests: GET /ready — readiness probe endpoint
 *
 * Covers:
 *  - /ready returns 200 or 503 (never 404, never 401, never 500)
 *  - Response body has the expected shape (ready, checks.mongodb, checks.vectorSearch)
 *  - Each check result has status 'ok' or 'error'
 *  - When ready=false every failing check has a non-empty error string
 *  - /health is unchanged (liveness probe)
 *  - /ready is unauthenticated (no token required)
 *  - Security headers are present on /ready responses
 *
 * Run: node --test testing/standalone/ready.test.js
 *
 * Note: The test accepts both 200 (all checks pass) and 503 (some check fails)
 * because MongoDB / mongot availability is environment-dependent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES } from '../sync/helpers.js';

const BASE = INSTANCES.a;

describe('GET /ready — readiness probe', () => {
  it('returns 200 or 503 (never 404 / 401 / 500)', async () => {
    const r = await fetch(`${BASE}/ready`);
    assert.ok(
      r.status === 200 || r.status === 503,
      `Expected 200 or 503 from /ready, got ${r.status}`,
    );
  });

  it('response body has top-level ready boolean', async () => {
    const r = await fetch(`${BASE}/ready`);
    const body = await r.json();
    assert.equal(typeof body.ready, 'boolean', 'body.ready must be a boolean');
  });

  it('response body has checks.mongodb with status ok or error', async () => {
    const r = await fetch(`${BASE}/ready`);
    const body = await r.json();
    assert.ok(body.checks, 'body.checks must exist');
    assert.ok(body.checks.mongodb, 'body.checks.mongodb must exist');
    assert.ok(
      body.checks.mongodb.status === 'ok' || body.checks.mongodb.status === 'error',
      `checks.mongodb.status must be 'ok' or 'error', got ${body.checks.mongodb.status}`,
    );
  });

  it('response body has checks.vectorSearch with status ok or error', async () => {
    const r = await fetch(`${BASE}/ready`);
    const body = await r.json();
    assert.ok(body.checks.vectorSearch, 'body.checks.vectorSearch must exist');
    assert.ok(
      body.checks.vectorSearch.status === 'ok' || body.checks.vectorSearch.status === 'error',
      `checks.vectorSearch.status must be 'ok' or 'error', got ${body.checks.vectorSearch.status}`,
    );
  });

  it('ready=true iff HTTP status is 200', async () => {
    const r = await fetch(`${BASE}/ready`);
    const body = await r.json();
    if (r.status === 200) {
      assert.equal(body.ready, true, 'HTTP 200 must have ready=true');
    } else {
      assert.equal(body.ready, false, 'HTTP 503 must have ready=false');
    }
  });

  it('when mongodb.status=ok, latencyMs is a non-negative number', async () => {
    const r = await fetch(`${BASE}/ready`);
    const body = await r.json();
    if (body.checks.mongodb.status === 'ok') {
      assert.equal(typeof body.checks.mongodb.latencyMs, 'number',
        'latencyMs must be a number when mongodb is ok');
      assert.ok(body.checks.mongodb.latencyMs >= 0, 'latencyMs must be >= 0');
    }
  });

  it('when a check has status=error, error string is non-empty', async () => {
    const r = await fetch(`${BASE}/ready`);
    const body = await r.json();
    for (const [name, check] of Object.entries(body.checks)) {
      const c = check;
      if (c.status === 'error') {
        assert.ok(c.error && typeof c.error === 'string' && c.error.length > 0,
          `checks.${name}.error must be a non-empty string when status=error`);
      }
    }
  });

  it('is unauthenticated — no Authorization header needed', async () => {
    const r = await fetch(`${BASE}/ready`);
    // Should not return 401 or 403
    assert.ok(r.status !== 401 && r.status !== 403,
      `/ready must not require authentication, got ${r.status}`);
  });

  it('returns JSON content-type', async () => {
    const r = await fetch(`${BASE}/ready`);
    const ct = r.headers.get('content-type') ?? '';
    assert.ok(ct.includes('json'), `Expected JSON content-type, got ${ct}`);
  });

  it('security header X-Content-Type-Options: nosniff is present', async () => {
    const r = await fetch(`${BASE}/ready`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('GET /health — liveness probe unchanged', () => {
  it('still returns 200 with status=ok and ts', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.ts === 'string' && body.ts.length > 0, 'ts must be a non-empty string');
  });
});
