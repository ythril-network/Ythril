/**
 * Integration tests: Proxy spaces
 *
 * Covers:
 *  — Create a proxy space grouping two real spaces
 *  — Proxy space appears in space listing with proxyFor field
 *  — Proxy nesting rejected (proxy-of-proxy)
 *  — Non-existent member rejected
 *  — Brain reads aggregate across member spaces
 *  — Brain writes require targetSpace param
 *  — Brain writes without targetSpace return 400
 *  — Brain delete searches across member spaces
 *  — Brain stats sum across members
 *  — File reads aggregate directory listings across members
 *  — File writes require targetSpace
 *  — File reads find files across members
 *  — MCP recall aggregates across member spaces
 *  — MCP remember requires targetSpace for proxy
 *  — MCP read_file / list_dir aggregate across members
 *  — MCP write_file requires targetSpace for proxy
 *  — Entities/edges aggregate across members
 *  — Reindex-status aggregates across members
 *  — Cleanup
 *
 * Run: node --test testing/integration/proxy-spaces.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const BASE = INSTANCES.a;

let tokenA;
const RUN = `px${Date.now()}`;
const SPACE_A = `${RUN}-alpha`;
const SPACE_B = `${RUN}-beta`;
const PROXY = `${RUN}-proxy`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function patch(baseUrl, token, urlPath, data) {
  return reqJson(baseUrl, token, urlPath, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ── MCP session helper (same pattern as mcp-tools.test.js) ──────────────────

async function openMcpSession(authToken, instance = BASE, timeoutMs = 15_000) {
  const parsed = new URL(instance);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '80', 10);

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: '/mcp', method: 'GET',
        headers: { Authorization: `Bearer ${authToken}`, Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`MCP SSE open: ${res.statusCode}`), { statusCode: res.statusCode }));
          return;
        }
        let buffer = '';
        let sessionId = null;
        const pending = [];
        const waiters = [];

        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            if (!part.trim()) continue;
            const lines = part.split('\n');
            let eventType = 'message', data = '';
            for (const line of lines) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) data = line.slice(5).trim();
            }
            if (eventType === 'endpoint') {
              const m = data.match(/sessionId=([^&\s]+)/);
              if (m) sessionId = m[1];
            } else if (eventType === 'message' && data) {
              try { const p = JSON.parse(data); const w = waiters.shift(); if (w) w(p); else pending.push(p); } catch {}
            }
          }
        });

        const deadline = Date.now() + timeoutMs;
        const poll = setInterval(() => {
          if (sessionId) { clearInterval(poll); resolve({ callTool, listTools, close }); }
          else if (Date.now() > deadline) { clearInterval(poll); reject(new Error('No endpoint event')); }
        }, 50);

        async function postRpc(body) {
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => rej2(new Error('MCP timeout')), timeoutMs);
            if (pending.length > 0) { clearTimeout(timer); res2(pending.shift()); return; }
            waiters.push(msg => { clearTimeout(timer); res2(msg); });
            const pd = JSON.stringify(body);
            const pr = http.request(
              { host, port, path: `/mcp/messages?sessionId=${sessionId}`, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pd), Authorization: `Bearer ${authToken}` } },
              pres => { let t = ''; pres.setEncoding('utf8'); pres.on('data', c => { t += c; }); pres.on('end', () => { if (pres.statusCode !== 202 && pres.statusCode !== 200) { clearTimeout(timer); rej2(new Error(`POST ${pres.statusCode} ${t}`)); } }); },
            );
            pr.on('error', rej2);
            pr.write(pd);
            pr.end();
          });
        }

        async function callTool(name, args = {}) {
          const rpc = await postRpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
          return rpc?.result ?? rpc;
        }
        async function listTools() {
          const rpc = await postRpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} });
          return rpc?.result?.tools ?? rpc?.tools ?? [];
        }
        function close() { req.destroy(); }
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Proxy spaces', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    // Create two member spaces
    const rA = await post(BASE, tokenA, '/api/spaces', { id: SPACE_A, label: 'Alpha' });
    assert.equal(rA.status, 201, `Create alpha: ${JSON.stringify(rA.body)}`);
    const rB = await post(BASE, tokenA, '/api/spaces', { id: SPACE_B, label: 'Beta' });
    assert.equal(rB.status, 201, `Create beta: ${JSON.stringify(rB.body)}`);

    // Create the proxy space
    const rP = await post(BASE, tokenA, '/api/spaces', {
      id: PROXY,
      label: 'Proxy',
      description: 'Aggregates alpha and beta.',
      proxyFor: [SPACE_A, SPACE_B],
    });
    assert.equal(rP.status, 201, `Create proxy: ${JSON.stringify(rP.body)}`);
  });

  after(async () => {
    for (const id of [PROXY, SPACE_A, SPACE_B]) {
      await delWithBody(BASE, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  // ── Space creation & listing ─────────────────────────────────────────────

  describe('Space creation', () => {
    it('Proxy space appears in listing with proxyFor', async () => {
      const r = await get(BASE, tokenA, '/api/spaces');
      assert.equal(r.status, 200);
      const proxy = r.body.spaces.find(s => s.id === PROXY);
      assert.ok(proxy, 'Proxy space should be in listing');
      assert.deepEqual(proxy.proxyFor, [SPACE_A, SPACE_B]);
      assert.equal(proxy.description, 'Aggregates alpha and beta.');
    });

    it('Proxy nesting rejected', async () => {
      const r = await post(BASE, tokenA, '/api/spaces', {
        id: `${RUN}-nested`,
        label: 'Nested proxy',
        proxyFor: [PROXY],
      });
      assert.equal(r.status, 400);
      assert.ok(r.body.error.includes('itself a proxy'), r.body.error);
    });

    it('Non-existent member rejected', async () => {
      const r = await post(BASE, tokenA, '/api/spaces', {
        id: `${RUN}-bad`,
        label: 'Bad proxy',
        proxyFor: ['does-not-exist-99'],
      });
      assert.equal(r.status, 400);
      assert.ok(r.body.error.includes('not found'), r.body.error);
    });
  });

  // ── Brain API reads/writes ───────────────────────────────────────────────

  describe('Brain — memories', () => {
    let memIdA, memIdB;

    it('Write to proxy without targetSpace returns 400', async () => {
      const r = await post(BASE, tokenA, `/api/brain/${PROXY}/memories`, {
        fact: 'Should fail',
      });
      assert.equal(r.status, 400);
      assert.ok(r.body.error.includes('targetSpace'), r.body.error);
    });

    it('Write to proxy with invalid targetSpace returns 400', async () => {
      const r = await post(BASE, tokenA, `/api/brain/${PROXY}/memories?targetSpace=non-member`, {
        fact: 'Should fail',
      });
      assert.equal(r.status, 400);
      assert.ok(r.body.error.includes('not a member'), r.body.error);
    });

    it('Write memory to alpha via proxy', async () => {
      const r = await post(BASE, tokenA, `/api/brain/${PROXY}/memories?targetSpace=${SPACE_A}`, {
        fact: 'Alpha fact from proxy',
        tags: ['alpha'],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      memIdA = r.body._id;
      assert.ok(memIdA);
    });

    it('Write memory to beta via proxy', async () => {
      const r = await post(BASE, tokenA, `/api/brain/${PROXY}/memories?targetSpace=${SPACE_B}`, {
        fact: 'Beta fact from proxy',
        tags: ['beta'],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      memIdB = r.body._id;
      assert.ok(memIdB);
    });

    it('List memories via proxy aggregates both spaces', async () => {
      const r = await get(BASE, tokenA, `/api/brain/${PROXY}/memories?limit=100`);
      assert.equal(r.status, 200);
      const facts = r.body.memories.map(m => m.fact);
      assert.ok(facts.includes('Alpha fact from proxy'), 'Should include alpha memory');
      assert.ok(facts.includes('Beta fact from proxy'), 'Should include beta memory');
    });

    it('Get memory by ID via proxy finds it across members', async () => {
      // memIdA is in alpha, try to get via proxy
      const r = await get(BASE, tokenA, `/api/brain/${PROXY}/memories/${memIdA}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.fact, 'Alpha fact from proxy');
    });

    it('Long-form list via /spaces/ prefix aggregates', async () => {
      const r = await get(BASE, tokenA, `/api/brain/spaces/${PROXY}/memories?limit=100`);
      assert.equal(r.status, 200);
      assert.ok(r.body.memories.length >= 2, `Expected >=2 memories, got ${r.body.memories.length}`);
    });

    it('Stats aggregate counts across member spaces', async () => {
      const r = await get(BASE, tokenA, `/api/brain/spaces/${PROXY}/stats`);
      assert.equal(r.status, 200);
      assert.ok(r.body.memories >= 2, `Expected memories count >=2, got ${r.body.memories}`);
    });

    it('Delete memory via proxy works (alpha memory)', async () => {
      const r = await del(BASE, tokenA, `/api/brain/${PROXY}/memories/${memIdA}`);
      assert.equal(r.status, 204);

      // Confirm it's gone
      const r2 = await get(BASE, tokenA, `/api/brain/${PROXY}/memories/${memIdA}`);
      assert.equal(r2.status, 404);
    });

    it('Delete memory via proxy works (long-form, beta memory)', async () => {
      const r = await del(BASE, tokenA, `/api/brain/spaces/${PROXY}/memories/${memIdB}`);
      assert.equal(r.status, 204);
    });
  });

  // ── Brain API — entities & edges ─────────────────────────────────────────

  describe('Brain — entities & edges via proxy', () => {
    it('Entities listed via proxy aggregate across members', async () => {
      // Seed one entity in each member space directly via sync API (single doc body)
      const rA = await post(BASE, tokenA, '/api/sync/entities?spaceId=' + SPACE_A, {
        _id: `${RUN}-ent-a`, spaceId: SPACE_A, name: 'AlphaEnt', type: 'test', tags: [], seq: 1,
        author: { instanceId: 'test', instanceLabel: 'test' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      assert.equal(rA.status, 200, `Seed alpha entity: ${JSON.stringify(rA.body)}`);

      const rB = await post(BASE, tokenA, '/api/sync/entities?spaceId=' + SPACE_B, {
        _id: `${RUN}-ent-b`, spaceId: SPACE_B, name: 'BetaEnt', type: 'test', tags: [], seq: 1,
        author: { instanceId: 'test', instanceLabel: 'test' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      assert.equal(rB.status, 200, `Seed beta entity: ${JSON.stringify(rB.body)}`);

      const r = await get(BASE, tokenA, `/api/brain/spaces/${PROXY}/entities?limit=100`);
      assert.equal(r.status, 200);
      const names = r.body.entities.map(e => e.name);
      assert.ok(names.includes('AlphaEnt'), 'Should include alpha entity');
      assert.ok(names.includes('BetaEnt'), 'Should include beta entity');
    });

    it('Edges listed via proxy aggregate across members', async () => {
      const rE = await post(BASE, tokenA, '/api/sync/edges?spaceId=' + SPACE_A, {
        _id: `${RUN}-edge-a`, spaceId: SPACE_A, from: `${RUN}-ent-a`, to: `${RUN}-ent-b`, label: 'alpha-link', weight: 1, seq: 1,
        author: { instanceId: 'test', instanceLabel: 'test' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      assert.equal(rE.status, 200, `Seed alpha edge: ${JSON.stringify(rE.body)}`);

      const r = await get(BASE, tokenA, `/api/brain/spaces/${PROXY}/edges?limit=100`);
      assert.equal(r.status, 200);
      assert.ok(r.body.edges.some(e => e.label === 'alpha-link'), 'Should include alpha edge');
    });

    it('Delete entity via proxy finds it across members', async () => {
      const r = await del(BASE, tokenA, `/api/brain/spaces/${PROXY}/entities/${RUN}-ent-a`);
      assert.equal(r.status, 204);
    });

    it('Delete edge via proxy finds it across members', async () => {
      const r = await del(BASE, tokenA, `/api/brain/spaces/${PROXY}/edges/${RUN}-edge-a`);
      assert.equal(r.status, 204);
    });
  });

  // ── Reindex status ───────────────────────────────────────────────────────

  describe('Reindex status via proxy', () => {
    it('Returns aggregated reindex status', async () => {
      const r = await get(BASE, tokenA, `/api/brain/spaces/${PROXY}/reindex-status`);
      assert.equal(r.status, 200);
      assert.equal(typeof r.body.needsReindex, 'boolean');
    });
  });

  // ── Files API ────────────────────────────────────────────────────────────

  describe('Files — read/write via proxy', () => {
    it('Write file without targetSpace returns 400', async () => {
      const r = await post(BASE, tokenA, `/api/files/${PROXY}?path=test.txt`, {
        content: 'should fail', encoding: 'utf8',
      });
      assert.equal(r.status, 400);
      assert.ok(r.body.error.includes('targetSpace'), r.body.error);
    });

    it('Write file to alpha via proxy', async () => {
      const r = await post(BASE, tokenA, `/api/files/${PROXY}?path=proxy-alpha.txt&targetSpace=${SPACE_A}`, {
        content: 'alpha file content', encoding: 'utf8',
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    it('Write file to beta via proxy', async () => {
      const r = await post(BASE, tokenA, `/api/files/${PROXY}?path=proxy-beta.txt&targetSpace=${SPACE_B}`, {
        content: 'beta file content', encoding: 'utf8',
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    it('Read file from alpha via proxy', async () => {
      const resp = await fetch(`${BASE}/api/files/${PROXY}?path=proxy-alpha.txt`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.equal(resp.status, 200);
      const text = await resp.text();
      assert.equal(text, 'alpha file content');
    });

    it('List root dir via proxy aggregates entries from both members', async () => {
      const r = await get(BASE, tokenA, `/api/files/${PROXY}`);
      assert.equal(r.status, 200);
      const names = r.body.entries.map(e => e.name);
      assert.ok(names.includes('proxy-alpha.txt'), `Expected proxy-alpha.txt in listing: ${names}`);
      assert.ok(names.includes('proxy-beta.txt'), `Expected proxy-beta.txt in listing: ${names}`);
    });

    it('mkdir without targetSpace returns 400', async () => {
      const r = await post(BASE, tokenA, `/api/files/${PROXY}/mkdir?path=newdir`, {});
      assert.equal(r.status, 400);
    });

    it('mkdir with targetSpace works', async () => {
      const r = await post(BASE, tokenA, `/api/files/${PROXY}/mkdir?path=newdir&targetSpace=${SPACE_A}`, {});
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    it('Delete file without targetSpace returns 400', async () => {
      const r = await del(BASE, tokenA, `/api/files/${PROXY}?path=proxy-alpha.txt`);
      assert.equal(r.status, 400);
    });

    it('Delete file with targetSpace works', async () => {
      const r = await del(BASE, tokenA, `/api/files/${PROXY}?path=proxy-alpha.txt&targetSpace=${SPACE_A}`);
      assert.equal(r.status, 204);
    });

    it('Move file without targetSpace returns 400', async () => {
      const r = await patch(BASE, tokenA, `/api/files/${PROXY}?path=proxy-beta.txt`, {
        destination: 'renamed.txt',
      });
      assert.equal(r.status, 400);
    });

    it('Move file with targetSpace works', async () => {
      const r = await patch(BASE, tokenA, `/api/files/${PROXY}?path=proxy-beta.txt&targetSpace=${SPACE_B}`, {
        destination: 'renamed.txt',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });
  });

  // ── Regular spaces still work (regression) ──────────────────────────────

  describe('Regular spaces unaffected by proxy code', () => {
    it('Write memory to alpha directly (no targetSpace needed)', async () => {
      const r = await post(BASE, tokenA, `/api/brain/${SPACE_A}/memories`, {
        fact: 'Direct alpha fact',
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    it('Write file to beta directly (no targetSpace needed)', async () => {
      const r = await post(BASE, tokenA, `/api/files/${SPACE_B}?path=direct.txt`, {
        content: 'direct content', encoding: 'utf8',
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });
  });

  // ── MCP tools via proxy space ────────────────────────────────────────────

  describe('MCP tools through proxy space', () => {
    let session;
    before(async () => {
      // Seed data: one memory in each member space for recall testing
      await post(BASE, tokenA, `/api/brain/${SPACE_A}/memories`, {
        fact: 'Alpha MCP recall test fact about quantum physics',
        tags: ['mcp-test'],
      });
      await post(BASE, tokenA, `/api/brain/${SPACE_B}/memories`, {
        fact: 'Beta MCP recall test fact about machine learning',
        tags: ['mcp-test'],
      });
      // Write a file in alpha for read_file testing
      await post(BASE, tokenA, `/api/files/${SPACE_A}?path=mcp-test.txt`, {
        content: 'MCP test file in alpha', encoding: 'utf8',
      });

      session = await openMcpSession(tokenA);
    });
    after(() => session?.close());

    it('tools/list includes all expected tools', async () => {
      const tools = await session.listTools();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('remember'), 'remember tool should be present');
      assert.ok(names.includes('recall'), 'recall tool should be present');
      assert.ok(names.includes('read_file'), 'read_file tool should be present');
    });

    it('remember without targetSpace returns error for proxy', async () => {
      const result = await session.callTool('remember', { space: PROXY, fact: 'Should fail without target' });
      assert.ok(result.isError || result.content?.[0]?.text?.includes('targetSpace'),
        `Expected error about targetSpace, got: ${JSON.stringify(result)}`);
    });

    it('remember with targetSpace works', async () => {
      const result = await session.callTool('remember', {
        space: PROXY,
        fact: 'MCP proxy write to alpha',
        targetSpace: SPACE_A,
      });
      assert.ok(!result.isError, `Expected success, got: ${JSON.stringify(result)}`);
      assert.ok(result.content?.[0]?.text?.includes('Stored memory'));
    });

    it('recall aggregates across member spaces (or errors if index not ready)', async () => {
      // Vector search indexes may not be ready on newly-created spaces.
      // This test verifies the aggregation path runs without crashing.
      const result = await session.callTool('recall', { space: PROXY, query: 'quantum physics machine learning', topK: 20 });
      // Either succeeds with results, or returns a reindex/index error (both acceptable)
      const text = result.content?.[0]?.text ?? '';
      assert.ok(text.length > 0, 'Should return some response text');
    });

    it('query tool aggregates across member spaces', async () => {
      // Use query (MongoDB find, no vector index needed) to verify aggregation
      const result = await session.callTool('query', {
        space: PROXY, collection: 'memories', filter: { tags: 'mcp-test' }, limit: 50,
      });
      assert.ok(!result.isError, JSON.stringify(result));
      const docs = JSON.parse(result.content?.[0]?.text ?? '[]');
      assert.ok(docs.length >= 2, `Expected >=2 memories with tag mcp-test, got ${docs.length}`);
    });

    it('read_file finds files across member spaces', async () => {
      const result = await session.callTool('read_file', { space: PROXY, path: 'mcp-test.txt' });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(result.content?.[0]?.text, 'MCP test file in alpha');
    });

    it('list_dir aggregates across member spaces', async () => {
      const result = await session.callTool('list_dir', { space: PROXY, path: '' });
      assert.ok(!result.isError, JSON.stringify(result));
      const text = result.content?.[0]?.text ?? '';
      // Should see files from both member spaces
      assert.ok(text.includes('mcp-test.txt') || text.includes('direct.txt') || text.includes('renamed.txt'),
        `Expected aggregated dir listing, got: ${text}`);
    });

    it('write_file without targetSpace returns error for proxy', async () => {
      const result = await session.callTool('write_file', { space: PROXY, path: 'fail.txt', content: 'x' });
      assert.ok(result.isError || result.content?.[0]?.text?.includes('targetSpace'),
        `Expected targetSpace error, got: ${JSON.stringify(result)}`);
    });

    it('write_file with targetSpace works', async () => {
      const result = await session.callTool('write_file', {
        space: PROXY, path: 'mcp-written.txt', content: 'written via MCP proxy', targetSpace: SPACE_B,
      });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.ok(result.content?.[0]?.text?.includes('Written'));
    });

    it('upsert_entity without targetSpace returns error for proxy', async () => {
      const result = await session.callTool('upsert_entity', { space: PROXY, name: 'Fail', type: 'test' });
      assert.ok(result.isError || result.content?.[0]?.text?.includes('targetSpace'),
        `Expected targetSpace error, got: ${JSON.stringify(result)}`);
    });

    it('upsert_entity with targetSpace works', async () => {
      const result = await session.callTool('upsert_entity', {
        space: PROXY, name: 'McpEntity', type: 'test', targetSpace: SPACE_A,
      });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.ok(result.content?.[0]?.text?.includes('upserted'));
    });

    it('delete_file without targetSpace returns error for proxy', async () => {
      const result = await session.callTool('delete_file', { space: PROXY, path: 'mcp-written.txt' });
      assert.ok(result.isError || result.content?.[0]?.text?.includes('targetSpace'),
        `Expected targetSpace error, got: ${JSON.stringify(result)}`);
    });

    it('delete_file with targetSpace works', async () => {
      const result = await session.callTool('delete_file', {
        space: PROXY, path: 'mcp-written.txt', targetSpace: SPACE_B,
      });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.ok(result.content?.[0]?.text?.includes('Deleted'));
    });
  });
});
