/**
 * Integration tests: Sync API — batch-upsert, cursor pagination, tombstones,
 *                    seq boundary conditions.
 *
 * Covers:
 *  - POST /api/sync/batch-upsert — memories, entities, edges in one call
 *  - batch-upsert returns per-type stats (inserted, updated, forked, skipped, tombstoned)
 *  - batch-upsert respects tombstone: tombstoned doc is not re-inserted
 *  - batch-upsert 500-doc cap per type (limit enforcement)
 *  - POST /api/sync/facts — equal-seq + same-fact returns {status:'skipped'}
 *  - POST /api/sync/facts — equal-seq + different-fact returns {status:'forked'}
 *  - POST /api/sync/facts — tombstone with seq >= incoming blocks insert
 *  - POST /api/sync/facts — tombstone with seq < incoming allows insert
 *  - POST /api/sync/facts — requires spaceId
 *  - GET /api/sync/facts — requires spaceId
 *  - GET /api/sync/facts — cursor pagination pages correctly
 *  - GET /api/sync/facts — full=true returns complete docs
 *
 * Run: node --test testing/sync/sync-api.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RECURRENCE_FREQ } from '../../server/dist/brain/chrono.js';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REPLICATED_FAMILIES } from '../../server/dist/sync/replicated-families.js';
import { INSTANCES, post, get, reqJson, createTestSpace } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let token;
let SPACE, removeSpace;
const RUN = Date.now();

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  ({ id: SPACE, remove: removeSpace } = await createTestSpace('sync-api', [[INSTANCES.a, token]]));
});

after(async () => {
  await removeSpace?.();
});

// ── POST /api/sync/facts — seq rules ──────────────────────────────────

describe('POST /api/sync/facts — conflict rules', () => {
  it('returns {status:"inserted"} for a new document', async () => {
    const id = `seq-test-new-${RUN}`;
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'inserted fact', seq: 1, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'inserted');
  });

  it('returns {status:"updated"} when incoming seq > existing seq', async () => {
    const id = `seq-test-update-${RUN}`;
    // Insert with seq 10
    await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'original fact', seq: 10, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    // Re-upsert with seq 20 (higher)
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'updated fact', seq: 20, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'updated');
  });

  it('returns {status:"skipped"} for equal seq + identical fact', async () => {
    const id = `seq-test-skip-${RUN}`;
    const fact = 'same fact same seq';
    await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact, seq: 50, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact, seq: 50, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'skipped', `Expected skipped, got: ${JSON.stringify(r.body)}`);
  });

  it('returns {status:"skipped"} when incoming seq < existing seq (older remote)', async () => {
    const id = `seq-test-older-${RUN}`;
    await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'newer local', seq: 100, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'older remote', seq: 5, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'skipped');
  });

  it('returns {status:"forked"} for equal seq + different fact', async () => {
    const id = `seq-test-fork-${RUN}`;
    await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'branch A fact', seq: 77, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'branch B different fact', seq: 77, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'forked', `Expected forked, got: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.forkId, 'forked response must include forkId');
  });

  it('tombstone with seq >= incoming returns {status:"tombstoned"} (insert blocked)', async () => {
    // First plant an explicit tombstone
    const id = `seq-tomb-block-${RUN}`;
    await post(INSTANCES.a, token, `/api/sync/tombstones?spaceId=${SPACE}`, {
      tombstones: [{
        _id: id, type: 'fact', spaceId: SPACE,
        deletedAt: new Date().toISOString(), instanceId: 'test', seq: 999,
      }],
    });
    // Now try to insert the same id with a lower seq
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'should be blocked', seq: 500, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'tombstoned', `Expected tombstoned, got: ${JSON.stringify(r.body)}`);
  });

  it('tombstone with seq < incoming allows the insert', async () => {
    // Plant tombstone with low seq
    const id = `seq-tomb-allow-${RUN}`;
    await post(INSTANCES.a, token, `/api/sync/tombstones?spaceId=${SPACE}`, {
      tombstones: [{
        _id: id, type: 'fact', spaceId: SPACE,
        deletedAt: new Date().toISOString(), instanceId: 'test', seq: 10,
      }],
    });
    // Incoming has higher seq — should override tombstone
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: 'newer than tombstone', seq: 50, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'inserted', `Expected inserted (override tombstone), got: ${JSON.stringify(r.body)}`);
  });

  it('returns 400 without spaceId', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/facts', {
      _id: 'x', spaceId: SPACE, fact: 'test', seq: 1, embedding: [], tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for invalid memory document (missing seq)', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: 'no-seq', spaceId: SPACE, fact: 'no seq',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with non-numeric seq', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: 'bad-seq', spaceId: SPACE, fact: 'bad', seq: 'not-a-number',
      embedding: [], tags: [],      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with MongoDB operator in tags', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: 'inject-tags', spaceId: SPACE, fact: 'injection', seq: 1,
      embedding: [], tags: [{ $ne: '' }],      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with missing author', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: 'no-author', spaceId: SPACE, fact: 'test', seq: 1,
      embedding: [], tags: [],      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for memory with seq exceeding safety limit', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: 'huge-seq', spaceId: SPACE, fact: 'huge', seq: Number.MAX_SAFE_INTEGER,
      embedding: [], tags: [],      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for entity with missing name', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/entities?spaceId=${SPACE}`, {
      _id: 'no-name', spaceId: SPACE, type: 'concept', tags: [], seq: 1,
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for edge with missing from/to', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/edges?spaceId=${SPACE}`, {
      _id: 'no-from', spaceId: SPACE, label: 'test', seq: 1,
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400);
  });
});

// ── POST /api/sync/batch-upsert ───────────────────────────────────────────

describe('POST /api/sync/batch-upsert', () => {
  it('returns 400 without spaceId', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert', { facts: [] });
    assert.equal(r.status, 400);
  });

  it('returns 200 with per-type stats for valid batch', async () => {
    const memId = `batch-mem-${RUN}`;
    const entId = `batch-ent-${RUN}`;
    const edgeId = `batch-edge-${RUN}`;

    const r = await post(INSTANCES.a, token, `/api/sync/batch-upsert?spaceId=${SPACE}`, {
      facts: [{
        _id: memId, spaceId: SPACE, fact: `batch fact ${RUN}`, seq: Date.now(), embedding: [], tags: [],
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      }],
      entities: [{
        _id: entId, spaceId: SPACE, name: `BatchEntity-${RUN}`, type: 'concept', tags: [],
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), seq: Date.now() - 1,
      }],
      edges: [{
        _id: edgeId, spaceId: SPACE, from: entId, to: entId, label: 'self',
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), seq: Date.now() - 2,
      }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok');
    assert.ok(r.body.facts, 'memories stats must be present');
    assert.ok(r.body.entities, 'entities stats must be present');
    assert.ok(r.body.edges, 'edges stats must be present');
    assert.equal(r.body.facts.inserted, 1, `Expected 1 inserted memory, got: ${JSON.stringify(r.body.facts)}`);
  });

  it('batch-upsert respects existing tombstone — tombstoned doc not re-inserted', async () => {
    const id = `batch-tomb-${RUN}`;
    // Plant tombstone first
    await post(INSTANCES.a, token, `/api/sync/tombstones?spaceId=${SPACE}`, {
      tombstones: [{
        _id: id, type: 'fact', spaceId: SPACE,
        deletedAt: new Date().toISOString(), instanceId: 'test', seq: 999,
      }],
    });
    // Try to upsert the tombstoned id
    const r = await post(INSTANCES.a, token, `/api/sync/batch-upsert?spaceId=${SPACE}`, {
      facts: [{
        _id: id, spaceId: SPACE, fact: `should be blocked ${RUN}`, seq: 500, embedding: [], tags: [],
        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.facts.tombstoned, 1, `Expected 1 tombstoned, got: ${JSON.stringify(r.body.facts)}`);
    assert.equal(r.body.facts.inserted, 0);
  });

  it('batch-upsert silently skips documents with missing _id or seq', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/batch-upsert?spaceId=${SPACE}`, {
      facts: [{ fact: 'no id or seq' }, null, {}],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // All three should be silently skipped
    assert.equal(r.body.facts.inserted, 0);
  });

  it('batch-upsert drops documents containing non-string tags (Zod filter)', async () => {
    const goodId = `batch-zod-good-${RUN}`;
    const r = await post(INSTANCES.a, token, `/api/sync/batch-upsert?spaceId=${SPACE}`, {
      facts: [
        // valid
        {
          _id: goodId, spaceId: SPACE, fact: 'good', seq: Date.now(), embedding: [], tags: [],
          author: { instanceId: 'test', instanceLabel: 'Test' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
        },
        // invalid: tags contain an object (potential MongoDB operator)
        {
          _id: `batch-zod-bad-${RUN}`, spaceId: SPACE, fact: 'bad', seq: Date.now() + 1,
          embedding: [], tags: [{ $ne: '' }],          author: { instanceId: 'test', instanceLabel: 'Test' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
        },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.facts.inserted, 1, 'Only the valid memory should be inserted');
  });

  it('batch-upsert caps memories at 500 per type', async () => {
    // Build 502 memories — only first 500 should be processed
    const many = Array.from({ length: 502 }, (_, i) => ({
      _id: `batch-cap-${RUN}-${i}`, spaceId: SPACE, fact: `cap test ${i}`,
      seq: Date.now() + i, embedding: [], tags: [],      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    }));
    const r = await post(INSTANCES.a, token, `/api/sync/batch-upsert?spaceId=${SPACE}`, { facts: many });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const total = r.body.facts.inserted + r.body.facts.updated + r.body.facts.skipped + r.body.facts.forked + r.body.facts.tombstoned;
    assert.ok(total <= 500, `Expected at most 500 docs processed, got ${total}`);
    /*
     * The overflow is REJECTED, not dropped (`Q-107` part 1). It used to vanish: sliced off before counting, so
     * the response accounted for 500 of 502 and the sender — which subtracts `rejected` from what it pushed —
     * counted the other two as delivered and advanced its watermark past records this instance never stored.
     */
    assert.equal(total, 500, `Expected exactly the first 500 processed, got ${total}`);
    assert.equal(r.body.facts.rejected, 2,
      `the 2 documents past the 500 cap must be counted in rejected, got ${JSON.stringify(r.body.facts)}`);
  });

  it('returns 403 for forbidden space', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=nonexistent', { facts: [] });
    assert.equal(r.status, 403);
  });

  it('returns 401 without auth', async () => {
    const r = await reqJson(INSTANCES.a, null, `/api/sync/batch-upsert?spaceId=${SPACE}`, {
      method: 'POST', body: JSON.stringify({ facts: [] }),
    });
    assert.equal(r.status, 401);
  });
});

// ── GET /api/sync/facts — listing & pagination ─────────────────────────

describe('GET /api/sync/facts — listing and cursor pagination', () => {
  it('requires spaceId', async () => {
    const r = await reqJson(INSTANCES.a, token, '/api/sync/facts');
    assert.equal(r.status, 400);
  });

  it('returns 403 for unknown spaceId', async () => {
    const r = await reqJson(INSTANCES.a, token, '/api/sync/facts?spaceId=nonexistent');
    assert.equal(r.status, 403);
  });

  it('returns items and nextCursor for the test space', async () => {
    const r = await reqJson(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}&limit=10`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.items), 'items must be an array');
    assert.ok('nextCursor' in r.body, 'nextCursor field must be present');
  });

  // bundle-81 rewrites the three cases that followed here on `sinceSeq` and a seq cursor. A 6.0 page is read by
  // POSITION: `afterPos` (a whole number of 0 to `Number.MAX_SAFE_INTEGER`) or the opaque `p1.` cursor the previous page
  // handed back, and every page says how far it is complete (`through`) and where the store's settled end is (`head`).
  it('full=true returns complete memory documents (not just stubs)', async () => {
    // The position the store has settled to BEFORE the seed: a read after it targets just the seeded item and whatever
    // landed since (it cannot be buried by the earlier batch items, which sit at or below it).
    const mark = await reqJson(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}&afterPos=0&limit=1`);
    assert.equal(mark.status, 200, JSON.stringify(mark.body));
    assert.ok(Number.isSafeInteger(mark.body.head), `a page answers head, the settled end of the stream: ${JSON.stringify(mark.body)}`);
    const id = `fullmode-${RUN}`;
    await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
      _id: id, spaceId: SPACE, fact: `full mode test ${RUN}`, seq: Date.now(), embedding: [], tags: ['fullmode'],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
    });
    const r = await reqJson(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}&full=true&afterPos=${mark.body.head}&limit=5`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const item = r.body.items.find(i => i._id === id);
    assert.ok(item, `Seeded memory ${id} must appear in full=true response after position ${mark.body.head}`);
    assert.ok(item.fact, 'Full mode item must have fact field');
    assert.deepEqual(r.body.items.map(i => i._id).filter(x => x !== id), [],
      'only what landed after the position is served: nothing at or below it comes back');
  });

  it('a cursor from page 1 continues exactly where page 1 ended', async () => {
    // Seed enough memories to guarantee at least 2 pages at limit=3
    for (let i = 0; i < 5; i++) {
      await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, {
        _id: `cursor-page-${RUN}-${i}`, spaceId: SPACE, fact: `cursor page test ${RUN} ${i}`,
        seq: Date.now() + i + 10000, embedding: [], tags: [],        author: { instanceId: 'test', instanceLabel: 'Test' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
      });
    }
    const page1 = await reqJson(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}&afterPos=0&limit=3`);
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    assert.equal(page1.body.items.length, 3, 'the space holds more than three memories, so page 1 is full');
    assert.equal(typeof page1.body.nextCursor, 'string', 'a full page with more behind it hands back a cursor');
    assert.ok(page1.body.nextCursor.startsWith('p1.'), `a 6.0 cursor is the p1. form, got ${page1.body.nextCursor}`);

    const page2 = await reqJson(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}&limit=3&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    assert.equal(page2.status, 200, `Page 2 request: ${JSON.stringify(page2.body)}`);
    // Identity, not "no duplicate": pages 1 and 2 are exactly the first six of one six-item read, in that order.
    const six = await reqJson(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}&afterPos=0&limit=6`);
    assert.equal(six.status, 200, JSON.stringify(six.body));
    assert.deepEqual([...page1.body.items, ...page2.body.items].map(i => i._id), six.body.items.map(i => i._id),
      'the cursor continues at the item after page 1\'s last, with none repeated and none skipped');
  });

  it('afterPos=0 returns all memories', async () => {
    const r = await reqJson(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}&afterPos=0&limit=500`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.items.length > 0, 'Should have at least one memory (seeded above)');
  });

  it('returns 401 without auth', async () => {
    const r = await reqJson(INSTANCES.a, null, `/api/sync/facts?spaceId=${SPACE}`);
    assert.equal(r.status, 401);
  });
});

// ── The 6.0 wire contract (bundle-81, Q-394 / Q-278): position paging, refused old forms, `positions: 1` ───────────

/**
 * What a 6.0 sync door answers and refuses (`sync/wire-answer.ts`, `syncPositionStart` in `api/sync/_shared.ts`), read from
 * outside, over HTTP, on every door it covers.
 *
 * The set of read doors is DERIVED: every replicated family the server declares (`REPLICATED_FAMILIES`, read from the
 * built server so a seventh family is covered the day it is added) plus the tombstone pull. The floor is the six families
 * that exist, so an import that came back empty cannot pass every loop below. The push doors are the ones that answer a
 * push: batch-upsert, the single-document POST and the tombstone POST.
 *
 * NOT covered here, and why: `503 positions_building` (a space that owes its positions) cannot be produced on a fresh
 * stack, where every space is ready the moment it exists; its body and the sender's reading of it (held, no mark moves,
 * no member failure) are `a-space-owes-its-positions-until-one-write-db`'s. And a `through` cut inside a run of EQUAL
 * positions needs a legacy-band tie, which only 5.6-shaped data has: on a 6.0 stack every landing takes its own clock
 * position, so the tie rule is read here at the boundary it costs one position at (below) and in the -db tests for the
 * tie itself.
 */
describe('the 6.0 wire contract — position paging', () => {
  const FAMILY_KEYS = REPLICATED_FAMILIES.map(f => f.payloadKey);
  const READ_DOORS = [...FAMILY_KEYS, 'tombstones'];
  const doc = (over) => ({
    _id: `wire-${RUN}-${randomUUID()}`, spaceId: SPACE, fact: 'wire contract fact', seq: Date.now(), embedding: [], tags: [],
    author: { instanceId: 'test', instanceLabel: 'Test' },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none', ...over,
  });
  const read = (door, query) => reqJson(INSTANCES.a, token, `/api/sync/${door}?spaceId=${SPACE}&${query}`);

  before(async () => {
    assert.ok(FAMILY_KEYS.length >= 6, `the server declares at least the six replicated families, found ${FAMILY_KEYS.join(',')}`);
    // Two rows in every read door, so no refusal below is read from an empty page and a page can be cut at one item:
    // each family through its own REST door (a local write, as the owner would make it), tombstones through the sync door.
    const must = (r, what) => { assert.ok(r.status < 300, `seed ${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body._id ?? r.body.id; };
    const brain = (kind, body) => post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/${kind}`, body);
    const facts = [], ents = [];
    for (let i = 0; i < 2; i++) {
      facts.push(must(await brain('facts', { fact: `wire seed fact ${RUN} ${i}` }), 'fact'));
      ents.push(must(await brain('entities', { name: `WireSeedEntity-${RUN}-${i}`, type: 'concept' }), 'entity'));
      must(await brain('chrono', { title: `Wire seed ${RUN} ${i}`, type: 'event', startsAt: new Date().toISOString() }), 'chrono');
      must(await brain('edges', { from: ents[0], to: ents[i], label: `wire_seed_${i}` }), 'edge');
      must(await brain('links', { from: facts[i], fromKind: 'fact', to: ents[i], toKind: 'entity' }), 'link');
      const f = await fetch(`${INSTANCES.a}/api/files/${SPACE}?path=${encodeURIComponent(`wire-seed-${RUN}-${i}.md`)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: `# wire seed ${i}\n`, encoding: 'utf8' }),
      });
      assert.ok(f.status < 300, `seed file: ${f.status}`);
      const tomb = await post(INSTANCES.a, token, `/api/sync/tombstones?spaceId=${SPACE}`, {
        tombstones: [{ _id: `wire-tomb-${RUN}-${i}`, type: 'fact', spaceId: SPACE, deletedAt: new Date().toISOString(), instanceId: 'test', seq: 4242 + i }],
      });
      assert.equal(tomb.status, 200, JSON.stringify(tomb.body));
    }
  });

  it('every page answers items, an integer through and head, and positions: 1', async () => {
    for (const door of READ_DOORS) {
      const r = await read(door, 'afterPos=0&limit=5&full=true');
      assert.equal(r.status, 200, `${door}: ${JSON.stringify(r.body)}`);
      assert.ok(Array.isArray(r.body.items), `${door} answers its rows as items: ${JSON.stringify(Object.keys(r.body))}`);
      assert.ok(Number.isSafeInteger(r.body.through), `${door} answers an integer through: ${JSON.stringify(r.body.through)}`);
      assert.ok(Number.isSafeInteger(r.body.head), `${door} answers an integer head: ${JSON.stringify(r.body.head)}`);
      assert.equal(r.body.positions, 1, `${door} says it pages by position`);
    }
  });

  it('afterPos takes 0 and Number.MAX_SAFE_INTEGER on every read door', async () => {
    for (const door of READ_DOORS) {
      const control = await read(door, 'afterPos=0&limit=5');
      assert.equal(control.status, 200, `${door}: ${JSON.stringify(control.body)}`);
      assert.ok(control.body.items?.length > 0, `${door}: positive control, the stream holds something above 0`);

      const top = await read(door, `afterPos=${Number.MAX_SAFE_INTEGER}&limit=5`);
      assert.equal(top.status, 200, `${door} at the largest position: ${JSON.stringify(top.body)}`);
      assert.deepEqual(top.body.items, [], `${door}: nothing lies above the largest position`);
      assert.equal(top.body.nextCursor, null, `${door}: and there is no more`);

    }
  });

  it('afterPos refuses everything that is not a whole safe number, on every read door', async () => {
    for (const door of READ_DOORS) {
      for (const bad of ['-1', '1.5', 'abc', '1e3', '0x10', 'NaN', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1), '1&afterPos=2']) {
        const r = await read(door, `afterPos=${bad}&limit=5`);
        assert.equal(r.status, 400, `${door}: afterPos=${bad} is refused, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.equal(typeof r.body.error, 'string', `${door}: the refusal says why`);
      }
    }
  });

  it('sinceSeq is refused on every family and on tombstones, alone and beside a cursor, with a sentence naming position paging', async () => {
    for (const door of READ_DOORS) {
      const first = await read(door, 'afterPos=0&limit=1');
      assert.equal(first.status, 200, `${door}: ${JSON.stringify(first.body)}`);
      for (const q of ['sinceSeq=0', 'sinceSeq=5&limit=5', 'afterPos=0&sinceSeq=0']) {
        const r = await read(door, q);
        assert.equal(r.status, 400, `${door}: ${q} is refused, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.match(String(r.body?.error), /position/i, `${door}: ${q} is refused in words that name position paging: ${JSON.stringify(r.body)}`);
      }
      // The refusal is tested BEFORE the cursor branch: a 5.6 client sends its sinceSeq constant beside the cursor it echoes.
      assert.equal(typeof first.body.nextCursor, 'string', `${door}: positive control, a page cut at one item hands back a cursor`);
      const beside = await read(door, `sinceSeq=0&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      assert.equal(beside.status, 400, `${door}: sinceSeq beside a valid cursor is still refused, got ${beside.status}`);
    }
  });

  it('every old cursor form is refused on every read door, the client-built bare-seq cursor included', async () => {
    const b64 = (text) => Buffer.from(text).toString('base64url');
    // The forms a 5.6 server emitted or a 5.6 integrator wrote: a pair, a bare seq, the bare seq as the integrator guide
    // told clients to build it, and text that is no cursor at all.
    const OLD_FORMS = [b64('5:some-record-id'), b64('0'), b64('1'), '5', 'not-a-cursor', b64('9007199254740991:x')];
    for (const door of READ_DOORS) {
      for (const cursor of OLD_FORMS) {
        const r = await read(door, `cursor=${encodeURIComponent(cursor)}&limit=5`);
        assert.equal(r.status, 400, `${door}: the old cursor ${cursor} is refused, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      }
    }
  });

  it('a page cut with more behind it answers through below head, and resuming at through re-offers the last item', async () => {
    // `through` is complete-through: the position BEFORE the last item's when more follows, because a run of equal
    // positions may continue on the next page. On the clock band that costs one position, so resuming at `through`
    // hands the last item of the cut page back first. A mark set to the last item's own position would be the defect
    // (decision 5): the rest of a run is never read.
    for (const door of READ_DOORS) {
      const cut = await read(door, 'afterPos=0&limit=1&full=true');
      assert.equal(cut.status, 200, `${door}: ${JSON.stringify(cut.body)}`);
      assert.equal(cut.body.items.length, 1, `${door}: positive control, the page is cut at one item`);
      assert.equal(typeof cut.body.nextCursor, 'string', `${door}: with more behind it, a cursor`);
      assert.ok(Number.isSafeInteger(cut.body.through), `${door}: through is an integer: ${JSON.stringify(cut.body.through)}`);
      assert.ok(cut.body.through < cut.body.head, `${door}: a cut page is not complete through the head: ${cut.body.through} vs ${cut.body.head}`);
      const resumed = await read(door, `afterPos=${cut.body.through}&limit=1&full=true`);
      assert.equal(resumed.status, 200, `${door}: ${JSON.stringify(resumed.body)}`);
      assert.equal(resumed.body.items[0]?._id, cut.body.items[0]._id,
        `${door}: the item the cut page ended on is offered again from its through, never skipped`);
    }
  });

  it('read to the end, throughs rise page by page and the last page is complete through head', async () => {
    for (const door of READ_DOORS) {
      let query = 'afterPos=0&limit=200', last = -1, pages = 0;
      for (;;) {
        const r = await read(door, query);
        assert.equal(r.status, 200, `${door}: ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.ok(Number.isSafeInteger(r.body.through), `${door} page ${pages}: through is an integer`);
        assert.ok(r.body.through > last, `${door}: through rises (${last} -> ${r.body.through})`);
        last = r.body.through;
        pages++;
        if (r.body.nextCursor === null) {
          assert.equal(r.body.through, r.body.head, `${door}: nothing follows, so the page is complete through the head`);
          break;
        }
        assert.ok(r.body.through < r.body.head, `${door}: a page with more behind it is not complete through the head`);
        query = `limit=200&cursor=${encodeURIComponent(r.body.nextCursor)}`;
        assert.ok(pages < 50, `${door}: the read ends`);
      }
    }
  });

  it('every push answer says positions: 1', async () => {
    const batch = await post(INSTANCES.a, token, `/api/sync/batch-upsert?spaceId=${SPACE}`, { facts: [doc({})] });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.equal(batch.body.status, 'ok');
    assert.equal(batch.body.positions, 1, `batch-upsert says positions: 1: ${JSON.stringify(batch.body)}`);

    const single = await post(INSTANCES.a, token, `/api/sync/facts?spaceId=${SPACE}`, doc({}));
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.positions, 1, `the single-document POST says positions: 1: ${JSON.stringify(single.body)}`);

    const entity = await post(INSTANCES.a, token, `/api/sync/entities?spaceId=${SPACE}`, {
      _id: `wire-ent-${RUN}`, spaceId: SPACE, name: `WireEntity-${RUN}`, type: 'concept', tags: [], seq: Date.now(),
      author: { instanceId: 'test', instanceLabel: 'Test' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(entity.status, 200, JSON.stringify(entity.body));
    assert.equal(entity.body.positions, 1, `the single entity POST says positions: 1: ${JSON.stringify(entity.body)}`);

    const tomb = await post(INSTANCES.a, token, `/api/sync/tombstones?spaceId=${SPACE}`, {
      tombstones: [{ _id: `wire-tomb2-${RUN}`, type: 'fact', spaceId: SPACE, deletedAt: new Date().toISOString(), instanceId: 'test', seq: 4243 }],
    });
    assert.equal(tomb.status, 200, JSON.stringify(tomb.body));
    assert.equal(tomb.body.positions, 1, `the tombstone POST says positions: 1: ${JSON.stringify(tomb.body)}`);
    assert.equal(tomb.body.applied, 1, 'and keeps the fields it answered before');
  });
});

// ── POST /api/sync/chrono — IncomingChronoDoc recurrence validation ────────

describe('POST /api/sync/chrono — recurrence field validation', () => {
  function makeChronoDoc(overrides = {}) {
    return {
      _id: `chrono-recur-${RUN}-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE,
      title: 'Weekly standup',
      type: 'plan',
      startsAt: new Date().toISOString(),
      status: 'upcoming',
      tags: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      seq: Date.now(),
      ...overrides,
    };
  }

  it('accepts a valid chrono doc with weekly recurrence', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc({
      recurrence: { freq: 'weekly', interval: 1 },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok', JSON.stringify(r.body));
  });

  it('accepts valid recurrence with all allowed freq values', async () => {
    // The validator's own list, so "all allowed values" means all of them -- a fifth frequency would be
    // accepted by the server and tried by nobody.
    for (const freq of RECURRENCE_FREQ) {
      const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc({
        recurrence: { freq, interval: 2 },
      }));
      assert.equal(r.status, 200, `freq=${freq}: ${JSON.stringify(r.body)}`);
    }
  });

  it('accepts recurrence with optional until field', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc({
      recurrence: { freq: 'monthly', interval: 1, until: '2030-12-31T23:59:59Z' },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('rejects recurrence with invalid freq value', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc({
      recurrence: { freq: 'hourly', interval: 1 },
    }));
    assert.equal(r.status, 400, `Expected 400 for invalid freq, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects recurrence with non-positive interval', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc({
      recurrence: { freq: 'daily', interval: 0 },
    }));
    assert.equal(r.status, 400, `Expected 400 for interval=0, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects chrono doc with invalid type', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc({
      type: 'reminder',
    }));
    assert.equal(r.status, 400, `Expected 400 for invalid kind, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects chrono doc with invalid status', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc({
      status: 'deleted',
    }));
    assert.equal(r.status, 400, `Expected 400 for invalid status, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('accepts chrono doc without recurrence field', async () => {
    const r = await post(INSTANCES.a, token, `/api/sync/chrono?spaceId=${SPACE}`, makeChronoDoc());
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});
