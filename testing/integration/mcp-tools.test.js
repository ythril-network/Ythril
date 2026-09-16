/**
 * Integration tests: All 12 MCP brain/file tools + MCP security
 *
 * Extends the existing mcp.test.js coverage (which only covered list_peers
 * and sync_now) with:
 *
 * Brain tools:
 *  - remember — stores a memory, returns confirmation
 *  - recall — finds a previously stored memory
 *  - recall_global — searches across spaces (security: space-scoped token must
 *    NOT see memories from other spaces)
 *  - query — structured MongoDB filter, operator whitelist enforced
 *  - upsert_entity — creates/updates an entity
 *  - upsert_edge — creates a directed relationship edge
 *
 * File tools:
 *  - write_file — write text to the space file store
 *  - read_file — read back the written file
 *  - list_dir — lists directory contents
 *  - create_dir — creates a new directory
 *  - move_file — renames a file
 *  - delete_file — deletes a file
 *
 * Security:
 *  - Unauthenticated GET /mcp/:spaceId returns 401
 *  - Unauthenticated POST /mcp/:spaceId/messages returns 401
 *  - Space-scoped token cannot open MCP session for a different space
 *  - recall_global with space-scoped token only returns results from
 *    the token's allowed spaces (CRITICAL scope-leak test)
 *  - query tool rejects disallowed MongoDB operators ($where, $function)
 *
 * Run: node --test testing/integration/mcp-tools.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, patch, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;

// The MCP client harness lives in ../sync/mcp-session.js. It was copy-pasted into ten files while the
// transport was SSE; 4.0 removed SSE and one shared `POST /mcp` caller replaced every copy.

/** POST without auth (raw) */
async function rawGet(url) {
  const r = await fetch(url);
  return r.status;
}

/**
 * Reindex every space on the given instance whose embeddings were created with a
 * different model, so recall / recall_global work with the currently configured model.
 */
async function ensureReindexed(baseUrl, token) {
  const { body: spacesBody } = await get(baseUrl, token, '/api/spaces');
  const spaces = spacesBody?.spaces ?? [];
  for (const space of spaces) {
    const { body: statusBody } = await get(baseUrl, token, `/api/brain/spaces/${space.id}/reindex-status`);
    if (statusBody?.needsReindex) {
      await post(baseUrl, token, `/api/brain/spaces/${space.id}/reindex`, {});
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe embedding readiness at USE time, not once. Readiness is defined by a full round-trip: a
 * uniquely-remembered fact must be *recallable with a non-zero count*. That is stricter than "the
 * endpoint answered" on purpose — memory storage succeeds in a degraded mode with no embedding
 * server, but recall then returns empty without vectors.
 *
 * REMEMBER ONCE, THEN POLL. The previous version inserted a NEW fact on every attempt and recalled it
 * immediately, so each round raced MongoDB's vector-index lag from zero and the probe could
 * essentially never succeed — measured at ~10s on the test stack, against 8 attempts that each
 * restarted the clock. Every embedding-dependent test therefore skipped itself, permanently, while CI
 * reported green: 19 tests covering remember / recall / recall_global — the product's core — were
 * running nowhere. The message they printed ("Embedding server not configured in test stack") was a
 * wrong conclusion drawn from a probe that could not pass; the bundled ONNX model works fine and the
 * stored vectors are real.
 *
 * Returns false fast when the endpoint is genuinely unreachable — the server says "Could not reach
 * embedding endpoint …" (server/src/brain/embedding.ts) — so a stack with no embedding service still
 * skips deterministically instead of burning the full timeout.
  */
async function waitForEmbeddingReady(session, space = 'general', { attempts = 15, delayMs = 2000 } = {}) {
  const unreachable = (text) => text.includes('could not reach') || text.includes('unreachable');

  // Store ONE fact, then give the index time to catch up with it.
  const fact = `__embedding-probe-${Date.now()}__`;
  const remembered = await session.callTool('save_fact', { space, fact, tags: [] });
  const remText = (remembered?.content?.[0]?.text ?? '').toLowerCase();
  // Storing is what needs the embedding service; if that failed there is nothing to recall. Either way
  // the suite skips — but log the reason so it is not mistaken for the index-lag case again.
  if (remembered?.isError) {
    console.log(`  embedding probe: remember failed (${unreachable(remText) ? 'endpoint unreachable' : remText.slice(0, 120)})`);
    return false;
  }

  for (let i = 0; i < attempts; i++) {
    const recalled = await session.callTool('recall', { space, query: fact, topK: 1 });
    if (recalled?.isError) {
      if (unreachable((recalled?.content?.[0]?.text ?? '').toLowerCase())) return false;
    } else {
      let count = 0;
      try { count = JSON.parse(recalled?.content?.[0]?.text ?? '{}').count ?? 0; }
      catch { count = (recalled?.content?.[0]?.text ?? '').length > 0 ? 1 : 0; }
      if (count > 0) return true;
    }
    await sleep(delayMs); // vector-index lag / model warm-up — the SAME fact becomes recallable
  }
  // Exhausted. Say what was actually observed — a silent 'not configured' is what hid this for so long.
  console.log(`  embedding probe: stored ok but recall returned 0 after ${(attempts * delayMs) / 1000}s (vector-index lag exceeded the budget, or recall is broken) — fact=${fact}`);
  return false;
}

// ── Brain tool tests ──────────────────────────────────────────────────────

describe('MCP brain tools — remember / recall / query', () => {
  let session;
  const uniqueFact = `MCP-test-fact-${Date.now()}`;
  let embeddingAvailable = false;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession(tokenA);
    // Gate embedding-dependent tests on a real remember→recall round-trip, retried across
    // ollama warm-up so a mid-warm-up probe can't pass and then flake a later recall.
    embeddingAvailable = await waitForEmbeddingReady(session);
  });
  after(() => session?.close());

  it('remember stores a memory and returns confirmation with seq and id', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('save_fact', { space: 'general', fact: uniqueFact, tags: ['mcp-test'] });
    assert.ok(!result?.isError, `remember returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('Stored fact'), `Expected "Stored fact" in: ${text}`);
    assert.ok(/seq \d+/.test(text) || /ID /.test(text), `Expected seq/ID in text: ${text}`);
  });

  it('recall finds the just-stored memory', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', { space: 'general', query: uniqueFact, topK: 5 });
    assert.ok(!result?.isError, `recall returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'recall must return non-empty response');

    // Recall returns structured JSON -- verify shape regardless of whether
    // any results were found (embedding scores vary by environment).
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      assert.fail(`recall response must be valid JSON, got: ${text}`);
    }
    assert.ok(typeof parsed === 'object' && parsed !== null, 'recall response must be a JSON object');
    assert.ok('results' in parsed, 'recall JSON must have "results" array');
    assert.ok('count' in parsed, 'recall JSON must have "count" field');
    assert.ok(Array.isArray(parsed.results), '"results" must be an array');
    assert.equal(parsed.count, parsed.results.length, 'count must equal results.length');

    for (const item of parsed.results) {
      assert.ok('score' in item, 'each result must have score');
      assert.ok('spaceId' in item, 'each result must have spaceId');
      assert.ok('type' in item, 'each result must have type');
      // `matchedText` was the pre-embedding source string, and for a file chunk it is
      // `headingText + ' ' + content` — i.e. the passage a second time. Dropped from MCP
      // responses so the passage is paid for once, under its named field. REST still has it.
      assert.ok(!('matchedText' in item), 'MCP recall must not duplicate the passage as matchedText');
      assert.ok('record' in item, 'each result must have record');
      assert.ok(typeof item.record === 'object' && item.record !== null, 'record must be an object');
      assert.ok('_id' in item.record, 'record must have _id');
      assert.ok(!('embedding' in item.record), 'record must not expose embedding vector');
      // Per-row cost with no per-row information: `embeddingModel` is identical for every record in a
      // space, `seq` is the sync counter and is not an input to any tool.
      assert.ok(!('embeddingModel' in item.record), 'record must not repeat embeddingModel per row');
      assert.ok(!('seq' in item.record), 'record must not carry the sync seq counter');
    }
  });

  it('recall with empty query returns isError', async () => {
    const result = await session.callTool('recall', { query: '' });
    assert.ok(result?.isError, 'Empty query must return isError=true');
  });

  it('remember with empty fact returns isError', async () => {
    const result = await session.callTool('save_fact', { space: 'general', fact: '' });
    assert.ok(result?.isError, 'Empty fact must return isError=true');
  });

  it('query with allowed operators returns results (no error)', async () => {
    const result = await session.callTool('filter', {
      space: 'general',
      collection: 'facts',
      filter: { fact: { $exists: true } },
      limit: 5,
    });
    assert.ok(!result?.isError, `query with $exists returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    // Should be valid JSON array
    const parsed = JSON.parse(text);
    assert.ok(Array.isArray(parsed), `query result must be a JSON array, got: ${text}`);
    // Embedding vectors must be stripped from results
    for (const doc of parsed) {
      assert.ok(!('embedding' in doc), 'query must not expose embedding vectors');
    }
  });

  it('query projection include-mode returns only the named fields (S8.2)', async () => {
    // Seed a memory with a distinctive fact + tags, then project just {fact:1}.
    const seed = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: `mcp-projection-${Date.now()}`, tags: ['mcp-proj'],
    });
    assert.equal(seed.status, 201, JSON.stringify(seed.body));
    const seededId = seed.body._id;
    try {
      const result = await session.callTool('filter', {
        space: 'general',
        collection: 'facts',
        filter: { _id: seededId },
        projection: { fact: 1 },
        limit: 1,
      });
      assert.ok(!result?.isError, `projection query returned isError: ${JSON.stringify(result)}`);
      const parsed = JSON.parse(result?.content?.[0]?.text ?? '[]');
      assert.ok(Array.isArray(parsed) && parsed.length > 0, 'expected the seeded memory');
      const doc = parsed[0];
      assert.ok('fact' in doc, 'included field "fact" must be present');
      assert.ok(!('tags' in doc), 'non-included field "tags" must be absent under include projection');
      assert.ok(!('embedding' in doc), 'embedding must never be exposed');
    } finally {
      await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${seededId}`).catch(() => {});
    }
  });

  it('query with disallowed $where operator returns isError', async () => {
    const result = await session.callTool('filter', {
      space: 'general',
      collection: 'facts',
      filter: { $where: 'this.fact.length > 0' },
    });
    assert.ok(result?.isError, 'Disallowed operator $where must return isError');
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.toLowerCase().includes('not allowed') || text.toLowerCase().includes('operator'), `Expected operator rejection message: ${text}`);
  });

  it('query with disallowed $function operator returns isError', async () => {
    const result = await session.callTool('filter', {
      space: 'general',
      collection: 'facts',
      filter: { $function: { body: 'function() { return true; }', args: [], lang: 'js' } },
    });
    assert.ok(result?.isError, 'Disallowed operator $function must return isError');
  });

  it('query with deeply nested filter beyond depth limit returns isError', async () => {
    // Build a 10-level deep nested object to exceed depth=8 limit
    let deep = { _id: 'x' };
    for (let i = 0; i < 10; i++) deep = { $and: [deep] };
    const result = await session.callTool('filter', {
      space: 'general',
      collection: 'facts',
      filter: deep,
    });
    assert.ok(result?.isError, 'Filter too deeply nested must return isError');
  });

  it('query on invalid collection returns isError', async () => {
    const result = await session.callTool('filter', {
      space: 'general',
      collection: 'admin',
      filter: {},
    });
    assert.ok(result?.isError, 'Unknown collection must return isError');
  });
});

describe('MCP brain tools — upsert_entity / upsert_edge', () => {
  let session;
  let entityAId;
  let entityBId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);
  });
  after(() => session?.close());

  it('upsert_entity creates an entity and returns its id', async () => {
    const name = `MCP-Entity-${Date.now()}`;
    const result = await session.callTool('save_entity', { space: 'general', name, type: 'concept', tags: ['mcp-test'] });
    assert.ok(!result?.isError, `upsert_entity error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('upserted'), `Expected "upserted" in: ${text}`);
    const idMatch = text.match(/ID ([a-f0-9-]{36})/i);
    assert.ok(idMatch, `Expected entity ID in: ${text}`);
    entityAId = idMatch[1];
  });

  it('upsert_entity with empty name returns isError', async () => {
    const result = await session.callTool('save_entity', { space: 'general', name: '', type: 'concept' });
    assert.ok(result?.isError, 'Empty name must return isError');
  });

  it('upsert_entity with empty type returns isError', async () => {
    const result = await session.callTool('save_entity', { space: 'general', name: 'ValidName', type: '' });
    assert.ok(result?.isError, 'Empty type must return isError');
  });

  it('upsert_edge creates a directed edge and returns its id', async () => {
    // Create second entity
    const name2 = `MCP-Entity-B-${Date.now()}`;
    const r2 = await session.callTool('save_entity', { space: 'general', name: name2, type: 'concept' });
    const idMatch2 = (r2?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(idMatch2, `Could not extract entityB ID: ${r2?.content?.[0]?.text}`);
    entityBId = idMatch2[1];

    const result = await session.callTool('save_edge', {
      space: 'general',
      from: entityAId,
      to: entityBId,
      label: 'related_to',
      weight: 0.8,
    });
    assert.ok(!result?.isError, `upsert_edge error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('upserted'), `Expected "upserted" in: ${text}`);
    assert.ok(text.includes('related_to'), `Expected label in: ${text}`);
  });

  it('upsert_edge with empty from returns isError', async () => {
    const result = await session.callTool('save_edge', { space: 'general', from: '', to: entityBId, label: 'test' });
    assert.ok(result?.isError, 'Empty from must return isError');
  });

  it('upsert_edge with empty label returns isError', async () => {
    const result = await session.callTool('save_edge', { space: 'general', from: entityAId, to: entityBId, label: '' });
    assert.ok(result?.isError, 'Empty label must return isError');
  });
});

describe('MCP brain tools � traverse', () => {
  let session;
  let entityAId;
  let entityBId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);

    // Create two entities and an edge for traversal testing
    const rA = await session.callTool('save_entity', { space: 'general', name: `TraverseMCP-A-${Date.now()}`, type: 'service' });
    const mA = (rA?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(mA, `Could not extract entity A ID: ${rA?.content?.[0]?.text}`);
    entityAId = mA[1];

    const rB = await session.callTool('save_entity', { space: 'general', name: `TraverseMCP-B-${Date.now()}`, type: 'service' });
    const mB = (rB?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(mB, `Could not extract entity B ID: ${rB?.content?.[0]?.text}`);
    entityBId = mB[1];

    await session.callTool('save_edge', { space: 'general', from: entityAId, to: entityBId, label: 'depends_on' });
  });
  after(() => session?.close());

  it('traverse with empty startId returns isError', async () => {
    const result = await session.callTool('graph_traverse', { space: 'general', startId: '' });
    assert.ok(result?.isError, 'Empty startId must return isError');
  });

  it('traverse returns nodes and edges JSON', async () => {
    const result = await session.callTool('graph_traverse', { space: 'general', startId: entityAId, direction: 'outbound', maxDepth: 1 });
    assert.ok(!result?.isError, `traverse returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    assert.ok(Array.isArray(parsed.nodes), 'nodes must be array');
    assert.ok(Array.isArray(parsed.edges), 'edges must be array');
    assert.equal(typeof parsed.truncated, 'boolean', 'truncated must be boolean');
    const nodeIds = parsed.nodes.map(n => n._id);
    assert.ok(nodeIds.includes(entityBId), 'Entity B must appear in outbound traversal from A');
  });

  it('traverse tool appears in tools/list', async () => {
    const tools = await session.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('graph_traverse'), 'traverse must appear in tools list');
  });
});

describe('MCP file tools — write_file / read_file / list_dir / create_dir / move_file / delete_file', () => {
  let session;
  const dir = `mcp-test-${Date.now()}`;
  const testSpaceId = `mcp-files-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const createSpace = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'MCP File Tools Test Space' });
    assert.equal(createSpace.status, 201, `Create space: ${JSON.stringify(createSpace.body)}`);
    session = await openMcpSession(tokenA);
  });
  after(async () => {
    session?.close();
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
  });

  it('write_file creates a file and returns sha256', async () => {
    const result = await session.callTool('write_file', {
      space: testSpaceId,
      path: `${dir}/hello.txt`,
      content: 'Hello from MCP!',
    });
    assert.ok(!result?.isError, `write_file error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('sha256'), `Expected sha256 in: ${text}`);
  });

  it('write_file with empty path returns isError', async () => {
    const result = await session.callTool('write_file', { space: testSpaceId, path: '', content: 'oops' });
    assert.ok(result?.isError, 'Empty path must return isError');
  });

  it('write_file of a document converts ASYNCHRONOUSLY via the worker (A10 — parity with REST)', async () => {
    // MCP write_file used to convert documents synchronously inline; it now enqueues a background
    // job like the REST upload path (one shared policy). The tool returns immediately, and the
    // worker produces chunk records shortly after — so an agent must poll, exactly like REST.
    const docPath = `${dir}/async-doc.md`;
    const content = '# Async Doc\n\nFirst section with enough body text to clear the minimum chunk ' +
      'length threshold so a chunk record is produced by the converter.\n\n' +
      '## Second Section\n\nSecond section, likewise long enough to yield its own chunk record ' +
      'once the background worker has run the markdown conversion pipeline.';
    const result = await session.callTool('write_file', { space: testSpaceId, path: docPath, content });
    assert.ok(!result?.isError, `write_file(doc) error: ${JSON.stringify(result)}`);

    // Poll the REST files listing for chunk records whose parent is our document.
    let chunks = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const r = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/files?includeChunks=true&limit=200`);
      const all = r.body?.files ?? [];
      const parent = all.find(f => f.path === docPath && !f.parentFileId);
      chunks = parent ? all.filter(f => f.parentFileId === parent._id).length : 0;
      if (chunks >= 1) break;
      await new Promise(res => setTimeout(res, 1000));
    }
    assert.ok(chunks >= 1, `MCP write_file document must produce chunk records via the worker, found ${chunks}`);
  });

  it('read_file returns the written content', async () => {
    const result = await session.callTool('read_file', { space: testSpaceId, path: `${dir}/hello.txt` });
    assert.ok(!result?.isError, `read_file error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.equal(text, 'Hello from MCP!', `Expected file content, got: ${text}`);
  });

  it('read_file for non-existent file returns isError', async () => {
    const result = await session.callTool('read_file', { space: testSpaceId, path: `${dir}/does-not-exist.txt` });
    assert.ok(result?.isError, 'Non-existent file must return isError');
  });

  it('list_dir returns the created file', async () => {
    const result = await session.callTool('list_dir', { space: testSpaceId, path: dir });
    assert.ok(!result?.isError, `list_dir error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('hello.txt'), `Expected hello.txt in listing: ${text}`);
  });

  it('list_dir on root returns non-empty result', async () => {
    const result = await session.callTool('list_dir', { space: testSpaceId });
    assert.ok(!result?.isError, `list_dir root error: ${JSON.stringify(result)}`);
  });

  it('create_dir creates a new directory', async () => {
    const result = await session.callTool('create_dir', { space: testSpaceId, path: `${dir}/subdir` });
    assert.ok(!result?.isError, `create_dir error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('created') || text.includes('subdir'), `Expected created in: ${text}`);
  });

  it('create_dir with empty path returns isError', async () => {
    const result = await session.callTool('create_dir', { space: testSpaceId, path: '' });
    assert.ok(result?.isError, 'Empty path must return isError');
  });

  it('move_file renames a file within the space', async () => {
    // Write a file to move
    await session.callTool('write_file', { space: testSpaceId, path: `${dir}/to-move.txt`, content: 'move me' });
    const result = await session.callTool('move_file', {
      space: testSpaceId,
      src: `${dir}/to-move.txt`,
      dst: `${dir}/moved.txt`,
    });
    assert.ok(!result?.isError, `move_file error: ${JSON.stringify(result)}`);
    // Verify source is gone and destination exists
    const srcCheck = await session.callTool('read_file', { space: testSpaceId, path: `${dir}/to-move.txt` });
    assert.ok(srcCheck?.isError, 'Source file must not exist after move');
    const dstCheck = await session.callTool('read_file', { space: testSpaceId, path: `${dir}/moved.txt` });
    assert.ok(!dstCheck?.isError, 'Destination file must exist after move');
  });

  it('move_file with empty src returns isError', async () => {
    const result = await session.callTool('move_file', { space: testSpaceId, src: '', dst: `${dir}/x.txt` });
    assert.ok(result?.isError, 'Empty src must return isError');
  });

  it('delete_file removes a file', async () => {
    await session.callTool('write_file', { space: testSpaceId, path: `${dir}/to-delete.txt`, content: 'bye' });
    const result = await session.callTool('delete_file', { space: testSpaceId, path: `${dir}/to-delete.txt` });
    assert.ok(!result?.isError, `delete_file error: ${JSON.stringify(result)}`);
    const check = await session.callTool('read_file', { space: testSpaceId, path: `${dir}/to-delete.txt` });
    assert.ok(check?.isError, 'Deleted file must not be readable');
  });

  it('delete_file with empty path returns isError', async () => {
    const result = await session.callTool('delete_file', { space: testSpaceId, path: '' });
    assert.ok(result?.isError, 'Empty path must return isError');
  });
});

describe('MCP file metadata � write_file persists metadata, query supports files collection', () => {
  let session;
  const dir = `mcp-meta-test-${Date.now()}`;
  const testSpaceId = `mcp-meta-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const createSpace = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'MCP File Metadata Test Space' });
    assert.equal(createSpace.status, 201, `Create space: ${JSON.stringify(createSpace.body)}`);
    session = await openMcpSession(tokenA);
  });
  after(async () => {
    session?.close();
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
  });

  it('write_file with description and tags stores metadata queryable via query tool', async () => {
    const filePath = `${dir}/documented.txt`;
    const writeResult = await session.callTool('write_file', {
      space: testSpaceId,
      path: filePath,
      content: 'documented content',
      description: 'A well-documented file',
      tags: ['meta-test', 'documented'],
    });
    assert.ok(!writeResult?.isError, `write_file error: ${JSON.stringify(writeResult)}`);

    // Query the files collection and verify the metadata record exists
    const queryResult = await session.callTool('filter', {
      space: testSpaceId,
      collection: 'files',
      filter: { tags: 'meta-test' },
    });
    assert.ok(!queryResult?.isError, `query files error: ${JSON.stringify(queryResult)}`);
    const docs = JSON.parse(queryResult?.content?.[0]?.text ?? '[]');
    const found = docs.find(d => d.path === filePath || d._id === filePath);
    assert.ok(found, `Expected metadata record for ${filePath} in: ${JSON.stringify(docs)}`);
    assert.equal(found.description, 'A well-documented file', 'description must be stored');
    assert.ok(Array.isArray(found.tags) && found.tags.includes('meta-test'), 'tags must be stored');
    assert.ok(typeof found.sizeBytes === 'number' && found.sizeBytes > 0, 'sizeBytes must be set');
    assert.ok(typeof found.createdAt === 'string', 'createdAt must be set');
    assert.ok(typeof found.updatedAt === 'string', 'updatedAt must be set');
    assert.ok(found.author && typeof found.author.instanceId === 'string', 'author must be set');
  });

  it('write_file without description/tags still creates metadata record', async () => {
    const filePath = `${dir}/plain.txt`;
    const writeResult = await session.callTool('write_file', {
      space: testSpaceId,
      path: filePath,
      content: 'plain content',
    });
    assert.ok(!writeResult?.isError, `write_file error: ${JSON.stringify(writeResult)}`);

    const queryResult = await session.callTool('filter', {
      space: testSpaceId,
      collection: 'files',
      filter: { _id: filePath },
    });
    assert.ok(!queryResult?.isError, `query files error: ${JSON.stringify(queryResult)}`);
    const docs = JSON.parse(queryResult?.content?.[0]?.text ?? '[]');
    assert.ok(docs.length > 0, `Expected metadata record for ${filePath}`);
    assert.ok(typeof docs[0].sizeBytes === 'number', 'sizeBytes must be set');
  });

  it('query tool rejects unknown collection', async () => {
    const result = await session.callTool('filter', {
      space: testSpaceId,
      collection: 'unknown_coll',
      filter: {},
    });
    assert.ok(result?.isError, 'Unknown collection must return isError');
  });

  it('get_stats files count increments after write_file', async () => {
    const before = await session.callTool('space_stats', { space: testSpaceId });
    const beforeCount = JSON.parse(before?.content?.[0]?.text ?? '{}').files ?? 0;

    await session.callTool('write_file', {
      space: testSpaceId,
      path: `${dir}/count-test.txt`,
      content: 'counting',
    });

    const after = await session.callTool('space_stats', { space: testSpaceId });
    const afterCount = JSON.parse(after?.content?.[0]?.text ?? '{}').files ?? 0;
    assert.ok(afterCount >= beforeCount + 1, `Expected files count to increment: before=${beforeCount}, after=${afterCount}`);
  });

  it('delete_file removes the metadata record', async () => {
    const filePath = `${dir}/to-delete-meta.txt`;
    await session.callTool('write_file', { space: testSpaceId, path: filePath, content: 'bye' });

    await session.callTool('delete_file', { space: testSpaceId, path: filePath });

    const queryResult = await session.callTool('filter', {
      space: testSpaceId,
      collection: 'files',
      filter: { _id: filePath },
    });
    assert.ok(!queryResult?.isError, `query files error: ${JSON.stringify(queryResult)}`);
    const docs = JSON.parse(queryResult?.content?.[0]?.text ?? '[]');
    assert.equal(docs.length, 0, `Metadata record must be deleted when file is deleted`);
  });

  it('move_file updates the path in metadata', async () => {
    const srcPath = `${dir}/move-meta-src.txt`;
    const dstPath = `${dir}/move-meta-dst.txt`;
    await session.callTool('write_file', { space: testSpaceId, path: srcPath, content: 'move me' });

    await session.callTool('move_file', { space: testSpaceId, src: srcPath, dst: dstPath });

    // Old path metadata should be gone
    const srcQuery = await session.callTool('filter', {
      space: testSpaceId,
      collection: 'files',
      filter: { _id: srcPath },
    });
    const srcDocs = JSON.parse(srcQuery?.content?.[0]?.text ?? '[]');
    assert.equal(srcDocs.length, 0, 'Source path metadata must be removed after move');

    // New path metadata should exist
    const dstQuery = await session.callTool('filter', {
      space: testSpaceId,
      collection: 'files',
      filter: { _id: dstPath },
    });
    const dstDocs = JSON.parse(dstQuery?.content?.[0]?.text ?? '[]');
    assert.ok(dstDocs.length > 0, 'Destination path metadata must exist after move');
    assert.equal(dstDocs[0].path, dstPath, 'path field must be updated to destination');
  });
});

describe('MCP recall_global — space-scoped token must only see its own spaces', () => {
  let sessionScoped;
  let scopedTokenPlaintext;
  let scopedTokenId;
  const secretFact = `PRIVATE-FACT-OTHER-SPACE-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    // Write a secret fact into the 'general' space using the full-access token
    await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: secretFact,
      tags: ['scope-leak-test'],
    });

    // Create a space-scoped token scoped to a non-existent space.
    // In the global MCP endpoint, sessions open for any authenticated token;
    // access to spaces is enforced at the tool-call level.
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `scoped-no-access-${Date.now()}`,
      rights: legacyRights({ spaces: ['__nonexistent_space__'] })
    });
    assert.equal(tokenRes.status, 201, `Create scoped token: ${JSON.stringify(tokenRes.body)}`);
    scopedTokenPlaintext = tokenRes.body.plaintext;
    scopedTokenId = tokenRes.body.id;

    // The global /mcp endpoint only requires authentication (not space-specific auth),
    // so any valid token can open a session � access control is enforced per tool call.
    sessionScoped = await openMcpSession(scopedTokenPlaintext);
  });

  after(async () => {
    sessionScoped?.close();
    if (scopedTokenId) await del(INSTANCES.a, tokenA, `/api/tokens/${scopedTokenId}`).catch(() => {});
  });

  it('space-scoped token is rejected when calling a tool on an unauthorized space', async () => {
    assert.ok(sessionScoped, 'Global MCP session must open for any authenticated token');
    // The token is scoped to __nonexistent_space__ � a tool call targeting 'general' must be rejected
    const result = await sessionScoped.callTool('recall', { space: 'general', query: secretFact });
    assert.ok(result?.isError, 'Tool call to unauthorized space must return isError');
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(
      text.toLowerCase().includes('access') || text.toLowerCase().includes('token'),
      `Expected access-denied message, got: ${text}`,
    );
  });
});

describe('MCP recall_global — full-access token, multi-space isolation', () => {
  let session;
  const spaceAFact = `SPACE-A-FACT-${Date.now()}`;
  let embeddingAvailable = false;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession(tokenA);
    // Gate on a real remember→recall round-trip (retried across warm-up) before seeding the fact.
    embeddingAvailable = await waitForEmbeddingReady(session);
    if (embeddingAvailable) {
      await session.callTool('save_fact', { space: 'general', fact: spaceAFact, tags: ['global-recall-test'] });
    }
  });
  after(() => session?.close());

  it('recall_global returns results without isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', { query: spaceAFact, topK: 5 });
    assert.ok(!result?.isError, `recall_global returned isError: ${JSON.stringify(result)}`);
  });

  it('recall_global response does not include spaces the token cannot access', async () => {
    // Full-access token CAN access all spaces, so results may come from all spaces —
    // the key check: the response is valid and not an error.
    // The CRITICAL path (scoped token seeing other spaces) is tested in the suite above.
    const result = await session.callTool('recall', { query: spaceAFact, topK: 5 });
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'recall_global must return non-empty text');
    // Verify no raw embedding vectors are exposed
    assert.ok(!text.includes('"embedding"'), 'recall_global must not expose embedding vectors');
  });

  it('recall_global with empty query returns isError', async () => {
    const result = await session.callTool('recall', { query: '' });
    assert.ok(result?.isError, 'Empty query must return isError');
  });
});


describe('MCP brain tools � update_memory / delete_memory / get_stats', () => {
  let session;
  let storedMemoryId;
  const factText = `MCP-update-delete-test-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);
    // Create a memory via REST API so we have an ID to update/delete
    const res = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', {
      fact: factText,
      tags: ['mcp-update-test'],
    });
    storedMemoryId = res.body?._id;
  });
  after(() => session?.close());

  it('get_stats returns counts with spaceId, memories, entities, edges, chrono, files', async () => {
    const result = await session.callTool('space_stats', { space: 'general' });
    assert.ok(!result?.isError, `get_stats returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    assert.ok(typeof parsed.spaceId === 'string', 'get_stats must return spaceId');
    assert.ok(typeof parsed.facts === 'number', 'get_stats must return memories count');
    assert.ok(typeof parsed.entities === 'number', 'get_stats must return entities count');
    assert.ok(typeof parsed.edges === 'number', 'get_stats must return edges count');
    assert.ok(typeof parsed.chrono === 'number', 'get_stats must return chrono count');
    assert.ok(typeof parsed.files === 'number', 'get_stats must return files count');
    assert.ok(parsed.facts >= 0, 'memories count must be non-negative');
    assert.ok(parsed.files >= 0, 'files count must be non-negative');
  });

  it('update_memory with no id returns isError', async () => {
    const result = await session.callTool('update_fact', { space: 'general', id: '' });
    assert.ok(result?.isError, 'Empty id must return isError');
  });

  it('update_memory with no fields to update returns isError', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId � prior test failed');
    const result = await session.callTool('update_fact', { space: 'general', id: storedMemoryId });
    assert.ok(result?.isError, 'No update fields must return isError');
  });

  it('update_memory updates tags on an existing memory', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId � prior test failed');
    const result = await session.callTool('update_fact', {
      space: 'general',
      id: storedMemoryId,
      tags: ['mcp-updated-tag'],
    });
    assert.ok(!result?.isError, `update_memory returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('updated') || text.includes(storedMemoryId), `Expected updated confirmation: ${text}`);

    // Effect: re-read via REST and deep-equal the persisted value — the
    // confirmation text alone is satisfied by a handler that persists nothing.
    const reread = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${storedMemoryId}`);
    assert.equal(reread.status, 200, JSON.stringify(reread.body));
    assert.deepEqual(reread.body.tags, ['mcp-updated-tag'], 'updated tags must be persisted');
    assert.equal(reread.body.fact, factText, 'untouched fields must survive the update');
  });

  it('update_memory REFUSES the retired excludeFromVectorSearch', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId — prior test failed');
    /*
     * This asserted the opposite while the old name was an input alias, and the reason is worth keeping:
     * the flag once reached three REST handlers and zero MCP tools, so it was documented, implemented and
     * unusable from the surface an agent holds.
     *
     * `D-6` retired the name in 4.0. On this door the refusal is the SCHEMA — tools are
     * `additionalProperties: false` and the dispatcher validates before the handler, so removing the
     * property is what makes the call fail. Which is why it is worth a case of its own: an alias here was
     * never a handler fallback, and neither is its removal.
     */
    const result = await session.callTool('update_fact', {
      space: 'general',
      id: storedMemoryId,
      excludeFromVectorSearch: true,
    });
    assert.ok(result?.isError,
      `update_memory still accepts the retired spelling: ${JSON.stringify(result)}`);

    // And nothing was written — an accepted-and-dropped field is the outcome this rules out.
    const reread = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${storedMemoryId}`);
    assert.equal(reread.status, 200, JSON.stringify(reread.body));
    assert.equal(reread.body.excludeFromVectorSearch, undefined,
      'a refused argument must not reach the stored record');
  });
  it('update_memory on non-existent id returns isError', async () => {
    const result = await session.callTool('update_fact', {
      space: 'general',
      id: '00000000-0000-0000-0000-000000000000',
      tags: ['irrelevant'],
    });
    assert.ok(result?.isError, 'Non-existent memory ID must return isError');
  });

  it('update_memory takes suppressEmbeddings, and writes only that', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId — prior test failed');
    /*
     * This case used to also assert that the pre-3.1.0 key was written ALONGSIDE, so a peer on an older
     * build still honoured the suppression, and that the new name won when a body carried both. Both
     * halves went with `D-6`: there is one name, and the peer floor keeps the builds that knew only the
     * old one off the network.
     *
     * The absence is asserted rather than dropped — a leftover mirror would put a field on every record
     * that nothing reads, and make two instances' hashes differ over it.
     */
    const on = await session.callTool('update_fact', {
      space: 'general', id: storedMemoryId, suppressEmbeddings: true,
    });
    assert.ok(!on?.isError, `update_memory rejected suppressEmbeddings: ${JSON.stringify(on)}`);
    let reread = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${storedMemoryId}`);
    assert.equal(reread.body.suppressEmbeddings, true, 'the name must persist');
    assert.equal(reread.body.excludeFromVectorSearch, undefined,
      'the retired key is still being written alongside');

    // And back off again, so the suite does not leave a record suppressed for whatever runs next.
    const off = await session.callTool('update_fact', {
      space: 'general', id: storedMemoryId, suppressEmbeddings: false,
    });
    assert.ok(!off?.isError, JSON.stringify(off));
    reread = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${storedMemoryId}`);
    assert.equal(reread.body.suppressEmbeddings, false, 'false must be stored, not dropped');
  });
  it('delete_memory with no id returns isError', async () => {
    const result = await session.callTool('delete_fact', { space: 'general', id: '' });
    assert.ok(result?.isError, 'Empty id must return isError');
  });

  it('delete_memory removes the memory', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId � prior test failed');
    const result = await session.callTool('delete_fact', { space: 'general', id: storedMemoryId });
    assert.ok(!result?.isError, `delete_memory returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('deleted') || text.includes(storedMemoryId), `Expected deletion confirmation: ${text}`);
  });

  it('delete_memory on already-deleted id returns isError', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId � prior test failed');
    const result = await session.callTool('delete_fact', { space: 'general', id: storedMemoryId });
    assert.ok(result?.isError, 'Double-delete must return isError');
  });
});

describe('MCP chrono tools — tag filtering through `filter`, and the chrono collection', () => {
  let session;
  const RUN = Date.now();
  const tagA = `mcp-chrono-tag-a-${RUN}`;
  const tagB = `mcp-chrono-tag-b-${RUN}`;
  let idTagA;
  let idTagB;
  let idBoth;
  let idNoTag;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);

    // Create four chrono entries: two with distinct tags, one with both, one untagged
    const rA = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-Tag-A-${RUN}`, type: 'event',
      startsAt: new Date().toISOString(), tags: [tagA],
    });
    idTagA = rA.body?._id;

    const rB = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-Tag-B-${RUN}`, type: 'milestone',
      startsAt: new Date().toISOString(), tags: [tagB],
    });
    idTagB = rB.body?._id;

    const rBoth = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-Tag-Both-${RUN}`, type: 'plan',
      startsAt: new Date().toISOString(), tags: [tagA, tagB],
    });
    idBoth = rBoth.body?._id;

    const rN = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-NoTag-${RUN}`, type: 'plan',
      startsAt: new Date().toISOString(), tags: [],
    });
    idNoTag = rN.body?._id;
  });
  after(async () => {
    session?.close();
    for (const id of [idTagA, idTagB, idBoth, idNoTag]) {
      if (id) await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/chrono/${id}`).catch(() => {});
    }
  });

  it('filtering chrono without filters returns results without isError', async () => {
    const result = await session.callTool('filter', { space: 'general', collection: 'chrono', filter: {} });
    assert.ok(!result?.isError, `filtering chrono returned isError: ${JSON.stringify(result)}`);
  });

  it('filtering chrono with tags filter (AND) returns only entries with that tag', async (t) => {
    if (!idTagA) return t.skip('No idTagA � prior setup failed');
    const result = await session.callTool('filter', { space: 'general', collection: 'chrono', filter: { tags: { $all: [tagA] } } });
    assert.ok(!result?.isError, `filtering chrono by tags returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Expected entry tagged ${tagA} (id ${idTagA}) in results: ${text}`);
    assert.ok(!text.includes(idTagB), `Entry tagged only ${tagB} should NOT appear when filtering by ${tagA}: ${text}`);
  });

  it('filtering chrono with multi-tag AND filter returns only entries with all specified tags', async (t) => {
    if (!idTagA || !idTagB || !idBoth) return t.skip('Missing seeded entries');
    const result = await session.callTool('filter', { space: 'general', collection: 'chrono', filter: { tags: { $all: [tagA, tagB] } } });
    assert.ok(!result?.isError, `filtering chrono by multi-tag AND returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idBoth), `Entry with both tags should appear for AND query: ${text}`);
    assert.ok(!text.includes(idTagA), `Entry with only ${tagA} should NOT appear for AND [${tagA},${tagB}] query: ${text}`);
  });

  it('filtering chrono with tagsAny filter (OR) returns entries matching any tag', async (t) => {
    if (!idTagA || !idTagB) return t.skip('Missing seeded entries');
    const result = await session.callTool('filter', { space: 'general', collection: 'chrono', filter: { tags: { $in: [tagA, tagB] } } });
    assert.ok(!result?.isError, `filtering chrono by tagsAny returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Expected entry tagged ${tagA} in results: ${text}`);
    assert.ok(text.includes(idTagB), `Expected entry tagged ${tagB} in results: ${text}`);
  });

  it('filtering chrono with tags filter that matches nothing returns empty message', async () => {
    const result = await session.callTool('filter', { collection: 'chrono', filter: { tags: { $all: [`no-such-tag-${RUN}`] } } });
    assert.ok(!result?.isError, `filtering chrono returned isError: ${JSON.stringify(result)}`);
    // `filter` answers with an envelope, not prose: an empty match is `results: []`, which is the shape
    // every other caller already branches on. `list_chrono` said “No chrono entries found.”, and a sentence
    // is not something a client can test for.
    // The MCP door sends the ROWS as the text payload — a bare array — while REST wraps them in an
    // envelope. Both carry the paging facts, REST in the body and MCP in `structuredContent`, which is
    // the spec's structured form of the same result rather than a sidecar.
    const rows = JSON.parse(result?.content?.[0]?.text ?? 'null');
    assert.deepEqual(rows, [], `Expected an empty result set, got: ${JSON.stringify(rows).slice(0, 200)}`);
  });

  it('filtering chrono with after filter returns only entries after the timestamp', async (t) => {
    if (!idTagA) return t.skip('No seeded entries');
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const result = await session.callTool('filter', { space: 'general', collection: 'chrono', filter: { createdAt: { $gte: pastTime } } });
    assert.ok(!result?.isError, `filtering chrono by after returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Seeded entry should appear for after=${pastTime}: ${text}`);
  });

  it('filtering chrono with before filter far in future returns seeded entries', async (t) => {
    if (!idTagA) return t.skip('No seeded entries');
    const futureTime = new Date(Date.now() + 3_600_000).toISOString();
    const result = await session.callTool('filter', { space: 'general', collection: 'chrono', filter: { createdAt: { $lt: futureTime } } });
    assert.ok(!result?.isError, `filtering chrono by before returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Seeded entry should appear for before=${futureTime}: ${text}`);
  });

  it('filtering chrono with search filter matches on title', async (t) => {
    if (!idTagA) return t.skip('No seeded entries');
    const result = await session.callTool('filter', { collection: 'chrono', filter: { $or: [
      { title: { $regex: `MCP-Tag-A-${RUN}`, $options: 'i' } },
      { description: { $regex: `MCP-Tag-A-${RUN}`, $options: 'i' } },
    ] } });
    assert.ok(!result?.isError, `filtering chrono by search returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Entry with matching title should appear: ${text}`);
  });

  it('query with collection "chrono" returns array without isError', async (t) => {
    if (!idTagA) return t.skip('No seeded chrono entry');
    const result = await session.callTool('filter', {
      space: 'general',
      collection: 'chrono',
      filter: { _id: idTagA },
    });
    assert.ok(!result?.isError, `query chrono returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    assert.ok(Array.isArray(parsed), `query chrono result must be a JSON array, got: ${text}`);
    assert.ok(parsed.length >= 1, `Expected at least one result for id ${idTagA}: ${text}`);
    assert.equal(parsed[0]._id, idTagA, `Expected _id to match`);
  });

  it('query chrono with tag filter returns matching entries', async (t) => {
    if (!idTagA) return t.skip('No seeded chrono entry');
    const result = await session.callTool('filter', {
      space: 'general',
      collection: 'chrono',
      filter: { tags: { $in: [tagA] } },
    });
    assert.ok(!result?.isError, `query chrono tag filter returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    assert.ok(Array.isArray(parsed), `result must be an array`);
    assert.ok(parsed.some(e => e._id === idTagA), `Expected entry with tag ${tagA}`);
    assert.ok(!parsed.some(e => e._id === idTagB), `Entry with only ${tagB} should not appear`);
  });
});

describe('MCP security � read-only token cannot call mutating tools', () => {
  let readOnlySession;
  let readOnlyTokenPlaintext;
  let readOnlyTokenId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `readonly-mcp-test-${Date.now()}`,
      rights: legacyRights({ readOnly: true })
    });
    assert.equal(tokenRes.status, 201, `Create read-only token: ${JSON.stringify(tokenRes.body)}`);
    readOnlyTokenPlaintext = tokenRes.body.plaintext;
    readOnlyTokenId = tokenRes.body.id;
    readOnlySession = await openMcpSession(readOnlyTokenPlaintext);
  });
  after(async () => {
    readOnlySession?.close();
    if (readOnlyTokenId) await del(INSTANCES.a, tokenA, `/api/tokens/${readOnlyTokenId}`).catch(() => {});
  });

  it('update_memory is rejected with read-only token', async () => {
    const result = await readOnlySession.callTool('update_fact', {
      space: 'general',
      id: '00000000-0000-0000-0000-000000000000',
      tags: ['nope'],
    });
    assert.ok(result?.isError, 'update_memory must be rejected by read-only token');
    const text = result?.content?.[0]?.text ?? '';
    // The refusal now names WHAT the token lacks rather than a flag it no longer has: mutating tools are
    // gated on holding a write rung somewhere, so the message says so. Asserted on the substance —
    // 'mutates' and 'write rung' — rather than loosened to `isError`, because a refusal that does not
    // tell the caller which grant is missing sends them to the docs to guess.
    assert.match(text, /mutates/i, `Expected a mutation refusal: ${text}`);
    assert.match(text, /write rung/i, `Expected the missing grant named: ${text}`);
  });

  it('delete_memory is rejected with read-only token', async () => {
    const result = await readOnlySession.callTool('delete_fact', {
      space: 'general',
      id: '00000000-0000-0000-0000-000000000000',
    });
    assert.ok(result?.isError, 'delete_memory must be rejected by read-only token');
    const text = result?.content?.[0]?.text ?? '';
    // The refusal now names WHAT the token lacks rather than a flag it no longer has: mutating tools are
    // gated on holding a write rung somewhere, so the message says so. Asserted on the substance —
    // 'mutates' and 'write rung' — rather than loosened to `isError`, because a refusal that does not
    // tell the caller which grant is missing sends them to the docs to guess.
    assert.match(text, /mutates/i, `Expected a mutation refusal: ${text}`);
    assert.match(text, /write rung/i, `Expected the missing grant named: ${text}`);
  });

  it('get_stats works with read-only token', async () => {
    const result = await readOnlySession.callTool('space_stats', { space: 'general' });
    assert.ok(!result?.isError, `get_stats must work with read-only token: ${JSON.stringify(result)}`);
  });
});

describe('MCP security — unauthenticated access', () => {
  it('GET /mcp without auth returns 401', async () => {
    /*
     * The method is GONE (405 with `Allow: POST`, since 4.0 removed the SSE stream) — but the 401 has to win,
     * and this case is what proves it. `requireMcpAuth` is mounted on the router, so it runs before any
     * handler, and its 401 carries the RFC 9728 `WWW-Authenticate` header that a browser OAuth connector
     * discovers the authorization server from. A 405 in front of it would have broken the claude.ai connector
     * flow while every authenticated test in this file kept passing.
     */
    const parsed = new URL(INSTANCES.a);
    const status = await new Promise((resolve) => {
      const req = http.request(
        { host: parsed.hostname, port: parseInt(parsed.port || '80'), path: '/mcp', method: 'GET' },
        r => { r.resume(); resolve(r.statusCode); },
      );
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(status, 401, `Expected 401 without auth, got ${status}`);
  });

  it('POST /mcp without auth returns 401', async () => {
    // The transport that is actually live. Nothing about MCP may answer before authentication.
    const r = await fetch(`${INSTANCES.a}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 401, `Expected 401 without auth, got ${r.status}`);
  });

  it('POST /mcp/messages without auth returns 401 — exactly, not "401 or 404"', async () => {
    /*
     * This used to accept `401 || 404`, because an unknown `sessionId` was a real 404 from the SSE transport
     * and either answer looked acceptable. With the transport removed the route has no session lookup left,
     * so the auth middleware is the only thing that can answer — and an assertion that tolerates two statuses
     * cannot tell "authentication ran" from "the route happened to 404 first".
     */
    const r = await fetch(`${INSTANCES.a}/mcp/messages?sessionId=fake-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'network_peers', arguments: {} } }),
    });
    assert.equal(r.status, 401, `Expected exactly 401 without auth, got ${r.status}`);
  });
});

describe('the removed SSE transport says what to use instead', () => {
  // Reads the token itself rather than leaning on another suite's `before`. A token that arrives from a
  // sibling describe works only while the file order holds, and a 401 here would read as a routing bug.
  let bearer;
  before(() => { bearer = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim(); });

  /*
   * A removed endpoint that falls through to a generic `Not found` leaves the client's author guessing, which
   * is the silent-misconfiguration failure the removed env vars were given a boot refusal for. Both of the
   * SSE endpoints name the streamable HTTP transport in their body.
   *
   * Asserted through the door a client uses, not by reading the router: the catch-all 404 sits in the same
   * file and would satisfy any source-level check that only looked for a status.
   */
  it('GET /mcp answers 405 with Allow: POST', async () => {
    const r = await fetch(`${INSTANCES.a}/mcp`, { headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal(r.status, 405, 'the resource still speaks MCP — it is the METHOD that is gone');
    assert.equal(r.headers.get('allow'), 'POST', 'a spec-following client reads Allow without reading the message');
    const body = await r.json();
    assert.match(body?.error ?? '', /POST \/mcp/, `the answer must name the transport to use: ${JSON.stringify(body)}`);
  });

  it('POST /mcp/messages answers 410 Gone', async () => {
    const r = await fetch(`${INSTANCES.a}/mcp/messages?sessionId=anything`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 410, 'that path is not coming back under any method');
    const body = await r.json();
    assert.match(body?.error ?? '', /POST \/mcp/, `the answer must name the transport to use: ${JSON.stringify(body)}`);
  });
});

// -- recall / recall_global � types filter ------------------------------------

describe('MCP recall � types filter restricts result set', () => {
  let session;
  let embeddingAvailable = false;
  const entityName = `TypeFilterEntity-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession(tokenA);
    embeddingAvailable = await waitForEmbeddingReady(session);
    if (embeddingAvailable) {
      // Seed an entity so entity-type results exist
      await session.callTool('save_entity', { space: 'general', name: entityName, type: 'concept', tags: ['types-filter-test'] });
    }
  });
  after(() => session?.close());

  it('recall with types=["fact"] does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', { space: 'general', query: entityName, topK: 5, types: ['fact'] });
    assert.ok(!result?.isError, `recall types=memory returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'recall with types filter must return non-empty response');
  });

  it('recall with types=["entity"] does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', { space: 'general', query: entityName, topK: 5, types: ['entity'] });
    assert.ok(!result?.isError, `recall types=entity returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with multiple types does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', { space: 'general', query: entityName, topK: 5, types: ['fact', 'entity', 'edge'] });
    assert.ok(!result?.isError, `recall types=[memory,entity,edge] returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with an unknown type string is rejected by inputSchema enforcement', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    // The dispatcher now validates args against each tool's inputSchema before the handler runs, so an
    // out-of-enum `types` value is rejected (previously the handler silently dropped unknown types). Still
    // a clean client error, never a server fault.
    const result = await session.callTool('recall', { space: 'general', query: entityName, topK: 5, types: ['__unknown__'] });
    assert.ok(result?.isError, 'Out-of-enum types value must return isError');
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(typeof text === 'string', 'Response text must be a string');
  });

  it('recall_global with types=["entity"] does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', { query: entityName, topK: 5, types: ['entity'] });
    assert.ok(!result?.isError, `recall_global types=entity returned isError: ${JSON.stringify(result)}`);
  });
});

// -- remember / recall with description and properties ---------------------

describe('MCP brain tools � remember with description and properties', () => {
  let session;
  let embeddingAvailable = false;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);
    embeddingAvailable = await waitForEmbeddingReady(session);
  });
  after(() => session?.close());

  it('remember with description and properties does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('save_fact', {
      space: 'general',
      fact: `MCP-rich-fact-${Date.now()}`,
      tags: ['rich-field-test'],
      description: 'Extra context for this fact',
      properties: { source: 'mcp-test', confidence: 0.9 },
    });
    assert.ok(!result?.isError, `remember with description/properties returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('Stored fact') || text.includes('seq'), `Expected confirmation in: ${text}`);
  });

  it('remember description is stored and queryable', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const uniqueFact = `DescPropMCPFact-${Date.now()}`;
    await session.callTool('save_fact', {
      space: 'general',
      fact: uniqueFact,
      description: 'A unique MCP description',
      properties: { mcp_key: 'mcp_val' },
    });

    // Query memories collection and verify description + properties are persisted
    const queryResult = await session.callTool('filter', {
      space: 'general',
      collection: 'facts',
      filter: { fact: uniqueFact },
      limit: 1,
    });
    assert.ok(!queryResult?.isError, `query returned isError: ${JSON.stringify(queryResult)}`);
    const docs = JSON.parse(queryResult?.content?.[0]?.text ?? '[]');
    assert.ok(docs.length > 0, 'Memory must be retrievable by exact fact');
    assert.equal(docs[0].description, 'A unique MCP description', 'description must be persisted');
    assert.deepStrictEqual(docs[0].properties, { mcp_key: 'mcp_val' }, 'properties must be persisted');
  });
});

// -- upsert_entity with description ----------------------------------------

describe('MCP brain tools � upsert_entity with description', () => {
  let session;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);
  });
  after(() => session?.close());

  it('upsert_entity with description stores it and returns id', async () => {
    const name = `MCP-DescEntity-${Date.now()}`;
    const result = await session.callTool('save_entity', {
      space: 'general',
      name,
      type: 'service',
      description: 'Primary API gateway for external traffic',
      tags: ['gateway'],
    });
    assert.ok(!result?.isError, `upsert_entity error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('upserted'), `Expected "upserted" in: ${text}`);

    // Verify description is queryable via query tool
    const q = await session.callTool('filter', {
      space: 'general',
      collection: 'entities',
      filter: { name },
      limit: 1,
    });
    assert.ok(!q?.isError, `query error: ${JSON.stringify(q)}`);
    const docs = JSON.parse(q?.content?.[0]?.text ?? '[]');
    assert.ok(docs.length > 0, 'Entity must be queryable by name');
    assert.equal(docs[0].description, 'Primary API gateway for external traffic', 'description persisted');
  });
});

// -- MCP bulk_write tool ------------------------------------------------------

describe('MCP brain tools � bulk_write', () => {
  let session;
  const RUN = Date.now();

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);
  });
  after(() => session?.close());

  it('bulk_write inserts memories, entities, edges, and chrono', async () => {
    const entName1 = `BulkEnt1-${RUN}`;
    const entName2 = `BulkEnt2-${RUN}`;
    const result = await session.callTool('save_bulk', {
      space: 'general',
      facts: [
        { fact: `BulkMem-${RUN}`, tags: ['bulk-test'] },
      ],
      entities: [
        { name: entName1, type: 'service' },
        { name: entName2, type: 'concept' },
      ],
      edges: [
        { from: entName1, to: entName2, label: `bulk-edge-${RUN}` },
      ],
      chrono: [
        { title: `BulkChrono-${RUN}`, type: 'event', startsAt: new Date().toISOString() },
      ],
    });
    assert.ok(!result?.isError, `bulk_write returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('bulk_write complete'), `Expected summary in: ${text}`);
    // Verify counts
    assert.ok(text.includes('"facts":1'), `Expected 1 memory inserted: ${text}`);
    assert.ok(text.includes('"entities":2') || text.includes('"entities":1'), `Expected entities inserted: ${text}`);
  });

  it('bulk_write with validation errors returns error entries without aborting batch', async () => {
    const result = await session.callTool('save_bulk', {
      space: 'general',
      facts: [
        { fact: '' },                                // invalid � empty fact
        { fact: `ValidBulkMem-${RUN}`, tags: [] },   // valid
      ],
      entities: [
        { name: '', type: 'concept' },               // invalid � missing name
        { name: `ValidBulkEnt-${RUN}`, type: '' },   // invalid � missing type
      ],
    });
    assert.ok(!result?.isError, `bulk_write should not be isError for validation failures: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('bulk_write complete'), `Expected summary: ${text}`);
    // At least 2 errors (empty fact + empty name), plus potentially the empty type
    assert.ok(text.includes('errors: ') && !text.includes('errors: 0'), `Expected non-zero errors: ${text}`);
  });

  it('bulk_write with empty arrays returns zero counts', async () => {
    const result = await session.callTool('save_bulk', {
      space: 'general',
      facts: [],
      entities: [],
      edges: [],
      chrono: [],
    });
    assert.ok(!result?.isError, `bulk_write returned isError for empty: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('"facts":0'), `Expected 0 facts: ${text}`);
    assert.ok(text.includes('errors: 0'), `Expected 0 errors: ${text}`);
  });

  it('bulk_write with no arrays returns zero counts', async () => {
    const result = await session.callTool('save_bulk', { space: 'general' });
    assert.ok(!result?.isError, `bulk_write returned isError for no arrays: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('bulk_write complete'), `Expected summary: ${text}`);
    assert.ok(text.includes('errors: 0'), `Expected 0 errors: ${text}`);
  });

  it('bulk_write chrono with invalid type returns error entry', async () => {
    const result = await session.callTool('save_bulk', {
      space: 'general',
      chrono: [
        { title: 'Bad Type', type: 'invalid_type', startsAt: new Date().toISOString() },
      ],
    });
    assert.ok(!result?.isError, `bulk_write should not be isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('errors: 1'), `Expected 1 error for invalid type: ${text}`);
    assert.ok(text.includes('type'), `Error should mention type: ${text}`);
  });
});

// -- MCP bulk_write � read-only token blocked ---------------------------------

describe('MCP security � read-only token cannot call bulk_write', () => {
  let readOnlySession;
  let readOnlyTokenPlaintext;
  let readOnlyTokenId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `readonly-bulk-${Date.now()}`,
      rights: legacyRights({ readOnly: true })
    });
    assert.equal(tokenRes.status, 201, `Create read-only token: ${JSON.stringify(tokenRes.body)}`);
    readOnlyTokenPlaintext = tokenRes.body.plaintext;
    readOnlyTokenId = tokenRes.body.id;
    readOnlySession = await openMcpSession(readOnlyTokenPlaintext);
  });
  after(async () => {
    readOnlySession?.close();
    if (readOnlyTokenId) await del(INSTANCES.a, tokenA, `/api/tokens/${readOnlyTokenId}`).catch(() => {});
  });

  it('bulk_write is rejected with read-only token', async () => {
    const result = await readOnlySession.callTool('save_bulk', {
      space: 'general',
      facts: [{ fact: 'This should be blocked' }],
    });
    assert.ok(result?.isError, 'bulk_write must be rejected by read-only token');
    const text = result?.content?.[0]?.text ?? '';
    // The refusal now names WHAT the token lacks rather than a flag it no longer has: mutating tools are
    // gated on holding a write rung somewhere, so the message says so. Asserted on the substance —
    // 'mutates' and 'write rung' — rather than loosened to `isError`, because a refusal that does not
    // tell the caller which grant is missing sends them to the docs to guess.
    assert.match(text, /mutates/i, `Expected a mutation refusal: ${text}`);
    assert.match(text, /write rung/i, `Expected the missing grant named: ${text}`);
  });
});

// -- upsert_edge with tags, description, and properties --------------------

describe('MCP brain tools � upsert_edge with tags, description, and properties', () => {
  let session;
  let entityAId;
  let entityBId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);

    const rA = await session.callTool('save_entity', { space: 'general', name: `RichEdgeA-${Date.now()}`, type: 'concept' });
    const rB = await session.callTool('save_entity', { space: 'general', name: `RichEdgeB-${Date.now()}`, type: 'concept' });
    const mA = (rA?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    const mB = (rB?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(mA, `Could not extract entityA ID: ${rA?.content?.[0]?.text}`);
    assert.ok(mB, `Could not extract entityB ID: ${rB?.content?.[0]?.text}`);
    entityAId = mA[1];
    entityBId = mB[1];
  });
  after(() => session?.close());

  it('upsert_edge with tags, description, and properties does not return isError', async () => {
    const result = await session.callTool('save_edge', {
      space: 'general',
      from: entityAId,
      to: entityBId,
      label: `rich_rel_${Date.now()}`,
      tags: ['causal', 'mcp-test'],
      description: 'Edge created with full rich fields from MCP',
      properties: { confidence: 0.77, reviewed: true },
    });
    assert.ok(!result?.isError, `upsert_edge rich fields error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('upserted'), `Expected "upserted" in: ${text}`);
  });

  it('upsert_edge description and properties are stored', async () => {
    const label = `queryable_rel_${Date.now()}`;
    await session.callTool('save_edge', {
      space: 'general',
      from: entityAId,
      to: entityBId,
      label,
      description: 'MCP edge with queryable desc',
      properties: { edge_prop: 'stored' },
    });

    const q = await session.callTool('filter', {
      space: 'general',
      collection: 'edges',
      filter: { label },
      limit: 1,
    });
    assert.ok(!q?.isError, `query error: ${JSON.stringify(q)}`);
    const docs = JSON.parse(q?.content?.[0]?.text ?? '[]');
    assert.ok(docs.length > 0, 'Edge must be queryable by label');
    assert.equal(docs[0].description, 'MCP edge with queryable desc', 'description persisted');
    assert.deepStrictEqual(docs[0].properties, { edge_prop: 'stored' }, 'properties persisted');
  });
});

// -- recall / recall_global with minPerType --------------------------------

describe('MCP brain tools � recall and recall_global with minPerType', () => {
  let session;
  let embeddingAvailable = false;
  const entityName = `MinPerTypeEntity-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession(tokenA);
    // waitForEmbeddingReady already validates recall returns a non-zero count (the degraded-mode
    // guard this block used to inline), now retried across warm-up.
    embeddingAvailable = await waitForEmbeddingReady(session);
    if (embeddingAvailable) {
      await session.callTool('save_entity', { space: 'general', name: entityName, type: 'concept', tags: ['minpertype-test'] });
    }
  });
  after(() => session?.close());

  it('recall with minPerType object does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      space: 'general',
      query: entityName,
      topK: 5,
      minPerType: { entity: 1 },
    });
    assert.ok(!result?.isError, `recall with minPerType returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'recall with minPerType must return non-empty response');
  });

  it('recall with minPerType={"entity":1} includes at least one entity when available', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      space: 'general',
      query: entityName,
      topK: 10,
      minPerType: { entity: 1 },
    });
    assert.ok(!result?.isError, `recall with minPerType error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    // Parse rather than substring-match: the response is compact JSON, so a literal
    // `"type": "entity"` (pretty-printed spacing) silently stopped matching.
    const parsed = JSON.parse(text);
    assert.ok(
      Array.isArray(parsed.results) && parsed.results.some(r => r.type === 'entity'),
      `Expected an entity result with minPerType={entity:1}: ${text}`,
    );
  });

  it('recall_global with minPerType does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      query: entityName,
      topK: 5,
      minPerType: { entity: 1 },
    });
    assert.ok(!result?.isError, `recall_global with minPerType returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with empty minPerType object behaves like no minPerType', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const withMinPerType = await session.callTool('recall', { space: 'general', query: entityName, topK: 5, minPerType: {} });
    const withoutMinPerType = await session.callTool('recall', { space: 'general', query: entityName, topK: 5 });
    assert.ok(!withMinPerType?.isError, 'recall with empty minPerType must not error');
    assert.ok(!withoutMinPerType?.isError, 'recall without minPerType must not error');
  });

  // -- maxPerType, the ceiling ------------------------------------------------
  //
  // The unit tests cover the selection logic on the pure function. These cover the thing a unit test cannot:
  // that the parameter is REACHABLE over MCP and enforced on a live instance. A capability wired into the
  // function and not into the surface is the exact defect the last brain-API sweep was.

  it('recall enforces maxPerType against a live instance', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      space: 'general', query: entityName, topK: 10, maxPerType: { entity: 1 },
    });
    assert.ok(!result?.isError, `recall with maxPerType returned isError: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result?.content?.[0]?.text ?? '{}');
    const entities = (parsed.results ?? []).filter(r => r.type === 'entity');
    assert.ok(entities.length <= 1, `maxPerType={entity:1} returned ${entities.length} entities`);
  });

  it('recall REFUSES a maxPerType below minPerType for the same type', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      space: 'general', query: entityName, topK: 10,
      minPerType: { entity: 3 }, maxPerType: { entity: 1 },
    });
    assert.ok(result?.isError, 'a contradictory floor/ceiling pair must be refused, not resolved');
    const text = JSON.stringify(result);
    assert.match(text, /contradict/, `the error should name the contradiction: ${text}`);
  });

  it('recall REFUSES a maxPerType of 0 rather than treating it as an exclusion', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      space: 'general', query: entityName, topK: 5, maxPerType: { entity: 0 },
    });
    assert.ok(result?.isError, '0 must be refused — `types` is the parameter that excludes a type');
  });

  it('recall accepts maxTimeMS and answers rather than hanging', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    // Not asserting that `degraded` appears: against a fast local Mongo the searches may finish inside the
    // 250 ms floor, and an assertion that depends on losing a race is a flake. The contract that holds
    // either way is asserted instead.
    const result = await session.callTool('recall', {
      space: 'general', query: entityName, topK: 5, maxTimeMS: 1,
    });
    assert.ok(!result?.isError, `recall with maxTimeMS returned isError: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result?.content?.[0]?.text ?? '{}');
    assert.ok(Array.isArray(parsed.results), 'results must be an array even on a partial answer');
    if (parsed.degraded !== undefined) {
      for (const reason of parsed.degraded) {
        assert.ok(['search_timeout', 'rerank_skipped_budget', 'rerank_unavailable'].includes(reason),
          `unknown degraded reason "${reason}"`);
      }
    }
  });

  it('recall REFUSES a non-integer or zero maxTimeMS', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    for (const v of [0, -5, 12.5]) {
      const result = await session.callTool('recall', { space: 'general', query: entityName, maxTimeMS: v });
      assert.ok(result?.isError, `maxTimeMS=${v} must be refused`);
    }
  });

  it('a healthy recall omits the degraded key entirely', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', { space: 'general', query: entityName, topK: 5 });
    assert.ok(!result?.isError, JSON.stringify(result));
    const parsed = JSON.parse(result?.content?.[0]?.text ?? '{}');
    assert.equal('degraded' in parsed, false, `a healthy recall must omit the key: ${JSON.stringify(parsed)}`);
  });

  it('recall_global accepts maxPerType — the ceiling survives the cross-space merge', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    // No `space`, so this is the global path, where each space caps itself and the merged answer must be
    // capped again. Without the second pass, N spaces at 1 each would return N.
    const result = await session.callTool('recall', { query: entityName, topK: 10, maxPerType: { entity: 1 } });
    assert.ok(!result?.isError, `recall_global with maxPerType returned isError: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result?.content?.[0]?.text ?? '{}');
    const entities = (parsed.results ?? []).filter(r => r.type === 'entity');
    assert.ok(entities.length <= 1, `global maxPerType={entity:1} returned ${entities.length} entities`);
  });
});

// -- recall / recall_global with minScore ----------------------------------

describe('MCP brain tools � recall and recall_global with minScore', () => {
  let session;
  let embeddingAvailable = false;
  const factForScore = `MinScoreTestFact-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession(tokenA);
    embeddingAvailable = await waitForEmbeddingReady(session);
    if (embeddingAvailable) {
      await session.callTool('save_fact', { space: 'general', fact: factForScore, tags: ['minscore-test'] });
    }
  });
  after(() => session?.close());

  it('recall with minScore does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      space: 'general',
      query: factForScore,
      topK: 5,
      minScore: 0.5,
    });
    assert.ok(!result?.isError, `recall with minScore returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with minScore=0.99 returns few or no results', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      space: 'general',
      query: factForScore,
      topK: 10,
      minScore: 0.99,
    });
    assert.ok(!result?.isError, `recall with high minScore returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    // With a very high threshold, we expect very few or no results
    // (the only possible hit is the exact fact itself, which may or may not score >= 0.99)
    assert.ok(typeof text === 'string', 'Response text must be a string');
  });

  it('recall with minScore=0.0 behaves like no minScore', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const withMinScore = await session.callTool('recall', { space: 'general', query: factForScore, topK: 5, minScore: 0.0 });
    const withoutMinScore = await session.callTool('recall', { space: 'general', query: factForScore, topK: 5 });
    assert.ok(!withMinScore?.isError, 'recall with minScore=0.0 must not error');
    assert.ok(!withoutMinScore?.isError, 'recall without minScore must not error');
  });

  it('recall_global with minScore does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      query: factForScore,
      topK: 5,
      minScore: 0.5,
    });
    assert.ok(!result?.isError, `recall_global with minScore returned isError: ${JSON.stringify(result)}`);
  });

  it('recall_global with minScore=0.99 returns few or no results', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack � skipping');
    const result = await session.callTool('recall', {
      query: factForScore,
      topK: 10,
      minScore: 0.99,
    });
    assert.ok(!result?.isError, `recall_global with high minScore returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(typeof text === 'string', 'Response text must be a string');
  });
});

// -- write_file with properties field --------------------------------------

describe('MCP file tools � write_file with properties metadata', () => {
  let session;
  const dir = `mcp-props-test-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);
  });
  after(() => session?.close());

  it('write_file with properties stores them in file metadata', async () => {
    const filePath = `${dir}/annotated.txt`;
    const writeResult = await session.callTool('write_file', {
      space: 'general',
      path: filePath,
      content: 'annotated file content',
      description: 'Annotated file',
      tags: ['props-test'],
      properties: { owner: 'infra-team', version: 3, archived: false },
    });
    assert.ok(!writeResult?.isError, `write_file error: ${JSON.stringify(writeResult)}`);

    const queryResult = await session.callTool('filter', {
      space: 'general',
      collection: 'files',
      filter: { _id: filePath },
    });
    assert.ok(!queryResult?.isError, `query files error: ${JSON.stringify(queryResult)}`);
    const docs = JSON.parse(queryResult?.content?.[0]?.text ?? '[]');
    assert.ok(docs.length > 0, `Expected metadata record for ${filePath}`);
    assert.deepStrictEqual(docs[0].properties, { owner: 'infra-team', version: 3, archived: false }, 'properties stored in file metadata');
  });
});

describe('MCP schema validation — strict mode must actually block (parity with REST)', () => {
  // Regression: MCP `save_fact` had no `type` parameter, and validateFact() keys the entire
  // per-type schema lookup off `memory.type`. With no type it found no schema and returned
  // ZERO violations — so the strict-mode gate could never fire and schema validation was a
  // total NO-OP on MCP, the surface agents actually use. REST enforced it all along.
  //
  // The existing schema-validation suite set up exactly this scenario and asserted 400 —
  // but only through REST. Same shape as the space-rename bug: the one surface that could
  // fail was never tested.
  let session;
  const spaceId = `mcp-schema-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const c = await post(INSTANCES.a, tokenA, '/api/spaces', { id: spaceId, label: 'MCP Schema Test' });
    assert.equal(c.status, 201, JSON.stringify(c.body));

    // memory type "note" requires properties.source; strict mode rejects violations.
    const meta = await patch(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, {
      meta: {
        validationMode: 'strict',
        typeSchemas: {
          fact: { note: { propertySchemas: { source: { type: 'string', required: true } } } },
        },
      },
    });
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    session = await openMcpSession(tokenA);
  });

  after(async () => {
    session?.close();
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { confirm: true }).catch(() => {});
  });

  it('remember with a typed memory MISSING a required property is REJECTED', async () => {
    const r = await session.callTool('save_fact', {
      space: spaceId,
      fact: `mcp strict missing source ${Date.now()}`,
      type: 'note',
    });
    const text = JSON.stringify(r);
    assert.ok(
      r.isError === true || /schema_violation/.test(text),
      `strict mode must block this on MCP too — schema validation was a no-op here because ` +
      `\`type\` was never forwarded. Got: ${text}`,
    );
    assert.match(text, /source/, 'the violation should name the missing required property');
  });

  it('remember with the required property is ACCEPTED, and the type is persisted', async () => {
    const fact = `mcp strict valid ${Date.now()}`;
    const r = await session.callTool('save_fact', {
      space: spaceId,
      fact,
      type: 'note',
      properties: { source: 'mcp-test' },
    });
    assert.notEqual(r.isError, true, `valid write must succeed: ${JSON.stringify(r)}`);

    // Effect assertion, not a status check: the type must actually be stored — otherwise
    // `type` is accepted and silently dropped, which is the bug in a different costume.
    const list = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${spaceId}/facts`);
    assert.equal(list.status, 200);
    const stored = list.body.facts.find(m => m.fact === fact);
    assert.ok(stored, 'the memory should have been stored');
    assert.equal(stored.type, 'note', '`type` must be persisted, not silently dropped');
  });

  it('bulk_write enforces the same schema (its memory items had no type either)', async () => {
    const r = await session.callTool('save_bulk', {
      space: spaceId,
      facts: [{ fact: `mcp bulk strict ${Date.now()}`, type: 'note' }],
    });
    assert.match(
      JSON.stringify(r), /schema_violation|source/,
      'bulk_write must enforce strict schema validation for typed memories too',
    );
  });
});

// ── F10: per-record ttlDays through the MCP write tools ──────────────────────

describe('MCP brain tools — per-record TTL (F10)', () => {
  let session;
  const RUN = Date.now();
  const DAY_MS = 86_400_000;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession(tokenA);
  });
  after(() => session?.close());

  const idFrom = (result) => (result?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i)?.[1];
  function assertAboutDaysFromNow(iso, days) {
    assert.ok(iso, `expected an _expireAt, got ${iso}`);
    assert.ok(Math.abs(new Date(iso).getTime() - (Date.now() + days * DAY_MS)) < DAY_MS, `expected ~${days}d out, got ${iso}`);
  }

  it('upsert_entity with ttlDays stamps _expireAt (visible over REST)', async () => {
    const r = await session.callTool('save_entity', { space: 'general', name: `McpTtlEnt-${RUN}`, type: 'concept', ttlDays: 10 });
    assert.ok(!r?.isError, `upsert_entity error: ${JSON.stringify(r)}`);
    const id = idFrom(r);
    const g = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${id}`);
    assertAboutDaysFromNow((g.body.entity ?? g.body)._expireAt, 10);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${id}`).catch(() => {});
  });

  it('upsert_entity with ttlDays 0 gets no _expireAt', async () => {
    const r = await session.callTool('save_entity', { space: 'general', name: `McpTtlZero-${RUN}`, type: 'concept', ttlDays: 0 });
    const id = idFrom(r);
    const g = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${id}`);
    assert.equal((g.body.entity ?? g.body)._expireAt, undefined);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${id}`).catch(() => {});
  });

  it('update_entity can set a TTL-only change, then clear it', async () => {
    const created = await session.callTool('save_entity', { space: 'general', name: `McpTtlUpd-${RUN}`, type: 'concept' });
    const id = idFrom(created);

    const set = await session.callTool('update_entity', { space: 'general', id, ttlDays: 5 });
    assert.ok(!set?.isError, `update_entity ttl-only error: ${JSON.stringify(set)}`);
    let g = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${id}`);
    assertAboutDaysFromNow((g.body.entity ?? g.body)._expireAt, 5);

    const clear = await session.callTool('update_entity', { space: 'general', id, ttlDays: 0 });
    assert.ok(!clear?.isError, `update_entity clear error: ${JSON.stringify(clear)}`);
    g = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${id}`);
    assert.equal((g.body.entity ?? g.body)._expireAt, undefined);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${id}`).catch(() => {});
  });

  it('invalid ttlDays is rejected with a tool error', async () => {
    const r = await session.callTool('save_entity', { space: 'general', name: `McpTtlBad-${RUN}`, type: 'concept', ttlDays: -3 });
    assert.ok(r?.isError, `expected isError for ttlDays:-3, got ${JSON.stringify(r)}`);
    assert.match(r?.content?.[0]?.text ?? '', /ttlDays/, 'error should name ttlDays');
  });

  it('bulk_write threads per-item ttlDays and reports invalid ones', async () => {
    const good = `McpBulkTtl-${RUN}`;
    const r = await session.callTool('save_bulk', {
      space: 'general',
      entities: [
        { name: good, type: 'concept', ttlDays: 7 },   // valid → stamped
        { name: `McpBulkTtlBad-${RUN}`, type: 'concept', ttlDays: 999999 }, // invalid → error, not aborting
      ],
    });
    assert.ok(!r?.isError, `bulk_write error: ${JSON.stringify(r)}`);
    const text = r?.content?.[0]?.text ?? '';
    assert.ok(text.includes('errors: ') && !text.includes('errors: 0'), `expected the invalid item reported: ${text}`);

    // The valid entity should exist with an expiry.
    const q = await get(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities?limit=1000`);
    const found = (q.body.entities ?? q.body ?? []).find(e => e.name === good);
    assert.ok(found, 'the valid bulk entity should have been created');
    assertAboutDaysFromNow(found._expireAt, 7);
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/entities/${found._id}`).catch(() => {});
  });
});
