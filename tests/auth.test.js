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
 * Run: node --test tests/auth.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, reqJson } from './sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'sync', 'configs');

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
    const before_ = await get(INSTANCES.a, plaintext, '/api/tokens');
    assert.equal(before_.status, 200, 'Token should work before revocation');

    // Revoke
    const rev = await del(INSTANCES.a, tokenA, `/api/tokens/${tokenId}`);
    assert.equal(rev.status, 204);

    // Verify it fails after revocation
    const after_ = await get(INSTANCES.a, plaintext, '/api/tokens');
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
      spaces: [spaceId],
    });
    assert.equal(create.status, 201);
    const scopedToken = create.body.plaintext;

    // Should be rejected on general space
    const wrongSpace = await get(INSTANCES.a, scopedToken, '/api/brain/general/memories');
    assert.equal(wrongSpace.status, 403, 'Scoped token should be rejected on wrong space');

    // Should work on the scoped space
    const rightSpace = await get(INSTANCES.a, scopedToken, `/api/brain/${spaceId}/memories`);
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
