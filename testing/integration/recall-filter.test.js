/**
 * Integration tests: Prefiltered semantic recall
 *
 * Covers:
 *  - recall with filter returns only matching records (eq on properties.status)
 *  - high-similarity record with non-matching filter value is excluded
 *  - numeric comparison (gt) filter works
 *  - tags in-filter returns any-of match
 *  - type and name filter keys are allowed
 *  - invalid filter key (not starting with properties./tags/type/name) returns 400
 *  - existing recall without filter is unaffected (backward compat)
 *  - MCP recall tool accepts filter argument and applies it
 *
 * Run: node --test testing/integration/recall-filter.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `filter-test-${RUN}`;

let tokenA;
let embeddingAvailable = false;

function token() { return tokenA; }

async function ensureReindexed(baseUrl, tok) {
  const { body: spacesBody } = await get(baseUrl, tok, '/api/spaces');
  const spaces = spacesBody?.spaces ?? [];
  for (const space of spaces) {
    const { body: statusBody } = await get(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex-status`);
    if (statusBody?.needsReindex) {
      await post(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex`, {});
    }
  }
}

async function openMcpSession(authToken, instance = INSTANCES.a, timeoutMs = 15_000) {
  const base = instance;
  const parsed = new URL(base);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '80', 10);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host, port,
        path: '/mcp',
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
          if (sessionId) { clearInterval(poll); resolve({ callTool, close }); }
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
                path: `/mcp/messages?sessionId=${sessionId}`,
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
        function close() { req.destroy(); }
      },
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  // Create dedicated space for isolation
  const r = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `Filter Test ${RUN}` });
  assert.equal(r.status, 201, `Failed to create space: ${JSON.stringify(r.body)}`);
  await ensureReindexed(INSTANCES.a, token());
  // Probe embedding availability by writing one entity and checking it gets embedded
  const probe = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: `__filter-probe-${RUN}__`,
    type: 'probe',
    description: `filter probe entity ${RUN}`,
    properties: { status: 'probe' },
    tags: [],
  });
  embeddingAvailable = probe.status === 201;
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

/**
 * Poll $vectorSearch until all given IDs appear in unfiltered recall results.
 * Atlas Local has indexing latency — a document written with a 201 is not
 * immediately visible to $vectorSearch. We must wait for mongot to catch up.
 */
async function waitForIndexed(ids, types = ['entity', 'memory'], timeoutMs = 30_000) {
  const pending = new Set(ids);
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'indexing probe query',
      types,
      topK: 100,
    });
    if (r.status === 200 && Array.isArray(r.body.results)) {
      for (const result of r.body.results) {
        pending.delete(result._id);
      }
    }
    if (pending.size > 0) {
      await new Promise(res => setTimeout(res, 500));
    }
  }
  if (pending.size > 0) {
    throw new Error(`Timed out waiting for indexing of: ${[...pending].join(', ')}`);
  }
}

// ── Validation tests (no embedding required) ─────────────────────────────

describe('Recall filter — input validation', () => {
  it('filter key not starting with properties./tags/type/name returns 400', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: { 'injected.key': { eq: 'value' } },
    });
    assert.equal(r.status, 400, `Expected 400 for invalid filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error, 'Response must have error field');
  });

  it('filter key with arbitrary top-level field returns 400', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: { 'spaceId': { eq: 'anything' } },
    });
    assert.equal(r.status, 400, `Expected 400 for disallowed top-level key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('filter key with _id injection attempt returns 400', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: { '_id': { eq: 'anything' } },
    });
    assert.equal(r.status, 400, `Expected 400 for _id filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('filter: non-object body returns 400', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: 'not-an-object',
    });
    assert.equal(r.status, 400, `Expected 400 for non-object filter, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('filter: array body returns 400', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: [{ 'properties.status': { eq: 'x' } }],
    });
    assert.equal(r.status, 400, `Expected 400 for array filter, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key properties.* passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: { 'properties.status': { eq: 'nonexistent-value-xyzzy' } },
    });
    assert.equal(r.status, 200, `Expected 200 for valid filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key "type" passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: { 'type': { eq: 'entity' } },
    });
    assert.equal(r.status, 200, `Expected 200 for type filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key "name" passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: { 'name': { eq: 'nonexistent-xyzzy' } },
    });
    assert.equal(r.status, 200, `Expected 200 for name filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key "tags" passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test',
      filter: { 'tags': { in: ['nonexistent-tag-xyzzy'] } },
    });
    assert.equal(r.status, 200, `Expected 200 for tags filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('recall without filter returns 200 (backward compat)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: 'test query',
      types: ['entity'],
    });
    assert.equal(r.status, 200, `Expected 200 without filter, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.results), 'results must be an array');
  });
});

// ── Semantic filter correctness tests (embedding required) ────────────────

describe('Recall filter — eq filter on properties.status', () => {
  const sharedDesc = `architecture-decision-record-auth-security-${RUN}`;
  let acceptedId;
  let rejectedId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    // Write two entities with identical description (→ identical similarity score)
    // but different properties.status — the filter must distinguish them
    const acc = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `ADR-accepted-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'accepted', domain: 'security' },
      tags: ['adr', 'auth'],
    });
    assert.equal(acc.status, 201, `Create accepted entity failed: ${JSON.stringify(acc.body)}`);
    acceptedId = acc.body._id;

    const rej = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `ADR-rejected-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'rejected', domain: 'security' },
      tags: ['adr', 'auth'],
    });
    assert.equal(rej.status, 201, `Create rejected entity failed: ${JSON.stringify(rej.body)}`);
    rejectedId = rej.body._id;

    await waitForIndexed([acceptedId, rejectedId], ['entity']);
  });

  it('filter eq accepted — accepted entity appears, rejected does not', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { eq: 'accepted' } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), `Accepted entity (${acceptedId}) must be in results`);
    assert.ok(!ids.includes(rejectedId), `Rejected entity (${rejectedId}) must NOT be in filtered results`);
  });

  it('filter eq rejected — rejected entity appears, accepted does not', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { eq: 'rejected' } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(!ids.includes(acceptedId), `Accepted entity must NOT be in rejected-filter results`);
    assert.ok(ids.includes(rejectedId), `Rejected entity (${rejectedId}) must be in results`);
  });

  it('filter ne rejected — accepted entity appears, rejected does not', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { ne: 'rejected' } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), `Accepted entity must appear with ne:rejected filter`);
    assert.ok(!ids.includes(rejectedId), `Rejected entity must NOT appear with ne:rejected filter`);
  });
});

describe('Recall filter — numeric gt/gte/lt/lte on properties', () => {
  const desc = `numeric-filter-test-count-${RUN}`;
  let highId;
  let lowId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const high = await post(INSTANCES.a, token(), `/api/brain/${SPACE}/memories`, {
      fact: `${desc} high-count`,
      description: desc,
      properties: { count: 50, label: 'high' },
      tags: ['numeric-test'],
    });
    assert.equal(high.status, 201, `Create high-count memory failed: ${JSON.stringify(high.body)}`);
    highId = high.body._id;

    const low = await post(INSTANCES.a, token(), `/api/brain/${SPACE}/memories`, {
      fact: `${desc} low-count`,
      description: desc,
      properties: { count: 5, label: 'low' },
      tags: ['numeric-test'],
    });
    assert.equal(low.status, 201, `Create low-count memory failed: ${JSON.stringify(low.body)}`);
    lowId = low.body._id;

    await waitForIndexed([highId, lowId], ['memory']);
  });

  it('filter gt:10 returns high-count record, excludes low-count', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.count': { gt: 10 } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(highId), `High-count memory must appear with gt:10 filter`);
    assert.ok(!ids.includes(lowId), `Low-count memory must NOT appear with gt:10 filter`);
  });

  it('filter lte:10 returns low-count record, excludes high-count', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.count': { lte: 10 } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(!ids.includes(highId), `High-count memory must NOT appear with lte:10 filter`);
    assert.ok(ids.includes(lowId), `Low-count memory must appear with lte:10 filter`);
  });

  it('filter gte:5 and lt:100 (range) returns only high-count and low-count', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.count': { gte: 5, lt: 100 } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(highId), `High-count memory must appear with gte:5,lt:100 filter`);
    assert.ok(ids.includes(lowId), `Low-count memory must appear with gte:5,lt:100 filter`);
  });
});

describe('Recall filter — tags in (any-of)', () => {
  const desc = `tags-filter-test-${RUN}`;
  let securityId;
  let infraId;
  let unrelatedId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const sec = await post(INSTANCES.a, token(), `/api/brain/${SPACE}/memories`, {
      fact: `${desc} security-tagged`,
      description: desc,
      tags: ['security', 'auth'],
    });
    assert.equal(sec.status, 201, `Create security memory failed: ${JSON.stringify(sec.body)}`);
    securityId = sec.body._id;

    const infra = await post(INSTANCES.a, token(), `/api/brain/${SPACE}/memories`, {
      fact: `${desc} infra-tagged`,
      description: desc,
      tags: ['infra'],
    });
    assert.equal(infra.status, 201, `Create infra memory failed: ${JSON.stringify(infra.body)}`);
    infraId = infra.body._id;

    const unrel = await post(INSTANCES.a, token(), `/api/brain/${SPACE}/memories`, {
      fact: `${desc} unrelated-tagged`,
      description: desc,
      tags: ['unrelated-tag-xyzzy'],
    });
    assert.equal(unrel.status, 201, `Create unrelated memory failed: ${JSON.stringify(unrel.body)}`);
    unrelatedId = unrel.body._id;

    await waitForIndexed([securityId, infraId, unrelatedId], ['memory']);
  });

  it('filter tags in ["security","infra"] returns both security and infra records, not unrelated', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'tags': { in: ['security', 'infra'] } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(securityId), `Security-tagged memory must appear`);
    assert.ok(ids.includes(infraId), `Infra-tagged memory must appear`);
    assert.ok(!ids.includes(unrelatedId), `Unrelated-tagged memory must NOT appear`);
  });
});

describe('Recall filter — exists operator', () => {
  const desc = `exists-filter-test-${RUN}`;
  let withPropId;
  let withoutPropId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const withProp = await post(INSTANCES.a, token(), `/api/brain/${SPACE}/memories`, {
      fact: `${desc} with-domain-prop`,
      description: desc,
      properties: { domain: 'infra' },
      tags: ['exists-test'],
    });
    assert.equal(withProp.status, 201, `Create with-prop memory failed: ${JSON.stringify(withProp.body)}`);
    withPropId = withProp.body._id;

    const withoutProp = await post(INSTANCES.a, token(), `/api/brain/${SPACE}/memories`, {
      fact: `${desc} without-domain-prop`,
      description: desc,
      tags: ['exists-test'],
    });
    assert.equal(withoutProp.status, 201, `Create without-prop memory failed: ${JSON.stringify(withoutProp.body)}`);
    withoutPropId = withoutProp.body._id;

    await waitForIndexed([withPropId, withoutPropId], ['memory']);
  });

  it('filter exists:true on properties.domain returns only records that have that property', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.domain': { exists: true } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(withPropId), `Record with property must appear`);
    assert.ok(!ids.includes(withoutPropId), `Record without property must NOT appear`);
  });

  it('filter exists:false on properties.domain returns only records without that property', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/recall`, {
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.domain': { exists: false } },
    });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(!ids.includes(withPropId), `Record with property must NOT appear`);
    assert.ok(ids.includes(withoutPropId), `Record without property must appear`);
  });
});

describe('Recall filter — MCP recall tool accepts filter', () => {
  let session;
  const sharedDesc = `mcp-filter-test-auth-decision-${RUN}`;
  let acceptedId;
  let rejectedId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    session = await openMcpSession(token());

    const acc = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `MCP-ADR-accepted-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'accepted' },
      tags: ['mcp-filter-test'],
    });
    assert.equal(acc.status, 201, `Create accepted entity failed: ${JSON.stringify(acc.body)}`);
    acceptedId = acc.body._id;

    const rej = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `MCP-ADR-rejected-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'rejected' },
      tags: ['mcp-filter-test'],
    });
    assert.equal(rej.status, 201, `Create rejected entity failed: ${JSON.stringify(rej.body)}`);
    rejectedId = rej.body._id;

    await waitForIndexed([acceptedId, rejectedId], ['entity']);
  });

  after(() => session?.close());

  it('MCP recall with filter returns only matching records', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const result = await session.callTool('recall', {
      space: SPACE,
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { eq: 'accepted' } },
    });
    assert.ok(!result?.isError, `recall with filter returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      assert.fail(`MCP recall response must be valid JSON, got: ${text}`);
    }
    assert.ok(Array.isArray(parsed.results), '"results" must be an array');
    const ids = parsed.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), `Accepted entity must appear via MCP filter`);
    assert.ok(!ids.includes(rejectedId), `Rejected entity must NOT appear via MCP filter`);
  });

  it('MCP recall with invalid filter key returns isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const result = await session.callTool('recall', {
      space: SPACE,
      query: 'test',
      filter: { 'injected.field': { eq: 'value' } },
    });
    assert.ok(result?.isError, `Invalid filter key must return isError=true`);
  });
});
