/**
 * Integration tests: Authentication & Token lifecycle
 *
 * Covers:
 *  - Token creation (name, optional expiry, space scoping)
 *  - Token listing (hashes never exposed)
 *  - Token revocation
 *  - Expired token rejection
 *  - Space-scoped token enforcement
 *  - Missing / malformed auth header
 *  - Rate limiting on token creation (authRateLimit)
 *
 * Run: node --test testing/integration/auth.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, patch, reqJson, readCollection } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;

describe('Token lifecycle', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('Create token returns plaintext once', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'test-create' });
    assert.equal(r.status, 201);
    assert.ok(r.body.plaintext, 'plaintext should be present');
    assert.ok(r.body.plaintext.startsWith('ythril_'), 'plaintext should start with ythril_');
    assert.ok(r.body.token?.id, 'token record should have id');
    assert.ok(!r.body.token?.hash, 'hash must NOT be exposed');
    // Clean up
    await del(INSTANCES.a, tokenA, `/api/tokens/${r.body.token.id}`);
  });

  it('PATCH renames a token label and the change persists in the list', async () => {
    const create = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'rename-me' });
    assert.equal(create.status, 201);
    const id = create.body.token.id;

    const r = await patch(INSTANCES.a, tokenA, `/api/tokens/${id}`, { name: 'renamed-label' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.token?.name, 'renamed-label');
    assert.ok(!r.body.token?.hash, 'hash must NOT be exposed on rename');

    // The rename persists — the list reflects the new label, not the old.
    const list = await get(INSTANCES.a, tokenA, '/api/tokens');
    const found = list.body.tokens.find(t => t.id === id);
    assert.equal(found?.name, 'renamed-label');

    await del(INSTANCES.a, tokenA, `/api/tokens/${id}`);
  });

  it('PATCH rejects an empty label with 400 (same bound as create)', async () => {
    const create = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'validate-rename' });
    const id = create.body.token.id;
    const r = await patch(INSTANCES.a, tokenA, `/api/tokens/${id}`, { name: '' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    await del(INSTANCES.a, tokenA, `/api/tokens/${id}`);
  });

  it('PATCH a non-existent token returns 404', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/tokens/nonexistent-id', { name: 'whatever' });
    assert.equal(r.status, 404);
  });

  it('Token list never exposes hashes', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/tokens');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.tokens));
    for (const t of r.body.tokens) {
      assert.ok(!t.hash, `Token ${t.id} must not expose hash`);
      assert.ok(t.id, 'Token must have id');
      assert.ok(t.name, 'Token must have name');
    }
  });

  it('Expired token is rejected', async () => {
    // Create a token that expired in the past
    const past = new Date(Date.now() - 1000).toISOString();
    const create = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: 'expired-token',
      expiresAt: past,
    });
    assert.equal(create.status, 201);
    const expiredToken = create.body.plaintext;

    // It should be rejected immediately
    const r = await get(INSTANCES.a, expiredToken, '/api/tokens');
    assert.equal(r.status, 401, 'Expired token must return 401');

    // Clean up
    await del(INSTANCES.a, tokenA, `/api/tokens/${create.body.token.id}`);
  });

  it('Revoked token no longer authenticates', async () => {
    const create = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'to-revoke' });
    assert.equal(create.status, 201);
    const tokenId = create.body.token.id;
    const plaintext = create.body.plaintext;

    // Verify it works before revocation
    const before_ = await get(INSTANCES.a, plaintext, '/api/tokens/me');
    assert.equal(before_.status, 200, 'Token should work before revocation');

    // Revoke
    const rev = await del(INSTANCES.a, tokenA, `/api/tokens/${tokenId}`);
    assert.equal(rev.status, 204);

    // Verify it fails after revocation
    const after_ = await get(INSTANCES.a, plaintext, '/api/tokens/me');
    assert.equal(after_.status, 401, 'Revoked token must return 401');
  });

  it('No auth header returns 401', async () => {
    const r = await reqJson(INSTANCES.a, '', '/api/tokens', {
      headers: {}, // no Authorization header
    });
    assert.equal(r.status, 401);
  });

  it('Invalid token format returns 401', async () => {
    const r = await get(INSTANCES.a, 'not-a-valid-token', '/api/tokens');
    assert.equal(r.status, 401);
  });

  it('Space-scoped token rejected on wrong space', async () => {
    // Use a unique label per run to avoid conflicts when previous runs left
    // created spaces behind (e.g. after a mid-test failure).
    const space = await post(INSTANCES.a, tokenA, '/api/spaces', {
      label: 'Auth Test Space ' + Date.now(),
    });
    assert.equal(space.status, 201);
    const spaceId = space.body.space?.id;
    assert.ok(spaceId);

    // Create token scoped only to that space
    const create = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: 'scoped-token',
      rights: legacyRights({ spaces: [spaceId] })
    });
    assert.equal(create.status, 201);
    const scopedToken = create.body.plaintext;

    // Should be rejected on general space
    const wrongSpace = await readCollection(INSTANCES.a, scopedToken, 'general', 'facts');
    assert.equal(wrongSpace.status, 403, 'Scoped token should be rejected on wrong space');

    // Should work on the scoped space
    const rightSpace = await readCollection(INSTANCES.a, scopedToken, spaceId, 'facts');
    assert.equal(rightSpace.status, 200, 'Scoped token should work on its own space');

    // Clean up
    await del(INSTANCES.a, tokenA, `/api/tokens/${create.body.token.id}`);
    await del(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`);
  });

  it('Revoking non-existent token returns 404', async () => {
    const r = await del(INSTANCES.a, tokenA, '/api/tokens/nonexistent-id');
    assert.equal(r.status, 404);
  });
});

// ── Startup migration ──────────────────────────────────────────────────────
// Validates that tokens lacking the `prefix` field (created before the field
// was introduced) are automatically evicted when the config is reloaded, and
// that the eviction does not affect tokens that do have a prefix.
//
// Uses POST /api/admin/reload-config instead of docker restart so this test
// does not kill the container while other test files run concurrently.
// ──────────────────────────────────────────────────────────────────────────
describe('Legacy (prefix-less) tokens self-heal instead of being evicted', () => {
  it('a prefix-less token still authenticates after reload and its prefix is backfilled', async () => {
    // 1. Create a fresh token — it has a prefix field set by createToken().
    const create = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'legacy-sim-token' });
    assert.equal(create.status, 201);
    const legacyId = create.body.token.id;
    const legacyPlaintext = create.body.plaintext;

    // Sanity: it authenticates before we tamper with anything.
    const before = await get(INSTANCES.a, legacyPlaintext, '/api/tokens/me');
    assert.equal(before.status, 200, 'Token must authenticate before simulation');

    // 2. Strip the prefix to simulate a token created before the prefix field
    //    existed (atomic tmp+rename to avoid a half-written read).
    execSync(
      `docker exec ythril-a node -e ` +
      `"const fs=require('fs'),p='/config/config.json',c=JSON.parse(fs.readFileSync(p,'utf8'));` +
      `const t=c.tokens.find(t=>t.id==='${legacyId}');` +
      `if(t)delete t.prefix;` +
      `const tmp=p+'.test-tmp';` +
      `fs.writeFileSync(tmp,JSON.stringify(c,null,2),{mode:0o600});` +
      `fs.renameSync(tmp,p);"`,
    );

    // 3. Reload config so the prefix-less token is the in-memory state.
    const reloadR = await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    assert.equal(reloadR.status, 200, `Reload failed: ${JSON.stringify(reloadR.body)}`);

    // 4. The legacy token must STILL authenticate (self-healing fallback scan),
    //    NOT be rejected — this is the fix for silent fleet-wide token invalidation.
    const probe = await get(INSTANCES.a, legacyPlaintext, '/api/tokens/me');
    assert.equal(probe.status, 200, 'Prefix-less token must still authenticate (self-heal, not eviction)');

    // 5. It remains in the token list (never deleted) and its prefix is backfilled.
    const list = await get(INSTANCES.a, tokenA, '/api/tokens');
    const listed = list.body.tokens.find(t => t.id === legacyId);
    assert.ok(listed, 'Legacy token must NOT be evicted from the token list');
    assert.ok(listed.prefix && listed.prefix.length === 8, 'Prefix must be backfilled on first use');

    // 6. A follow-up call still works (now via the fast prefix-filtered path).
    const again = await get(INSTANCES.a, legacyPlaintext, '/api/tokens/me');
    assert.equal(again.status, 200);

    // Cleanup
    await del(INSTANCES.a, tokenA, `/api/tokens/${legacyId}`).catch(() => {});
  });
});
