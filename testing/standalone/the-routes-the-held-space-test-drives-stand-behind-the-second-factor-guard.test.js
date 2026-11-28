/**
 * The routes the held-space test drives (a-held-space-refuses-a-peer-token-at-every-route-that-asks-the-second-factor-db.test.js) stand
 * behind the second-factor guard in the route table, and so do more: otherwise that test would hold nothing.
 *
 * It reads only the route table, so it lives in a pure file the local preflight runs (a-database-file-holds-no-case-that-reads-routes-and-
 * needs-no-database refuses it inside a -db file).
 *
 * Run: node --test testing/standalone/the-routes-the-held-space-test-drives-stand-behind-the-second-factor-guard.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';
import { MFA_GUARDED_ROUTES_DRIVEN } from './_mfa-guarded-routes-driven.mjs';

describe('the routes the held-space test drives stand behind the second-factor guard', () => {
  it('each driven route stands behind requireSpaceAuthMfaScoped in the route table, and so do at least as many more', () => {
    const behind = mountedRoutes().filter(r => /\brequireSpaceAuthMfa(?:Scoped)?\b/.test(r.chain));
    const named = new Set(behind.map(r => `${r.method} ${r.path}`));
    const missing = MFA_GUARDED_ROUTES_DRIVEN.filter(r => !named.has(`${r.method} ${r.path}`)).map(r => `${r.method} ${r.path}`);
    assert.deepEqual(missing, [], 'a route driven by the held-space test no longer stands behind the second-factor guard: that test would hold nothing');
    assert.ok(behind.length > MFA_GUARDED_ROUTES_DRIVEN.length, `only ${behind.length} route(s) stand behind the guard: the scan stopped seeing them`);
  });
});
