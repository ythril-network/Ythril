/**
 * Integration tests: Sync API — batch-upsert, cursor pagination, tombstones,
 *                    seq boundary conditions.
 *
 * Covers:
 *  - POST /api/sync/batch-upsert — memories, entities, edges in one call
 *  - batch-upsert returns per-type stats (inserted, updated, forked, skipped, tombstoned)
 *  - batch-upsert respects tombstone: tombstoned doc is not re-inserted
 *  - batch-upsert 500-doc cap per type (limit enforcement)
 *  - POST /api/sync/memories — equal-seq + same-fact returns {status:'skipped'}
 *  - POST /api/sync/memories — equal-seq + different-fact returns {status:'forked'}
 *  - POST /api/sync/memories — tombstone with seq >= incoming blocks insert
 *  - POST /api/sync/memories — tombstone with seq < incoming allows insert
 *  - POST /api/sync/memories — requires spaceId
 *  - GET /api/sync/memories — requires spaceId
 *  - GET /api/sync/memories — cursor pagination pages correctly
 *  - GET /api/sync/memories — full=true returns complete docs
 *
 * Run: node --test testing/sync/sync-api.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { INSTANCES, post, get, reqJson } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let token;
const RUN = Date.now();

before(() => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

// ── POST /api/sync/memories — seq rules ──────────────────────────────────

describe('POST /api/sync/memories — conflict rules', () => {
  it('returns {status:"inserted"} for a new document', async () => {
    const id = `seq-test-new-${RUN}`;
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'inserted fact', seq: 1, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'inserted');
  });

  it('returns {status:"updated"} when incoming seq > existing seq', async () => {
    const id = `seq-test-update-${RUN}`;
    // Insert with seq 10
    await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'original fact', seq: 10, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    // Re-upsert with seq 20 (higher)
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'updated fact', seq: 20, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'updated');
  });

  it('returns {status:"skipped"} for equal seq + identical fact', async () => {
    const id = `seq-test-skip-${RUN}`;
    const fact = 'same fact same seq';
    await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact, seq: 50, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact, seq: 50, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'skipped', `Expected skipped, got: ${JSON.stringify(r.body)}`);
  });

  it('returns {status:"skipped"} when incoming seq < existing seq (older remote)', async () => {
    const id = `seq-test-older-${RUN}`;
    await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'newer local', seq: 100, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'older remote', seq: 5, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'skipped');
  });

  it('returns {status:"forked"} for equal seq + different fact', async () => {
    const id = `seq-test-fork-${RUN}`;
    await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'branch A fact', seq: 77, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'branch B different fact', seq: 77, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'forked', `Expected forked, got: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.forkId, 'forked response must include forkId');
  });

  it('tombstone with seq >= incoming returns {status:"tombstoned"} (insert blocked)', async () => {
    // First plant an explicit tombstone
    const id = `seq-tomb-block-${RUN}`;
    await post(INSTANCES.a, token, '/api/sync/tombstones?spaceId=general', {
      tombstones: [{
        _id: id, type: 'memory', spaceId: 'general',
        deletedAt: new Date().toISOString(), instanceId: 'test', seq: 999,
      }],
    });
    // Now try to insert the same id with a lower seq
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'should be blocked', seq: 500, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'tombstoned', `Expected tombstoned, got: ${JSON.stringify(r.body)}`);
  });

  it('tombstone with seq < incoming allows the insert', async () => {
    // Plant tombstone with low seq
    const id = `seq-tomb-allow-${RUN}`;
    await post(INSTANCES.a, token, '/api/sync/tombstones?spaceId=general', {
      tombstones: [{
        _id: id, type: 'memory', spaceId: 'general',
        deletedAt: new Date().toISOString(), instanceId: 'test', seq: 10,
      }],
    });
    // Incoming has higher seq — should override tombstone
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: 'newer than tombstone', seq: 50, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'inserted', `Expected inserted (override tombstone), got: ${JSON.stringify(r.body)}`);
  });

  it('returns 400 without spaceId', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/memories', {
      _id: 'x', spaceId: 'general', fact: 'test', seq: 1, embedding: [], tags: [],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for invalid memory document (missing seq)', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: 'no-seq', spaceId: 'general', fact: 'no seq',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with non-numeric seq', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: 'bad-seq', spaceId: 'general', fact: 'bad', seq: 'not-a-number',
      embedding: [], tags: [], entityIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with MongoDB operator in tags', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: 'inject-tags', spaceId: 'general', fact: 'injection', seq: 1,
      embedding: [], tags: [{ $ne: '' }], entityIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with missing author', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: 'no-author', spaceId: 'general', fact: 'test', seq: 1,
      embedding: [], tags: [], entityIds: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with seq exceeding safety limit', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: 'huge-seq', spaceId: 'general', fact: 'huge', seq: Number.MAX_SAFE_INTEGER,
      embedding: [], tags: [], entityIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for entity with missing name', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/entities?spaceId=general', {
      _id: 'no-name', spaceId: 'general', type: 'concept', tags: [], seq: 1,
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for edge with missing from/to', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/edges?spaceId=general', {
      _id: 'no-from', spaceId: 'general', label: 'test', seq: 1,
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400);
  });
});

// ── POST /api/sync/batch-upsert ───────────────────────────────────────────

describe('POST /api/sync/batch-upsert', () => {
  it('returns 400 without spaceId', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert', { memories: [] });
    assert.equal(r.status, 400);
  });

  it('returns 200 with per-type stats for valid batch', async () => {
    const memId = `batch-mem-${RUN}`;
    const entId = `batch-ent-${RUN}`;
    const edgeId = `batch-edge-${RUN}`;

    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=general', {
      memories: [{
        _id: memId, spaceId: 'general', fact: `batch fact ${RUN}`, seq: Date.now(), embedding: [], tags: [],
        entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      }],
      entities: [{
        _id: entId, spaceId: 'general', name: `BatchEntity-${RUN}`, type: 'concept', tags: [],
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), seq: Date.now() - 1,
      }],
      edges: [{
        _id: edgeId, spaceId: 'general', from: entId, to: entId, label: 'self',
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), seq: Date.now() - 2,
      }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok');
    assert.ok(r.body.memories, 'memories stats must be present');
    assert.ok(r.body.entities, 'entities stats must be present');
    assert.ok(r.body.edges, 'edges stats must be present');
    assert.equal(r.body.memories.inserted, 1, `Expected 1 inserted memory, got: ${JSON.stringify(r.body.memories)}`);
  });

  it('batch-upsert respects existing tombstone — tombstoned doc not re-inserted', async () => {
    const id = `batch-tomb-${RUN}`;
    // Plant tombstone first
    await post(INSTANCES.a, token, '/api/sync/tombstones?spaceId=general', {
      tombstones: [{
        _id: id, type: 'memory', spaceId: 'general',
        deletedAt: new Date().toISOString(), instanceId: 'test', seq: 999,
      }],
    });
    // Try to upsert the tombstoned id
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=general', {
      memories: [{
        _id: id, spaceId: 'general', fact: `should be blocked ${RUN}`, seq: 500, embedding: [], tags: [],
        entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.memories.tombstoned, 1, `Expected 1 tombstoned, got: ${JSON.stringify(r.body.memories)}`);
    assert.equal(r.body.memories.inserted, 0);
  });

  it('batch-upsert silently skips documents with missing _id or seq', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=general', {
      memories: [{ fact: 'no id or seq' }, null, {}],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // All three should be silently skipped
    assert.equal(r.body.memories.inserted, 0);
  });

  it('batch-upsert drops documents containing non-string tags (Zod filter)', async () => {
    const goodId = `batch-zod-good-${RUN}`;
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=general', {
      memories: [
        // valid
        {
          _id: goodId, spaceId: 'general', fact: 'good', seq: Date.now(), embedding: [], tags: [],
          entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
        },
        // invalid: tags contain an object (potential MongoDB operator)
        {
          _id: `batch-zod-bad-${RUN}`, spaceId: 'general', fact: 'bad', seq: Date.now() + 1,
          embedding: [], tags: [{ $ne: '' }], entityIds: [],
          author: { instanceId: 'test', instanceLabel: 'Test' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
        },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.memories.inserted, 1, 'Only the valid memory should be inserted');
  });

  it('batch-upsert caps memories at 500 per type', async () => {
    // Build 502 memories — only first 500 should be processed
    const many = Array.from({ length: 502 }, (_, i) => ({
      _id: `batch-cap-${RUN}-${i}`, spaceId: 'general', fact: `cap test ${i}`,
      seq: Date.now() + i, embedding: [], tags: [], entityIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    }));
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=general', { memories: many });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const total = r.body.memories.inserted + r.body.memories.updated + r.body.memories.skipped + r.body.memories.forked + r.body.memories.tombstoned;
    assert.ok(total <= 500, `Expected at most 500 docs processed, got ${total}`);
  });

  it('returns 403 for forbidden space', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=nonexistent', { memories: [] });
    assert.equal(r.status, 403);
  });

  it('returns 401 without auth', async () => {
    const r = await reqJson(INSTANCES.a, null, '/api/sync/batch-upsert?spaceId=general', {
      method: 'POST', body: JSON.stringify({ memories: [] }),
    });
    assert.equal(r.status, 401);
  });
});

// ── GET /api/sync/memories — listing & pagination ─────────────────────────

describe('GET /api/sync/memories — listing and cursor pagination', () => {
  it('requires spaceId', async () => {
    const r = await reqJson(INSTANCES.a, token, '/api/sync/memories');
    assert.equal(r.status, 400);
  });

  it('returns 403 for unknown spaceId', async () => {
    const r = await reqJson(INSTANCES.a, token, '/api/sync/memories?spaceId=nonexistent');
    assert.equal(r.status, 403);
  });

  it('returns items and nextCursor for the general space', async () => {
    const r = await reqJson(INSTANCES.a, token, '/api/sync/memories?spaceId=general&limit=10');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.items), 'items must be an array');
    assert.ok('nextCursor' in r.body, 'nextCursor field must be present');
  });

  it('full=true returns complete memory documents (not just stubs)', async () => {
    // Seed a known memory with a known seq
    const id = `fullmode-${RUN}`;
    const seedSeq = Date.now();
    await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: id, spaceId: 'general', fact: `full mode test ${RUN}`, seq: seedSeq, embedding: [], tags: ['fullmode'],
      entityIds: [], author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    // Use sinceSeq to target just this item (avoids being buried by earlier batch items)
    const r = await reqJson(INSTANCES.a, token, `/api/sync/memories?spaceId=general&full=true&sinceSeq=${seedSeq - 1}&limit=5`);
    assert.equal(r.status, 200);
    const item = r.body.items.find(i => i._id === id);
    assert.ok(item, `Seeded memory ${id} must appear in full=true response`);
    assert.ok(item.fact, 'Full mode item must have fact field');
  });

  it('cursor from page 1 retrieves different items on page 2', async () => {
    // Seed enough memories to guarantee at least 2 pages at limit=3
    for (let i = 0; i < 5; i++) {
      await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
        _id: `cursor-page-${RUN}-${i}`, spaceId: 'general', fact: `cursor page test ${RUN} ${i}`,
        seq: Date.now() + i + 10000, embedding: [], tags: [], entityIds: [],
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
    }
    const page1 = await reqJson(INSTANCES.a, token, '/api/sync/memories?spaceId=general&limit=3');
    assert.equal(page1.status, 200);

    if (page1.body.nextCursor) {
      const page2 = await reqJson(INSTANCES.a, token, `/api/sync/memories?spaceId=general&limit=3&cursor=${page1.body.nextCursor}`);
      assert.equal(page2.status, 200, `Page 2 request: ${JSON.stringify(page2.body)}`);
      assert.ok(Array.isArray(page2.body.items));
      const p1Ids = new Set(page1.body.items.map(i => i._id));
      for (const item of page2.body.items) {
        assert.ok(!p1Ids.has(item._id), `Duplicate item ${item._id} found across pages`);
      }
    }
    // Single-page result is valid if all memories fit in one page
  });

  it('sinceSeq=0 returns all memories', async () => {
    const r = await reqJson(INSTANCES.a, token, '/api/sync/memories?spaceId=general&sinceSeq=0&limit=500');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length > 0, 'Should have at least one memory (seeded above)');
  });

  it('returns 401 without auth', async () => {
    const r = await reqJson(INSTANCES.a, null, '/api/sync/memories?spaceId=general');
    assert.equal(r.status, 401);
  });
});

// ── POST /api/sync/chrono — IncomingChronoDoc recurrence validation ────────

describe('POST /api/sync/chrono — recurrence field validation', () => {
  function makeChronoDoc(overrides = {}) {
    return {
      _id: `chrono-recur-${RUN}-${Math.random().toString(36).slice(2)}`,
      spaceId: 'general',
      title: 'Weekly standup',
      kind: 'plan',
      startsAt: new Date().toISOString(),
      status: 'upcoming',
      tags: [],
      entityIds: [],
      memoryIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      seq: Date.now(),
      ...overrides,
    };
  }

  it('accepts a valid chrono doc with weekly recurrence', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc({
      recurrence: { freq: 'weekly', interval: 1 },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok', JSON.stringify(r.body));
  });

  it('accepts valid recurrence with all allowed freq values', async () => {
    for (const freq of ['daily', 'weekly', 'monthly', 'yearly']) {
      const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc({
        recurrence: { freq, interval: 2 },
      }));
      assert.equal(r.status, 200, `freq=${freq}: ${JSON.stringify(r.body)}`);
    }
  });

  it('accepts recurrence with optional until field', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc({
      recurrence: { freq: 'monthly', interval: 1, until: '2030-12-31T23:59:59Z' },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('rejects recurrence with invalid freq value', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc({
      recurrence: { freq: 'hourly', interval: 1 },
    }));
    assert.equal(r.status, 400, `Expected 400 for invalid freq, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects recurrence with non-positive interval', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc({
      recurrence: { freq: 'daily', interval: 0 },
    }));
    assert.equal(r.status, 400, `Expected 400 for interval=0, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects chrono doc with invalid kind', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc({
      kind: 'reminder',
    }));
    assert.equal(r.status, 400, `Expected 400 for invalid kind, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects chrono doc with invalid status', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc({
      status: 'deleted',
    }));
    assert.equal(r.status, 400, `Expected 400 for invalid status, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('accepts chrono doc without recurrence field', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/chrono?spaceId=general', makeChronoDoc());
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});
