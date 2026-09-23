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
import { INSTANCES, post, get, del, delWithBody, patch, readRecord, readCollection, filterRest } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;

function token() { return tokenA; }

describe('Brain â€” memories', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('Write a memory returns 201 with _id and seq', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: 'The sky is blue',
      tags: ['science', 'color'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body._id || r.body.id, 'Should have _id');
    assert.ok(typeof r.body.seq === 'number', 'Should have seq number');
    assert.deepEqual(r.body.author?.instanceId !== undefined, true, 'Author instanceId required');
  });

  it('List memories returns written memory', async () => {
    const write = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: 'Unique fact for list test',
      tags: ['list-test'],
    });
    const memId = write.body._id ?? write.body.id;

    const r = await readRecord(INSTANCES.a, token(), 'general', 'facts', memId);
    assert.equal(r.status, 200, `Written memory should be retrievable by ID: ${JSON.stringify(r.body)}`);
  });

  it('Delete a memory returns 204 and it is gone', async () => {
    const write = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: 'Memory to delete',
      tags: ['delete-test'],
    });
    const memId = write.body._id ?? write.body.id;

    const delR = await del(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`);
    assert.equal(delR.status, 204, `Delete: ${JSON.stringify(delR.body)}`);

    // Confirm deletion via direct ID lookup — 404 is the authoritative signal;
    // scanning a paginated list would give a false pass once >100 memories exist.
    const lookup = await readRecord(INSTANCES.a, token(), 'general', 'facts', memId);
    assert.equal(lookup.status, 404, 'Deleted memory must return 404 on direct lookup');
  });

  it('Emptying a space requires confirm:true, on the one door that does it', async () => {
    // The five per-collection DELETEs are gone (5.0). `POST /api/delete_space_data` is the tool's own
    // arguments as a body, and the same call an agent makes over MCP.
    const noConfirm = await post(INSTANCES.a, token(), '/api/delete_space_data', { space: 'general' });
    assert.equal(noConfirm.status, 400, `no confirm should 400, got ${noConfirm.status}`);
    assert.match(noConfirm.body.error, /confirm/, 'the refusal must name what is missing');

    const falseConfirm = await post(INSTANCES.a, token(), '/api/delete_space_data', { space: 'general', confirm: false });
    assert.equal(falseConfirm.status, 400, `confirm:false should 400, got ${falseConfirm.status}`);
  });

  it('Delete non-existent memory returns 404', async () => {
    const r = await del(INSTANCES.a, token(), '/api/brain/spaces/general/facts/nonexistent-id');
    assert.equal(r.status, 404);
  });

  it('Access memory in non-existent space returns 404', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'nonexistent-space', 'facts');
    assert.equal(r.status, 404, `Got ${r.status}`);
  });
});

describe('Brain â€” stats', () => {
  it('Stats endpoint returns counts including files', async () => {
    const r = await get(INSTANCES.a, token(), '/api/brain/spaces/general/stats');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.facts === 'number', 'memories count required');
    assert.ok(typeof r.body.files === 'number', 'files count required');
    assert.ok(r.body.files >= 0, 'files count must be non-negative');
  });
});

describe('Brain â€” conflicts protection', () => {
  it('Writing to a wrongly spelled spaceId returns error', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/GENERAL/facts', {
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
    const r = await readCollection(INSTANCES.a, token(), 'general', 'entities');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.results), 'entities must be an array');
  });

  it('List entities returns 404 for unknown space', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'no-such-space', 'entities');
    assert.equal(r.status, 404);
  });

  it('List entities returns 401 without auth', async () => {
    // Through `filter`, because the per-collection route is gone. What has to stay true is that a read
    // with no credentials is refused before anything is read — not that one PATH refuses it.
    const r = await fetch(`${INSTANCES.a}/api/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ space: 'general', collection: 'entities' }),
    });
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
    const r = await readRecord(INSTANCES.a, token(), 'general', 'entities', createdId);
    assert.equal(r.status, 200);
    assert.equal(r.body.properties.wheels, 4);
    assert.equal(r.body.properties.color, 'blue');
  });
});


// â”€â”€ Edges CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Brain â€” edges CRUD (/api/brain/spaces/:spaceId/edges)', () => {
  const RUN = Date.now();

  it('List edges returns {edges:[...]}', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'edges');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.results), 'edges must be an array');
  });

  it('List edges returns 404 for unknown space', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'no-such-space', 'edges');
    assert.equal(r.status, 404);
  });

  it('List edges returns 401 without auth', async () => {
    // Through `filter`, because the per-collection route is gone. What has to stay true is that a read
    // with no credentials is refused before anything is read — not that one PATH refuses it.
    const r = await fetch(`${INSTANCES.a}/api/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ space: 'general', collection: 'edges' }),
    });
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

    const r = await readCollection(INSTANCES.a, token(), 'general', 'edges', { limit: 500, filter: { from: entFrom, to: entTo, label: encodeURIComponent(edgeLabel) } });
    assert.equal(r.status, 200);
    const edge = r.results.find(e => e._id === edgeId);
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

    const r = await readCollection(INSTANCES.a, token(), 'general', 'edges', { limit: 500, filter: { from: entFrom, to: entTo, label: encodeURIComponent(edgeLabel) } });
    assert.equal(r.status, 200);
    const edge = r.results.find(e => e._id === edgeId);
    assert.ok(edge, 'Untyped edge should appear in listing');
    assert.equal(edge.type, undefined, 'type should be absent when not set');
    assert.equal(edge.label, edgeLabel);
  });
});

// ── Memory list filtering ───────────────────────────────────────────────────

describe('Brain — memory list filtering', () => {
  const RUN = Date.now();
  let tokenA;

  // Seed 5 facts with distinct tags, and the link records that join three of them to entities
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    const seeds = [
      { _id: `filt-${RUN}-1`, fact: 'Alpha fact', tags: ['physics', 'science'], links: ['ent-x'] },
      { _id: `filt-${RUN}-2`, fact: 'Beta fact', tags: ['biology', 'science'], links: ['ent-y'] },
      { _id: `filt-${RUN}-3`, fact: 'Gamma fact', tags: ['physics'], links: ['ent-x', 'ent-y'] },
      { _id: `filt-${RUN}-4`, fact: 'Delta fact', tags: ['history'], links: [] },
      { _id: `filt-${RUN}-5`, fact: 'Epsilon fact', tags: ['biology'], links: ['ent-z'] },
    ];

    let seqBase = Date.now();
    const author = { instanceId: 'test', instanceLabel: 'Test' };
    for (const { links, ...seed } of seeds) {
      const now = new Date().toISOString();
      const r = await post(INSTANCES.a, tokenA, '/api/sync/facts?spaceId=general', {
        ...seed, spaceId: 'general', embedding: [],
        seq: seqBase++, author, createdAt: now, updatedAt: now, embeddingModel: 'none',
      });
      assert.equal(r.status, 200, `Seeding ${seed._id}: ${JSON.stringify(r.body)}`);
      /*
       * THE LINKS ARE THEIR OWN RECORDS, so they are seeded as such.
       *
       * They rode on the fact as `entityIds` until 5.0. Through the SYNC door, because these entity ids
       * are fixtures rather than records: the write doors check that a link resolves, and sync ingest is
       * validated, counted and let in — which is what lets this suite ask about the FILTER rather than
       * about reference integrity.
       */
      for (const to of links) {
        const lr = await post(INSTANCES.a, tokenA, '/api/sync/batch-upsert?spaceId=general', {
          links: [{
            _id: `link-${seed._id}-${to}`, spaceId: 'general',
            from: seed._id, fromKind: 'fact', to, toKind: 'entity',
            author, createdAt: now, updatedAt: now, seq: seqBase++,
          }],
        });
        assert.equal(lr.status, 200, `Seeding link ${seed._id}->${to}: ${JSON.stringify(lr.body)}`);
      }
    }
  });

  it('Filter by tag returns only matching memories', async () => {
    const r = await readCollection(INSTANCES.a, tokenA, 'general', 'facts', { tag: 'physics', limit: 500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.results.map(m => m._id);
    assert.ok(ids.includes(`filt-${RUN}-1`), 'Alpha (physics) should match');
    assert.ok(ids.includes(`filt-${RUN}-3`), 'Gamma (physics) should match');
    assert.ok(!ids.includes(`filt-${RUN}-2`), 'Beta (biology) should not match');
    assert.ok(!ids.includes(`filt-${RUN}-4`), 'Delta (history) should not match');
  });

  it('Tag filter is case-insensitive', async () => {
    const r = await readCollection(INSTANCES.a, tokenA, 'general', 'facts', { tag: 'PHYSICS', limit: 500 });
    assert.equal(r.status, 200);
    const ids = r.results.map(m => m._id);
    assert.ok(ids.includes(`filt-${RUN}-1`), 'Should match physics despite uppercase query');
  });

  /**
   * The facts linked to an entity — two reads, because a connection is its own record since 5.0.
   *
   * It was `filter: { entityIds: '<id>' }`, a predicate over a field the fact carried. The links
   * collection answers the same question and is indexed both ways; what changes is that the caller asks
   * it rather than the facts collection.
   */
  async function factsLinkedTo(entityId) {
    const links = await readCollection(INSTANCES.a, tokenA, 'general', 'links',
      { limit: 500, filter: { to: entityId, fromKind: 'fact' } });
    assert.equal(links.status, 200, JSON.stringify(links.body));
    return links.results.map(l => l.from);
  }

  it('Filter by entity returns only linked memories', async () => {
    const ids = await factsLinkedTo('ent-y');
    assert.ok(ids.includes(`filt-${RUN}-2`), 'Beta (ent-y) should match');
    assert.ok(ids.includes(`filt-${RUN}-3`), 'Gamma (ent-x,ent-y) should match');
    assert.ok(!ids.includes(`filt-${RUN}-1`), 'Alpha (ent-x only) should not match');
    assert.ok(!ids.includes(`filt-${RUN}-4`), 'Delta (no entities) should not match');
  });

  it('Combine tag + entity returns intersection', async () => {
    // tag=physics AND entity=ent-x → items 1 and 3. The intersection is still the SERVER's: the link ids
    // narrow `_id` and the tag narrows beside it, in one predicate.
    const linked = await factsLinkedTo('ent-x');
    const r = await readCollection(INSTANCES.a, tokenA, 'general', 'facts',
      { tag: 'physics', limit: 500, filter: { _id: { $in: linked } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.results.map(m => m._id);
    assert.ok(ids.includes(`filt-${RUN}-1`), 'Alpha (physics + ent-x) should match');
    assert.ok(ids.includes(`filt-${RUN}-3`), 'Gamma (physics + ent-x) should match');
    assert.ok(!ids.includes(`filt-${RUN}-2`), 'Beta (biology + ent-y) should not match');
  });

  it('No filter returns all (at least our 5)', async () => {
    const r = await readCollection(INSTANCES.a, tokenA, 'general', 'facts', { limit: 500 });
    assert.equal(r.status, 200);
    const ids = r.results.map(m => m._id);
    for (let i = 1; i <= 5; i++) {
      assert.ok(ids.includes(`filt-${RUN}-${i}`), `Item ${i} (filt-${RUN}-${i}) missing from ${ids.length} results`);
    }
  });

  it('Filter with no matches returns empty array', async () => {
    const r = await readCollection(INSTANCES.a, tokenA, 'general', 'facts', { tag: 'nonexistent-tag-xyz', limit: 500 });
    assert.equal(r.status, 200);
    assert.equal(r.results.length, 0, 'Should return empty array for non-matching filter');
  });
});

// â”€â”€ Memory list pagination â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Brain â€” memory list limit/skip pagination', () => {
  const RUN = Date.now();

  before(async () => {
    // Seed 8 memories to guarantee meaningful pagination
    const { post: syncPost } = await import('../sync/helpers.js');
    for (let i = 0; i < 8; i++) {
      await syncPost(INSTANCES.a, token(), '/api/sync/facts?spaceId=general', {
        _id: `paginate-${RUN}-${i}`, spaceId: 'general', fact: `Pagination seed ${RUN} item ${i}`,
        seq: Date.now() + i, embedding: [], tags: ['pagination-test'],
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
    }
  });

  it('limit=3 returns at most 3 memories', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'facts', { limit: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.results), 'memories must be array');
    assert.ok(r.results.length <= 3, `Expected â‰¤3 items, got ${r.results.length}`);
  });

  it('skip pagination returns disjoint results', async () => {
    const page1 = await readCollection(INSTANCES.a, token(), 'general', 'facts', { limit: 3, skip: 0 });
    const page2 = await readCollection(INSTANCES.a, token(), 'general', 'facts', { limit: 3, skip: 3 });
    assert.equal(page1.status, 200);
    assert.equal(page2.status, 200);
    const p1Ids = new Set(page1.results.map(m => m._id));
    for (const m of page2.results) {
      assert.ok(!p1Ids.has(m._id), `Duplicate id ${m._id} across pages`);
    }
  });

  it('a large limit is ECHOED, not silently capped', async () => {
    /*
     * THIS CASE ASSERTED THE OPPOSITE UNTIL 5.0, and the inversion is a decision rather than a fix.
     *
     * The list route clamped to 500 and said nothing: a caller asking for 9999 got 500 back with
     * `truncated` making it read as a correct short page. Owner, 2026-09-17: `cap should be a parameter
     * and default to 200`. So `limit` is a DEFAULT with no maximum, and what bounds an answer says so —
     * the byte budget hands back `nextSkip`, `maxTimeMS` bounds the duration, and a proxy space's merge
     * ceiling is an explicit 400 naming the limit.
     *
     * The value coming back UNCHANGED is what a pager needs: a `limit` echoed smaller than the one sent
     * is the silent clamp under another name.
     */
    const r = await readCollection(INSTANCES.a, token(), 'general', 'facts', { limit: 9999 });
    assert.equal(r.status, 200);
    assert.equal(r.body.limit, 9999, 'the limit must be echoed as sent, not trimmed to a hidden ceiling');
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

    await syncPost(INSTANCES.a, token(), `/api/sync/facts?spaceId=${testSpaceId}`, {
      _id: `reindex-mem-${RUN}`,
      spaceId: testSpaceId,
      fact: `Reindex memory fact ${RUN}`,
      embedding: [],
      embeddingModel: '__stale__',   // mark as stale so needsReindex triggers
      tags: ['reindex-test'],
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
      keys.some(k => ['facts', 'entities', 'edges', 'chrono', 'files', 'reindexed'].includes(k)),
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
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', { tags: ['nofact'] });
    assert.equal(r.status, 400);
  });

  it('Returns 400 if fact exceeds 50 000 characters', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: 'x'.repeat(50_001),
    });
    assert.equal(r.status, 400);
  });

  it('Returns 400 if tags contains non-string', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: 'valid fact',
      tags: [1, 2, 3],
    });
    assert.equal(r.status, 400);
  });

  it('Returns 201 at exactly 50 000 character fact', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: 'a'.repeat(50_000),
    });
    assert.equal(r.status, 201, `Boundary-value fact should be accepted: ${JSON.stringify(r.body)}`);
  });
});

// ── Bulk memory wipe ────────────────────────────────────────────────────────

describe('Brain — bulk memory wipe', () => {
  const RUN = Date.now();
  // Dedicated space (not `general`): these tests WIPE the whole space, so pointing them at the shared
  // `general` would delete other files' data — a real cross-file bleed and a hard blocker for running
  // the suite in parallel (Q4). Namespaced per run and torn down in `after`.
  const WIPE_SPACE = `wipe-${RUN}`;
  let seededIds;
  let seqBefore;
  /*
   * ITS OWN TOKEN, and the reason is a real rail rather than a test convenience.
   *
   * Emptying a space is throttled to five calls a minute PER TOKEN, on both doors, and the throttle counts
   * calls that reach the handler — a refusal for a missing `confirm` still reaches it, because that is
   * where the requirement lives. This describe makes six such calls, and the one above it makes two more
   * against `general`, so sharing the instance token spent one caller's budget across unrelated cases and
   * the last wipe got a 429.
   *
   * Raising the limit to fit the suite would loosen a rail to make a test pass. A token per caller is what
   * an operator is told to do anyway (`06-connecting-an-ai-assistant.md`), so the suite does it too.
   */
  let wipeToken;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // With the SPACE-ADMIN grant, because that is what emptying a space needs since 5.0 and a default mint
    // gets `write` everywhere and administers nothing. The floor form rather than a named list: the space
    // does not exist yet at this point, and a grant naming spaces is checked against the ones that do.
    const minted = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `bulk-wipe-${RUN}`,
      rights: {
        instanceAdmin: false, createSpaces: false,
        floor: { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' },
        perSpace: {}, spaceAdmin: { floor: true, spaces: [] },
      },
    });
    assert.equal(minted.status, 201, `minting the wipe token: ${JSON.stringify(minted.body)}`);
    wipeToken = minted.body.plaintext;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: WIPE_SPACE, label: 'Bulk Wipe Test' });

    // Seed 10 memories for the wipe test
    seededIds = [];
    let seqBase = Date.now();
    for (let i = 0; i < 10; i++) {
      const id = `wipe-${RUN}-${i}`;
      seededIds.push(id);
      const r = await post(INSTANCES.a, tokenA, `/api/sync/facts?spaceId=${WIPE_SPACE}`, {
        _id: id, spaceId: WIPE_SPACE, fact: `Wipe test memory ${i}`,
        tags: ['wipe-test'], embedding: [],
        seq: seqBase++, author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
      assert.equal(r.status, 200, `Seed wipe-${i}: ${JSON.stringify(r.body)}`);
    }

    // Create one more memory via brain API to capture the current seq counter
    const marker = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${WIPE_SPACE}/facts`, {
      fact: 'Seq marker for wipe test', tags: ['wipe-marker'],
    });
    assert.equal(marker.status, 201);
    seqBefore = marker.body.seq;

    // Verify they exist
    const list = await readCollection(INSTANCES.a, tokenA, WIPE_SPACE, 'facts', { limit: 500 });
    for (const id of seededIds) {
      assert.ok(list.results.some(m => m._id === id), `Seeded ${id} should exist`);
    }
  });

  it('without confirm it returns 400', async () => {
    const r = await post(INSTANCES.a, wipeToken, '/api/delete_space_data', { space: WIPE_SPACE, types: ['facts'] });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('with confirm:false it returns 400', async () => {
    const r = await post(INSTANCES.a, wipeToken, '/api/delete_space_data', { space: WIPE_SPACE, types: ['facts'], confirm: false });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('with confirm:true it returns the per-collection counts', async () => {
    // One envelope for every tool: `{ok, text, data}`. `data` is the structured result, `text` the prose
    // an agent reads — both carry the whole answer, so a caller may use either.
    const r = await post(INSTANCES.a, wipeToken, '/api/delete_space_data', { space: WIPE_SPACE, types: ['facts'], confirm: true });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    assert.ok(typeof r.body.data.facts === 'number', 'facts must be a number');
    assert.ok(r.body.data.facts >= 10, `Should have deleted at least 10, got ${r.body.data.facts}`);
  });

  it('Memories are gone after wipe', async () => {
    const list = await readCollection(INSTANCES.a, tokenA, WIPE_SPACE, 'facts', { limit: 500 });
    assert.equal(list.status, 200);
    for (const id of seededIds) {
      const found = list.results.some(m => m._id === id);
      assert.ok(!found, `Wiped memory ${id} should be gone`);
    }
  });

  it('a space wipe writes NO tombstones, and the reason is the vote', async () => {
    /*
     * INVERTED AT 5.0, and the inversion is the point rather than a relaxation.
     *
     * The five per-collection `DELETE` routes wrote a tombstone per record, because a peer holding the
     * record had to be told it was gone — without them the next sync cycle offers every record back and
     * the wipe silently undoes itself.
     *
     * Emptying a space is one tool call now, and `wipeSpace` writes none: on a space belonging to a
     * network it opens a governed round instead, every member wipes, and there is nothing for a peer to
     * offer back. On a space in no network there is no peer to tell. `wiping-a-networked-space-votes`
     * holds up the half this cannot see from here.
     *
     * Asserted rather than dropped, because "no tombstones" is indistinguishable from "the tombstone code
     * broke" unless somebody wrote down which one is intended.
     */
    const r = await get(INSTANCES.a, tokenA, `/api/sync/tombstones?spaceId=${WIPE_SPACE}&sinceSeq=${seqBefore}&limit=5000`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const written = (r.body.facts ?? []).filter(t => seededIds.includes(t._id));
    assert.deepEqual(written, [],
      `the wipe wrote ${written.length} tombstone(s). If that is deliberate, the networked-space vote is `
      + 'now redundant and should go with it — the two are alternatives, not layers.');
  });

  it('a second wipe on the same space works, and the seeded records go', async () => {
    // Titled after `DELETE /api/brain/spaces/:spaceId/facts` until 5.0 — a test named for a route that no
    // longer exists is one nobody can find when it fails. What it checks is unchanged: seed, wipe, count.
    // Seed a couple of facts first
    let seqBase = Date.now();
    for (let i = 0; i < 3; i++) {
      await post(INSTANCES.a, tokenA, `/api/sync/facts?spaceId=${WIPE_SPACE}`, {
        _id: `wipe-long-${RUN}-${i}`, spaceId: WIPE_SPACE, fact: `Long-form wipe ${i}`,
        tags: ['wipe-long'], embedding: [],
        seq: seqBase++, author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
    }

    const r = await post(INSTANCES.a, wipeToken, '/api/delete_space_data', { space: WIPE_SPACE, types: ['facts'], confirm: true });
    assert.equal(r.status, 200, `wipe: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.data.facts === 'number');
    assert.ok(r.body.data.facts >= 3, `Should have deleted at least 3, got ${r.body.data.facts}`);
  });

  it('Wipe on unknown space returns 404', async () => {
    const r = await post(INSTANCES.a, wipeToken, '/api/delete_space_data', { space: 'no-such-space', confirm: true });
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('and a LIST of spaces is refused, in the same words as the MCP door', async () => {
    // `delete_space_data` does not declare `spaceList`, so a list is a refusal rather than a loop. The
    // wording is the shared module's, which is why it can be asserted identically on both doors.
    const r = await post(INSTANCES.a, wipeToken, '/api/delete_space_data', { space: [WIPE_SPACE, 'general'], confirm: true });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /takes one 'space', not a list/);
  });

  after(async () => {
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${WIPE_SPACE}`, { confirm: true }).catch(() => {});
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
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.results), 'chrono must be an array');
    const found = r.results.find(c => c._id === chronoId);
    assert.ok(found, 'created entry should appear in listing');
  });

  it('List chrono returns 404 for unknown space', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'no-such-space', 'chrono');
    assert.equal(r.status, 404);
  });

  it('List chrono returns 401 without auth', async () => {
    // Through `filter`, because the per-collection route is gone. What has to stay true is that a read
    // with no credentials is refused before anything is read — not that one PATH refuses it.
    const r = await fetch(`${INSTANCES.a}/api/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ space: 'general', collection: 'chrono' }),
    });
    assert.equal(r.status, 401);
  });

  it('Update chrono entry via PATCH returns 200', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      status: 'completed',
      description: 'All done',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'completed');
    assert.equal(r.body.description, 'All done');
  });

  it('Update non-existent chrono entry returns 404', async () => {
    // PATCH, not POST. This asserted 404 through the legacy verb, which still answers 404 now that the
    // route is gone — for a different reason, so it would have kept passing while testing nothing.
    const r = await patch(INSTANCES.a, token(), '/api/brain/spaces/general/chrono/does-not-exist', {
      status: 'completed',
    });
    assert.equal(r.status, 404);
  });

  // The source-level gate proves the field is FORWARDED. These prove it LANDS — the previous version of
  // this feature was consistent in the source of three route files and unreachable on the fourth, and the
  // report that found it came from reading code, not from a response. Assert on the stored record.
  it('PATCH chrono with the RETIRED spelling is refused, not silently accepted', async () => {
    /*
     * Four cases stood here while `excludeFromVectorSearch` was an input alias: that it was accepted
     * alone, that it could be cleared alone, that writing the current name also wrote the old one, and
     * that the current name won when a body carried both.
     *
     * `D-6` removed it in 4.0, so all four describe a name that no longer exists. They collapse to the
     * one thing worth asserting from outside: a caller sending it gets a REFUSAL. Accepted-and-dropped
     * would be the bad outcome — a 200 for a field nothing applies — and that is what this rules out.
     */
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      excludeFromVectorSearch: true,
    });
    assert.equal(r.status, 400, `the retired spelling must be refused: ${JSON.stringify(r.body)}`);

    // And nothing was written. A refusal that still mutated is the worst of both.
    const back = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(back.body.excludeFromVectorSearch, undefined,
      'a refused field must not reach the stored record');
  });

  it('PATCH chrono with suppressEmbeddings persists it, and only it', async () => {
    /*
     * The source-level gate proves the field is FORWARDED. This proves it LANDS — the previous version of
     * this feature was consistent in three route files and unreachable in the fourth, and the report that
     * found it came from reading code rather than from a response.
     *
     * The second assertion is new: the write must NOT also carry the retired spelling. It did until 4.0,
     * deliberately, so an older peer rewriting the record kept a flag it understood.
     */
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      suppressEmbeddings: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const back = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(back.body.suppressEmbeddings, true, 'the STORED record must carry the name');
    assert.equal(back.body.excludeFromVectorSearch, undefined,
      'the retired spelling is still being written alongside');
  });

  it('and clearing it stores false rather than treating it as absent', async () => {
    // `false` is a real stored value at this tier: `recordSuppression` reports it as "not stated" so the
    // schema and space tiers decide, which is a different thing from the field being missing.
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      suppressEmbeddings: false,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const back = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(back.body.suppressEmbeddings, false, 'false must be stored, not dropped');
  });
  it('PATCH chrono rejects a non-boolean suppressEmbeddings', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      suppressEmbeddings: 'true',
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('PATCH chrono naming no recognised field returns 400, not a 200 no-op', async () => {
    // It answered 200 with an unchanged record, so a client could not tell a dropped field from an applied
    // one — which is how the missing flag above stayed invisible for a release.
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      notAFieldWeKnow: 1,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /At least one field must be provided/);
  });

  it('POST-as-update is a 404 in 3.0, and writes nothing', async () => {
    // This case used to assert the legacy route REFUSED `excludeFromVectorSearch` with a 400 naming PATCH —
    // it ran no property validation and wrote no audit snapshot, so it was deliberately not getting new
    // capability. 3.0 removed the route, so the refusal went with it and the answer is 404.
    //
    // The "writes nothing" half is kept and matters more than before: a 404 that still mutated would be
    // the worst of both, and the positive path is covered by the PATCH case directly above.
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      suppressEmbeddings: true,
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    const back = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(back.body.suppressEmbeddings, false, 'a removed route must not have written');
  });

  it('Create chrono with optional fields', async () => {
    // Real ids: linkage is validated now, and a placeholder only ever proved that an unchecked
    // string survives a round-trip.
    const linkedEnt = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      name: `ChronoLink-${RUN}`, type: 'concept',
    });
    assert.equal(linkedEnt.status, 201, JSON.stringify(linkedEnt.body));
    const linkedMem = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `chrono link target ${RUN}`,
    });
    assert.equal(linkedMem.status, 201, JSON.stringify(linkedMem.body));

    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/chrono', {
      title: `Deadline-${RUN}`,
      type: 'deadline',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 86400_000).toISOString(),
      status: 'upcoming',
      confidence: 0.8,
      tags: ['important'],
      /*
       * `linkEntities`/`linkFacts`, NOT the array fields, and that is `Q-26` rather than a preference.
       *
       * `general` was converted by the boot conversion, and a converted space answered 400 for
       * `entityIds`/`memoryIds`. This case asserted 201 and passed only while the stack had not restarted
       * since `general` was created, so it failed with an error naming a migration it has nothing to do
       * with. 5.0 removed the arrays outright, so the `link*` spelling is the only one there is.
       */
      linkEntities: [linkedEnt.body._id],
      linkFacts: [linkedMem.body._id],
      description: 'Submit report',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.type, 'deadline');
    assert.equal(r.body.confidence, 0.8);
    assert.ok(r.body.endsAt, 'endsAt should be set');
    /*
     * The link is asserted through a READER, not through the echoed arrays.
     *
     * Those two arrays are populated only on a space still read through the array shape; on a converted
     * one the link lives as a record and they stay empty. Asserting the echo therefore asserts which
     * side of the migration this space happens to be on, which is not what this case is about. The walk
     * reads whichever shape the space stores, so it answers the question that was meant.
     */
    const reach = await post(INSTANCES.a, token(), '/api/brain/spaces/general/traverse',
      { startId: linkedEnt.body._id, maxDepth: 1, includeChrono: true });
    assert.equal(reach.status, 200, JSON.stringify(reach.body));
    assert.ok((reach.body.nodes ?? []).some(n => n._id === r.body._id),
      `the chrono entry must be reachable from the entity it named: ${JSON.stringify(reach.body.nodes)}`);
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
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono', { filter: { tags: { $all: [tagA] } } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.results), 'chrono must be an array');
    const resultIds = r.results.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), `Entry with tag ${tagA} should be in results`);
    assert.ok(resultIds.includes(ids[2]), `Entry with both tags should be in results`);
    assert.ok(!resultIds.includes(ids[1]), `Entry with only ${tagB} should NOT be in results`);
  });

  it('Filter by multiple tags (AND) returns only entries with all specified tags', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono',
      { filter: { tags: { $all: [tagA, tagB] } } });
    assert.equal(r.status, 200);
    const resultIds = r.results.map(c => c._id);
    assert.ok(resultIds.includes(ids[2]), `Entry with both tags should be in results`);
    assert.ok(!resultIds.includes(ids[0]), `Entry with only ${tagA} should NOT appear for AND query`);
    assert.ok(!resultIds.includes(ids[1]), `Entry with only ${tagB} should NOT appear for AND query`);
  });

  it('tagsAny filter (OR) returns entries matching any of the tags', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono',
      { filter: { tags: { $in: [tagA, tagB] } } });
    assert.equal(r.status, 200);
    const resultIds = r.results.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), `Entry with tag ${tagA} should be in results`);
    assert.ok(resultIds.includes(ids[1]), `Entry with tag ${tagB} should be in results`);
    assert.ok(resultIds.includes(ids[2]), `Entry with both tags should be in results`);
    assert.ok(!resultIds.includes(ids[3]), `Entry with no tags should NOT be in results`);
  });

  it('Filter by non-existent tag returns empty array', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono',
      { filter: { tags: { $all: [`no-such-tag-${RUN}`] } } });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.results, []);
  });

  it('after filter returns only entries created after the timestamp', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono',
      { filter: { createdAt: { $gt: pastTime } } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.results), 'chrono must be an array');
    // Seeded entries were created after pastTime, so at least our seeded entries should appear
    const resultIds = r.results.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), 'Seeded entry should appear when after < createdAt');
  });

  it('before filter returns only entries created before the timestamp', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono',
      { filter: { createdAt: { $lt: futureTime } } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.results), 'chrono must be an array');
    const resultIds = r.results.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), 'Seeded entry should appear when before > createdAt');
  });

  it('after filter in the far future returns empty array', async () => {
    const farFuture = new Date(Date.now() + 86_400_000 * 365).toISOString();
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono',
      { filter: { createdAt: { $gt: farFuture } } });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.results, []);
  });

  it('search filter matches on title', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono', { search: `TagA-${RUN}` });
    assert.equal(r.status, 200);
    const resultIds = r.results.map(c => c._id);
    assert.ok(resultIds.includes(ids[0]), 'Entry with matching title should appear');
    assert.ok(!resultIds.includes(ids[1]), 'Entry with non-matching title should not appear');
  });

  it('search filter matches on description (case-insensitive)', async () => {
    const r = await readCollection(INSTANCES.a, token(), 'general', 'chrono', { search: 'FIND-THIS-SPECIAL' });
    assert.equal(r.status, 200);
    const resultIds = r.results.map(c => c._id);
    assert.ok(resultIds.includes(ids[4]), 'Entry with matching description should appear');
  });
});

// ── Memory description + properties fields ─────────────────────────────────

describe('Brain — memory description and properties fields', () => {
  const RUN = Date.now();

  it('POST /facts with description and properties stores both fields', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
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
    const write = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `DescPropRetrieve-${RUN}`,
      description: 'Retrievable description',
      properties: { key: 'val' },
    });
    assert.equal(write.status, 201);
    const memId = write.body._id;

    const r = await readRecord(INSTANCES.a, token(), 'general', 'facts', memId);
    assert.equal(r.status, 200);
    assert.equal(r.body.description, 'Retrievable description');
    assert.deepStrictEqual(r.body.properties, { key: 'val' });
  });

  it('memory without description/properties works (optional fields)', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `NoDescProp-${RUN}`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.description, undefined);
    assert.equal(r.body.properties, undefined);
  });

  /*
   * These two used to be titled *"is ignored (coerced away)"* and accepted `201 || 400`, which is what let
   * them keep passing through `W-21` while documenting the behaviour that row exists to end.
   *
   * A create SILENTLY DISCARDED a malformed optional scalar where its own PATCH answered 400 — three fields
   * dropped from one body, `201` returned, and nothing said so: the `warnings` array reports UNKNOWN keys
   * only, never malformed known ones. So the caller's record was missing what they sent and their client
   * had no way to find out.
   *
   * A test that accepts either answer cannot tell the two apart, which is why the assertion is now exact.
   */
  it('a non-string description is REFUSED, not dropped', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `BadDesc-${RUN}`,
      description: 12345,
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a non-object properties bag is REFUSED, not dropped', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `BadProps-${RUN}`,
      properties: 'not-an-object',
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
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
    const r = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.properties, { phase: 'alpha', priority: 1, critical: true });
  });

  it('Update chrono can set properties', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      properties: { phase: 'beta', priority: 2, critical: false },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.properties, { phase: 'beta', priority: 2, critical: false });

    const get2 = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(get2.status, 200);
    assert.deepStrictEqual(get2.body.properties, { phase: 'beta', priority: 2, critical: false },
      'updated properties persisted to DB');
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
      facts: [{ fact: `Bulk memory ${RUN}`, tags: ['bulk-test'] }],
      entities: [{ name: `BulkEnt-${RUN}`, type: 'concept', tags: ['bulk-test'] }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.ok(typeof r.body.inserted === 'object', 'inserted must be an object');
    assert.ok(typeof r.body.updated === 'object', 'updated must be an object');
    assert.ok(Array.isArray(r.body.errors), 'errors must be an array');
    assert.equal(r.body.inserted.facts, 1, 'memory should be inserted');
    assert.equal(r.body.inserted.entities, 1, 'entity should be inserted');
    assert.equal(r.body.errors.length, 0, `Unexpected errors: ${JSON.stringify(r.body.errors)}`);
  });

  it('Second call for same entity counts as updated', async () => {
    const name = `BulkUpsert-${RUN}`;
    const first = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      entities: [{ name, type: 'concept' }],
    });
    // Retrieve the created entity's id
    const listR = await readCollection(INSTANCES.a, token(), 'general', 'entities', { filter: { name: encodeURIComponent(name) } });
    const createdId = listR.results.find(e => e.name === name)?._id;
    assert.ok(createdId, 'entity must exist after first bulk call');
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      entities: [{ id: createdId, name, type: 'concept', description: 'updated' }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.updated.entities, 1, 'second upsert should be counted as updated');
    assert.equal(r.body.inserted.entities, 0);
  });

  it('Processes edges referencing entities from an EARLIER call, by their minted ids', async () => {
    /*
     * Two calls, and the title used to say one batch — which this case has never done. A bulk payload
     * CANNOT reference a record it creates: a supplied id addresses an existing record and never becomes a
     * new one's identity, so the ids have to be read back before the edges are sent. That is exactly what
     * happens below, and the old title was the only thing claiming otherwise (W-12).
     */
    const entityName = `BulkEdgeEnt-${RUN}`;
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {
      entities: [{ name: `${entityName}-A`, type: 'concept' }, { name: `${entityName}-B`, type: 'concept' }],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.entities, 2, JSON.stringify(r.body));

    // Get the entity IDs
    const listR = await readCollection(INSTANCES.a, token(), 'general', 'entities',
      { filter: { name: `${entityName}-A` } });
    const entA = listR.results?.[0];
    const listRB = await readCollection(INSTANCES.a, token(), 'general', 'entities',
      { filter: { name: `${entityName}-B` } });
    const entB = listRB.results?.[0];
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
      facts: [
        { fact: `Valid bulk memory ${RUN} A` },
        { tags: ['no-fact'] },          // missing fact → error
        { fact: `Valid bulk memory ${RUN} B` },
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.facts, 2, 'two valid memories should be inserted');
    assert.equal(r.body.errors.length, 1, 'one error expected');
    assert.equal(r.body.errors[0].type, 'fact');
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
      facts: [], entities: [], edges: [], chrono: [],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.facts, 0);
    assert.equal(r.body.inserted.entities, 0);
    assert.equal(r.body.inserted.edges, 0);
    assert.equal(r.body.inserted.chrono, 0);
    assert.equal(r.body.errors.length, 0);
  });

  it('Empty body (all arrays omitted) is a no-op', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/bulk', {});
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.facts + r.body.inserted.entities + r.body.inserted.edges + r.body.inserted.chrono, 0);
  });

  it('Returns 404 for unknown space', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/no-such-space/bulk', {
      facts: [{ fact: 'test' }],
    });
    assert.equal(r.status, 404);
  });

  it('Returns 401 without auth', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts: [{ fact: 'test' }] }),
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
    assert.ok(!nodeIds.includes(entC), 'C must not appear at depth 1');
    /*
     * The start node IS in the results now, at depth 0 — `Q-27` made `graph_traverse`'s own schema
     * true. This case asserted its absence and that every node was at depth 1; both are inverted
     * rather than dropped, because the depth is what tells the start from a neighbour and something
     * has to hold that.
     */
    assert.equal(r.body.nodes.find(n => n._id === entA)?.depth, 0, 'the start node is at depth 0');
    for (const n of r.body.nodes) {
      const expected = n._id === entA ? 0 : 1;
      assert.equal(n.depth, expected, `Node ${n._id} must have depth=${expected}`);
    }
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

  it('direction=both returns neighbours in either direction, and the start node at depth 0', async () => {
    /*
     * This case asserted that the start node NEVER appears, which was the behaviour until 5.0 and was
     * the opposite of what `graph_traverse`'s own schema had always described: *"`startId` itself at
     * depth 0, so a walk that finds nothing still comes back with one node rather than empty."*
     * `Q-27` made the description true, so the assertion is inverted rather than deleted — the start
     * node is now part of the contract and something has to hold it.
     */
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
    // And B itself, at depth 0 — an empty `nodes` now means the id resolved to nothing.
    const start = r.body.nodes.find(n => n._id === entB);
    assert.ok(start, 'the start node must be in the results');
    assert.equal(start.depth, 0, 'and at depth 0, which is what distinguishes it from a neighbour');
    // The neighbours keep the depth they had: the start is ADDED, never substituted.
    assert.equal(r.body.nodes.find(n => n._id === entA)?.depth, 1);
  });
});


// ── Brain — structured query endpoint ───────────────────────────────────────

describe('Brain — POST /spaces/:spaceId/query', () => {
  const RUN = Date.now();
  let seededId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // Seed a memory with a distinctive tag and fact for query tests
    const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: `QueryTest-${RUN} authentication service bootstrap`,
      tags: [`qtest-${RUN}`, 'auth'],
    });
    assert.equal(r.status, 201, `Seeding query test fact: ${JSON.stringify(r.body)}`);
    seededId = r.body._id;
  });

  after(async () => {
    if (seededId) {
      await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${seededId}`).catch(() => {});
    }
  });

  it('Returns 200 with results array and count for basic query', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: {},
      limit: 5,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.results), 'results must be an array');
    assert.equal(typeof r.body.count, 'number', 'count must be a number');
    assert.equal(r.body.collection, 'facts', 'collection echoed back');
  });

  it('Returns seeded memory when filtering by exact tag', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { tags: { $in: [`qtest-${RUN}`] } },
      limit: 10,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.results.map(d => d._id);
    assert.ok(ids.includes(seededId), `Seeded memory ${seededId} should appear in $in filter results`);
  });

  it('Supports $regex filter for partial text match on fact', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { fact: { $regex: `QueryTest-${RUN}`, $options: 'i' } },
      limit: 10,
    }) });
    assert.equal(r.status, 200, `$regex query should succeed: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(d => d._id);
    assert.ok(ids.includes(seededId), `$regex match should include seeded memory ${seededId}`);
  });

  it('$regex with case-insensitive flag matches uppercase version', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { fact: { $regex: `QUERYTEST-${RUN}`, $options: 'i' } },
      limit: 10,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.results.map(d => d._id);
    assert.ok(ids.includes(seededId), 'Case-insensitive $regex should match seeded memory');
  });

  it('Rejects disallowed operator $where with 400', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { $where: 'function() { return true; }' },
    }) });
    assert.equal(r.status, 400, `$where must be rejected with 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error, 'error message expected');
  });

  it('Rejects $options without $regex with 400', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { fact: { $options: 'i' } },
    }) });
    assert.equal(r.status, 400, `$options without $regex must be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error.includes('$regex'), 'Error should mention $regex requirement');
  });

  it('Rejects $options with invalid flags with 400', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { fact: { $regex: 'test', $options: 'ig' } },
    }) });
    assert.equal(r.status, 400, `$options with invalid flags must be rejected, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error.includes('valid regex flags'), 'Error should mention valid flags');
  });

  it('Rejects unknown collection with 400', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'unknown_collection',
      filter: {},
    }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error, 'error message expected');
  });

  it('Returns 404 for unknown space', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'no-such-space', ...({
      collection: 'facts',
      filter: {},
    }) });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('Returns 401 without auth token', async () => {
    const r = await fetch(`${INSTANCES.a}/api/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ space: 'general', collection: 'facts', filter: {} }),
    });
    assert.equal(r.status, 401, 'Query endpoint must require authentication');
  });

  it('Embedding field is excluded from query results', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { _id: seededId },
      limit: 1,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.results.length > 0, 'Expected at least one result');
    assert.ok(!('embedding' in r.body.results[0]), 'embedding field must be excluded from results');
  });

  it('projection include-mode returns only the named fields (+ _id, never embedding)', async () => {
    // S8.2: exercise the real projection path end-to-end (only mergeEmbeddingExclusion
    // was unit-tested before). Include-mode {fact:1} → fact present, tags/createdAt absent.
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { _id: seededId },
      projection: { fact: 1 },
      limit: 1,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.results.length > 0, 'expected the seeded memory');
    const doc = r.body.results[0];
    assert.ok('fact' in doc, 'included field "fact" must be present');
    assert.equal(doc._id, seededId, '_id is included by default in include-mode');
    assert.ok(!('tags' in doc), 'non-included field "tags" must be absent under include projection');
    assert.ok(!('createdAt' in doc), 'non-included field "createdAt" must be absent under include projection');
    assert.ok(!('embedding' in doc), 'embedding must never be returned');
  });

  it('projection exclude-mode drops the named field but keeps the rest (never embedding)', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: { _id: seededId },
      projection: { tags: 0 },
      limit: 1,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const doc = r.body.results[0];
    assert.ok(!('tags' in doc), 'excluded field "tags" must be absent under exclude projection');
    assert.ok('fact' in doc, 'non-excluded field "fact" must remain');
    assert.ok(!('embedding' in doc), 'embedding must never be returned even in exclude-mode');
  });

  it('Respects limit parameter', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'facts',
      filter: {},
      limit: 2,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.results.length <= 2, `Results must not exceed limit of 2, got ${r.body.results.length}`);
  });

  it('Query across entities collection works', async () => {
    const r = await filterRest(INSTANCES.a, tokenA, { space: 'general', ...({
      collection: 'entities',
      filter: {},
      limit: 5,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.results), 'entities results must be an array');
  });
});

// ── PATCH /facts/:id — description and properties update ─────────────────

describe('Brain — PATCH memory updates description and properties', () => {
  const RUN = Date.now();
  let memId;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `PatchMemFact-${RUN}`,
      tags: ['patch-test'],
      description: 'Initial description',
      properties: { source: 'original', confidence: 0.5 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    memId = r.body._id;
  });

  it('PATCH memory updates description field', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`, {
      description: 'Updated description',
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.description, 'Updated description', 'description must be updated');

    const get2 = await readRecord(INSTANCES.a, token(), 'general', 'facts', memId);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.description, 'Updated description', 'description persisted to DB');
  });

  it('PATCH memory updates properties field', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`, {
      properties: { source: 'patched', extra: 'yes' },
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.properties?.source, 'patched', 'source property updated');

    const get2 = await readRecord(INSTANCES.a, token(), 'general', 'facts', memId);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.properties?.source, 'patched', 'properties persisted to DB');
    assert.equal(get2.body.properties?.extra, 'yes', 'new property persisted');
  });

  it('PATCH memory updates fact field', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`, {
      fact: `PatchMemFact-updated-${RUN}`,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fact, `PatchMemFact-updated-${RUN}`);

    const get2 = await readRecord(INSTANCES.a, token(), 'general', 'facts', memId);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.fact, `PatchMemFact-updated-${RUN}`, 'fact persisted to DB');
  });

  it('PATCH memory with no fields returns 400', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`, {});
    assert.equal(r.status, 400, `Expected 400 for empty body`);
  });

  it('PATCH memory with unknown ID returns 404', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/facts/nonexistent-id-${RUN}`, {
      description: 'should not matter',
    });
    assert.equal(r.status, 404, `Expected 404 for unknown ID`);
  });

  after(async () => {
    if (memId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`).catch(() => {});
  });
});

// ── PATCH /spaces/:spaceId/facts/:id — long-form path ──────────────────

describe('Brain — PATCH memory long-form path persists description and properties', () => {
  const RUN = Date.now();
  let memId;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `PatchMemLong-${RUN}`,
      description: 'Initial',
      properties: { v: 1 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    memId = r.body._id;
  });

  it('PATCH long-form updates description and properties', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`, {
      description: 'Long-form updated',
      properties: { v: 2 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.description, 'Long-form updated');
    assert.equal(r.body.properties?.v, 2);

    const get2 = await readRecord(INSTANCES.a, token(), 'general', 'facts', memId);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.description, 'Long-form updated', 'description persisted to DB');
    assert.deepEqual(get2.body.properties, { v: 2 }, 'properties persisted to DB');
  });

  after(async () => {
    if (memId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${memId}`).catch(() => {});
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

    const getR = await readRecord(INSTANCES.a, token(), 'general', 'entities', entId);
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

    const getR = await readRecord(INSTANCES.a, token(), 'general', 'edges', edgeId);
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

    const get2 = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.description, 'Updated chrono description', 'description persisted to DB');
  });

  it('PATCH chrono updates properties by ID', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${chronoId}`, {
      properties: { phase: 'beta' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.properties?.phase, 'beta', 'property updated');

    const get2 = await readRecord(INSTANCES.a, token(), 'general', 'chrono', chronoId);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.properties?.phase, 'beta', 'updated property persisted to DB');
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

// ── A supplied id does NOT become a new record's identity ────────────────────────

/**
 * Reversed by the owner's 2026-08-12 ruling: "id is id". This block used to assert the opposite — that a
 * supplied UUID became the created entity's `_id` — which was the documented idempotency contract.
 *
 * It is rewritten rather than deleted. The behaviour it covers still needs a database to observe, and deleting
 * it would leave the new rule checked only by a source-reading gate: nothing would prove the SERVER honours it.
 */
describe('Brain — a supplied id does not become a new entity id', () => {
  const RUN = Date.now();
  const unusedUuid = `550e8400-e29b-41d4-a716-${String(RUN).padStart(12, '0').slice(0, 12)}`;
  const createdIds = [];

  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    for (const id of createdIds) {
      await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${id}`).catch(() => {});
    }
  });

  it('a create with an id that names nothing IGNORES it and mints a fresh one', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: unusedUuid,
      name: `IgnoredId-${RUN}`,
      type: 'concept',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notEqual(r.body._id, unusedUuid,
      'a supplied id must not become the identity — that made the caller a co-author of the primary key');
    assert.match(r.body._id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'the server must have minted a UUID v4 of its own');
    createdIds.push(r.body._id);
  });

  it('the ignored id addresses nothing afterwards', async () => {
    // The other half: if the id had been quietly adopted anyway, this would return the record.
    const r = await readRecord(INSTANCES.a, token(), 'general', 'entities', unusedUuid);
    assert.equal(r.status, 404, `expected the supplied id to name nothing, got ${r.status}`);
  });

  it('a create with the SAME unused id again produces a SECOND record', async () => {
    // This is the cost of the ruling, asserted rather than described: retry-by-reused-id no longer converges.
    // A caller relying on it duplicates, which is why `checkDuplicates` returning `similar` is the replacement.
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: unusedUuid,
      name: `IgnoredIdTwice-${RUN}`,
      type: 'concept',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notEqual(r.body._id, createdIds[0], 'the second create must be its own record');
    createdIds.push(r.body._id);
  });

  it('but an id that DOES name a record still updates it', async () => {
    // The half that must survive: an id addresses an existing record. Losing this would make every update a
    // create, which is a far worse bug than the one the ruling removes.
    const existing = createdIds[0];
    const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', {
      id: existing,
      name: `IgnoredId-${RUN}-renamed`,
      type: 'concept',
    });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
    assert.equal(r.body._id, existing, 'an id naming a real record must land on that record');
  });
});

// ── Entities by-name endpoint ────────────────────────────────────────────────

describe('Brain — entities by name, through the filter that replaced the route', () => {
  /*
   * `GET /spaces/:spaceId/entities/by-name` was removed at 5.0 with its `find_entities_by_name` tool. It ran
   * `find({spaceId, name})` and nothing else, which is `POST /api/filter` with a collection — and a
   * second route for one predicate drifts from the thing it duplicates.
   *
   * The CASES survive the route because they are about the capability: an exact name matches every record
   * carrying it whatever its type, a name nobody used is an empty result rather than an error, and a space
   * that does not exist is refused. One case went WITH the route — `name` was a required query parameter,
   * and a filter has no such thing as a missing predicate: `{}` is legal and matches everything, which is a
   * different question with a different right answer.
   */
  const RUN = Date.now();
  const entityName = `ByNameTest-${RUN}`;
  const createdIds = [];

  const byName = (space, name) => filterRest(INSTANCES.a, token(), {
    space, collection: 'entities', filter: { name },
  });

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // TWO types, one name: the point of the lookup is that it does not constrain the type.
    for (const type of ['person', 'character']) {
      const r = await post(INSTANCES.a, token(), '/api/brain/spaces/general/entities', { name: entityName, type });
      assert.equal(r.status, 201);
      createdIds.push(r.body._id);
    }
  });

  after(async () => {
    for (const id of createdIds) {
      await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${id}`).catch(() => {});
    }
  });

  it('Returns entities matching the name', async () => {
    const r = await byName('general', entityName);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.results), 'the filter answers with a results array');
    assert.ok(r.body.results.length >= 2,
      `both types must come back, got ${r.body.results.length}: ${JSON.stringify(r.body).slice(0, 200)}`);
    for (const ent of r.body.results) assert.equal(ent.name, entityName);
  });

  it('Returns empty array for non-existent name', async () => {
    const r = await byName('general', `no-such-entity-${RUN}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, [], 'an unmatched predicate is an empty result, not an error');
  });

  it('Returns 404 for non-existent space', async () => {
    const r = await byName(`no-such-space-${RUN}`, entityName);
    assert.equal(r.status, 404);
  });
});
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
      rights: legacyRights({ readOnly: true })
    });
    assert.equal(tokenRes.status, 201, `Create read-only token: ${JSON.stringify(tokenRes.body)}`);
    readOnlyToken = tokenRes.body.plaintext;
    readOnlyTokenId = tokenRes.body.id;

    // Seed test objects using the admin token for later PATCH/DELETE tests
    const memR = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
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
    if (testMemId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/facts/${testMemId}`).catch(() => {});
    if (testEntId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${testEntId}`).catch(() => {});
    if (helperEntId2) await del(INSTANCES.a, token(), `/api/brain/spaces/general/entities/${helperEntId2}`).catch(() => {});
    if (testEdgeId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/edges/${testEdgeId}`).catch(() => {});
    if (testChronoId) await del(INSTANCES.a, token(), `/api/brain/spaces/general/chrono/${testChronoId}`).catch(() => {});
  });

  it('POST /facts blocked with read-only token (403)', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/brain/spaces/general/facts', {
      fact: 'Should be blocked',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  });

  it('PATCH /facts/:id blocked with read-only token (403)', async () => {
    const r = await patch(INSTANCES.a, readOnlyToken, `/api/brain/spaces/general/facts/${testMemId}`, {
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
      facts: [{ fact: 'Blocked' }],
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
    const r = await filterRest(INSTANCES.a, readOnlyToken, { space: 'general', ...({
      collection: 'facts',
      filter: {},
      limit: 1,
    }) });
    assert.equal(r.status, 200, `Query is read-only — should be allowed, got ${r.status}`);
  });

  it('GET /facts allowed with read-only token', async () => {
    const r = await readCollection(INSTANCES.a, readOnlyToken, 'general', 'facts', { limit: 1 });
    assert.equal(r.status, 200, `GET memories should be allowed, got ${r.status}`);
  });

  // Regression: the conflict-resolution routes were missing `denyReadOnly`, so a read-only
  // token could resolve a conflict (which REWRITES brain records) and delete conflicts. Found
  // by route-guard-coverage.test.js — every other route in this block was written by hand and
  // this whole surface was simply never covered.
  it('POST /api/conflicts/:id/resolve is rejected for a read-only token', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, `/api/conflicts/does-not-exist-${RUN}/resolve`, {
      action: 'keep-existing',
    });
    assert.equal(r.status, 403, `conflict resolve must reject a read-only token, got ${r.status}`);
  });

  it('POST /api/conflicts/bulk-resolve is rejected for a read-only token', async () => {
    const r = await post(INSTANCES.a, readOnlyToken, '/api/conflicts/bulk-resolve', { action: 'keep-existing' });
    assert.equal(r.status, 403, `bulk-resolve must reject a read-only token, got ${r.status}`);
  });

  it('DELETE /api/conflicts/:id is rejected for a read-only token', async () => {
    const r = await del(INSTANCES.a, readOnlyToken, `/api/conflicts/does-not-exist-${RUN}`);
    assert.equal(r.status, 403, `conflict delete must reject a read-only token, got ${r.status}`);
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

  /*
   * THIS TEST WAS VACUOUS and `Q-41` is what exposed it.
   *
   * It posted the items under `memories` — the 4.x key — which 5.0 renamed to `facts`. The door carried the
   * unknown key in and never read it, so the answer was `207` with `inserted.facts: 0` and `errors: []`, and
   * `0 + 0 <= 500` passed. The cap it claims to check was never exercised: the assertion was true of a
   * request that wrote nothing at all.
   *
   * Two changes, and the second is the one that keeps it honest. It sends `facts`, so the items reach the
   * writer; and it asserts the cap BIT — exactly 500 of the 502 processed — because `<= 500` is satisfied by
   * zero, which is how this passed for as long as it did.
   */
  it('Items beyond 500 are dropped, and the cap is what decides it', async () => {
    const facts = [];
    for (let i = 0; i < 502; i++) {
      facts.push({ fact: `BulkCap-${RUN}-${i}` });
    }
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${testSpaceId}/bulk`, { facts });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    const total = r.body.inserted.facts + r.body.errors.length;
    assert.equal(total, 500,
      `the cap must process exactly 500 of the 502 sent, got ${total} — `
      + `${r.body.inserted.facts} inserted, ${r.body.errors.length} errored`);
  });
});

// ── Find-similar endpoint ────────────────────────────────────────────────────

describe('Brain — find-similar', () => {
  const RUN = Date.now();

  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('POST /find-similar requires entryId and entryType', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/similar', { space: 'general', ...({}) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('POST /find-similar rejects invalid entryType', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/similar', { space: 'general', ...({
      entryId: '00000000-0000-4000-a000-000000000001',
      entryType: 'invalid',
    }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error.includes('entryType'), r.body.error);
  });

  it('POST /find-similar rejects invalid entryId', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/similar', { space: 'general', ...({
      entryId: 'not-a-uuid',
      entryType: 'fact',
    }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error.includes('entryId'), r.body.error);
  });

  it('POST /find-similar 404 for non-existent entry', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/similar', { space: 'general', ...({
      entryId: '00000000-0000-4000-a000-000000000099',
      entryType: 'fact',
    }) });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('POST /find-similar returns results for a valid memory', async () => {
    // Write two similar memories
    const w1 = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `FindSimilar test: authentication and authorization ${RUN}`,
      // find-similar compares VECTORS, so the source must be embedded before it is searched.
      // Without this the test races the embedding worker — it lost that race on CI once already.
      waitForEmbedding: true,
      tags: ['find-similar-test'],
    });
    const w2 = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `FindSimilar test: auth and authz security ${RUN}`,
      // find-similar compares VECTORS, so the source must be embedded before it is searched.
      // Without this the test races the embedding worker — it lost that race on CI once already.
      waitForEmbedding: true,
      tags: ['find-similar-test'],
    });
    assert.equal(w1.status, 201, JSON.stringify(w1.body));
    assert.equal(w2.status, 201, JSON.stringify(w2.body));

    const sourceId = w1.body._id ?? w1.body.id;

    // Search for similar
    const r = await post(INSTANCES.a, token(), '/api/brain/similar', { space: 'general', ...({
      entryId: sourceId,
      entryType: 'fact',
      topK: 5,
    }) });
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
    const w = await post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {
      fact: `FindSimilar targetTypes test ${RUN}`,
      // find-similar compares VECTORS, so the source must be embedded before it is searched.
      // Without this the test races the embedding worker — it lost that race on CI once already.
      waitForEmbedding: true,
    });
    const sourceId = w.body._id ?? w.body.id;

    const r = await post(INSTANCES.a, token(), '/api/brain/similar', { space: 'general', ...({
      entryId: sourceId,
      entryType: 'fact',
      targetTypes: ['entity'],
      topK: 5,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // All results (if any) should be of type 'entity'
    for (const result of r.body.results) {
      assert.equal(result.type, 'entity', `Expected entity type but got ${result.type}`);
    }
  });

  it('POST /find-similar on non-existent space returns 404', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/similar', { space: 'nonexistent-space', ...({
      entryId: '00000000-0000-4000-a000-000000000001',
      entryType: 'fact',
    }) });
    assert.equal(r.status, 404, `Got ${r.status}`);
  });
});

// ── A1: legacy /:spaceId route shape removed (breaking change for 2.0) ──────
describe('Brain — legacy route shape removed (A1)', () => {
  let tk;
  before(() => {
    tk = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('legacy GET /:spaceId/facts is gone (404, not a redirect)', async () => {
    const r = await get(INSTANCES.a, tk, '/api/brain/general/facts');
    assert.equal(r.status, 404, 'the legacy /:spaceId shape must be removed (404)');
  });

  it('legacy POST /:spaceId/facts is gone (404)', async () => {
    const r = await post(INSTANCES.a, tk, '/api/brain/general/facts', { fact: 'legacy gone' });
    assert.equal(r.status, 404);
  });

  it('canonical /spaces/:spaceId/facts create + get-by-id still work', async () => {
    const w = await post(INSTANCES.a, tk, '/api/brain/spaces/general/facts', { fact: 'a1 canonical ok' });
    assert.equal(w.status, 201, `canonical create must work: ${JSON.stringify(w.body)}`);
    const g = await readRecord(INSTANCES.a, tk, 'general', 'facts', w.body._id);
    assert.equal(g.status, 200, 'canonical get-by-id must work');
  });
});
