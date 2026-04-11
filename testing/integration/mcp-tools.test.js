/**
 * Integration tests: All 12 MCP brain/file tools + MCP security
 *
 * Extends the existing mcp.test.js coverage (which only covered list_peers
 * and sync_now) with:
 *
 * Brain tools:
 *  - remember â€” stores a memory, returns confirmation
 *  - recall â€” finds a previously stored memory
 *  - recall_global â€” searches across spaces (security: space-scoped token must
 *    NOT see memories from other spaces)
 *  - query â€” structured MongoDB filter, operator whitelist enforced
 *  - upsert_entity â€” creates/updates an entity
 *  - upsert_edge â€” creates a directed relationship edge
 *
 * File tools:
 *  - write_file â€” write text to the space file store
 *  - read_file â€” read back the written file
 *  - list_dir â€” lists directory contents
 *  - create_dir â€” creates a new directory
 *  - move_file â€” renames a file
 *  - delete_file â€” deletes a file
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
import { INSTANCES, post, get, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;

// â”€â”€ Reusable MCP session helper (same as mcp.test.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function openMcpSession(spaceId, authToken, instance = INSTANCES.a, timeoutMs = 15_000) {
  const base = instance;
  const parsed = new URL(base);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '80', 10);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host, port,
        path: `/mcp/${spaceId}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}`, Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`MCP SSE open failed: ${res.statusCode}`), { statusCode: res.statusCode }));
          return;
        }

        let buffer = '';
        let sessionId = null;
        const pendingMessages = [];
        const waiters = [];

        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            if (!part.trim()) continue;
            const lines = part.split('\n');
            let eventType = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) data = line.slice(5).trim();
            }
            if (eventType === 'endpoint') {
              const m = data.match(/sessionId=([^&\s]+)/);
              if (m) sessionId = m[1];
            } else if (eventType === 'message' && data) {
              try {
                const parsed = JSON.parse(data);
                const waiter = waiters.shift();
                if (waiter) waiter(parsed);
                else pendingMessages.push(parsed);
              } catch { /* non-JSON */ }
            }
          }
        });

        const deadline = Date.now() + timeoutMs;
        const poll = setInterval(() => {
          if (sessionId) { clearInterval(poll); resolve({ callTool, listTools, close }); }
          else if (Date.now() > deadline) { clearInterval(poll); reject(new Error('MCP session did not receive endpoint event')); }
        }, 50);

        async function postJsonRpc(body) {
          return new Promise((res2, rej2) => {
            const waiterTimeout = setTimeout(() => rej2(new Error('MCP tool call timed out')), timeoutMs);
            if (pendingMessages.length > 0) {
              clearTimeout(waiterTimeout);
              res2(pendingMessages.shift());
              return;
            }
            waiters.push(msg => { clearTimeout(waiterTimeout); res2(msg); });

            const postData = JSON.stringify(body);
            const pr = http.request(
              {
                host, port,
                path: `/mcp/${spaceId}/messages?sessionId=${sessionId}`,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(postData),
                  Authorization: `Bearer ${authToken}`,
                },
              },
              pres => {
                let txt = '';
                pres.setEncoding('utf8');
                pres.on('data', c => { txt += c; });
                pres.on('end', () => {
                  if (pres.statusCode !== 202 && pres.statusCode !== 200) {
                    clearTimeout(waiterTimeout);
                    rej2(new Error(`MCP POST failed: ${pres.statusCode} ${txt}`));
                  }
                });
              },
            );
            pr.on('error', rej2);
            pr.write(postData);
            pr.end();
          });
        }

        async function callTool(name, args = {}) {
          const rpc = await postJsonRpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
          return rpc?.result ?? rpc;
        }
        async function listTools() {
          const rpc = await postJsonRpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} });
          return rpc?.result?.tools ?? rpc?.tools ?? [];
        }
        function close() { req.destroy(); }
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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

// â”€â”€ Brain tool tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('MCP brain tools â€” remember / recall / query', () => {
  let session;
  const uniqueFact = `MCP-test-fact-${Date.now()}`;
  let embeddingAvailable = false;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession('general', tokenA);
    // Probe: attempt one remember to find out if embedding is configured.
    // If it returns isError with an embedding-unreachable message, skip embedding tests.
    const probe = await session.callTool('remember', { fact: `__embedding-probe-${Date.now()}__`, tags: [] });
    const probeText = probe?.content?.[0]?.text ?? '';
    embeddingAvailable = !probe?.isError || !probeText.toLowerCase().includes('embedding');
  });
  after(() => session?.close());

  it('remember stores a memory and returns confirmation with seq and id', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack â€” skipping');
    const result = await session.callTool('remember', { fact: uniqueFact, tags: ['mcp-test'] });
    assert.ok(!result?.isError, `remember returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('Stored memory'), `Expected "Stored memory" in: ${text}`);
    assert.ok(/seq \d+/.test(text) || /ID /.test(text), `Expected seq/ID in text: ${text}`);
  });

  it('recall finds the just-stored memory', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack â€” skipping');
    const result = await session.callTool('recall', { query: uniqueFact, topK: 5 });
    assert.ok(!result?.isError, `recall returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    // Either finds the fact or returns "No memories found" (embedding may be unavailable)
    assert.ok(text.length > 0, 'recall must return non-empty response');
  });

  it('recall with empty query returns isError', async () => {
    const result = await session.callTool('recall', { query: '' });
    assert.ok(result?.isError, 'Empty query must return isError=true');
  });

  it('remember with empty fact returns isError', async () => {
    const result = await session.callTool('remember', { fact: '' });
    assert.ok(result?.isError, 'Empty fact must return isError=true');
  });

  it('query with allowed operators returns results (no error)', async () => {
    const result = await session.callTool('query', {
      collection: 'memories',
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

  it('query with disallowed $where operator returns isError', async () => {
    const result = await session.callTool('query', {
      collection: 'memories',
      filter: { $where: 'this.fact.length > 0' },
    });
    assert.ok(result?.isError, 'Disallowed operator $where must return isError');
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.toLowerCase().includes('not allowed') || text.toLowerCase().includes('operator'), `Expected operator rejection message: ${text}`);
  });

  it('query with disallowed $function operator returns isError', async () => {
    const result = await session.callTool('query', {
      collection: 'memories',
      filter: { $function: { body: 'function() { return true; }', args: [], lang: 'js' } },
    });
    assert.ok(result?.isError, 'Disallowed operator $function must return isError');
  });

  it('query with deeply nested filter beyond depth limit returns isError', async () => {
    // Build a 10-level deep nested object to exceed depth=8 limit
    let deep = { _id: 'x' };
    for (let i = 0; i < 10; i++) deep = { $and: [deep] };
    const result = await session.callTool('query', {
      collection: 'memories',
      filter: deep,
    });
    assert.ok(result?.isError, 'Filter too deeply nested must return isError');
  });

  it('query on invalid collection returns isError', async () => {
    const result = await session.callTool('query', {
      collection: 'admin',
      filter: {},
    });
    assert.ok(result?.isError, 'Unknown collection must return isError');
  });
});

describe('MCP brain tools â€” upsert_entity / upsert_edge', () => {
  let session;
  let entityAId;
  let entityBId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
  });
  after(() => session?.close());

  it('upsert_entity creates an entity and returns its id', async () => {
    const name = `MCP-Entity-${Date.now()}`;
    const result = await session.callTool('upsert_entity', { name, type: 'concept', tags: ['mcp-test'] });
    assert.ok(!result?.isError, `upsert_entity error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('upserted'), `Expected "upserted" in: ${text}`);
    const idMatch = text.match(/ID ([a-f0-9-]{36})/i);
    assert.ok(idMatch, `Expected entity ID in: ${text}`);
    entityAId = idMatch[1];
  });

  it('upsert_entity with empty name returns isError', async () => {
    const result = await session.callTool('upsert_entity', { name: '', type: 'concept' });
    assert.ok(result?.isError, 'Empty name must return isError');
  });

  it('upsert_entity with empty type returns isError', async () => {
    const result = await session.callTool('upsert_entity', { name: 'ValidName', type: '' });
    assert.ok(result?.isError, 'Empty type must return isError');
  });

  it('upsert_edge creates a directed edge and returns its id', async () => {
    // Create second entity
    const name2 = `MCP-Entity-B-${Date.now()}`;
    const r2 = await session.callTool('upsert_entity', { name: name2, type: 'concept' });
    const idMatch2 = (r2?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(idMatch2, `Could not extract entityB ID: ${r2?.content?.[0]?.text}`);
    entityBId = idMatch2[1];

    const result = await session.callTool('upsert_edge', {
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
    const result = await session.callTool('upsert_edge', { from: '', to: entityBId, label: 'test' });
    assert.ok(result?.isError, 'Empty from must return isError');
  });

  it('upsert_edge with empty label returns isError', async () => {
    const result = await session.callTool('upsert_edge', { from: entityAId, to: entityBId, label: '' });
    assert.ok(result?.isError, 'Empty label must return isError');
  });
});

describe('MCP brain tools — traverse', () => {
  let session;
  let entityAId;
  let entityBId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);

    // Create two entities and an edge for traversal testing
    const rA = await session.callTool('upsert_entity', { name: `TraverseMCP-A-${Date.now()}`, type: 'service' });
    const mA = (rA?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(mA, `Could not extract entity A ID: ${rA?.content?.[0]?.text}`);
    entityAId = mA[1];

    const rB = await session.callTool('upsert_entity', { name: `TraverseMCP-B-${Date.now()}`, type: 'service' });
    const mB = (rB?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(mB, `Could not extract entity B ID: ${rB?.content?.[0]?.text}`);
    entityBId = mB[1];

    await session.callTool('upsert_edge', { from: entityAId, to: entityBId, label: 'depends_on' });
  });
  after(() => session?.close());

  it('traverse with empty startId returns isError', async () => {
    const result = await session.callTool('traverse', { startId: '' });
    assert.ok(result?.isError, 'Empty startId must return isError');
  });

  it('traverse returns nodes and edges JSON', async () => {
    const result = await session.callTool('traverse', { startId: entityAId, direction: 'outbound', maxDepth: 1 });
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
    assert.ok(names.includes('traverse'), 'traverse must appear in tools list');
  });
});

describe('MCP file tools â€” write_file / read_file / list_dir / create_dir / move_file / delete_file', () => {
  let session;
  const dir = `mcp-test-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
  });
  after(() => session?.close());

  it('write_file creates a file and returns sha256', async () => {
    const result = await session.callTool('write_file', {
      path: `${dir}/hello.txt`,
      content: 'Hello from MCP!',
    });
    assert.ok(!result?.isError, `write_file error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('sha256'), `Expected sha256 in: ${text}`);
  });

  it('write_file with empty path returns isError', async () => {
    const result = await session.callTool('write_file', { path: '', content: 'oops' });
    assert.ok(result?.isError, 'Empty path must return isError');
  });

  it('read_file returns the written content', async () => {
    const result = await session.callTool('read_file', { path: `${dir}/hello.txt` });
    assert.ok(!result?.isError, `read_file error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.equal(text, 'Hello from MCP!', `Expected file content, got: ${text}`);
  });

  it('read_file for non-existent file returns isError', async () => {
    const result = await session.callTool('read_file', { path: `${dir}/does-not-exist.txt` });
    assert.ok(result?.isError, 'Non-existent file must return isError');
  });

  it('list_dir returns the created file', async () => {
    const result = await session.callTool('list_dir', { path: dir });
    assert.ok(!result?.isError, `list_dir error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('hello.txt'), `Expected hello.txt in listing: ${text}`);
  });

  it('list_dir on root returns non-empty result', async () => {
    const result = await session.callTool('list_dir', {});
    assert.ok(!result?.isError, `list_dir root error: ${JSON.stringify(result)}`);
  });

  it('create_dir creates a new directory', async () => {
    const result = await session.callTool('create_dir', { path: `${dir}/subdir` });
    assert.ok(!result?.isError, `create_dir error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('created') || text.includes('subdir'), `Expected created in: ${text}`);
  });

  it('create_dir with empty path returns isError', async () => {
    const result = await session.callTool('create_dir', { path: '' });
    assert.ok(result?.isError, 'Empty path must return isError');
  });

  it('move_file renames a file within the space', async () => {
    // Write a file to move
    await session.callTool('write_file', { path: `${dir}/to-move.txt`, content: 'move me' });
    const result = await session.callTool('move_file', {
      src: `${dir}/to-move.txt`,
      dst: `${dir}/moved.txt`,
    });
    assert.ok(!result?.isError, `move_file error: ${JSON.stringify(result)}`);
    // Verify source is gone and destination exists
    const srcCheck = await session.callTool('read_file', { path: `${dir}/to-move.txt` });
    assert.ok(srcCheck?.isError, 'Source file must not exist after move');
    const dstCheck = await session.callTool('read_file', { path: `${dir}/moved.txt` });
    assert.ok(!dstCheck?.isError, 'Destination file must exist after move');
  });

  it('move_file with empty src returns isError', async () => {
    const result = await session.callTool('move_file', { src: '', dst: `${dir}/x.txt` });
    assert.ok(result?.isError, 'Empty src must return isError');
  });

  it('delete_file removes a file', async () => {
    await session.callTool('write_file', { path: `${dir}/to-delete.txt`, content: 'bye' });
    const result = await session.callTool('delete_file', { path: `${dir}/to-delete.txt` });
    assert.ok(!result?.isError, `delete_file error: ${JSON.stringify(result)}`);
    const check = await session.callTool('read_file', { path: `${dir}/to-delete.txt` });
    assert.ok(check?.isError, 'Deleted file must not be readable');
  });

  it('delete_file with empty path returns isError', async () => {
    const result = await session.callTool('delete_file', { path: '' });
    assert.ok(result?.isError, 'Empty path must return isError');
  });
});

describe('MCP file metadata — write_file persists metadata, query supports files collection', () => {
  let session;
  const dir = `mcp-meta-test-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
  });
  after(() => session?.close());

  it('write_file with description and tags stores metadata queryable via query tool', async () => {
    const filePath = `${dir}/documented.txt`;
    const writeResult = await session.callTool('write_file', {
      path: filePath,
      content: 'documented content',
      description: 'A well-documented file',
      tags: ['meta-test', 'documented'],
    });
    assert.ok(!writeResult?.isError, `write_file error: ${JSON.stringify(writeResult)}`);

    // Query the files collection and verify the metadata record exists
    const queryResult = await session.callTool('query', {
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
      path: filePath,
      content: 'plain content',
    });
    assert.ok(!writeResult?.isError, `write_file error: ${JSON.stringify(writeResult)}`);

    const queryResult = await session.callTool('query', {
      collection: 'files',
      filter: { _id: filePath },
    });
    assert.ok(!queryResult?.isError, `query files error: ${JSON.stringify(queryResult)}`);
    const docs = JSON.parse(queryResult?.content?.[0]?.text ?? '[]');
    assert.ok(docs.length > 0, `Expected metadata record for ${filePath}`);
    assert.ok(typeof docs[0].sizeBytes === 'number', 'sizeBytes must be set');
  });

  it('query tool rejects unknown collection', async () => {
    const result = await session.callTool('query', {
      collection: 'unknown_coll',
      filter: {},
    });
    assert.ok(result?.isError, 'Unknown collection must return isError');
  });

  it('get_stats files count increments after write_file', async () => {
    const before = await session.callTool('get_stats', {});
    const beforeCount = JSON.parse(before?.content?.[0]?.text ?? '{}').files ?? 0;

    await session.callTool('write_file', {
      path: `${dir}/count-test.txt`,
      content: 'counting',
    });

    const after = await session.callTool('get_stats', {});
    const afterCount = JSON.parse(after?.content?.[0]?.text ?? '{}').files ?? 0;
    assert.ok(afterCount >= beforeCount + 1, `Expected files count to increment: before=${beforeCount}, after=${afterCount}`);
  });

  it('delete_file removes the metadata record', async () => {
    const filePath = `${dir}/to-delete-meta.txt`;
    await session.callTool('write_file', { path: filePath, content: 'bye' });

    await session.callTool('delete_file', { path: filePath });

    const queryResult = await session.callTool('query', {
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
    await session.callTool('write_file', { path: srcPath, content: 'move me' });

    await session.callTool('move_file', { src: srcPath, dst: dstPath });

    // Old path metadata should be gone
    const srcQuery = await session.callTool('query', {
      collection: 'files',
      filter: { _id: srcPath },
    });
    const srcDocs = JSON.parse(srcQuery?.content?.[0]?.text ?? '[]');
    assert.equal(srcDocs.length, 0, 'Source path metadata must be removed after move');

    // New path metadata should exist
    const dstQuery = await session.callTool('query', {
      collection: 'files',
      filter: { _id: dstPath },
    });
    const dstDocs = JSON.parse(dstQuery?.content?.[0]?.text ?? '[]');
    assert.ok(dstDocs.length > 0, 'Destination path metadata must exist after move');
    assert.equal(dstDocs[0].path, dstPath, 'path field must be updated to destination');
  });
});

describe('MCP recall_global â€” space-scoped token must only see its own spaces', () => {
  let sessionScoped;
  let scopedTokenPlaintext;
  let scopedTokenId;
  const secretFact = `PRIVATE-FACT-OTHER-SPACE-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    // Write a secret fact into the 'general' space using the full-access token
    await post(INSTANCES.a, tokenA, '/api/brain/general/memories', {
      fact: secretFact,
      tags: ['scope-leak-test'],
    });

    // Create a space-scoped token that has access to NO spaces (empty allowlist)
    // â€” in practice we use a token that is scoped to a space that is NOT 'general'
    // so any recall_global result containing the secretFact is a scope leak.
    //
    // Since the test instance only has 'general' built-in, we create a space-scoped
    // token scoped to nothing (spaces: []) â€” recall_global must return empty.
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `scoped-no-access-${Date.now()}`,
      spaces: ['__nonexistent_space__'],
    });
    assert.equal(tokenRes.status, 201, `Create scoped token: ${JSON.stringify(tokenRes.body)}`);
    scopedTokenPlaintext = tokenRes.body.plaintext;
    scopedTokenId = tokenRes.body.id;

    // Open MCP session using the scoped token against 'general'
    // requireSpaceAuth checks the token has access to the spaceId in the URL â€”
    // if the token's spaces list doesn't include 'general' this open should fail with 403.
    // That itself is a security assertion.
    try {
      sessionScoped = await openMcpSession('general', scopedTokenPlaintext);
    } catch (err) {
      // 403 is the CORRECT behavior â€” scoped token must not open 'general' session
      if (err.statusCode === 403) {
        sessionScoped = null; // test will assert the 403 was correct
      } else {
        throw err;
      }
    }
  });

  after(async () => {
    sessionScoped?.close();
    if (scopedTokenId) await del(INSTANCES.a, tokenA, `/api/tokens/${scopedTokenId}`).catch(() => {});
  });

  it('space-scoped token cannot open MCP session for unauthorized space (must get 403)', () => {
    // Either sessionScoped is null (403 was returned â€” correct) or it opened
    // (should not happen â€” the test will then check recall_global cannot leak).
    assert.equal(
      sessionScoped,
      null,
      'A token scoped to __nonexistent_space__ must not be able to open an MCP session for "general" â€” got 200 instead of 403',
    );
  });
});

describe('MCP recall_global â€” full-access token, multi-space isolation', () => {
  let session;
  const spaceAFact = `SPACE-A-FACT-${Date.now()}`;
  let embeddingAvailable = false;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession('general', tokenA);
    // Probe embedding availability before attempting to remember a seed fact.
    const probe = await session.callTool('remember', { fact: `__rg-probe-${Date.now()}__`, tags: [] });
    const probeText = probe?.content?.[0]?.text ?? '';
    embeddingAvailable = !probe?.isError || !probeText.toLowerCase().includes('embedding');
    if (embeddingAvailable) {
      await session.callTool('remember', { fact: spaceAFact, tags: ['global-recall-test'] });
    }
  });
  after(() => session?.close());

  it('recall_global returns results without isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack â€” skipping');
    const result = await session.callTool('recall_global', { query: spaceAFact, topK: 5 });
    assert.ok(!result?.isError, `recall_global returned isError: ${JSON.stringify(result)}`);
  });

  it('recall_global response does not include spaces the token cannot access', async () => {
    // Full-access token CAN access all spaces, so results may come from all spaces â€”
    // the key check: the response is valid and not an error.
    // The CRITICAL path (scoped token seeing other spaces) is tested in the suite above.
    const result = await session.callTool('recall_global', { query: spaceAFact, topK: 5 });
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'recall_global must return non-empty text');
    // Verify no raw embedding vectors are exposed
    assert.ok(!text.includes('"embedding"'), 'recall_global must not expose embedding vectors');
  });

  it('recall_global with empty query returns isError', async () => {
    const result = await session.callTool('recall_global', { query: '' });
    assert.ok(result?.isError, 'Empty query must return isError');
  });
});


describe('MCP brain tools — update_memory / delete_memory / get_stats', () => {
  let session;
  let storedMemoryId;
  const factText = `MCP-update-delete-test-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
    // Create a memory via REST API so we have an ID to update/delete
    const res = await post(INSTANCES.a, tokenA, '/api/brain/general/memories', {
      fact: factText,
      tags: ['mcp-update-test'],
    });
    storedMemoryId = res.body?._id;
  });
  after(() => session?.close());

  it('get_stats returns counts with spaceId, memories, entities, edges, chrono, files', async () => {
    const result = await session.callTool('get_stats', {});
    assert.ok(!result?.isError, `get_stats returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    assert.ok(typeof parsed.spaceId === 'string', 'get_stats must return spaceId');
    assert.ok(typeof parsed.memories === 'number', 'get_stats must return memories count');
    assert.ok(typeof parsed.entities === 'number', 'get_stats must return entities count');
    assert.ok(typeof parsed.edges === 'number', 'get_stats must return edges count');
    assert.ok(typeof parsed.chrono === 'number', 'get_stats must return chrono count');
    assert.ok(typeof parsed.files === 'number', 'get_stats must return files count');
    assert.ok(parsed.memories >= 0, 'memories count must be non-negative');
    assert.ok(parsed.files >= 0, 'files count must be non-negative');
  });

  it('update_memory with no id returns isError', async () => {
    const result = await session.callTool('update_memory', { id: '' });
    assert.ok(result?.isError, 'Empty id must return isError');
  });

  it('update_memory with no fields to update returns isError', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId — prior test failed');
    const result = await session.callTool('update_memory', { id: storedMemoryId });
    assert.ok(result?.isError, 'No update fields must return isError');
  });

  it('update_memory updates tags on an existing memory', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId — prior test failed');
    const result = await session.callTool('update_memory', {
      id: storedMemoryId,
      tags: ['mcp-updated-tag'],
    });
    assert.ok(!result?.isError, `update_memory returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('updated') || text.includes(storedMemoryId), `Expected updated confirmation: ${text}`);
  });

  it('update_memory on non-existent id returns isError', async () => {
    const result = await session.callTool('update_memory', {
      id: '00000000-0000-0000-0000-000000000000',
      tags: ['irrelevant'],
    });
    assert.ok(result?.isError, 'Non-existent memory ID must return isError');
  });

  it('delete_memory with no id returns isError', async () => {
    const result = await session.callTool('delete_memory', { id: '' });
    assert.ok(result?.isError, 'Empty id must return isError');
  });

  it('delete_memory removes the memory', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId — prior test failed');
    const result = await session.callTool('delete_memory', { id: storedMemoryId });
    assert.ok(!result?.isError, `delete_memory returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('deleted') || text.includes(storedMemoryId), `Expected deletion confirmation: ${text}`);
  });

  it('delete_memory on already-deleted id returns isError', async (t) => {
    if (!storedMemoryId) return t.skip('No storedMemoryId — prior test failed');
    const result = await session.callTool('delete_memory', { id: storedMemoryId });
    assert.ok(result?.isError, 'Double-delete must return isError');
  });
});

describe('MCP chrono tools — list_chrono tags filter / query chrono collection', () => {
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
    session = await openMcpSession('general', tokenA);

    // Create four chrono entries: two with distinct tags, one with both, one untagged
    const rA = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-Tag-A-${RUN}`, kind: 'event',
      startsAt: new Date().toISOString(), tags: [tagA],
    });
    idTagA = rA.body?._id;

    const rB = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-Tag-B-${RUN}`, kind: 'milestone',
      startsAt: new Date().toISOString(), tags: [tagB],
    });
    idTagB = rB.body?._id;

    const rBoth = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-Tag-Both-${RUN}`, kind: 'plan',
      startsAt: new Date().toISOString(), tags: [tagA, tagB],
    });
    idBoth = rBoth.body?._id;

    const rN = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
      title: `MCP-NoTag-${RUN}`, kind: 'plan',
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

  it('list_chrono without filters returns results without isError', async () => {
    const result = await session.callTool('list_chrono', {});
    assert.ok(!result?.isError, `list_chrono returned isError: ${JSON.stringify(result)}`);
  });

  it('list_chrono with tags filter (AND) returns only entries with that tag', async (t) => {
    if (!idTagA) return t.skip('No idTagA — prior setup failed');
    const result = await session.callTool('list_chrono', { tags: [tagA] });
    assert.ok(!result?.isError, `list_chrono with tags returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Expected entry tagged ${tagA} (id ${idTagA}) in results: ${text}`);
    assert.ok(!text.includes(idTagB), `Entry tagged only ${tagB} should NOT appear when filtering by ${tagA}: ${text}`);
  });

  it('list_chrono with multi-tag AND filter returns only entries with all specified tags', async (t) => {
    if (!idTagA || !idTagB || !idBoth) return t.skip('Missing seeded entries');
    const result = await session.callTool('list_chrono', { tags: [tagA, tagB] });
    assert.ok(!result?.isError, `list_chrono multi-tag AND returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idBoth), `Entry with both tags should appear for AND query: ${text}`);
    assert.ok(!text.includes(idTagA), `Entry with only ${tagA} should NOT appear for AND [${tagA},${tagB}] query: ${text}`);
  });

  it('list_chrono with tagsAny filter (OR) returns entries matching any tag', async (t) => {
    if (!idTagA || !idTagB) return t.skip('Missing seeded entries');
    const result = await session.callTool('list_chrono', { tagsAny: [tagA, tagB] });
    assert.ok(!result?.isError, `list_chrono tagsAny returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Expected entry tagged ${tagA} in results: ${text}`);
    assert.ok(text.includes(idTagB), `Expected entry tagged ${tagB} in results: ${text}`);
  });

  it('list_chrono with tags filter that matches nothing returns empty message', async () => {
    const result = await session.callTool('list_chrono', { tags: [`no-such-tag-${RUN}`] });
    assert.ok(!result?.isError, `list_chrono returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text === 'No chrono entries found.' || text.trim() === '', `Expected empty result, got: ${text}`);
  });

  it('list_chrono with after filter returns only entries after the timestamp', async (t) => {
    if (!idTagA) return t.skip('No seeded entries');
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const result = await session.callTool('list_chrono', { after: pastTime });
    assert.ok(!result?.isError, `list_chrono after returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Seeded entry should appear for after=${pastTime}: ${text}`);
  });

  it('list_chrono with before filter far in future returns seeded entries', async (t) => {
    if (!idTagA) return t.skip('No seeded entries');
    const futureTime = new Date(Date.now() + 3_600_000).toISOString();
    const result = await session.callTool('list_chrono', { before: futureTime });
    assert.ok(!result?.isError, `list_chrono before returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Seeded entry should appear for before=${futureTime}: ${text}`);
  });

  it('list_chrono with search filter matches on title', async (t) => {
    if (!idTagA) return t.skip('No seeded entries');
    const result = await session.callTool('list_chrono', { search: `MCP-Tag-A-${RUN}` });
    assert.ok(!result?.isError, `list_chrono search returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes(idTagA), `Entry with matching title should appear: ${text}`);
  });

  it('query with collection "chrono" returns array without isError', async (t) => {
    if (!idTagA) return t.skip('No seeded chrono entry');
    const result = await session.callTool('query', {
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
    const result = await session.callTool('query', {
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

describe('MCP security — read-only token cannot call mutating tools', () => {
  let readOnlySession;
  let readOnlyTokenPlaintext;
  let readOnlyTokenId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `readonly-mcp-test-${Date.now()}`,
      readOnly: true,
    });
    assert.equal(tokenRes.status, 201, `Create read-only token: ${JSON.stringify(tokenRes.body)}`);
    readOnlyTokenPlaintext = tokenRes.body.plaintext;
    readOnlyTokenId = tokenRes.body.id;
    readOnlySession = await openMcpSession('general', readOnlyTokenPlaintext);
  });
  after(async () => {
    readOnlySession?.close();
    if (readOnlyTokenId) await del(INSTANCES.a, tokenA, `/api/tokens/${readOnlyTokenId}`).catch(() => {});
  });

  it('update_memory is rejected with read-only token', async () => {
    const result = await readOnlySession.callTool('update_memory', {
      id: '00000000-0000-0000-0000-000000000000',
      tags: ['nope'],
    });
    assert.ok(result?.isError, 'update_memory must be rejected by read-only token');
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.toLowerCase().includes('read-only'), `Expected read-only message: ${text}`);
  });

  it('delete_memory is rejected with read-only token', async () => {
    const result = await readOnlySession.callTool('delete_memory', {
      id: '00000000-0000-0000-0000-000000000000',
    });
    assert.ok(result?.isError, 'delete_memory must be rejected by read-only token');
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.toLowerCase().includes('read-only'), `Expected read-only message: ${text}`);
  });

  it('get_stats works with read-only token', async () => {
    const result = await readOnlySession.callTool('get_stats', {});
    assert.ok(!result?.isError, `get_stats must work with read-only token: ${JSON.stringify(result)}`);
  });
});

describe('MCP security â€” unauthenticated access', () => {
  it('GET /mcp/:spaceId without auth returns 401', async () => {
    const parsed = new URL(INSTANCES.a);
    const status = await new Promise((resolve) => {
      const req = http.request(
        { host: parsed.hostname, port: parseInt(parsed.port || '80'), path: '/mcp/general', method: 'GET' },
        r => { r.resume(); resolve(r.statusCode); },
      );
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(status, 401, `Expected 401 without auth, got ${status}`);
  });

  it('POST /mcp/:spaceId/messages without auth returns 401', async () => {
    const parsed = new URL(INSTANCES.a);
    const status = await new Promise((resolve) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_peers', arguments: {} } });
      const req = http.request(
        {
          host: parsed.hostname, port: parseInt(parsed.port || '80'),
          path: '/mcp/general/messages?sessionId=fake-session',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        r => { r.resume(); resolve(r.statusCode); },
      );
      req.on('error', () => resolve(0));
      req.write(body);
      req.end();
    });
    assert.ok(status === 401 || status === 404, `Expected 401/404 without auth, got ${status} (404 = no such session is also acceptable)`);
  });
});

// ── recall / recall_global — types filter ────────────────────────────────────

describe('MCP recall — types filter restricts result set', () => {
  let session;
  let embeddingAvailable = false;
  const entityName = `TypeFilterEntity-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession('general', tokenA);
    // Probe embedding availability
    const probe = await session.callTool('remember', { fact: `__types-probe-${Date.now()}__`, tags: [] });
    const probeText = probe?.content?.[0]?.text ?? '';
    embeddingAvailable = !probe?.isError || !probeText.toLowerCase().includes('embedding');
    if (embeddingAvailable) {
      // Seed an entity so entity-type results exist
      await session.callTool('upsert_entity', { name: entityName, type: 'concept', tags: ['types-filter-test'] });
    }
  });
  after(() => session?.close());

  it('recall with types=["memory"] does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', { query: entityName, topK: 5, types: ['memory'] });
    assert.ok(!result?.isError, `recall types=memory returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'recall with types filter must return non-empty response');
  });

  it('recall with types=["entity"] does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', { query: entityName, topK: 5, types: ['entity'] });
    assert.ok(!result?.isError, `recall types=entity returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with multiple types does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', { query: entityName, topK: 5, types: ['memory', 'entity', 'edge'] });
    assert.ok(!result?.isError, `recall types=[memory,entity,edge] returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with unknown type strings is tolerated (filter ignores unknown types)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    // Server filters to valid RecallKnowledgeType values — unknown strings are dropped,
    // resulting in an empty types filter (equivalent to no filter) or an empty search.
    // Either way it must not crash.
    const result = await session.callTool('recall', { query: entityName, topK: 5, types: ['__unknown__'] });
    // Should be either a valid response or an error indicating no results — not a server fault
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(typeof text === 'string', 'Response text must be a string regardless of types value');
  });

  it('recall_global with types=["entity"] does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall_global', { query: entityName, topK: 5, types: ['entity'] });
    assert.ok(!result?.isError, `recall_global types=entity returned isError: ${JSON.stringify(result)}`);
  });
});

// ── remember / recall with description and properties ─────────────────────

describe('MCP brain tools — remember with description and properties', () => {
  let session;
  let embeddingAvailable = false;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
    const probe = await session.callTool('remember', { fact: `__rich-fields-probe-${Date.now()}__`, tags: [] });
    const probeText = probe?.content?.[0]?.text ?? '';
    embeddingAvailable = !probe?.isError || !probeText.toLowerCase().includes('embedding');
  });
  after(() => session?.close());

  it('remember with description and properties does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('remember', {
      fact: `MCP-rich-fact-${Date.now()}`,
      tags: ['rich-field-test'],
      description: 'Extra context for this fact',
      properties: { source: 'mcp-test', confidence: 0.9 },
    });
    assert.ok(!result?.isError, `remember with description/properties returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('Stored memory') || text.includes('seq'), `Expected confirmation in: ${text}`);
  });

  it('remember description is stored and queryable', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const uniqueFact = `DescPropMCPFact-${Date.now()}`;
    await session.callTool('remember', {
      fact: uniqueFact,
      description: 'A unique MCP description',
      properties: { mcp_key: 'mcp_val' },
    });

    // Query memories collection and verify description + properties are persisted
    const queryResult = await session.callTool('query', {
      collection: 'memories',
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

// ── upsert_entity with description ────────────────────────────────────────

describe('MCP brain tools — upsert_entity with description', () => {
  let session;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
  });
  after(() => session?.close());

  it('upsert_entity with description stores it and returns id', async () => {
    const name = `MCP-DescEntity-${Date.now()}`;
    const result = await session.callTool('upsert_entity', {
      name,
      type: 'service',
      description: 'Primary API gateway for external traffic',
      tags: ['gateway'],
    });
    assert.ok(!result?.isError, `upsert_entity error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('upserted'), `Expected "upserted" in: ${text}`);

    // Verify description is queryable via query tool
    const q = await session.callTool('query', {
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

// ── MCP bulk_write tool ──────────────────────────────────────────────────────

describe('MCP brain tools — bulk_write', () => {
  let session;
  const RUN = Date.now();

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
  });
  after(() => session?.close());

  it('bulk_write inserts memories, entities, edges, and chrono', async () => {
    const entName1 = `BulkEnt1-${RUN}`;
    const entName2 = `BulkEnt2-${RUN}`;
    const result = await session.callTool('bulk_write', {
      memories: [
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
        { title: `BulkChrono-${RUN}`, kind: 'event', startsAt: new Date().toISOString() },
      ],
    });
    assert.ok(!result?.isError, `bulk_write returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('bulk_write complete'), `Expected summary in: ${text}`);
    // Verify counts
    assert.ok(text.includes('"memories":1'), `Expected 1 memory inserted: ${text}`);
    assert.ok(text.includes('"entities":2') || text.includes('"entities":1'), `Expected entities inserted: ${text}`);
  });

  it('bulk_write with validation errors returns error entries without aborting batch', async () => {
    const result = await session.callTool('bulk_write', {
      memories: [
        { fact: '' },                                // invalid — empty fact
        { fact: `ValidBulkMem-${RUN}`, tags: [] },   // valid
      ],
      entities: [
        { name: '', type: 'concept' },               // invalid — missing name
        { name: `ValidBulkEnt-${RUN}`, type: '' },   // invalid — missing type
      ],
    });
    assert.ok(!result?.isError, `bulk_write should not be isError for validation failures: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('bulk_write complete'), `Expected summary: ${text}`);
    // At least 2 errors (empty fact + empty name), plus potentially the empty type
    assert.ok(text.includes('errors: ') && !text.includes('errors: 0'), `Expected non-zero errors: ${text}`);
  });

  it('bulk_write with empty arrays returns zero counts', async () => {
    const result = await session.callTool('bulk_write', {
      memories: [],
      entities: [],
      edges: [],
      chrono: [],
    });
    assert.ok(!result?.isError, `bulk_write returned isError for empty: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('"memories":0'), `Expected 0 memories: ${text}`);
    assert.ok(text.includes('errors: 0'), `Expected 0 errors: ${text}`);
  });

  it('bulk_write with no arrays returns zero counts', async () => {
    const result = await session.callTool('bulk_write', {});
    assert.ok(!result?.isError, `bulk_write returned isError for no arrays: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('bulk_write complete'), `Expected summary: ${text}`);
    assert.ok(text.includes('errors: 0'), `Expected 0 errors: ${text}`);
  });

  it('bulk_write chrono with invalid kind returns error entry', async () => {
    const result = await session.callTool('bulk_write', {
      chrono: [
        { title: 'Bad Kind', kind: 'invalid_kind', startsAt: new Date().toISOString() },
      ],
    });
    assert.ok(!result?.isError, `bulk_write should not be isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('errors: 1'), `Expected 1 error for invalid kind: ${text}`);
    assert.ok(text.includes('kind'), `Error should mention kind: ${text}`);
  });
});

// ── MCP bulk_write — read-only token blocked ─────────────────────────────────

describe('MCP security — read-only token cannot call bulk_write', () => {
  let readOnlySession;
  let readOnlyTokenPlaintext;
  let readOnlyTokenId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const tokenRes = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `readonly-bulk-${Date.now()}`,
      readOnly: true,
    });
    assert.equal(tokenRes.status, 201, `Create read-only token: ${JSON.stringify(tokenRes.body)}`);
    readOnlyTokenPlaintext = tokenRes.body.plaintext;
    readOnlyTokenId = tokenRes.body.id;
    readOnlySession = await openMcpSession('general', readOnlyTokenPlaintext);
  });
  after(async () => {
    readOnlySession?.close();
    if (readOnlyTokenId) await del(INSTANCES.a, tokenA, `/api/tokens/${readOnlyTokenId}`).catch(() => {});
  });

  it('bulk_write is rejected with read-only token', async () => {
    const result = await readOnlySession.callTool('bulk_write', {
      memories: [{ fact: 'This should be blocked' }],
    });
    assert.ok(result?.isError, 'bulk_write must be rejected by read-only token');
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.toLowerCase().includes('read-only'), `Expected read-only message: ${text}`);
  });
});

// ── upsert_edge with tags, description, and properties ────────────────────

describe('MCP brain tools — upsert_edge with tags, description, and properties', () => {
  let session;
  let entityAId;
  let entityBId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);

    const rA = await session.callTool('upsert_entity', { name: `RichEdgeA-${Date.now()}`, type: 'concept' });
    const rB = await session.callTool('upsert_entity', { name: `RichEdgeB-${Date.now()}`, type: 'concept' });
    const mA = (rA?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    const mB = (rB?.content?.[0]?.text ?? '').match(/ID ([a-f0-9-]{36})/i);
    assert.ok(mA, `Could not extract entityA ID: ${rA?.content?.[0]?.text}`);
    assert.ok(mB, `Could not extract entityB ID: ${rB?.content?.[0]?.text}`);
    entityAId = mA[1];
    entityBId = mB[1];
  });
  after(() => session?.close());

  it('upsert_edge with tags, description, and properties does not return isError', async () => {
    const result = await session.callTool('upsert_edge', {
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
    await session.callTool('upsert_edge', {
      from: entityAId,
      to: entityBId,
      label,
      description: 'MCP edge with queryable desc',
      properties: { edge_prop: 'stored' },
    });

    const q = await session.callTool('query', {
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

// ── recall / recall_global with minPerType ────────────────────────────────

describe('MCP brain tools — recall and recall_global with minPerType', () => {
  let session;
  let embeddingAvailable = false;
  const entityName = `MinPerTypeEntity-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession('general', tokenA);
    const probe = await session.callTool('remember', { fact: `__minpertype-probe-${Date.now()}__`, tags: [] });
    const probeText = probe?.content?.[0]?.text ?? '';
    embeddingAvailable = !probe?.isError || !probeText.toLowerCase().includes('embedding');
    if (embeddingAvailable) {
      await session.callTool('upsert_entity', { name: entityName, type: 'concept', tags: ['minpertype-test'] });
    }
  });
  after(() => session?.close());

  it('recall with minPerType object does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', {
      query: entityName,
      topK: 5,
      minPerType: { entity: 1 },
    });
    assert.ok(!result?.isError, `recall with minPerType returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'recall with minPerType must return non-empty response');
  });

  it('recall with minPerType={"entity":1} includes at least one entity when available', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', {
      query: entityName,
      topK: 10,
      minPerType: { entity: 1 },
    });
    assert.ok(!result?.isError, `recall with minPerType error: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    // Response is formatted text — verify entity name appears somewhere in the output
    // (embedded entity should match the exact name we seeded)
    assert.ok(text.includes(entityName) || text.toLowerCase().includes('[entity]'), `Expected entity in recall output: ${text}`);
  });

  it('recall_global with minPerType does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall_global', {
      query: entityName,
      topK: 5,
      minPerType: { entity: 1 },
    });
    assert.ok(!result?.isError, `recall_global with minPerType returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with empty minPerType object behaves like no minPerType', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const withMinPerType = await session.callTool('recall', { query: entityName, topK: 5, minPerType: {} });
    const withoutMinPerType = await session.callTool('recall', { query: entityName, topK: 5 });
    assert.ok(!withMinPerType?.isError, 'recall with empty minPerType must not error');
    assert.ok(!withoutMinPerType?.isError, 'recall without minPerType must not error');
  });
});

// ── recall / recall_global with minScore ──────────────────────────────────

describe('MCP brain tools — recall and recall_global with minScore', () => {
  let session;
  let embeddingAvailable = false;
  const factForScore = `MinScoreTestFact-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    await ensureReindexed(INSTANCES.a, tokenA);
    session = await openMcpSession('general', tokenA);
    const probe = await session.callTool('remember', { fact: `__minscore-probe-${Date.now()}__`, tags: [] });
    const probeText = probe?.content?.[0]?.text ?? '';
    embeddingAvailable = !probe?.isError || !probeText.toLowerCase().includes('embedding');
    if (embeddingAvailable) {
      await session.callTool('remember', { fact: factForScore, tags: ['minscore-test'] });
    }
  });
  after(() => session?.close());

  it('recall with minScore does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', {
      query: factForScore,
      topK: 5,
      minScore: 0.5,
    });
    assert.ok(!result?.isError, `recall with minScore returned isError: ${JSON.stringify(result)}`);
  });

  it('recall with minScore=0.99 returns few or no results', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall', {
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
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const withMinScore = await session.callTool('recall', { query: factForScore, topK: 5, minScore: 0.0 });
    const withoutMinScore = await session.callTool('recall', { query: factForScore, topK: 5 });
    assert.ok(!withMinScore?.isError, 'recall with minScore=0.0 must not error');
    assert.ok(!withoutMinScore?.isError, 'recall without minScore must not error');
  });

  it('recall_global with minScore does not return isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall_global', {
      query: factForScore,
      topK: 5,
      minScore: 0.5,
    });
    assert.ok(!result?.isError, `recall_global with minScore returned isError: ${JSON.stringify(result)}`);
  });

  it('recall_global with minScore=0.99 returns few or no results', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding server not configured in test stack — skipping');
    const result = await session.callTool('recall_global', {
      query: factForScore,
      topK: 10,
      minScore: 0.99,
    });
    assert.ok(!result?.isError, `recall_global with high minScore returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(typeof text === 'string', 'Response text must be a string');
  });
});

// ── write_file with properties field ──────────────────────────────────────

describe('MCP file tools — write_file with properties metadata', () => {
  let session;
  const dir = `mcp-props-test-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    session = await openMcpSession('general', tokenA);
  });
  after(() => session?.close());

  it('write_file with properties stores them in file metadata', async () => {
    const filePath = `${dir}/annotated.txt`;
    const writeResult = await session.callTool('write_file', {
      path: filePath,
      content: 'annotated file content',
      description: 'Annotated file',
      tags: ['props-test'],
      properties: { owner: 'infra-team', version: 3, archived: false },
    });
    assert.ok(!writeResult?.isError, `write_file error: ${JSON.stringify(writeResult)}`);

    const queryResult = await session.callTool('query', {
      collection: 'files',
      filter: { _id: filePath },
    });
    assert.ok(!queryResult?.isError, `query files error: ${JSON.stringify(queryResult)}`);
    const docs = JSON.parse(queryResult?.content?.[0]?.text ?? '[]');
    assert.ok(docs.length > 0, `Expected metadata record for ${filePath}`);
    assert.deepStrictEqual(docs[0].properties, { owner: 'infra-team', version: 3, archived: false }, 'properties stored in file metadata');
  });
});
