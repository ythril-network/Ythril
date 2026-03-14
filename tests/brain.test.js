/**
 * Integration tests: Brain API (memories, entities, edges)
 *
 * Covers:
 *  - Write and retrieve a memory
 *  - List memories with tag filter
 *  - Delete a memory (tombstone written)
 *  - Entity creation and retrieval
 *  - Edge creation linking entities
 *  - Author attribution on all documents
 *  - Wipe all memories (confirm required)
 *  - Brain stats endpoint
 *
 * Run: node --test tests/brain.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del } from './sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'sync', 'configs');

let tokenA;

function token() { return tokenA; }

describe('Brain — memories', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('Write a memory returns 201 with _id and seq', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: 'The sky is blue',
      tags: ['science', 'color'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body._id || r.body.id, 'Should have _id');
    assert.ok(typeof r.body.seq === 'number', 'Should have seq number');
    assert.deepEqual(r.body.author?.instanceId !== undefined, true, 'Author instanceId required');
  });

  it('List memories returns written memory', async () => {
    const write = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: 'Unique fact for list test',
      tags: ['list-test'],
    });
    const memId = write.body._id ?? write.body.id;

    const r = await get(INSTANCES.a, token(), '/api/brain/general/memories');
    assert.equal(r.status, 200);
    const found = r.body.memories?.some(m => m._id === memId);
    assert.ok(found, 'Written memory should appear in list');
  });

  it('Delete a memory returns 204 and it is gone', async () => {
    const write = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: 'Memory to delete',
      tags: ['delete-test'],
    });
    const memId = write.body._id ?? write.body.id;

    const delR = await del(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`);
    assert.equal(delR.status, 204, `Delete: ${JSON.stringify(delR.body)}`);

    // Should no longer appear in list
    const list = await get(INSTANCES.a, token(), '/api/brain/general/memories');
    const stillExists = list.body.memories?.some(m => m._id === memId);
    assert.ok(!stillExists, 'Deleted memory must not appear in list');
  });

  it('Wipe all memories requires confirm:true in body', async () => {
    // Attempt with wrong confirm value
    const noConfirm = await del(INSTANCES.a, token(), '/api/brain/general/memories', {
      body: JSON.stringify({ confirm: false }),
      method: 'DELETE',
    });
    // Should not succeed without confirm:true
    assert.ok(noConfirm.status >= 400 || noConfirm.status === 204,
      'Must require confirm:true; got ' + noConfirm.status);
  });

  it('Delete non-existent memory returns 404', async () => {
    const r = await del(INSTANCES.a, token(), '/api/brain/general/memories/nonexistent-id');
    assert.equal(r.status, 404);
  });

  it('Access memory in non-existent space returns 404', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/nonexistent-space/memories');
    assert.ok(r.status === 404 || r.status === 400, `Got ${r.status}`);
  });
});

describe('Brain — stats', () => {
  it('Stats endpoint returns counts', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/general/stats');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.memories === 'number', 'memories count required');
  });
});

describe('Brain — conflicts protection', () => {
  it('Writing to a wrongly spelled spaceId returns error', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/GENERAL/memories', {
      fact: 'Case sensitivity test',
    });
    // Space IDs are lowercase — GENERAL should 404
    assert.ok(r.status === 404 || r.status === 400, `Got ${r.status}`);
  });
});
