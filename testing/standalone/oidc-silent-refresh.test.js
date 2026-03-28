/**
 * Standalone tests: OIDC silent refresh — server-side coverage
 *
 * The full silent refresh cycle (iframe → IdP → postMessage → code exchange)
 * requires a live browser. These tests cover the server-side contracts that
 * the silent refresh depends on:
 *
 *  - /oidc-callback route serves the SPA (200, HTML) — required for iframe src
 *  - /api/auth/oidc-info returns expected shape (enabled boolean)
 *  - /api/auth/oidc-info is accessible without authentication (pre-login)
 *  - The SPA's CSP allows same-origin iframing (frame-ancestors 'self')
 *
 * Run: node --test testing/standalone/oidc-silent-refresh.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES } from '../sync/helpers.js';

const BASE = INSTANCES.a;

describe('OIDC silent refresh — server-side contracts', () => {
  it('/oidc-callback serves HTML (SPA route, no 404)', async () => {
    const r = await fetch(`${BASE}/oidc-callback?code=test&state=test`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/html'), `Expected HTML content-type, got: ${ct}`);
  });

  it('/api/auth/oidc-info is accessible without authentication', async () => {
    const r = await fetch(`${BASE}/api/auth/oidc-info`);
    // Should return 200 with OIDC info (may be enabled: false in test stack)
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = await r.json();
    assert.equal(typeof body.enabled, 'boolean', 'enabled must be a boolean');
  });

  it('/api/auth/oidc-info returns expected shape when OIDC is disabled', async () => {
    const r = await fetch(`${BASE}/api/auth/oidc-info`);
    const body = await r.json();
    // In the test stack OIDC is not configured, so it should be disabled
    if (!body.enabled) {
      assert.equal(body.enabled, false);
    } else {
      // If enabled, these fields must be present
      assert.ok(typeof body.issuerUrl === 'string', 'issuerUrl must be a string when enabled');
      assert.ok(typeof body.clientId === 'string', 'clientId must be a string when enabled');
    }
  });

  it('CSP frame-ancestors allows same-origin iframing', async () => {
    const r = await fetch(`${BASE}/health`);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.ok(
      csp.includes("frame-ancestors 'self'"),
      `Expected CSP frame-ancestors 'self', got: '${csp}'`,
    );
  });

  it('/oidc-callback without code/state still serves the SPA (handles error display)', async () => {
    const r = await fetch(`${BASE}/oidc-callback`);
    // The SPA handles the error display — should still return 200 HTML
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/html'), `Expected HTML, got: ${ct}`);
  });
});
