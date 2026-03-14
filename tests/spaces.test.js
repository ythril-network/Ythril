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
 * Run: node --test tests/spaces.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del } from './sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'sync', 'configs');

let tokenA;
const createdSpaceIds = [];

describe('Space management', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    // Clean up any spaces we created
    for (const id of createdSpaceIds) {
      await del(INSTANCES.a, tokenA, `/api/spaces/${id}`).catch(() => {});
    }
  });

  it('Create space with auto-generated slug from label', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { label: 'Test Research Space' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.space?.id;
    assert.ok(id, 'space id should be present');
    assert.match(id, /^[a-z0-9-]+$/, 'id should be slug format');
    createdSpaceIds.push(id);
  });

  it('Create space with explicit id', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: 'explicit-test-space',
      label: 'Explicit ID Space',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.space?.id, 'explicit-test-space');
    createdSpaceIds.push('explicit-test-space');
  });

  it('Duplicate space ID is rejected', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', {
      id: 'explicit-test-space',
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
    assert.ok(ids.includes('explicit-test-space'));
  });

  it('Space data is isolated — writes to one space not visible in another', async () => {
    // Write a memory to explicit-test-space
    const writeR = await post(INSTANCES.a, tokenA, '/api/brain/explicit-test-space/memories', {
      fact: 'Isolated space fact',
      tags: ['isolation-test'],
    });
    assert.equal(writeR.status, 201, `Write: ${JSON.stringify(writeR.body)}`);
    const memId = writeR.body._id ?? writeR.body.id;

    // Should NOT appear in general space
    const generalR = await get(INSTANCES.a, tokenA, '/api/brain/general/memories');
    assert.equal(generalR.status, 200);
    const found = generalR.body.memories?.some(m => m._id === memId);
    assert.ok(!found, 'Memory from explicit-test-space must not appear in general space');

    // Should appear in explicit-test-space
    const ownSpaceR = await get(INSTANCES.a, tokenA, '/api/brain/explicit-test-space/memories');
    assert.equal(ownSpaceR.status, 200);
    const ownFound = ownSpaceR.body.memories?.some(m => m._id === memId);
    assert.ok(ownFound, 'Memory should be visible in its own space');
  });

  it('Delete built-in general space is rejected', async () => {
    const r = await del(INSTANCES.a, tokenA, '/api/spaces/general');
    // Either 400 or 403 — must not succeed
    assert.ok(r.status >= 400, `Deleting general space should fail, got ${r.status}`);
  });

  it('Delete non-existent space returns 404', async () => {
    const r = await del(INSTANCES.a, tokenA, '/api/spaces/does-not-exist');
    assert.equal(r.status, 404);
  });
});
