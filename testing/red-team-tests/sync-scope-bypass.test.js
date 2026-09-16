/**
 * Red-team tests: Space-scope bypass via sync endpoints
 *
 * Sync routes use requireAuth (not requireSpaceAuth), so the server must
 * explicitly enforce the calling token's space allowlist against the
 * ?spaceId= query parameter.  Without this check a token scoped to "general"
 * can read and write data in any other space via the sync API.
 *
 * Run: node --test testing/red-team-tests/sync-scope-bypass.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
let scopedToken;     // scoped to "general" only
let scopedTokenId;
let targetSpaceId;   // a space the scoped token is NOT allowed to access

describe('Space-scoped token cannot access sync endpoints of other spaces', () => {
  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Create an isolated target space for this test suite
    const spaceRes = await post(INSTANCES.a, adminToken, '/api/spaces', {
      id: 'scope-bypass-target',
      label: 'Scope Bypass Target',
    });
    assert.ok(
      spaceRes.status === 201 || spaceRes.status === 409,
      `Expected 201/409 creating test space, got ${spaceRes.status}: ${JSON.stringify(spaceRes.body)}`,
    );
    targetSpaceId = 'scope-bypass-target';

    // Create a token scoped ONLY to "general"
    const tokRes = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: 'sync-scope-bypass-test ' + Date.now(),
      rights: legacyRights({ spaces: ['general'] })
    });
    assert.equal(tokRes.status, 201, `Failed to create scoped token: ${JSON.stringify(tokRes.body)}`);
    scopedToken = tokRes.body.plaintext;
    scopedTokenId = tokRes.body.token?.id;
  });

  after(async () => {
    if (scopedTokenId) {
      await fetch(`${INSTANCES.a}/api/tokens/${scopedTokenId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
    // Delete test space (solo; no network)
    await fetch(`${INSTANCES.a}/api/spaces/${targetSpaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
  });

  // ── Reads ────────────────────────────────────────────────────────────────

  it('Scoped token cannot GET memories from out-of-scope space → 403', async () => {
    const r = await get(INSTANCES.a, scopedToken, `/api/sync/facts?spaceId=${targetSpaceId}`);
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot GET entities from out-of-scope space → 403', async () => {
    const r = await get(INSTANCES.a, scopedToken, `/api/sync/entities?spaceId=${targetSpaceId}`);
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot GET edges from out-of-scope space → 403', async () => {
    const r = await get(INSTANCES.a, scopedToken, `/api/sync/edges?spaceId=${targetSpaceId}`);
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot GET tombstones from out-of-scope space → 403', async () => {
    const r = await get(INSTANCES.a, scopedToken, `/api/sync/tombstones?spaceId=${targetSpaceId}`);
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot GET manifest from out-of-scope space → 403', async () => {
    const r = await get(INSTANCES.a, scopedToken, `/api/sync/manifest?spaceId=${targetSpaceId}`);
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ── Writes ───────────────────────────────────────────────────────────────

  it('Scoped token cannot POST memory to out-of-scope space → 403', async () => {
    const r = await post(
      INSTANCES.a,
      scopedToken,
      `/api/sync/facts?spaceId=${targetSpaceId}`,
      { _id: 'rt-bypass-mem-001', fact: 'injected', seq: 1 },
    );
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot batch-upsert memories into out-of-scope space → 403', async () => {
    const r = await post(
      INSTANCES.a,
      scopedToken,
      `/api/sync/batch-upsert?spaceId=${targetSpaceId}`,
      { facts: [{ _id: 'rt-bypass-mem-002', fact: 'batch-injected', seq: 1 }] },
    );
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot batch-upsert entities into out-of-scope space → 403', async () => {
    const r = await post(
      INSTANCES.a,
      scopedToken,
      `/api/sync/batch-upsert?spaceId=${targetSpaceId}`,
      { entities: [{ _id: 'rt-bypass-ent-001', name: 'Injected', type: 'person', seq: 1 }] },
    );
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot POST tombstone to out-of-scope space → 403', async () => {
    const r = await post(
      INSTANCES.a,
      scopedToken,
      `/api/sync/tombstones?spaceId=${targetSpaceId}`,
      { _id: 'rt-bypass-tomb-001', type: 'fact', seq: 99 },
    );
    assert.equal(r.status, 403, `Should be 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ── Confirm in-scope access still works ──────────────────────────────────

  it('Scoped token CAN GET memories from its own space → 200', async () => {
    const r = await get(INSTANCES.a, scopedToken, '/api/sync/facts?spaceId=general');
    assert.equal(r.status, 200, `Scoped token should access its own space, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Scoped token cannot batch-upsert even into its own space → 403 (S10: sync writes are peer-only)', async () => {
    // The sync data-write surface requires a peer token (peerInstanceId) or an
    // admin token: sync writes carry raw seq/_id/author stream metadata, which
    // a space-scoped user PAT must not be able to forge. User writes go through
    // the regular REST API instead.
    const r = await post(
      INSTANCES.a,
      scopedToken,
      '/api/sync/batch-upsert?spaceId=general',
      { facts: [{ _id: 'rt-scope-allowed-001', fact: 'allowed write', seq: 1 }] },
    );
    assert.equal(r.status, 403, `Non-peer PAT must not write via /api/sync, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error?.includes('peer token'), `Error should demand a peer token: ${r.body.error}`);
  });
});
