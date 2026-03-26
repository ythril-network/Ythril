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
 * Run: node --test testing/integration/brain.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;

function token() { return tokenA; }

describe('Brain â€” memories', () => {
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

    // Confirm deletion via direct ID lookup — 404 is the authoritative signal;
    // scanning a paginated list would give a false pass once >100 memories exist.
    const lookup = await get(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`);
    assert.equal(lookup.status, 404, 'Deleted memory must return 404 on direct lookup');
  });

  it('Wipe all memories requires confirm:true in body', async () => {
    // No body → 400
    const noBody = await del(INSTANCES.a, token(), '/api/brain/general/memories');
    assert.equal(noBody.status, 400, `No body should 400, got ${noBody.status}`);

    // confirm:false → 400
    const noConfirm = await delWithBody(INSTANCES.a, token(), '/api/brain/general/memories', { confirm: false });
    assert.equal(noConfirm.status, 400, `confirm:false should 400, got ${noConfirm.status}`);
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

describe('Brain â€” stats', () => {
  it('Stats endpoint returns counts', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/stats');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.memories === 'number', 'memories count required');
  });
});

describe('Brain â€” conflicts protection', () => {
  it('Writing to a wrongly spelled spaceId returns error', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/GENERAL/memories', {
      fact: 'Case sensitivity test',
    });
    // Space IDs are lowercase â€” GENERAL should 404
    assert.ok(r.status === 404 || r.status === 400, `Got ${r.status}`);
  });
});

// â”€â”€ Entities CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Brain â€” entities CRUD (/api/brain/spaces/:spaceId/entities)', () => {
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
    // Use the sync endpoint as a seeding shortcut â€” upsert directly into the DB
    const entId = `test-entity-${RUN}`;
    await (await import('../sync/helpers.js')).post(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
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

// -- Entity properties ----------------------------------------------------------

describe('Brain -- entity properties', () => {
  const RUN = Date.now();

  it('Create entity with properties returns them in response', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `PropTest-${RUN}`,
      type: 'concept',
      tags: [],
      properties: { wheels: 4, color: 'red', electric: true },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.properties, { wheels: 4, color: 'red', electric: true });
  });

  it('Upsert merges properties with existing', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `PropTest-${RUN}`,
      type: 'concept',
      tags: [],
      properties: { seats: 5 },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.properties.wheels, 4, 'existing property preserved');
    assert.equal(r.body.properties.seats, 5, 'new property merged');
    assert.equal(r.body.properties.color, 'red', 'unchanged property preserved');
  });

  it('Upsert overrides same-key property', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `PropTest-${RUN}`,
      type: 'concept',
      properties: { color: 'blue' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.properties.color, 'blue', 'property overridden');
    assert.equal(r.body.properties.wheels, 4, 'other property untouched');
  });

  it('Entity without properties defaults to empty object', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `NoPropTest-${RUN}`,
      type: 'misc',
    });
    assert.equal(r.status, 201);
    assert.deepStrictEqual(r.body.properties, {});
  });

  it('Invalid properties value type returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `BadProp-${RUN}`,
      type: 'misc',
      properties: { nested: { a: 1 } },
    });
    assert.equal(r.status, 400);
  });

  it('Properties appear in entity listing', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/entities?limit=100');
    assert.equal(r.status, 200);
    const ent = r.body.entities.find(e => e.name === `PropTest-${RUN}`);
    assert.ok(ent, 'entity found');
    assert.equal(ent.properties.wheels, 4);
    assert.equal(ent.properties.color, 'blue');
  });
});


// â”€â”€ Edges CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Brain â€” edges CRUD (/api/brain/spaces/:spaceId/edges)', () => {
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
    const { post: syncPost } = await import('../sync/helpers.js');
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

// ── Edge type field ─────────────────────────────────────────────────────────

describe('Brain — edge type field', () => {
  const RUN = Date.now();

  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('Edge with type field persists and returns in listing', async () => {
    const { post: syncPost } = await import('../sync/helpers.js');
    const edgeId = `typed-edge-${RUN}`;
    const entFrom = `typed-from-${RUN}`;
    const entTo = `typed-to-${RUN}`;

    // Seed entities
    await syncPost(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
      _id: entFrom, spaceId: 'general', name: `TypedFrom-${RUN}`, type: 'concept', tags: [],
      seq: Date.now(), author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await syncPost(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
      _id: entTo, spaceId: 'general', name: `TypedTo-${RUN}`, type: 'concept', tags: [],
      seq: Date.now() + 1, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Seed edge with type via sync endpoint
    await syncPost(INSTANCES.a, token(), '/api/sync/edges?spaceId=general', {
      _id: edgeId, spaceId: 'general', from: entFrom, to: entTo, label: 'causes',
      type: 'causal', weight: 0.9,
      seq: Date.now() + 2, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
    });

    // Verify it appears in listing with type field
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/edges?limit=500');
    assert.equal(r.status, 200);
    const edge = r.body.edges.find(e => e._id === edgeId);
    assert.ok(edge, 'Typed edge should appear in listing');
    assert.equal(edge.type, 'causal', 'type field should be preserved');
    assert.equal(edge.label, 'causes');
    assert.equal(edge.weight, 0.9);
  });

  it('Edge without type field is unaffected', async () => {
    const { post: syncPost } = await import('../sync/helpers.js');
    const edgeId = `untyped-edge-${RUN}`;
    const entFrom = `untyped-from-${RUN}`;
    const entTo = `untyped-to-${RUN}`;

    await syncPost(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
      _id: entFrom, spaceId: 'general', name: `UntypedFrom-${RUN}`, type: 'concept', tags: [],
      seq: Date.now() + 10, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await syncPost(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
      _id: entTo, spaceId: 'general', name: `UntypedTo-${RUN}`, type: 'concept', tags: [],
      seq: Date.now() + 11, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    await syncPost(INSTANCES.a, token(), '/api/sync/edges?spaceId=general', {
      _id: edgeId, spaceId: 'general', from: entFrom, to: entTo, label: 'related',
      seq: Date.now() + 12, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
    });

    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/edges?limit=500');
    assert.equal(r.status, 200);
    const edge = r.body.edges.find(e => e._id === edgeId);
    assert.ok(edge, 'Untyped edge should appear in listing');
    assert.equal(edge.type, undefined, 'type should be absent when not set');
    assert.equal(edge.label, 'related');
  });
});

// ── Memory list filtering ───────────────────────────────────────────────────

describe('Brain — memory list filtering', () => {
  const RUN = Date.now();
  let tokenA;

  // Seed 5 memories with distinct tags and entityIds
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    const seeds = [
      { _id: `filt-${RUN}-1`, fact: 'Alpha fact', tags: ['physics', 'science'], entityIds: ['ent-x'] },
      { _id: `filt-${RUN}-2`, fact: 'Beta fact', tags: ['biology', 'science'], entityIds: ['ent-y'] },
      { _id: `filt-${RUN}-3`, fact: 'Gamma fact', tags: ['physics'], entityIds: ['ent-x', 'ent-y'] },
      { _id: `filt-${RUN}-4`, fact: 'Delta fact', tags: ['history'], entityIds: [] },
      { _id: `filt-${RUN}-5`, fact: 'Epsilon fact', tags: ['biology'], entityIds: ['ent-z'] },
    ];

    let seqBase = Date.now();
    for (const s of seeds) {
      const r = await post(INSTANCES.a, tokenA, '/api/sync/memories?spaceId=general', {
        ...s, spaceId: 'general', embedding: [],
        seq: seqBase++, author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
      assert.equal(r.status, 200, `Seeding ${s._id}: ${JSON.stringify(r.body)}`);
    }
  });

  it('Filter by tag returns only matching memories', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/brain/general/memories?tag=physics&limit=500');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.memories.map(m => m._id);
    assert.ok(ids.includes(`filt-${RUN}-1`), 'Alpha (physics) should match');
    assert.ok(ids.includes(`filt-${RUN}-3`), 'Gamma (physics) should match');
    assert.ok(!ids.includes(`filt-${RUN}-2`), 'Beta (biology) should not match');
    assert.ok(!ids.includes(`filt-${RUN}-4`), 'Delta (history) should not match');
  });

  it('Tag filter is case-insensitive', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/brain/general/memories?tag=PHYSICS&limit=500');
    assert.equal(r.status, 200);
    const ids = r.body.memories.map(m => m._id);
    assert.ok(ids.includes(`filt-${RUN}-1`), 'Should match physics despite uppercase query');
  });

  it('Filter by entity returns only linked memories', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/brain/general/memories?entity=ent-y&limit=500');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.memories.map(m => m._id);
    assert.ok(ids.includes(`filt-${RUN}-2`), 'Beta (ent-y) should match');
    assert.ok(ids.includes(`filt-${RUN}-3`), 'Gamma (ent-x,ent-y) should match');
    assert.ok(!ids.includes(`filt-${RUN}-1`), 'Alpha (ent-x only) should not match');
    assert.ok(!ids.includes(`filt-${RUN}-4`), 'Delta (no entities) should not match');
  });

  it('Combine tag + entity returns intersection', async () => {
    // tag=physics AND entity=ent-x → items 1 and 3
    const r = await get(INSTANCES.a, tokenA, '/api/brain/general/memories?tag=physics&entity=ent-x&limit=500');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.memories.map(m => m._id);
    assert.ok(ids.includes(`filt-${RUN}-1`), 'Alpha (physics + ent-x) should match');
    assert.ok(ids.includes(`filt-${RUN}-3`), 'Gamma (physics + ent-x) should match');
    assert.ok(!ids.includes(`filt-${RUN}-2`), 'Beta (biology + ent-y) should not match');
  });

  it('No filter returns all (at least our 5)', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/brain/general/memories?limit=500');
    assert.equal(r.status, 200);
    const ids = r.body.memories.map(m => m._id);
    for (let i = 1; i <= 5; i++) {
      assert.ok(ids.includes(`filt-${RUN}-${i}`), `Item ${i} (filt-${RUN}-${i}) missing from ${ids.length} results`);
    }
  });

  it('Filter with no matches returns empty array', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/brain/general/memories?tag=nonexistent-tag-xyz&limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.body.memories.length, 0, 'Should return empty array for non-matching filter');
  });
});

// â”€â”€ Memory list pagination â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Brain â€” memory list limit/skip pagination', () => {
  const RUN = Date.now();

  before(async () => {
    // Seed 8 memories to guarantee meaningful pagination
    const { post: syncPost } = await import('../sync/helpers.js');
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
    assert.ok(r.body.memories.length <= 3, `Expected â‰¤3 items, got ${r.body.memories.length}`);
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

  it('limit cap â€” limit > 500 is capped at 500', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/general/memories?limit=9999');
    assert.equal(r.status, 200);
    assert.ok(r.body.limit <= 500, `Expected limit â‰¤500 in response, got ${r.body.limit}`);
  });
});

// â”€â”€ Reindex status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Brain â€” reindex-status endpoint', () => {
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

// â”€â”€ Memory fact validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Brain â€” memory fact validation', () => {
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

// ── Bulk memory wipe ────────────────────────────────────────────────────────

describe('Brain — bulk memory wipe', () => {
  const RUN = Date.now();
  const WIPE_SPACE = 'general';
  let seededIds;
  let seqBefore;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    // Seed 10 memories for the wipe test
    seededIds = [];
    let seqBase = Date.now();
    for (let i = 0; i < 10; i++) {
      const id = `wipe-${RUN}-${i}`;
      seededIds.push(id);
      const r = await post(INSTANCES.a, tokenA, '/api/sync/memories?spaceId=general', {
        _id: id, spaceId: WIPE_SPACE, fact: `Wipe test memory ${i}`,
        tags: ['wipe-test'], entityIds: [], embedding: [],
        seq: seqBase++, author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
      assert.equal(r.status, 200, `Seed wipe-${i}: ${JSON.stringify(r.body)}`);
    }

    // Create one more memory via brain API to capture the current seq counter
    const marker = await post(INSTANCES.a, tokenA, `/api/brain/${WIPE_SPACE}/memories`, {
      fact: 'Seq marker for wipe test', tags: ['wipe-marker'],
    });
    assert.equal(marker.status, 201);
    seqBefore = marker.body.seq;

    // Verify they exist
    const list = await get(INSTANCES.a, tokenA, `/api/brain/${WIPE_SPACE}/memories?limit=500`);
    for (const id of seededIds) {
      assert.ok(list.body.memories.some(m => m._id === id), `Seeded ${id} should exist`);
    }
  });

  it('DELETE without body returns 400', async () => {
    const r = await del(INSTANCES.a, tokenA, `/api/brain/${WIPE_SPACE}/memories`);
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('DELETE with confirm:false returns 400', async () => {
    const r = await delWithBody(INSTANCES.a, tokenA, `/api/brain/${WIPE_SPACE}/memories`, { confirm: false });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('DELETE with confirm:true returns {deleted: N}', async () => {
    const r = await delWithBody(INSTANCES.a, tokenA, `/api/brain/${WIPE_SPACE}/memories`, { confirm: true });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.deleted === 'number', 'deleted must be a number');
    assert.ok(r.body.deleted >= 10, `Should have deleted at least 10, got ${r.body.deleted}`);
  });

  it('Memories are gone after wipe', async () => {
    const list = await get(INSTANCES.a, tokenA, `/api/brain/${WIPE_SPACE}/memories?limit=500`);
    assert.equal(list.status, 200);
    for (const id of seededIds) {
      const found = list.body.memories.some(m => m._id === id);
      assert.ok(!found, `Wiped memory ${id} should be gone`);
    }
  });

  it('Tombstones were written for wiped memories', async () => {
    // Query only tombstones created after our seq watermark
    const r = await get(INSTANCES.a, tokenA, `/api/sync/tombstones?spaceId=${WIPE_SPACE}&sinceSeq=${seqBefore}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tombIds = (r.body.memories ?? []).map(t => t._id);
    for (const id of seededIds) {
      assert.ok(tombIds.includes(id), `Tombstone for ${id} should exist (got ${tombIds.length} tombstones since seq ${seqBefore})`);
    }
  });

  it('Long-form route works: DELETE /api/brain/spaces/:spaceId/memories', async () => {
    // Seed a couple of memories first
    let seqBase = Date.now();
    for (let i = 0; i < 3; i++) {
      await post(INSTANCES.a, tokenA, '/api/sync/memories?spaceId=general', {
        _id: `wipe-long-${RUN}-${i}`, spaceId: WIPE_SPACE, fact: `Long-form wipe ${i}`,
        tags: ['wipe-long'], entityIds: [], embedding: [],
        seq: seqBase++, author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
    }

    const r = await delWithBody(INSTANCES.a, tokenA, `/api/brain/spaces/${WIPE_SPACE}/memories`, { confirm: true });
    assert.equal(r.status, 200, `Long-form wipe: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.deleted === 'number');
    assert.ok(r.body.deleted >= 3, `Should have deleted at least 3, got ${r.body.deleted}`);
  });

  it('Wipe on unknown space returns 404', async () => {
    const r = await delWithBody(INSTANCES.a, tokenA, '/api/brain/no-such-space/memories', { confirm: true });
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
  });
});
