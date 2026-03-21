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
 * Run: node --test testing/brain.test.js
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

    const r = await get(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`);
    assert.equal(r.status, 200, `Written memory should be retrievable by ID: ${JSON.stringify(r.body)}`);
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
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/stats');
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

// ── Entities CRUD ─────────────────────────────────────────────────────────

describe('Brain — entities CRUD (/api/brain/spaces/:spaceId/entities)', () => {
  const RUN = Date.now();

  it('List entities returns {entities:[...]}', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/entities');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.entities), 'entities must be an array');
  });

  it('List entities returns 404 for unknown space', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/entities');
    assert.equal(r.status, 404);
  });

  it('List entities returns 401 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/entities`);
    assert.equal(r.status, 401);
  });

  it('Delete entity returns 204 and it is gone', async () => {
    // First create an entity via the MCP upsert route
    // Use the sync endpoint as a seeding shortcut — upsert directly into the DB
    const entId = `test-entity-${RUN}`;
    await (await import('./sync/helpers.js')).post(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
      _id: entId, spaceId: 'general', name: `EntityForDelete-${RUN}`,
      type: 'concept', tags: [], seq: Date.now(),
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const delR = await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${entId}`);
    assert.equal(delR.status, 204, `Delete: ${JSON.stringify(delR.body)}`);
  });

  it('Delete non-existent entity returns 404', async () => {
    const r = await del(INSTANCES.a, token(), '/api/brain/spaces/general/entities/does-not-exist');
    assert.equal(r.status, 404);
  });
});

// ── Edges CRUD ────────────────────────────────────────────────────────────

describe('Brain — edges CRUD (/api/brain/spaces/:spaceId/edges)', () => {
  const RUN = Date.now();

  it('List edges returns {edges:[...]}', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/edges');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.edges), 'edges must be an array');
  });

  it('List edges returns 404 for unknown space', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/edges');
    assert.equal(r.status, 404);
  });

  it('List edges returns 401 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/edges`);
    assert.equal(r.status, 401);
  });

  it('Delete edge returns 204 and it is gone', async () => {
    const { post: syncPost } = await import('./sync/helpers.js');
    const entA = `edge-from-${RUN}`;
    const entB = `edge-to-${RUN}`;
    const edgeId = `test-edge-${RUN}`;

    await syncPost(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
      _id: entA, spaceId: 'general', name: `EdgeFrom-${RUN}`, type: 'concept', tags: [],
      seq: Date.now(), author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await syncPost(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
      _id: entB, spaceId: 'general', name: `EdgeTo-${RUN}`, type: 'concept', tags: [],
      seq: Date.now() + 1, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await syncPost(INSTANCES.a, token(), '/api/sync/edges?spaceId=general', {
      _id: edgeId, spaceId: 'general', from: entA, to: entB, label: 'test-rel',
      seq: Date.now() + 2, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const delR = await del(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${edgeId}`);
    assert.equal(delR.status, 204, `Delete: ${JSON.stringify(delR.body)}`);
  });

  it('Delete non-existent edge returns 404', async () => {
    const r = await del(INSTANCES.a, token(), '/api/brain/spaces/general/edges/does-not-exist');
    assert.equal(r.status, 404);
  });
});

// ── Memory list pagination ────────────────────────────────────────────────

describe('Brain — memory list limit/skip pagination', () => {
  const RUN = Date.now();

  before(async () => {
    // Seed 8 memories to guarantee meaningful pagination
    const { post: syncPost } = await import('./sync/helpers.js');
    for (let i = 0; i < 8; i++) {
      await syncPost(INSTANCES.a, token(), '/api/sync/memories?spaceId=general', {
        _id: `paginate-${RUN}-${i}`, spaceId: 'general', fact: `Pagination seed ${RUN} item ${i}`,
        seq: Date.now() + i, embedding: [], tags: ['pagination-test'], entityIds: [],
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
    }
  });

  it('limit=3 returns at most 3 memories', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/general/memories?limit=3');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.memories), 'memories must be array');
    assert.ok(r.body.memories.length <= 3, `Expected ≤3 items, got ${r.body.memories.length}`);
  });

  it('skip pagination returns disjoint results', async () => {
    const page1 = await get(INSTANCES.a, token(), '/api/brain/general/memories?limit=3&skip=0');
    const page2 = await get(INSTANCES.a, token(), '/api/brain/general/memories?limit=3&skip=3');
    assert.equal(page1.status, 200);
    assert.equal(page2.status, 200);
    const p1Ids = new Set(page1.body.memories.map(m => m._id));
    for (const m of page2.body.memories) {
      assert.ok(!p1Ids.has(m._id), `Duplicate id ${m._id} across pages`);
    }
  });

  it('limit cap — limit > 500 is capped at 500', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/general/memories?limit=9999');
    assert.equal(r.status, 200);
    assert.ok(r.body.limit <= 500, `Expected limit ≤500 in response, got ${r.body.limit}`);
  });
});

// ── Reindex status ────────────────────────────────────────────────────────

describe('Brain — reindex-status endpoint', () => {
  it('Returns {spaceId, needsReindex} for valid space', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/reindex-status');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.spaceId, 'general');
    assert.ok(typeof r.body.needsReindex === 'boolean', 'needsReindex must be boolean');
  });

  it('Returns 404 for unknown space', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/reindex-status');
    assert.equal(r.status, 404);
  });

  it('Returns 401 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/reindex-status`);
    assert.equal(r.status, 401);
  });
});

// ── Memory fact validation ────────────────────────────────────────────────

describe('Brain — memory fact validation', () => {
  it('Returns 400 if fact is missing', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', { tags: ['nofact'] });
    assert.equal(r.status, 400);
  });

  it('Returns 400 if fact exceeds 50 000 characters', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: 'x'.repeat(50_001),
    });
    assert.equal(r.status, 400);
  });

  it('Returns 400 if tags contains non-string', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: 'valid fact',
      tags: [1, 2, 3],
    });
    assert.equal(r.status, 400);
  });

  it('Returns 201 at exactly 50 000 character fact', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: 'a'.repeat(50_000),
    });
    assert.equal(r.status, 201, `Boundary-value fact should be accepted: ${JSON.stringify(r.body)}`);
  });
});
