/**
 * Integration tests: Setup flow
 *
 * Covers:
 *  - Setup endpoint returns 404 after first run (SEC-13)
 *  - Health endpoint is always available without auth
 *  - Root redirect: / → /setup (pre-setup) or /settings (post-setup)
 *
 * Run: node --test tests/setup.test.js
 * Note: This test runs AFTER setup has been completed on instance A/B/C.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES } from './sync/helpers.js';

describe('First-run setup gating', () => {
  it('Health endpoint returns 200 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
  });

  it('Setup endpoint returns 404 after first run (already completed)', async () => {
    const r = await fetch(`${INSTANCES.a}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'FAKE-CODE', label: 'Attacker', settingsPassword: 'abc12345', settingsPasswordConfirm: 'abc12345' }),
    });
    // After setup is complete, /setup POST must return 404
    assert.equal(r.status, 404, `Setup endpoint should be 404 after first run, got ${r.status}`);
  });

  it('Setup GET returns 404 after first run', async () => {
    const r = await fetch(`${INSTANCES.a}/setup`);
    assert.equal(r.status, 404, `Setup GET should be 404 after first run`);
  });

  it('Root / redirects to /settings (post-setup)', async () => {
    const r = await fetch(`${INSTANCES.a}/`, { redirect: 'manual' });
    // Should redirect — 302 to /settings
    assert.ok(r.status === 302 || r.status === 301 || r.status === 303,
      `Root should redirect after setup, got ${r.status}`);
    const location = r.headers.get('location') ?? '';
    assert.ok(location.includes('/settings'), `Should redirect to settings, got ${location}`);
  });

  it('Non-existent API route returns 404 JSON', async () => {
    const r = await fetch(`${INSTANCES.a}/api/nonexistent`);
    assert.equal(r.status, 404);
    // Should be JSON
    const contentType = r.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('json'), 'Non-existent API should return JSON 404');
  });
});

describe('Security headers', () => {
  it('X-Content-Type-Options: nosniff is set', async () => {
    const r = await fetch(`${INSTANCES.a}/health`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  it('X-Frame-Options: DENY is set', async () => {
    const r = await fetch(`${INSTANCES.a}/health`);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  it('Referrer-Policy: no-referrer is set', async () => {
    const r = await fetch(`${INSTANCES.a}/health`);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });
});
