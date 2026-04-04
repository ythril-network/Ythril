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
import { INSTANCES, post, get, del, delWithBody, patch } from '../sync/helpers.js';

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

  it('PATCH /api/spaces/:id with description exceeding 2000 chars returns 400', async () => {
    const created = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: `patch-toolong-test-${RUN_ID}`,
      label: 'Patch Too Long',
    });
    assert.equal(created.status, 201);
    const spaceId = created.body.space?.id;
    createdSpaceIds.push(spaceId);

    const r = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, {
      description: 'x'.repeat(2001),
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });

});
