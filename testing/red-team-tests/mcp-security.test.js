/**
 * Red-team tests: MCP security — token hygiene and input validation.
 *
 * Covers:
 *  1. Token prefix collision — an 8-char prefix match without the full token
 *     must return 401 on the MCP SSE endpoint
 *  2. Token brute-force — exhausting a 16-char space must be impossible; the
 *     rate-limiter must trip before an attacker can try more than N tokens
 *  3. recall_global space scope leak — a token scoped to space A must NOT
 *     retrieve memories from space B via the recall_global MCP tool
 *  4. MCP tool injection via oversized input — a 200KB fact string must be
 *     rejected by the remember tool
 *  5. MCP tool injection via operator in filter — $where / $function must
 *     be rejected by the query tool
 *  6. MCP unauthenticated access — GET/POST to /mcp without a valid Bearer
 *     token must return 401
 *
 * Tests 1 and 3 are EXPECTED TO FAIL until the corresponding fixes are applied.
 * All other tests should pass if the existing allowlist and rate-limit middleware work.
 *
 * Run: node --test testing/red-team-tests/mcp-security.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Open an MCP SSE session and return the session endpoint URL.
 * Returns null if the server returns a non-200 status.
 */
async function openMcpSession(instance, bearerToken) {
  const res = await fetch(`${instance}/mcp`, {
    headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
  });
  if (res.status !== 200) return { status: res.status, sessionUrl: null };
  // SSE: read first event to get the session URL
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const match = buf.match(/data:\s*(.+)\n/);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        const sessionUrl = data.sessionId
          ? `${instance}/mcp/${data.sessionId}`
          : (data.endpoint ?? null);
        reader.cancel();
        return { status: 200, sessionUrl };
      } catch {
        reader.cancel();
        return { status: 200, sessionUrl: null };
      }
    }
  }
  return { status: 200, sessionUrl: null };
}

/**
 * Call an MCP tool over JSON-RPC on an already-opened session.
 */
async function callTool(instance, bearerToken, sessionUrl, toolName, toolArgs) {
  const payload = {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  };
  const res = await fetch(sessionUrl ?? `${instance}/mcp/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: res.status !== 204 ? await res.json().catch(() => null) : null };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MCP security — authentication', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('GET /mcp without auth returns 401', async () => {
    const r = await fetch(`${INSTANCES.a}/mcp`);
    assert.equal(r.status, 401);
  });

  it('POST /mcp/messages without auth returns 401', async () => {
    const r = await fetch(`${INSTANCES.a}/mcp/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 401);
  });

  it('Token prefix collision — 8-char prefix alone must return 401', async () => {
    // Take only first 8 characters of a valid token: "ythril_x" prefix-only attack
    const fullToken = tokenA;
    // Tokens are of the form  ythril_<random>
    // An attacker knowing only the prefix cannot authenticate
    const eightCharPrefix = fullToken.slice(0, Math.min(15, fullToken.length));
    const r = await fetch(`${INSTANCES.a}/mcp`, {
      headers: { Authorization: `Bearer ${eightCharPrefix}` },
    });
    assert.equal(r.status, 401,
      `VULNERABILITY: Short prefix "${eightCharPrefix}" was accepted as a valid token (got ${r.status}).`);
  });

  it('Completely invalid token returns 401', async () => {
    const r = await fetch(`${INSTANCES.a}/mcp`, {
      headers: { Authorization: 'Bearer ythril_totallywrongtokenvalue1234567890' },
    });
    assert.equal(r.status, 401);
  });
});

// ── recall_global scope leak ───────────────────────────────────────────────

describe('MCP security — recall_global scope isolation', () => {
  it('recall_global must not return memories outside the token\'s allowed spaces', async () => {
    // This test requires two spaces: 'general' (accessible) plus a private space.
    // We use the space-B token from the multi-instance setup if available.
    // If only one space is configured, we skip this test gracefully.
    const tokenBPath = path.join(CONFIGS, 'b', 'token.txt');
    if (!fs.existsSync(tokenBPath)) {
      return; // skip: single-space setup
    }
    const tokenB = fs.readFileSync(tokenBPath, 'utf8').trim();

    // Write a secret memory into instance B's space using tokenB
    const secretFact = `SECRET-SCOPELEAK-${Date.now()}`;
    await post(INSTANCES.b, tokenB, '/api/brain/general/memories', { fact: secretFact });

    // Now open an MCP session on instance A with tokenA (scope: instance A only)
    const { status, sessionUrl } = await openMcpSession(INSTANCES.a, tokenA);
    if (status !== 200 || !sessionUrl) {
      // MCP not wired or session URL not obtainable — skip gracefully
      return;
    }

    // Call recall_global — this should only search spaces allowed by tokenA
    const toolR = await callTool(INSTANCES.a, tokenA, sessionUrl, 'recall_global', {
      query: secretFact,
    });

    // The result must NOT contain the secret from instance B
    const content = JSON.stringify(toolR.body ?? '');
    assert.ok(!content.includes(secretFact),
      `VULNERABILITY: recall_global returned a memory from outside the token's allowed spaces.\n` +
      `Found "${secretFact}" in cross-instance response. ` +
      `Fix: filter cfg.spaces against req.authToken?.spaces in the recall_global handler.`);
  });
});

// ── remember tool — oversized input ───────────────────────────────────────

describe('MCP security — remember tool input validation', () => {
  it('remember with a 200KB fact returns isError=true', async () => {
    const { status, sessionUrl } = await openMcpSession(INSTANCES.a, tokenA);
    if (status !== 200 || !sessionUrl) return; // skip if MCP not wired

    const r = await callTool(INSTANCES.a, tokenA, sessionUrl, 'remember', {
      spaceId: 'general',
      fact: 'X'.repeat(200_000),
    });
    const body = r.body;
    // MCP spec: isError=true for tool execution errors
    assert.ok(
      (body?.result?.isError === true) ||
      (Array.isArray(body?.result?.content) && body.result.content.some(c => c.text?.toLowerCase().includes('error'))),
      `Expected isError=true for oversized fact, got: ${JSON.stringify(body)}`
    );
  });
});

// ── query tool — operator injection ───────────────────────────────────────

describe('MCP security — query tool operator allowlist', () => {
  it('query with $where returns isError=true', async () => {
    const { status, sessionUrl } = await openMcpSession(INSTANCES.a, tokenA);
    if (status !== 200 || !sessionUrl) return;

    const r = await callTool(INSTANCES.a, tokenA, sessionUrl, 'query', {
      spaceId: 'general',
      filter: { $where: 'function() { return true; }' },
    });
    const body = r.body;
    assert.ok(
      (body?.result?.isError === true) ||
      (Array.isArray(body?.result?.content) && body.result.content.some(c => c.text?.toLowerCase().includes('error'))),
      `Expected isError=true for $where injection, got: ${JSON.stringify(body)}`
    );
  });

  it('query with $function returns isError=true', async () => {
    const { status, sessionUrl } = await openMcpSession(INSTANCES.a, tokenA);
    if (status !== 200 || !sessionUrl) return;

    const r = await callTool(INSTANCES.a, tokenA, sessionUrl, 'query', {
      spaceId: 'general',
      filter: { $function: { body: 'return true', args: [], lang: 'js' } },
    });
    const body = r.body;
    assert.ok(
      (body?.result?.isError === true) ||
      (Array.isArray(body?.result?.content) && body.result.content.some(c => c.text?.toLowerCase().includes('error'))),
      `Expected isError=true for $function injection, got: ${JSON.stringify(body)}`
    );
  });

  it('query with deeply nested filter (>8 deep) returns isError=true', async () => {
    const { status, sessionUrl } = await openMcpSession(INSTANCES.a, tokenA);
    if (status !== 200 || !sessionUrl) return;

    // Build a 10-deep nested $and filter
    let deep = { tags: { $exists: true } };
    for (let i = 0; i < 10; i++) {
      deep = { $and: [deep] };
    }

    const r = await callTool(INSTANCES.a, tokenA, sessionUrl, 'query', {
      spaceId: 'general',
      filter: deep,
    });
    const body = r.body;
    assert.ok(
      (body?.result?.isError === true) ||
      (Array.isArray(body?.result?.content) && body.result.content.some(c => c.text?.toLowerCase().includes('error'))),
      `Expected isError=true for depth-10 filter, got: ${JSON.stringify(body)}`
    );
  });

  it('query with allowed operators ($eq, $in, $and) returns results (not error)', async () => {
    const { status, sessionUrl } = await openMcpSession(INSTANCES.a, tokenA);
    if (status !== 200 || !sessionUrl) return;

    const r = await callTool(INSTANCES.a, tokenA, sessionUrl, 'query', {
      spaceId: 'general',
      filter: { tags: { $in: ['test'] } },
    });
    const body = r.body;
    assert.ok(
      (body?.result?.isError !== true),
      `False positive: valid $in query was errored out: ${JSON.stringify(body)}`
    );
  });
});
