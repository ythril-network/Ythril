/**
 * Integration tests: Setup flow
 *
 * Covers:
 *  - Setup endpoint returns 404 after first run (SEC-13)
 *  - Health endpoint is always available without auth
 *  - Root redirect: / → /setup (pre-setup) or /settings (post-setup)
 *
 * Run: node --test testing/integration/setup.test.js
 * Note: This test runs AFTER setup has been completed on instance A/B/C.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES } from '../sync/helpers.js';

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
      body: new URLSearchParams({ label: 'Attacker', settingsPassword: 'abc12345', settingsPasswordConfirm: 'abc12345' }),
    });
    // After setup is complete, /setup POST must return 404.
    // If the auth rate limit is exhausted (e.g. when run after other auth-heavy
    // tests in the same minute window), it returns 429 — also acceptable since
    // both mean the setup endpoint is effectively unavailable.
    assert.ok(r.status === 404 || r.status === 429,
      `Setup endpoint should be 404 (or 429 rate-limited) after first run, got ${r.status}`);
  });

  it('GET /setup is the SPA now, and the SPA route is the one guarded', async () => {
    // This asserted 404, which was the LEGACY HTML FORM's behaviour: `setupRouter` was mounted at `/setup`
    // and refused once configured. That mount is gone (deprecation 1.5) because it shadowed the SPA's own
    // first-run page — Express matches a mount before the index fallback, so the Angular route had never
    // served a first run on any instance.
    //
    // `/setup` therefore behaves like every other SPA route: the shell is served and the app's `setupGuard`
    // routes a configured instance away. A 200 here is the SPA shell, not an open setup page.
    const r = await fetch(`${INSTANCES.a}/setup`);
    assert.ok(r.status === 200 || r.status === 429,
      `GET /setup should serve the SPA shell after first run, got ${r.status}`);
    if (r.status === 200) {
      const body = await r.text();
      assert.ok(body.includes('app-root'), 'the body must be the SPA shell');
      assert.ok(!/name="settingsPassword"|id="submitBtn"/.test(body),
        'the legacy server-rendered form must not come back');
    }
  });

  it('the setup API itself still refuses once configured', async () => {
    // The protection that actually matters, and the one the assertion above used to stand in for. It is on
    // the JSON API, which is what both the SPA and any script would post to.
    const status = await fetch(`${INSTANCES.a}/api/setup/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).configured, true, 'this instance is past first run');

    const r = await fetch(`${INSTANCES.a}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Attacker', settingsPassword: 'abc12345', settingsPasswordConfirm: 'abc12345' }),
    });
    assert.ok(r.status === 404 || r.status === 429,
      `POST /api/setup should be refused after first run, got ${r.status}`);
  });

  it('Root / redirects to /brain (post-setup)', async () => {
    const r = await fetch(`${INSTANCES.a}/`, { redirect: 'manual' });
    // Should redirect — 302 to /brain (the default post-setup landing page)
    assert.ok(r.status === 302 || r.status === 301 || r.status === 303,
      `Root should redirect after setup, got ${r.status}`);
    const location = r.headers.get('location') ?? '';
    assert.ok(location.includes('/brain'), `Should redirect to /brain, got ${location}`);
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

  it('Content-Security-Policy is exactly the expected directive set', async () => {
    // Pinned by EQUALITY, not by substring, and deliberately so: a substring check would pass while a directive
    // was silently dropped, and every one of these is load-bearing. `font-src 'self'` is the newest — the client
    // used to fetch its typeface from a CDN, and nothing here stopped it.
    //
    // The cost is that an intentional change edits this line. That is the right cost for a security header: it
    // makes adding or removing a directive a visible decision rather than a side effect.
    const r = await fetch(`${INSTANCES.a}/health`);
    assert.equal(
      r.headers.get('content-security-policy'),
      "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; font-src 'self'",
    );
  });

  it('Referrer-Policy: no-referrer is set', async () => {
    const r = await fetch(`${INSTANCES.a}/health`);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });
});
