/**
 * Integration tests: Space management
 *
 * Covers:
 *  - Create space (auto-slug, custom id)
 *  - List spaces
 *  - Delete space
 *  - Space isolation: data cannot cross space boundaries
 *  - Duplicate space ID rejected
 *  - Invalid slug characters rejected
 *
 * Run: node --test testing/integration/spaces.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, patch, put } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;
const createdSpaceIds = [];
const RUN_ID = Date.now();

describe('Space management', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    // Clean up any spaces we created.
    // Use { confirm: true } body since solo-space deletion now requires it.
    for (const id of createdSpaceIds) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('Create space with auto-generated slug from label', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { label: `Test Research Space ${RUN_ID}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.space?.id;
    assert.ok(id, 'space id should be present');
    assert.match(id, /^[a-z0-9-]+$/, 'id should be slug format');
    createdSpaceIds.push(id);
  });

  it('Create space with explicit id', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: `explicit-test-space-${RUN_ID}`,
      label: 'Explicit ID Space',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.space?.id, `explicit-test-space-${RUN_ID}`);
    createdSpaceIds.push(`explicit-test-space-${RUN_ID}`);
  });

  it('Duplicate space ID is rejected', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: `explicit-test-space-${RUN_ID}`,
      label: 'Duplicate',
    });
    assert.ok(r.status === 400 || r.status === 409, `Expected 400 or 409, got ${r.status}`);
  });

  it('Invalid slug characters in id rejected', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: 'UPPER_CASE!',
      label: 'Invalid',
    });
    assert.equal(r.status, 400, 'Upper/special chars in id should be rejected');
  });

  it('List spaces includes newly created spaces', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/spaces');
    assert.equal(r.status, 200);
    const ids = r.body.spaces?.map(s => s.id) ?? [];
    assert.ok(ids.includes('general'), 'general space should always be present');
    assert.ok(ids.includes(`explicit-test-space-${RUN_ID}`));
  });

  it('Space data is isolated â€” writes to one space not visible in another', async () => {
    // Use the explicit-test-space created in this run
    const isolationSpace = `explicit-test-space-${RUN_ID}`;
    // Write a memory to the explicit-test-space (it was created above and pushed to createdSpaceIds)
    const writeR = await post(INSTANCES.a, tokenA, `/api/brain/${isolationSpace}/memories`, {
      fact: 'Isolated space fact',
      tags: ['isolation-test'],
    });
    assert.equal(writeR.status, 201, `Write: ${JSON.stringify(writeR.body)}`);
    const memId = writeR.body._id ?? writeR.body.id;

    // Should NOT appear in general space
    const generalR = await get(INSTANCES.a, tokenA, '/api/brain/general/memories');
    assert.equal(generalR.status, 200);
    const found = generalR.body.memories?.some(m => m._id === memId);
    assert.ok(!found, `Memory from ${isolationSpace} must not appear in general space`);

    // Should appear in the isolation space
    const ownSpaceR = await get(INSTANCES.a, tokenA, `/api/brain/${isolationSpace}/memories`);
    assert.equal(ownSpaceR.status, 200);
    const ownFound = ownSpaceR.body.memories?.some(m => m._id === memId);
    assert.ok(ownFound, 'Memory should be visible in its own space');
  });

  it('Delete built-in general space is rejected', async () => {
    const r = await del(INSTANCES.a, tokenA, '/api/spaces/general');
    // Either 400 or 403 â€” must not succeed
    assert.ok(r.status >= 400, `Deleting general space should fail, got ${r.status}`);
  });

  it('Delete non-existent space returns 404', async () => {
    const r = await del(INSTANCES.a, tokenA, '/api/spaces/does-not-exist');
    assert.equal(r.status, 404);
  });

  it('Delete solo space without { confirm: true } body is rejected with 400', async () => {
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', { label: `Gov Solo No-Confirm ${RUN_ID}` });
    assert.equal(created.status, 201);
    const spaceId = created.body.space?.id;
    createdSpaceIds.push(spaceId);

    const r = await del(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`);
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
    assert.ok(
      r.body?.error?.toLowerCase().includes('confirm'),
      `Error should mention 'confirm', got: ${r.body?.error}`,
    );
  });

  it('Delete solo space with { confirm: true } succeeds immediately â€” 204', async () => {
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', { label: `Gov Solo Confirm-Del ${RUN_ID}` });
    assert.equal(created.status, 201);
    const spaceId = created.body.space?.id;
    // Don't push to createdSpaceIds â€” we're deleting it in this test

    const r = await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { confirm: true });
    assert.equal(r.status, 204, `Expected 204, got ${r.status}`);

    // Must no longer appear in the space list
    const listR = await get(INSTANCES.a, tokenA, '/api/spaces');
    assert.ok(
      !listR.body?.spaces?.some(s => s.id === spaceId),
      'Space must not appear in list after confirmed deletion',
    );
  });
  it('Update space description via PATCH /api/spaces/:id', async () => {
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: `patch-desc-test-${RUN_ID}`,
      label: 'Patch Desc Test',
      description: 'original description',
    });
    assert.equal(created.status, 201);
    const spaceId = created.body.space?.id;
    createdSpaceIds.push(spaceId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, {
      description: 'updated description',
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.space?.description, 'updated description');

    // Verify the list endpoint reflects the change
    const listR = await get(INSTANCES.a, tokenA, '/api/spaces');
    const found = listR.body?.spaces?.find(s => s.id === spaceId);
    assert.ok(found, 'Space should still appear in list');
    assert.equal(found.description, 'updated description');
  });

  it('Update space label via PATCH /api/spaces/:id', async () => {
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: `patch-label-test-${RUN_ID}`,
      label: 'Original Label',
    });
    assert.equal(created.status, 201);
    const spaceId = created.body.space?.id;
    createdSpaceIds.push(spaceId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, {
      label: 'Updated Label',
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.space?.label, 'Updated Label');
  });

  it('PATCH /api/spaces/:id with no fields returns 400', async () => {
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: `patch-nofields-test-${RUN_ID}`,
      label: 'Patch No Fields',
    });
    assert.equal(created.status, 201);
    const spaceId = created.body.space?.id;
    createdSpaceIds.push(spaceId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, {});
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it('PATCH /api/spaces/:id on non-existent space returns 404', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/spaces/does-not-exist-space', {
      description: 'something',
    });
    assert.equal(r.status, 404, `Expected 404, got ${r.status}`);
  });

  it('PATCH /api/spaces/:id with description exceeding 4000 chars returns 400', async () => {
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: `patch-toolong-test-${RUN_ID}`,
      label: 'Patch Too Long',
    });
    assert.equal(created.status, 201);
    const spaceId = created.body.space?.id;
    createdSpaceIds.push(spaceId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, {
      description: 'x'.repeat(4001),
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

  // ── Space-scoped admin token enforcement ────────────────────────────────────

  it('Space-scoped admin token: PATCH /api/spaces/:id schema on own space succeeds', async () => {
    // Create the target space
    const targetId = `scope-own-${RUN_ID}`;
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: targetId,
      label: 'Scope Own Space',
    });
    assert.equal(created.status, 201, `Create space: ${JSON.stringify(created.body)}`);
    createdSpaceIds.push(targetId);

    // Create an admin token scoped to that space
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `scoped-own-${RUN_ID}`,
      admin: true,
      spaces: [targetId],
    });
    assert.equal(tokenRes.status, 201, `Create scoped token: ${JSON.stringify(tokenRes.body)}`);
    const scopedToken = tokenRes.body.plaintext;

    // Patching the token's own space should succeed
    const r = await patch(INSTANCES.a, scopedToken, `/api/spaces/${targetId}`, {
      description: 'updated by scoped token',
    });
    assert.equal(r.status, 200, `Expected 200 on own space, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.space?.description, 'updated by scoped token');

    // Revoke the token
    const revokeR = await del(INSTANCES.a, tokenA, `/api/tokens/${tokenRes.body.token?.id}`);
    assert.ok(revokeR.status < 400, `Revoke scoped token failed: ${revokeR.status}`);
  });

  it('Space-scoped admin token: PATCH /api/spaces/:id schema on another space returns 403', async () => {
    // Create two spaces
    const allowedId = `scope-allowed-${RUN_ID}`;
    const forbiddenId = `scope-forbidden-${RUN_ID}`;

    const c1 = await post(INSTANCES.a, tokenA, '/api/spaces', { id: allowedId, label: 'Scope Allowed' });
    assert.equal(c1.status, 201, `Create allowed space: ${JSON.stringify(c1.body)}`);
    createdSpaceIds.push(allowedId);

    const c2 = await post(INSTANCES.a, tokenA, '/api/spaces', { id: forbiddenId, label: 'Scope Forbidden' });
    assert.equal(c2.status, 201, `Create forbidden space: ${JSON.stringify(c2.body)}`);
    createdSpaceIds.push(forbiddenId);

    // Create an admin token scoped to allowedId only
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `scoped-restricted-${RUN_ID}`,
      admin: true,
      spaces: [allowedId],
    });
    assert.equal(tokenRes.status, 201, `Create scoped token: ${JSON.stringify(tokenRes.body)}`);
    const scopedToken = tokenRes.body.plaintext;

    // Attempting to PATCH the forbidden space should return 403
    const r = await patch(INSTANCES.a, scopedToken, `/api/spaces/${forbiddenId}`, {
      description: 'should be blocked',
    });
    assert.equal(r.status, 403, `Expected 403 on forbidden space, got ${r.status}: ${JSON.stringify(r.body)}`);

    // Revoke the token
    const revokeR = await del(INSTANCES.a, tokenA, `/api/tokens/${tokenRes.body.token?.id}`);
    assert.ok(revokeR.status < 400, `Revoke scoped token failed: ${revokeR.status}`);
  });

  it('Space-scoped admin token: PUT typeSchema on own space succeeds; 403 on another space', async () => {
    const allowedId = `scope-ts-allowed-${RUN_ID}`;
    const forbiddenId = `scope-ts-forbidden-${RUN_ID}`;

    const c1 = await post(INSTANCES.a, tokenA, '/api/spaces', { id: allowedId, label: 'TS Allowed' });
    assert.equal(c1.status, 201);
    createdSpaceIds.push(allowedId);

    const c2 = await post(INSTANCES.a, tokenA, '/api/spaces', { id: forbiddenId, label: 'TS Forbidden' });
    assert.equal(c2.status, 201);
    createdSpaceIds.push(forbiddenId);

    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `scoped-ts-${RUN_ID}`,
      admin: true,
      spaces: [allowedId],
    });
    assert.equal(tokenRes.status, 201);
    const scopedToken = tokenRes.body.plaintext;

    // PUT on own space — should succeed
    const okR = await put(INSTANCES.a, scopedToken, `/api/spaces/${allowedId}/meta/typeSchemas/entity/Widget`, {
      namingPattern: '^Widget-',
    });
    assert.equal(okR.status, 200, `Expected 200 on own space PUT, got ${okR.status}: ${JSON.stringify(okR.body)}`);

    // PUT on forbidden space — should be blocked
    const badR = await put(INSTANCES.a, scopedToken, `/api/spaces/${forbiddenId}/meta/typeSchemas/entity/Widget`, {
      namingPattern: '^Widget-',
    });
    assert.equal(badR.status, 403, `Expected 403 on forbidden space PUT, got ${badR.status}: ${JSON.stringify(badR.body)}`);

    // Revoke the token
    const revokeR = await del(INSTANCES.a, tokenA, `/api/tokens/${tokenRes.body.token?.id}`);
    assert.ok(revokeR.status < 400, `Revoke scoped token failed: ${revokeR.status}`);
  });

  it('Unrestricted admin token: PATCH /api/spaces/:id schema is not blocked', async () => {
    const spaceId = `scope-unrestricted-${RUN_ID}`;
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: spaceId,
      label: 'Scope Unrestricted',
    });
    assert.equal(created.status, 201);
    createdSpaceIds.push(spaceId);

    // tokenA has no spaces restriction — must succeed on any space
    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, {
      description: 'written by unrestricted admin',
    });
    assert.equal(r.status, 200, `Expected 200 for unrestricted admin, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

});
