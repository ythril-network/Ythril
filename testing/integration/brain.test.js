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

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, patch } from '../sync/helpers.js';

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
    assert.equal(r.status, 404, `Got ${r.status}`);
  });
});

describe('Brain â€” stats', () => {
  it('Stats endpoint returns counts including files', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/stats');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.memories === 'number', 'memories count required');
    assert.ok(typeof r.body.files === 'number', 'files count required');
    assert.ok(r.body.files >= 0, 'files count must be non-negative');
  });
});

describe('Brain â€” conflicts protection', () => {
  it('Writing to a wrongly spelled spaceId returns error', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/GENERAL/memories', {
      fact: 'Case sensitivity test',
    });
    // Space IDs are lowercase â€” GENERAL should 404
    assert.equal(r.status, 404, `Got ${r.status}`);
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
  let createdId;

  it('Create entity with properties returns them in response', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `PropTest-${RUN}`,
      type: 'concept',
      tags: [],
      properties: { wheels: 4, color: 'red', electric: true },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.properties, { wheels: 4, color: 'red', electric: true });
    createdId = r.body._id;
  });

  it('Upsert merges properties with existing', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: createdId,
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
      id: createdId,
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
    // Look up by the specific id we updated
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${createdId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.properties.wheels, 4);
    assert.equal(r.body.properties.color, 'blue');
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
    const edgeLabel = `causes-${RUN}`;

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
      _id: edgeId, spaceId: 'general', from: entFrom, to: entTo, label: edgeLabel,
      type: 'causal', weight: 0.9,
      seq: Date.now() + 2, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
    });

    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/edges?from=${entFrom}&to=${entTo}&label=${encodeURIComponent(edgeLabel)}&limit=500`);
    assert.equal(r.status, 200);
    const edge = r.body.edges.find(e => e._id === edgeId);
    assert.ok(edge, 'Typed edge should appear in listing');
    assert.equal(edge.type, 'causal', 'type field should be preserved');
    assert.equal(edge.label, edgeLabel);
    assert.equal(edge.weight, 0.9);
  });

  it('Edge without type field is unaffected', async () => {
    const { post: syncPost } = await import('../sync/helpers.js');
    const edgeId = `untyped-edge-${RUN}`;
    const entFrom = `untyped-from-${RUN}`;
    const entTo = `untyped-to-${RUN}`;
    const edgeLabel = `related-${RUN}`;

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
      _id: edgeId, spaceId: 'general', from: entFrom, to: entTo, label: edgeLabel,
      seq: Date.now() + 12, author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
    });

    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/edges?from=${entFrom}&to=${entTo}&label=${encodeURIComponent(edgeLabel)}&limit=500`);
    assert.equal(r.status, 200);
    const edge = r.body.edges.find(e => e._id === edgeId);
    assert.ok(edge, 'Untyped edge should appear in listing');
    assert.equal(edge.type, undefined, 'type should be absent when not set');
    assert.equal(edge.label, edgeLabel);
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

// ── Reindex endpoint ─────────────────────────────────────────────────────────────────

describe('Brain — POST /api/brain/spaces/:spaceId/reindex', () => {
  const RUN = Date.now();
  const testSpaceId = `reindex-test-${RUN}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const createSpace = await post(INSTANCES.a, token(), '/api/spaces', { id: testSpaceId, label: 'Reindex Test Space' });
    assert.equal(createSpace.status, 201, `Create test space: ${JSON.stringify(createSpace.body)}`);

    // Seed one of each type with rich fields so the reindex formulas exercise the new fieldsets
    const { post: syncPost } = await import('../sync/helpers.js');

    await syncPost(INSTANCES.a, token(), `/api/sync/memories?spaceId=${testSpaceId}`, {
      _id: `reindex-mem-${RUN}`,
      spaceId: testSpaceId,
      fact: `Reindex memory fact ${RUN}`,
      embedding: [],
      embeddingModel: '__stale__',   // mark as stale so needsReindex triggers
      tags: ['reindex-test'],
      entityIds: [],
      description: 'Reindex description',
      properties: { aspect: 'test' },
      seq: Date.now(),
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await syncPost(INSTANCES.a, token(), `/api/sync/entities?spaceId=${testSpaceId}`, {
      _id: `reindex-ent-${RUN}`,
      spaceId: testSpaceId,
      name: `ReindexEnt-${RUN}`,
      type: 'concept',
      tags: ['reindex-test'],
      description: 'Entity for reindex',
      properties: { tier: 'core' },
      seq: Date.now() + 1,
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await syncPost(INSTANCES.a, token(), `/api/sync/edges?spaceId=${testSpaceId}`, {
      _id: `reindex-edge-${RUN}`,
      spaceId: testSpaceId,
      from: `reindex-ent-${RUN}`,
      to: `reindex-ent-${RUN}`,
      label: 'self_ref',
      tags: ['reindex-test'],
      description: 'Edge for reindex test',
      seq: Date.now() + 2,
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  after(async () => {
    await delWithBody(INSTANCES.a, token(), `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
  });

  it('POST /reindex returns 200 with count summary', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${testSpaceId}/reindex`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body === 'object', 'response must be an object');
    // The reindex response includes count fields for each collection type
    const keys = Object.keys(r.body);
    assert.ok(
      keys.some(k => ['memories', 'entities', 'edges', 'chrono', 'files', 'reindexed'].includes(k)),
      `Expected count key in response: ${JSON.stringify(r.body)}`,
    );
  });

  it('POST /reindex requires auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 401);
  });

  it('POST /reindex for unknown space returns 404', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/reindex', {});
    assert.equal(r.status, 404);
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
    // Query tombstones created after our seq watermark; page until all IDs are found
    const tombIds = new Set();
    const pending = new Set(seededIds);
    let sinceSeq = seqBefore;
    for (let page = 0; page < 200; page++) {
      const r = await get(INSTANCES.a, tokenA, `/api/sync/tombstones?spaceId=${WIPE_SPACE}&sinceSeq=${sinceSeq}&limit=5000`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const batch = r.body.memories ?? [];
      if (batch.length === 0) break;
      for (const t of batch) {
        tombIds.add(t._id);
        pending.delete(t._id);
      }
      if (pending.size === 0) break;
      // Advance past this page's highest seq; if no progress, stop to avoid loops
      const maxSeq = Math.max(...batch.map(t => t.seq ?? 0));
      if (maxSeq <= sinceSeq) break;
      sinceSeq = maxSeq;
    }
    for (const id of seededIds) {
      assert.ok(tombIds.has(id), `Tombstone for ${id} should exist (got ${tombIds.size} tombstones since seq ${seqBefore})`);
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

// -- Chrono CRUD ---------------------------------------------------------------

describe('Brain -- chrono CRUD (/api/brain/spaces/:spaceId/chrono)', () => {
  const RUN = Date.now();
  let chronoId;

  it('Create chrono entry returns 201', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: `Meeting-${RUN}`,
      type: 'event',
      startsAt: new Date().toISOString(),
      tags: ['test'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body._id, 'must have _id');
    assert.equal(r.body.type, 'event');
    assert.ok(typeof r.body.seq === 'number', 'must have seq');
    assert.deepStrictEqual(r.body.tags, ['test']);
    assert.equal(r.body.status, 'upcoming');
    chronoId = r.body._id;
  });

  it('List chrono returns {chrono:[...]}', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/chrono');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.chrono), 'chrono must be an array');
    const found = r.body.chrono.find(c => c._id === chronoId);
    assert.ok(found, 'created entry should appear in listing');
  });

  it('List chrono returns 404 for unknown space', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/chrono');
    assert.equal(r.status, 404);
  });

  it('List chrono returns 401 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/chrono`);
    assert.equal(r.status, 401);
  });

  it('Update chrono entry returns 200', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      status: 'completed',
      description: 'All done',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'completed');
    assert.equal(r.body.description, 'All done');
  });

  it('Update non-existent chrono entry returns 404', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono/does-not-exist', {
      status: 'completed',
    });
    assert.equal(r.status, 404);
  });

  it('Create chrono with optional fields', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: `Deadline-${RUN}`,
      type: 'deadline',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 86400_000).toISOString(),
      status: 'upcoming',
      confidence: 0.8,
      tags: ['important'],
      entityIds: ['some-entity'],
      memoryIds: ['some-memory'],
      description: 'Submit report',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.type, 'deadline');
    assert.equal(r.body.confidence, 0.8);
    assert.ok(r.body.endsAt, 'endsAt should be set');
    assert.deepStrictEqual(r.body.entityIds, ['some-entity']);
    assert.deepStrictEqual(r.body.memoryIds, ['some-memory']);
    assert.equal(r.body.description, 'Submit report');
  });

  it('Create chrono with invalid kind returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: 'Bad kind',
      type: 'invalid-kind',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400);
  });

  it('Create chrono without title returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      type: 'event',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400);
  });

  it('Create chrono without startsAt returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: 'Missing date',
      type: 'event',
    });
    assert.equal(r.status, 400);
  });

  it('Create chrono with invalid confidence returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: 'Bad confidence',
      type: 'prediction',
      startsAt: new Date().toISOString(),
      confidence: 1.5,
    });
    assert.equal(r.status, 400);
  });

  it('Delete chrono entry returns 204', async () => {
    const delR = await del(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`);
    assert.equal(delR.status, 204, JSON.stringify(delR.body));
  });

  it('Delete non-existent chrono entry returns 404', async () => {
    const r = await del(INSTANCES.a, token(), '/api/brain/spaces/general/chrono/does-not-exist');
    assert.equal(r.status, 404);
  });
});

describe('Brain -- chrono filter queries (/api/brain/spaces/:spaceId/chrono)', () => {
  const RUN = Date.now();
  const tagA = `brain-chrono-tag-a-${RUN}`;
  const tagB = `brain-chrono-tag-b-${RUN}`;
  const ids = [];
  const pastTime = new Date(Date.now() - 60_000).toISOString();
  const futureTime = new Date(Date.now() + 3_600_000).toISOString();

  before(async () => {
    // Seed chrono entries with various tags/descriptions
    for (const [title, tags, description] of [
      [`TagA-${RUN}`, [tagA], undefined],
      [`TagB-${RUN}`, [tagB], undefined],
      [`TagBoth-${RUN}`, [tagA, tagB], undefined],
      [`NoTag-${RUN}`, [], undefined],
      [`SearchMe-${RUN}`, [], 'find-this-special-description'],
    ]) {
      const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
        title, type: 'event', startsAt: new Date().toISOString(), tags,
        ...(description ? { description } : {}),
      });
      if (r.body._id) ids.push(r.body._id);
    }
  });

  after(async () => {
    for (const id of ids) {
      await del(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${id}`).catch(() => {});
    }
  });

  it('Filter by single tag (AND) returns only matching entries', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?tags=${encodeURIComponent(tagA)}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.chrono), 'chrono must be an array');
    const resultIds = r.body.chrono.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), `Entry with tag ${tagA} should be in results`);
    assert.ok(resultIds.includes(ids[2]), `Entry with both tags should be in results`);
    assert.ok(!resultIds.includes(ids[1]), `Entry with only ${tagB} should NOT be in results`);
  });

  it('Filter by multiple tags (AND) returns only entries with all specified tags', async () => {
    const qs = `tags=${encodeURIComponent(tagA)}&tags=${encodeURIComponent(tagB)}`;
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?${qs}`);
    assert.equal(r.status, 200);
    const resultIds = r.body.chrono.map(c => c._id);
    assert.ok(resultIds.includes(ids[2]), `Entry with both tags should be in results`);
    assert.ok(!resultIds.includes(ids[0]), `Entry with only ${tagA} should NOT appear for AND query`);
    assert.ok(!resultIds.includes(ids[1]), `Entry with only ${tagB} should NOT appear for AND query`);
  });

  it('tagsAny filter (OR) returns entries matching any of the tags', async () => {
    const qs = `tagsAny=${encodeURIComponent(tagA)}&tagsAny=${encodeURIComponent(tagB)}`;
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?${qs}`);
    assert.equal(r.status, 200);
    const resultIds = r.body.chrono.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), `Entry with tag ${tagA} should be in results`);
    assert.ok(resultIds.includes(ids[1]), `Entry with tag ${tagB} should be in results`);
    assert.ok(resultIds.includes(ids[2]), `Entry with both tags should be in results`);
    assert.ok(!resultIds.includes(ids[3]), `Entry with no tags should NOT be in results`);
  });

  it('Filter by non-existent tag returns empty array', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?tags=no-such-tag-${RUN}`);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.chrono, []);
  });

  it('after filter returns only entries created after the timestamp', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?after=${encodeURIComponent(pastTime)}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.chrono), 'chrono must be an array');
    // Seeded entries were created after pastTime, so at least our seeded entries should appear
    const resultIds = r.body.chrono.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), 'Seeded entry should appear when after < createdAt');
  });

  it('before filter returns only entries created before the timestamp', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?before=${encodeURIComponent(futureTime)}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.chrono), 'chrono must be an array');
    const resultIds = r.body.chrono.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), 'Seeded entry should appear when before > createdAt');
  });

  it('after filter in the far future returns empty array', async () => {
    const farFuture = new Date(Date.now() + 86_400_000 * 365).toISOString();
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?after=${encodeURIComponent(farFuture)}`);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.chrono, []);
  });

  it('search filter matches on title', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?search=${encodeURIComponent('TagA-' + RUN)}`);
    assert.equal(r.status, 200);
    const resultIds = r.body.chrono.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), 'Entry with matching title should appear');
    assert.ok(!resultIds.includes(ids[1]), 'Entry with non-matching title should not appear');
  });

  it('search filter matches on description (case-insensitive)', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono?search=FIND-THIS-SPECIAL`);
    assert.equal(r.status, 200);
    const resultIds = r.body.chrono.map(c => c._id);
    assert.ok(resultIds.includes(ids[4]), 'Entry with matching description should appear');
  });
});

// ── Memory description + properties fields ─────────────────────────────────

describe('Brain — memory description and properties fields', () => {
  const RUN = Date.now();

  it('POST /memories with description and properties stores both fields', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `DescPropFact-${RUN}`,
      tags: ['desc-prop-test'],
      description: 'Context for this fact',
      properties: { source: 'unit-test', confidence: 0.9, reviewed: true },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.description, 'Context for this fact');
    assert.deepStrictEqual(r.body.properties, { source: 'unit-test', confidence: 0.9, reviewed: true });
  });

  it('description and properties are retrievable by ID', async () => {
    const write = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `DescPropRetrieve-${RUN}`,
      description: 'Retrievable description',
      properties: { key: 'val' },
    });
    assert.equal(write.status, 201);
    const memId = write.body._id;

    const r = await get(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.description, 'Retrievable description');
    assert.deepStrictEqual(r.body.properties, { key: 'val' });
  });

  it('memory without description/properties works (optional fields)', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `NoDescProp-${RUN}`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.description, undefined);
    assert.equal(r.body.properties, undefined);
  });

  it('non-string description is ignored (coerced away)', async () => {
    // Server strips non-string description — must not crash
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `BadDesc-${RUN}`,
      description: 12345,
    });
    assert.ok(r.status === 201 || r.status === 400, `Expected 201 or 400, got ${r.status}`);
  });

  it('non-object properties is ignored (coerced away)', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `BadProps-${RUN}`,
      properties: 'not-an-object',
    });
    assert.ok(r.status === 201 || r.status === 400, `Expected 201 or 400, got ${r.status}`);
  });
});

// ── Entity description field ────────────────────────────────────────────────

describe('Brain — entity description field', () => {
  const RUN = Date.now();
  let createdId;

  it('Create entity with description stores and returns it', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `DescEntity-${RUN}`,
      type: 'concept',
      description: 'A well-described entity',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.description, 'A well-described entity');
    createdId = r.body._id;
  });

  it('Upsert preserves description when not re-supplied', async () => {
    // Update by id without description — should preserve the existing one
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: createdId,
      name: `DescEntity-${RUN}`,
      type: 'concept',
      tags: ['extra-tag'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.description, 'A well-described entity', 'description preserved on re-upsert without description');
  });

  it('Upsert overwrites description when re-supplied', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: createdId,
      name: `DescEntity-${RUN}`,
      type: 'concept',
      description: 'Updated description',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.description, 'Updated description');
  });

  it('Entity without description has no description field', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `NoDescEntity-${RUN}`,
      type: 'misc',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.description, undefined);
  });
});

// ── Edge tags, description, and properties fields ──────────────────────────

describe('Brain — edge tags, description, and properties fields', () => {
  const RUN = Date.now();
  let entFromId;
  let entToId;

  before(async () => {
    const fR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `EdgeDescFrom-${RUN}`, type: 'concept',
    });
    assert.equal(fR.status, 201);
    entFromId = fR.body._id;

    const tR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `EdgeDescTo-${RUN}`, type: 'concept',
    });
    assert.equal(tR.status, 201);
    entToId = tR.body._id;
  });

  it('Create edge with tags, description, and properties stores all three', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: entFromId,
      to: entToId,
      label: `rich-edge-${RUN}`,
      tags: ['causal', 'infra'],
      description: 'Why this edge exists',
      properties: { score: 0.85, validated: true },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.tags) && r.body.tags.includes('causal'), 'tags stored');
    assert.ok(r.body.tags.includes('infra'), 'both tags stored');
    assert.equal(r.body.description, 'Why this edge exists', 'description stored');
    assert.deepStrictEqual(r.body.properties, { score: 0.85, validated: true }, 'properties stored');
  });

  it('Upsert merges edge tags (union)', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: entFromId,
      to: entToId,
      label: `rich-edge-${RUN}`,
      tags: ['new-tag'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.tags.includes('causal'), 'original tag preserved');
    assert.ok(r.body.tags.includes('new-tag'), 'new tag merged');
  });

  it('Upsert merges edge properties (shallow merge)', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: entFromId,
      to: entToId,
      label: `rich-edge-${RUN}`,
      properties: { extra: 'yes' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.properties.score, 0.85, 'original property preserved');
    assert.equal(r.body.properties.extra, 'yes', 'new property merged');
  });

  it('Edge without new fields returns valid response', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: entFromId,
      to: entToId,
      label: `plain-edge-${RUN}`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(!r.body.description, 'description absent when not set');
  });

  it('Invalid tags value returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: entFromId,
      to: entToId,
      label: `bad-tags-${RUN}`,
      tags: 'not-an-array',
    });
    assert.equal(r.status, 400, `Expected 400 for non-array tags`);
  });

  it('Invalid description type returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: entFromId,
      to: entToId,
      label: `bad-desc-${RUN}`,
      description: { nested: true },
    });
    assert.equal(r.status, 400, `Expected 400 for non-string description`);
  });
});

// ── Chrono properties field ─────────────────────────────────────────────────

describe('Brain — chrono properties field', () => {
  const RUN = Date.now();
  let chronoId;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: `ChronoPropTest-${RUN}`,
      type: 'milestone',
      startsAt: new Date().toISOString(),
      properties: { phase: 'alpha', priority: 1, critical: true },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    chronoId = r.body._id;
  });

  it('Create chrono with properties stores them in response', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.properties, { phase: 'alpha', priority: 1, critical: true });
  });

  it('Update chrono can set properties', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      properties: { phase: 'beta', priority: 2, critical: false },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.properties, { phase: 'beta', priority: 2, critical: false });
  });

  after(async () => {
    if (chronoId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`).catch(() => {});
  });
});

// ── Bulk write ─────────────────────────────────────────────────────────────

describe('Brain — POST /api/brain/spaces/:spaceId/bulk', () => {
  const RUN = Date.now();

  it('Returns 207 with inserted/updated/errors shape', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      memories: [{ fact: `Bulk memory ${RUN}`, tags: ['bulk-test'] }],
      entities: [{ name: `BulkEnt-${RUN}`, type: 'concept', tags: ['bulk-test'] }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.ok(typeof r.body.inserted === 'object', 'inserted must be an object');
    assert.ok(typeof r.body.updated === 'object', 'updated must be an object');
    assert.ok(Array.isArray(r.body.errors), 'errors must be an array');
    assert.equal(r.body.inserted.memories, 1, 'memory should be inserted');
    assert.equal(r.body.inserted.entities, 1, 'entity should be inserted');
    assert.equal(r.body.errors.length, 0, `Unexpected errors: ${JSON.stringify(r.body.errors)}`);
  });

  it('Second call for same entity counts as updated', async () => {
    const name = `BulkUpsert-${RUN}`;
    const first = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      entities: [{ name, type: 'concept' }],
    });
    // Retrieve the created entity's id
    const listR = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities?name=${encodeURIComponent(name)}`);
    const createdId = listR.body.entities.find(e => e.name === name)?._id;
    assert.ok(createdId, 'entity must exist after first bulk call');
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      entities: [{ id: createdId, name, type: 'concept', description: 'updated' }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.updated.entities, 1, 'second upsert should be counted as updated');
    assert.equal(r.body.inserted.entities, 0);
  });

  it('Processes edges referencing entities from same batch', async () => {
    const entityName = `BulkEdgeEnt-${RUN}`;
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      entities: [{ name: `${entityName}-A`, type: 'concept' }, { name: `${entityName}-B`, type: 'concept' }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.entities, 2, JSON.stringify(r.body));

    // Get the entity IDs
    const listR = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities?name=${encodeURIComponent(`${entityName}-A`)}`);
    const entA = listR.body.entities?.[0];
    const listRB = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities?name=${encodeURIComponent(`${entityName}-B`)}`);
    const entB = listRB.body.entities?.[0];
    assert.ok(entA, 'entity A should be found');
    assert.ok(entB, 'entity B should be found');

    const edgeR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      edges: [{ from: entA._id, to: entB._id, label: `bulk-rel-${RUN}` }],
    });
    assert.equal(edgeR.status, 207, JSON.stringify(edgeR.body));
    assert.equal(edgeR.body.inserted.edges, 1, JSON.stringify(edgeR.body));
    assert.equal(edgeR.body.errors.length, 0, JSON.stringify(edgeR.body.errors));
  });

  it('Inserts chrono entries', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      chrono: [
        { title: `BulkEvent-${RUN}`, type: 'event', startsAt: new Date().toISOString() },
        { title: `BulkDeadline-${RUN}`, type: 'deadline', startsAt: new Date().toISOString(), status: 'upcoming' },
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.chrono, 2, JSON.stringify(r.body));
    assert.equal(r.body.errors.length, 0, JSON.stringify(r.body.errors));
  });

  it('Per-item validation errors do not abort the batch', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      memories: [
        { fact: `Valid bulk memory ${RUN} A` },
        { tags: ['no-fact'] },          // missing fact → error
        { fact: `Valid bulk memory ${RUN} B` },
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.memories, 2, 'two valid memories should be inserted');
    assert.equal(r.body.errors.length, 1, 'one error expected');
    assert.equal(r.body.errors[0].type, 'memory');
    assert.equal(r.body.errors[0].index, 1);
    assert.ok(r.body.errors[0].reason, 'error reason should be set');
  });

  it('Entity missing name returns error entry', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      entities: [{ type: 'concept' }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.errors.length, 1);
    assert.equal(r.body.errors[0].type, 'entity');
    assert.ok(r.body.errors[0].reason.includes('name'), `Expected name in reason: ${r.body.errors[0].reason}`);
  });

  it('Edge missing required fields returns per-field errors', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      edges: [{ to: 'some-id', label: 'rel' }], // missing from
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.errors.length, 1);
    assert.equal(r.body.errors[0].type, 'edge');
    assert.ok(r.body.errors[0].reason.includes('from'));
  });

  it('Chrono with invalid kind returns error entry', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      chrono: [{ title: 'Bad kind', type: 'invalid', startsAt: new Date().toISOString() }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.errors.length, 1);
    assert.equal(r.body.errors[0].type, 'chrono');
  });

  it('Empty arrays is a no-op returning zero counts', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      memories: [], entities: [], edges: [], chrono: [],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.memories, 0);
    assert.equal(r.body.inserted.entities, 0);
    assert.equal(r.body.inserted.edges, 0);
    assert.equal(r.body.inserted.chrono, 0);
    assert.equal(r.body.errors.length, 0);
  });

  it('Empty body (all arrays omitted) is a no-op', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {});
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.memories + r.body.inserted.entities + r.body.inserted.edges + r.body.inserted.chrono, 0);
  });

  it('Returns 404 for unknown space', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/bulk', {
      memories: [{ fact: 'test' }],
    });
    assert.equal(r.status, 404);
  });

  it('Returns 401 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memories: [{ fact: 'test' }] }),
    });
    assert.equal(r.status, 401);
  });
});

// ── Graph traversal ─────────────────────────────────────────────────────────

describe('Brain — graph traversal (/api/brain/spaces/:spaceId/traverse)', () => {
  const RUN = Date.now();
  // Entity IDs for a small graph: A → B → C (chain), A → D (branch)
  const entA = `trav-A-${RUN}`;
  const entB = `trav-B-${RUN}`;
  const entC = `trav-C-${RUN}`;
  const entD = `trav-D-${RUN}`;

  before(async () => {
    const { post: syncPost } = await import('../sync/helpers.js');
    const now = new Date().toISOString();
    let seq = Date.now();

    for (const [id, name] of [[entA, 'A'], [entB, 'B'], [entC, 'C'], [entD, 'D']]) {
      await syncPost(INSTANCES.a, token(), '/api/sync/entities?spaceId=general', {
        _id: id, spaceId: 'general', name: `TravEnt-${name}-${RUN}`, type: 'service', tags: [],
        seq: seq++, author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: now, updatedAt: now,
      });
    }
    // A → B (depends_on), B → C (depends_on), A → D (references)
    for (const [from, to, label] of [
      [entA, entB, 'depends_on'],
      [entB, entC, 'depends_on'],
      [entA, entD, 'references'],
    ]) {
      await syncPost(INSTANCES.a, token(), '/api/sync/edges?spaceId=general', {
        _id: `trav-edge-${from}-${to}-${RUN}`, spaceId: 'general',
        from, to, label,
        seq: seq++, author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: now, updatedAt: now,
      });
    }
  });

  it('Returns 400 when startId is missing', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('Returns 404 for unknown space', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/traverse', { startId: entA });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('Returns 401 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/traverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startId: entA }),
    });
    assert.equal(r.status, 401);
  });

  it('Outbound depth=1 returns direct neighbours B and D', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entA, direction: 'outbound', maxDepth: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.nodes), 'nodes must be array');
    assert.ok(Array.isArray(r.body.edges), 'edges must be array');
    assert.equal(typeof r.body.truncated, 'boolean', 'truncated must be boolean');
    const nodeIds = r.body.nodes.map(n => n._id);
    assert.ok(nodeIds.includes(entB), 'B must be in depth-1 neighbours');
    assert.ok(nodeIds.includes(entD), 'D must be in depth-1 neighbours');
    assert.ok(!nodeIds.includes(entA), 'start node must not appear in results');
    assert.ok(!nodeIds.includes(entC), 'C must not appear at depth 1');
    // All returned nodes must have depth=1
    for (const n of r.body.nodes) assert.equal(n.depth, 1, `Node ${n._id} must have depth=1`);
  });

  it('Outbound depth=2 reaches C via B', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entA, direction: 'outbound', maxDepth: 2,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nodeIds = r.body.nodes.map(n => n._id);
    assert.ok(nodeIds.includes(entC), 'C must appear at depth 2');
    const nodeC = r.body.nodes.find(n => n._id === entC);
    assert.equal(nodeC.depth, 2, 'C must have depth=2');
  });

  it('edgeLabels filter restricts traversal to matching labels', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entA, direction: 'outbound', maxDepth: 1, edgeLabels: ['depends_on'],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nodeIds = r.body.nodes.map(n => n._id);
    assert.ok(nodeIds.includes(entB), 'B (depends_on) must appear');
    assert.ok(!nodeIds.includes(entD), 'D (references) must not appear with depends_on filter');
  });

  it('Inbound traversal from C returns B then A', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entC, direction: 'inbound', maxDepth: 2,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nodeIds = r.body.nodes.map(n => n._id);
    assert.ok(nodeIds.includes(entB), 'B must appear in inbound traversal from C');
    assert.ok(nodeIds.includes(entA), 'A must appear in inbound traversal from C at depth 2');
  });

  it('limit=1 returns only one node and sets truncated=true', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entA, direction: 'outbound', maxDepth: 3, limit: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.nodes.length, 1, 'Only one node must be returned');
    assert.equal(r.body.truncated, true, 'truncated must be true');
  });

  it('Response edges only include traversed edges (not all edges)', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entA, direction: 'outbound', maxDepth: 1, edgeLabels: ['depends_on'],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Only the A→B edge should appear (not A→D)
    assert.equal(r.body.edges.length, 1, 'Only traversed edge should be returned');
    const e = r.body.edges[0];
    assert.equal(e.from, entA);
    assert.equal(e.to, entB);
    assert.equal(e.label, 'depends_on');
  });

  it('maxDepth is capped at 10 and does not error with large value', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entA, direction: 'outbound', maxDepth: 999,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('Unknown startId returns empty nodes and edges', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: 'nonexistent-entity-id-xyz',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.nodes, []);
    assert.deepEqual(r.body.edges, []);
    assert.equal(r.body.truncated, false);
  });

  it('direction=both returns neighbours in either direction and start node never appears in results', async () => {
    // A→B and A→D outbound; C→B is not in graph, but B→C is. Starting from B with both:
    // outbound: C; inbound: A
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse', {
      startId: entB, direction: 'both', maxDepth: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nodeIds = r.body.nodes.map(n => n._id);
    // A is an inbound neighbour of B (A→B depends_on)
    assert.ok(nodeIds.includes(entA), 'A must appear as inbound neighbour of B in both direction');
    // C is an outbound neighbour of B (B→C depends_on)
    assert.ok(nodeIds.includes(entC), 'C must appear as outbound neighbour of B in both direction');
    // Start node (B) must never appear in results
    assert.ok(!nodeIds.includes(entB), 'Start node must not appear in traversal results');
  });
});


// ── Brain — structured query endpoint ───────────────────────────────────────

describe('Brain — POST /spaces/:spaceId/query', () => {
  const RUN = Date.now();
  let seededId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // Seed a memory with a distinctive tag and fact for query tests
    const r = await post(INSTANCES.a, tokenA, '/api/brain/general/memories', {
      fact: `QueryTest-${RUN} authentication service bootstrap`,
      tags: [`qtest-${RUN}`, 'auth'],
    });
    assert.equal(r.status, 201, `Seeding query test memory: ${JSON.stringify(r.body)}`);
    seededId = r.body._id;
  });

  after(async () => {
    if (seededId) {
      await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/memories/${seededId}`).catch(() => {});
    }
  });

  it('Returns 200 with results array and count for basic query', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: {},
      limit: 5,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.results), 'results must be an array');
    assert.equal(typeof r.body.count, 'number', 'count must be a number');
    assert.equal(r.body.collection, 'memories', 'collection echoed back');
  });

  it('Returns seeded memory when filtering by exact tag', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: { tags: { $in: [`qtest-${RUN}`] } },
      limit: 10,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.results.map(d => d._id);
    assert.ok(ids.includes(seededId), `Seeded memory ${seededId} should appear in $in filter results`);
  });

  it('Supports $regex filter for partial text match on fact', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: { fact: { $regex: `QueryTest-${RUN}`, $options: 'i' } },
      limit: 10,
    });
    assert.equal(r.status, 200, `$regex query should succeed: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(d => d._id);
    assert.ok(ids.includes(seededId), `$regex match should include seeded memory ${seededId}`);
  });

  it('$regex with case-insensitive flag matches uppercase version', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: { fact: { $regex: `QUERYTEST-${RUN}`, $options: 'i' } },
      limit: 10,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.results.map(d => d._id);
    assert.ok(ids.includes(seededId), 'Case-insensitive $regex should match seeded memory');
  });

  it('Rejects disallowed operator $where with 400', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: { $where: 'function() { return true; }' },
    });
    assert.equal(r.status, 400, `$where must be rejected with 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error, 'error message expected');
  });

  it('Rejects $options without $regex with 400', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: { fact: { $options: 'i' } },
    });
    assert.equal(r.status, 400, `$options without $regex must be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error.includes('$regex'), 'Error should mention $regex requirement');
  });

  it('Rejects $options with invalid flags with 400', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: { fact: { $regex: 'test', $options: 'ig' } },
    });
    assert.equal(r.status, 400, `$options with invalid flags must be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error.includes('valid regex flags'), 'Error should mention valid flags');
  });

  it('Rejects unknown collection with 400', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'unknown_collection',
      filter: {},
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error, 'error message expected');
  });

  it('Returns 404 for unknown space', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/no-such-space/query', {
      collection: 'memories',
      filter: {},
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('Returns 401 without auth token', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: 'memories', filter: {} }),
    });
    assert.equal(r.status, 401, 'Query endpoint must require authentication');
  });

  it('Embedding field is excluded from query results', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: { _id: seededId },
      limit: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.results.length > 0, 'Expected at least one result');
    assert.ok(!('embedding' in r.body.results[0]), 'embedding field must be excluded from results');
  });

  it('Respects limit parameter', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: {},
      limit: 2,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.results.length <= 2, `Results must not exceed limit of 2, got ${r.body.results.length}`);
  });

  it('Query across entities collection works', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/query', {
      collection: 'entities',
      filter: {},
      limit: 5,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.results), 'entities results must be an array');
  });
});

// ── PATCH /memories/:id — description and properties update ─────────────────

describe('Brain — PATCH memory updates description and properties', () => {
  const RUN = Date.now();
  let memId;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `PatchMemFact-${RUN}`,
      tags: ['patch-test'],
      description: 'Initial description',
      properties: { source: 'original', confidence: 0.5 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    memId = r.body._id;
  });

  it('PATCH memory updates description field', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`, {
      description: 'Updated description',
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.description, 'Updated description', 'description must be updated');

    const get2 = await get(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.description, 'Updated description', 'description persisted to DB');
  });

  it('PATCH memory updates properties field', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`, {
      properties: { source: 'patched', extra: 'yes' },
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.properties?.source, 'patched', 'source property updated');

    const get2 = await get(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.properties?.source, 'patched', 'properties persisted to DB');
    assert.equal(get2.body.properties?.extra, 'yes', 'new property persisted');
  });

  it('PATCH memory updates fact field', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`, {
      fact: `PatchMemFact-updated-${RUN}`,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fact, `PatchMemFact-updated-${RUN}`);
  });

  it('PATCH memory with no fields returns 400', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`, {});
    assert.equal(r.status, 400, `Expected 400 for empty body`);
  });

  it('PATCH memory with unknown ID returns 404', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/general/memories/nonexistent-id-${RUN}`, {
      description: 'should not matter',
    });
    assert.equal(r.status, 404, `Expected 404 for unknown ID`);
  });

  after(async () => {
    if (memId) await del(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`).catch(() => {});
  });
});

// ── PATCH /spaces/:spaceId/memories/:id — long-form path ──────────────────

describe('Brain — PATCH memory long-form path persists description and properties', () => {
  const RUN = Date.now();
  let memId;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `PatchMemLong-${RUN}`,
      description: 'Initial',
      properties: { v: 1 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    memId = r.body._id;
  });

  it('PATCH long-form updates description and properties', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/memories/${memId}`, {
      description: 'Long-form updated',
      properties: { v: 2 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.description, 'Long-form updated');
    assert.equal(r.body.properties?.v, 2);
  });

  after(async () => {
    if (memId) await del(INSTANCES.a, token(), `/api/brain/general/memories/${memId}`).catch(() => {});
  });
});

// ── PATCH /spaces/:spaceId/entities/:id ──────────────────────────────────────

describe('Brain — PATCH entity by ID', () => {
  const RUN = Date.now();
  let entId;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `PatchEntityName-${RUN}`,
      type: 'concept',
      description: 'Original entity description',
      properties: { tier: 'core' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    entId = r.body._id;
  });

  it('PATCH entity updates description by ID', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${entId}`, {
      description: 'Updated entity description',
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.description, 'Updated entity description', 'description updated');

    const getR = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${entId}`);
    assert.equal(getR.body.description, 'Updated entity description', 'persisted to DB');
  });

  it('PATCH entity merges properties by ID', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${entId}`, {
      properties: { tier: 'premium', extra: 'yes' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.properties?.tier, 'premium', 'property updated');
    assert.equal(r.body.properties?.extra, 'yes', 'new property added');
  });

  it('PATCH entity with no fields returns 400', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${entId}`, {});
    assert.equal(r.status, 400, `Expected 400`);
  });

  it('PATCH entity with unknown ID returns 404', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/entities/nonexistent-${RUN}`, {
      description: 'nope',
    });
    assert.equal(r.status, 404, `Expected 404`);
  });

  after(async () => {
    if (entId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${entId}`).catch(() => {});
  });
});

// ── PATCH /spaces/:spaceId/edges/:id ─────────────────────────────────────────

describe('Brain — PATCH edge by ID', () => {
  const RUN = Date.now();
  let edgeId;
  let fromId;
  let toId;

  before(async () => {
    const fR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `PatchEdgeFrom-${RUN}`, type: 'concept',
    });
    assert.equal(fR.status, 201);
    fromId = fR.body._id;

    const tR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `PatchEdgeTo-${RUN}`, type: 'concept',
    });
    assert.equal(tR.status, 201);
    toId = tR.body._id;

    const eR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: fromId,
      to: toId,
      label: `patch-edge-${RUN}`,
      description: 'Original edge description',
      properties: { score: 0.5 },
    });
    assert.equal(eR.status, 201, JSON.stringify(eR.body));
    edgeId = eR.body._id;
  });

  it('PATCH edge updates description by ID', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${edgeId}`, {
      description: 'Updated edge description',
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.description, 'Updated edge description', 'description updated');

    const getR = await get(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${edgeId}`);
    assert.equal(getR.body.description, 'Updated edge description', 'persisted to DB');
  });

  it('PATCH edge merges properties by ID', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${edgeId}`, {
      properties: { score: 0.9, validated: true },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.properties?.score, 0.9, 'property updated');
    assert.equal(r.body.properties?.validated, true, 'new property added');
  });

  it('PATCH edge with no fields returns 400', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${edgeId}`, {});
    assert.equal(r.status, 400, `Expected 400`);
  });

  it('PATCH edge with unknown ID returns 404', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/edges/nonexistent-${RUN}`, {
      description: 'nope',
    });
    assert.equal(r.status, 404, `Expected 404`);
  });

  after(async () => {
    if (edgeId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${edgeId}`).catch(() => {});
    if (fromId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${fromId}`).catch(() => {});
    if (toId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${toId}`).catch(() => {});
  });
});

// ── PATCH /spaces/:spaceId/chrono/:id ────────────────────────────────────────

describe('Brain — PATCH chrono by ID', () => {
  const RUN = Date.now();
  let chronoId;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: `PatchChrono-${RUN}`,
      type: 'milestone',
      startsAt: new Date().toISOString(),
      description: 'Original chrono description',
      properties: { phase: 'alpha' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    chronoId = r.body._id;
  });

  it('PATCH chrono updates description by ID', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      description: 'Updated chrono description',
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.description, 'Updated chrono description', 'description updated');
  });

  it('PATCH chrono updates properties by ID', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      properties: { phase: 'beta' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.properties?.phase, 'beta', 'property updated');
  });

  it('PATCH chrono with unknown ID returns 404', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/nonexistent-${RUN}`, {
      description: 'nope',
    });
    assert.equal(r.status, 404, `Expected 404`);
  });

  after(async () => {
    if (chronoId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`).catch(() => {});
  });
});

// ── Entity creation with explicit UUID id ────────────────────────────────────

describe('Brain — entity creation with explicit UUID id', () => {
  const RUN = Date.now();
  const validUuid = `550e8400-e29b-41d4-a716-${String(RUN).padStart(12, '0').slice(0, 12)}`;
  const createdIds = [];

  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    for (const id of createdIds) {
      await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${id}`).catch(() => {});
    }
  });

  it('Create entity with valid UUID id uses that id', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: validUuid,
      name: `ExplicitId-${RUN}`,
      type: 'concept',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body._id, validUuid, 'Entity _id must match supplied UUID');
    createdIds.push(validUuid);
  });

  it('Retrieve entity by explicit UUID id', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${validUuid}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body._id, validUuid);
    assert.equal(r.body.name, `ExplicitId-${RUN}`);
  });

  it('Second POST with same UUID id updates (upserts) the entity', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: validUuid,
      name: `ExplicitId-${RUN}`,
      type: 'concept',
      description: 'updated via id-based upsert',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body._id, validUuid, 'Same UUID must be reused');
    assert.equal(r.body.description, 'updated via id-based upsert');
  });

  it('Rejects invalid UUID (ObjectId format) with 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: '507f1f77bcf86cd799439011',
      name: `BadId-${RUN}`,
      type: 'concept',
    });
    assert.equal(r.status, 400, `Expected 400 for ObjectId, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Rejects UUID v1 with 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: '550e8400-e29b-11d4-a716-446655440000',
      name: `V1Id-${RUN}`,
      type: 'concept',
    });
    assert.equal(r.status, 400, `Expected 400 for UUID v1, got ${r.status}`);
  });

  it('Rejects empty string id with 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: '',
      name: `EmptyId-${RUN}`,
      type: 'concept',
    });
    assert.equal(r.status, 400, `Expected 400 for empty id, got ${r.status}`);
  });
});

// ── Entities by-name endpoint ────────────────────────────────────────────────

describe('Brain — GET /spaces/:spaceId/entities/by-name', () => {
  const RUN = Date.now();
  const entityName = `ByNameTest-${RUN}`;
  const createdIds = [];

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const r1 = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: entityName,
      type: 'person',
    });
    assert.equal(r1.status, 201);
    createdIds.push(r1.body._id);

    const r2 = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: entityName,
      type: 'character',
    });
    assert.equal(r2.status, 201);
    createdIds.push(r2.body._id);
  });

  after(async () => {
    for (const id of createdIds) {
      await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${id}`).catch(() => {});
    }
  });

  it('Returns entities matching the name', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities/by-name?name=${encodeURIComponent(entityName)}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.entities), 'entities must be an array');
    assert.ok(r.body.entities.length >= 2, `Expected at least 2 results, got ${r.body.entities.length}`);
    for (const ent of r.body.entities) {
      assert.equal(ent.name, entityName);
    }
  });

  it('Returns empty array for non-existent name', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/general/entities/by-name?name=no-such-entity-ever-${RUN}`);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.entities, []);
  });

  it('Returns 400 when name query param is missing', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/entities/by-name');
    assert.equal(r.status, 400, `Expected 400 without name param, got ${r.status}`);
  });

  it('Returns 404 for non-existent space', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/no-such-space/entities/by-name?name=${entityName}`);
    assert.equal(r.status, 404);
  });
});

// ── Read-only token enforcement on REST write endpoints ─────────────────────

describe('Brain — read-only token blocked on REST write endpoints', () => {
  const RUN = Date.now();
  let readOnlyToken;
  let readOnlyTokenId;
  let testMemId;
  let testEntId;
  let testEdgeId;
  let testChronoId;
  let helperEntId2;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    // Create a read-only token
    const tokenRes = await post(INSTANCES.a, token(), '/api/tokens', {
      name: `readonly-rest-${RUN}`,
      readOnly: true,
    });
    assert.equal(tokenRes.status, 201, `Create read-only token: ${JSON.stringify(tokenRes.body)}`);
    readOnlyToken = tokenRes.body.plaintext;
    readOnlyTokenId = tokenRes.body.id;

    // Seed test objects using the admin token for later PATCH/DELETE tests
    const memR = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `ROTest-mem-${RUN}`,
    });
    testMemId = memR.body._id;

    const entR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `ROTest-ent-${RUN}`, type: 'concept',
    });
    testEntId = entR.body._id;

    const entR2 = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `ROTest-ent2-${RUN}`, type: 'concept',
    });
    helperEntId2 = entR2.body._id;

    const edgeR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/edges', {
      from: testEntId, to: helperEntId2, label: `ro-edge-${RUN}`,
    });
    testEdgeId = edgeR.body._id;

    const chronoR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: `ROTest-chrono-${RUN}`, type: 'event', startsAt: new Date().toISOString(),
    });
    testChronoId = chronoR.body._id;
  });

  after(async () => {
    if (readOnlyTokenId) await del(INSTANCES.a, token(), `/api/tokens/${readOnlyTokenId}`).catch(() => {});
    if (testMemId) await del(INSTANCES.a, token(), `/api/brain/general/memories/${testMemId}`).catch(() => {});
    if (testEntId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${testEntId}`).catch(() => {});
    if (helperEntId2) await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${helperEntId2}`).catch(() => {});
    if (testEdgeId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${testEdgeId}`).catch(() => {});
    if (testChronoId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${testChronoId}`).catch(() => {});
  });

  it('POST /memories blocked with read-only token (403)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/general/memories', {
      fact: 'Should be blocked',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('PATCH /memories/:id blocked with read-only token (403)', async () => {
    const r = await patch(INSTANCES.a, readOnlyToken, `/api/brain/general/memories/${testMemId}`, {
      fact: 'Should be blocked',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('POST /entities blocked with read-only token (403)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/spaces/general/entities', {
      name: 'Blocked', type: 'concept',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('PATCH /entities/:id blocked with read-only token (403)', async () => {
    const r = await patch(INSTANCES.a, readOnlyToken, `/api/brain/spaces/general/entities/${testEntId}`, {
      description: 'Should be blocked',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('POST /edges blocked with read-only token (403)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/spaces/general/edges', {
      from: testEntId, to: helperEntId2, label: 'blocked',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('PATCH /edges/:id blocked with read-only token (403)', async () => {
    const r = await patch(INSTANCES.a, readOnlyToken, `/api/brain/spaces/general/edges/${testEdgeId}`, {
      description: 'Should be blocked',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('POST /chrono blocked with read-only token (403)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/spaces/general/chrono', {
      title: 'Blocked', type: 'event', startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('PATCH /chrono/:id blocked with read-only token (403)', async () => {
    const r = await patch(INSTANCES.a, readOnlyToken, `/api/brain/spaces/general/chrono/${testChronoId}`, {
      description: 'Should be blocked',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('POST /bulk blocked with read-only token (403)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/spaces/general/bulk', {
      memories: [{ fact: 'Blocked' }],
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('POST /traverse allowed with read-only token (read-only operation)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/spaces/general/traverse', {
      startId: testEntId,
    });
    assert.equal(r.status, 200, `Traverse is read-only — should be allowed, got ${r.status}`);
  });

  it('POST /query allowed with read-only token (read-only operation)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/spaces/general/query', {
      collection: 'memories',
      filter: {},
      limit: 1,
    });
    assert.equal(r.status, 200, `Query is read-only — should be allowed, got ${r.status}`);
  });

  it('GET /memories allowed with read-only token', async () => {
    const r = await get(INSTANCES.a, readOnlyToken, '/api/brain/general/memories?limit=1');
    assert.equal(r.status, 200, `GET memories should be allowed, got ${r.status}`);
  });
});

// ── Bulk write cap at 500 items per type ─────────────────────────────────────

describe('Brain — bulk write caps at 500 items per type', () => {
  const RUN = Date.now();
  const testSpaceId = `bulk-cap-${RUN}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const createSpace = await post(INSTANCES.a, token(), '/api/spaces', { id: testSpaceId, label: 'Bulk Cap Test Space' });
    assert.equal(createSpace.status, 201, `Create test space: ${JSON.stringify(createSpace.body)}`);
  });

  after(async () => {
    await delWithBody(INSTANCES.a, token(), `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
  });

  it('Items beyond 500 are silently dropped', async () => {
    const memories = [];
    for (let i = 0; i < 502; i++) {
      memories.push({ fact: `BulkCap-${RUN}-${i}` });
    }
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${testSpaceId}/bulk`, { memories });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    const total = r.body.inserted.memories + r.body.errors.length;
    assert.ok(total <= 500, `Total processed must be <= 500, got ${total}`);
  });
});

// ── Find-similar endpoint ────────────────────────────────────────────────────

describe('Brain — find-similar', () => {
  const RUN = Date.now();

  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('POST /find-similar requires entryId and entryType', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/find-similar', {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('POST /find-similar rejects invalid entryType', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/find-similar', {
      entryId: '00000000-0000-4000-a000-000000000001',
      entryType: 'invalid',
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error.includes('entryType'), r.body.error);
  });

  it('POST /find-similar rejects invalid entryId', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/find-similar', {
      entryId: 'not-a-uuid',
      entryType: 'memory',
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error.includes('entryId'), r.body.error);
  });

  it('POST /find-similar 404 for non-existent entry', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/find-similar', {
      entryId: '00000000-0000-4000-a000-000000000099',
      entryType: 'memory',
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('POST /find-similar returns results for a valid memory', async () => {
    // Write two similar memories
    const w1 = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `FindSimilar test: authentication and authorization ${RUN}`,
      tags: ['find-similar-test'],
    });
    const w2 = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `FindSimilar test: auth and authz security ${RUN}`,
      tags: ['find-similar-test'],
    });
    assert.equal(w1.status, 201, JSON.stringify(w1.body));
    assert.equal(w2.status, 201, JSON.stringify(w2.body));

    const sourceId = w1.body._id ?? w1.body.id;

    // Search for similar
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/find-similar', {
      entryId: sourceId,
      entryType: 'memory',
      topK: 5,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.source, 'Response must include source entry');
    assert.equal(r.body.source._id, sourceId, 'Source _id must match');
    assert.equal(r.body.source.score, 1.0, 'Source score must be 1.0');
    assert.ok(Array.isArray(r.body.results), 'Results must be an array');
    // The self-match should be excluded from results
    const selfMatch = r.body.results.find(e => e._id === sourceId);
    assert.equal(selfMatch, undefined, 'Self-match must be excluded from results');
  });

  it('POST /find-similar respects targetTypes filter', async () => {
    const w = await post(INSTANCES.a, token(), '/api/brain/general/memories', {
      fact: `FindSimilar targetTypes test ${RUN}`,
    });
    const sourceId = w.body._id ?? w.body.id;

    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/find-similar', {
      entryId: sourceId,
      entryType: 'memory',
      targetTypes: ['entity'],
      topK: 5,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // All results (if any) should be of type 'entity'
    for (const result of r.body.results) {
      assert.equal(result.type, 'entity', `Expected entity type but got ${result.type}`);
    }
  });

  it('POST /find-similar on non-existent space returns 404', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/nonexistent-space/find-similar', {
      entryId: '00000000-0000-4000-a000-000000000001',
      entryType: 'memory',
    });
    assert.equal(r.status, 404, `Got ${r.status}`);
  });
});
