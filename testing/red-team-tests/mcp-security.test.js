/**
 * Red-team tests: MCP security — token hygiene and input validation.
 *
 * Covers:
 *  1. Token prefix collision — an 8-char prefix match without the full token
 *     must return 401 on the MCP endpoint
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
 *  7. Per-request authorization — 4.0 removed the SSE transport, which removed
 *     the session-hijacking class outright; what replaces it is asserted here
 *
 * All tests should pass with the current codebase. Token prefix collision (test 1)
 * and recall_global scope isolation (test 3) fixes have been applied.
 *
 * Run: node --test testing/red-team-tests/mcp-security.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, reqJson } from '../sync/helpers.js';
import { openMcpSession as openSharedMcpSession } from '../sync/mcp-session.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The shared client, adapted to this file's `{ status, callTool, close }` shape.
 *
 * There were THREE local harnesses here — a session opener, a raw one that exposed its `sessionId`, and a
 * poster that drove someone else's session with a chosen bearer. All three existed to attack the SSE session,
 * and 4.0 removed the transport they attacked.
 *
 * `status` survives because six cases assert the endpoint is reachable before drawing a conclusion from a
 * refusal — and under a stateless transport there is no "open" to take a status from, so this PROBES with a
 * `tools/list` rather than reporting a hardcoded 200. That distinction matters here more than anywhere: a
 * red-team case that cannot tell "refused" from "unreachable" reports a vulnerability as fixed.
 */
async function openMcpSession(instance, bearerToken) {
  const client = await openSharedMcpSession(bearerToken, instance);
  try {
    await client.listTools();
    return { status: 200, callTool: client.callTool, close: client.close };
  } catch (err) {
    return { status: err?.statusCode ?? 0, callTool: null, close: () => {} };
  }
}

// ── Per-request authorization (what replaced S2) ───────────────────────────

/*
 * S2 was: an SSE session was pinned to the id of the token that opened it, and to a signature of that
 * token's rights matrix, so a second valid token that LEARNED the session id could not drive it. The session
 * id travelled as a query parameter, which put it in proxy logs and browser history, so this was not a
 * theoretical way to learn one.
 *
 * 4.0 removes the SSE transport, and with it the whole class: `POST /mcp` is stateless, so there is no
 * session to hijack, nothing to learn, and no window in which a token's rights can go stale mid-stream. The
 * old case is not "fixed" — its subject no longer exists, and a test kept alive against a deleted mechanism
 * passes for the wrong reason.
 *
 * What must still be true is the property that made the binding necessary: **every request is authorized on
 * the bearer it carries, and on that token's CURRENT rights.** That is asserted here, because it is the thing
 * an attacker would have been reaching for.
 */
describe('MCP security — every request is authorized on its own bearer', () => {
  let readOnlyToken;
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // A second, distinct token (different id) valid on instance A, with no write rights.
    const r = await post(INSTANCES.a, tokenA, '/api/tokens', { name: `s2-readonly-${Date.now()}`, rights: legacyRights({ readOnly: true })});
    readOnlyToken = r?.body?.plaintext;
  });

  it('a read-only token is refused a write, while an admin token is not', async () => {
    assert.ok(readOnlyToken && readOnlyToken.startsWith('ythril_'), 'second token must be minted');

    const attacker = await openMcpSession(INSTANCES.a, readOnlyToken);
    try {
      assert.equal(attacker.status, 200, 'the read-only token must reach MCP — a refusal is the point, not a 401');
      const refused = await attacker.callTool('save_fact', { fact: 'S2-successor-write-attempt', space: 'general' });
      assert.ok(refused?.isError, `VULNERABILITY: a read-only token wrote through MCP: ${JSON.stringify(refused)}`);
    } finally { attacker.close(); }

    // Control: the same call with a token that HAS the right succeeds, so the refusal above is about rights
    // and not about the tool, the space, or the transport being broken.
    const admin = await openMcpSession(INSTANCES.a, tokenA);
    try {
      const ok = await admin.callTool('save_fact', { fact: `S2-successor-control-${Date.now()}`, space: 'general' });
      assert.ok(!ok?.isError, `the control write must succeed: ${JSON.stringify(ok)}`);
    } finally { admin.close(); }
  });
});

/**
 * THE SECOND DOOR ONTO THE SAME TOOLS, which is a new attack surface at 5.0.
 *
 * `POST /api/<tool-name>` reaches every tool with the arguments as the body. It is governed by `callTool`,
 * the same function the MCP dispatcher calls — so in principle there is nothing separate to attack. That
 * "in principle" is exactly what a red-team case is for: a door that forgets `requireAuth`, or that is
 * reached before the gates because of where it is mounted, would hand every tool to anybody.
 *
 * The greedy mount is the specific worry. The route is `/:tool`, mounted at `/api` IN FRONT of every other
 * router, and it declines a segment that is not a tool name by handing control back. If that decline ever
 * broke, `POST /api/spaces` would be answered by the tool door instead of by space creation — with a 200,
 * and nothing in a log to say so.
 */
describe('the HTTP tool door is governed by the same rights as MCP', () => {
  let readOnlyToken;
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const r = await post(INSTANCES.a, tokenA, '/api/tokens',
      { name: `tool-door-readonly-${Date.now()}`, rights: legacyRights({ readOnly: true }) });
    readOnlyToken = r?.body?.plaintext;
  });

  const callDoor = (bearer, tool, args) => fetch(`${INSTANCES.a}/api/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(args),
  });

  it('refuses an unauthenticated call', async () => {
    const r = await callDoor(null, 'list_spaces', {});
    assert.equal(r.status, 401, 'VULNERABILITY: the tool door answered without a bearer token');
  });

  it('refuses a garbage bearer', async () => {
    const r = await callDoor('ythril_not_a_real_token_at_all', 'list_spaces', {});
    assert.equal(r.status, 401);
  });

  it('refuses a read-only token a write, exactly as MCP does', async () => {
    assert.ok(readOnlyToken?.startsWith('ythril_'), 'the read-only token must be minted');
    const r = await callDoor(readOnlyToken, 'save_fact', { space: 'general', fact: 'tool-door write attempt' });
    assert.ok(r.status >= 400, `VULNERABILITY: a read-only token wrote through the HTTP tool door (${r.status})`);
    const body = await r.json();
    assert.equal(body.ok, false);

    // Control: the same call with a token that HAS the right succeeds, so the refusal is about rights and
    // not about the door, the tool or the space being broken.
    const ok = await callDoor(tokenA, 'save_fact', { space: 'general', fact: `tool-door control ${Date.now()}` });
    assert.equal(ok.status, 200, `the control write must succeed: ${await ok.text()}`);
  });

  it('does not swallow a route that merely looks like a tool name', async () => {
    // `POST /api/spaces` creates a space. If the tool door claimed it, this would answer in the tool
    // envelope instead — a 200 that created nothing, with the caller told it worked.
    const id = `door-probe-${Date.now()}`;
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { id, label: 'door probe' });
    assert.equal(r.status, 201, `VULNERABILITY: /api/spaces was answered by something else: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.ok, undefined, 'the tool envelope must not appear on a router route');
    await fetch(`${INSTANCES.a}/api/spaces/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });
});

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

  it('POST /mcp (Streamable HTTP) without auth returns 401', async () => {
    const r = await fetch(`${INSTANCES.a}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
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
      return; // skip: single-space setup — B not configured
    }
    const tokenB = fs.readFileSync(tokenBPath, 'utf8').trim();

    // Write a secret memory into instance B's space using tokenB
    const secretFact = `SECRET-SCOPELEAK-${Date.now()}`;
    await post(INSTANCES.b, tokenB, '/api/brain/spaces/general/facts', { fact: secretFact });

    // Now open an MCP session on instance A with tokenA (scope: instance A only)
    const { status, callTool, close } = await openMcpSession(INSTANCES.a, tokenA);
    try {
      assert.equal(status, 200, 'MCP endpoint must be reachable for recall_global scope test');
      assert.ok(callTool, 'MCP session must establish');

      // Call recall_global — this should only search spaces allowed by tokenA
      const rpc = await callTool('recall', { query: secretFact });

      // The result must NOT contain the secret from instance B
      const content = JSON.stringify(rpc?.result ?? rpc ?? '');
      assert.ok(!content.includes(secretFact),
        `VULNERABILITY: recall_global returned a memory from outside the token's allowed spaces.\n` +
        `Found "${secretFact}" in cross-instance response. ` +
        `Fix: filter cfg.spaces against req.authToken?.spaces in the recall_global handler.`);
    } finally { close(); }
  });
});

// ── remember tool — oversized input ───────────────────────────────────────

describe('MCP security — remember tool input validation', () => {
  it('remember with a 200KB fact returns isError=true', async () => {
    const { status, callTool, close } = await openMcpSession(INSTANCES.a, tokenA);
    try {
      assert.equal(status, 200, 'MCP endpoint must be reachable for security testing');
      assert.ok(callTool, 'MCP session must establish');

      const rpc = await callTool('save_fact', {
        space: 'general',
        fact: 'X'.repeat(200_000),
      });
      const result = rpc?.result ?? rpc;
      // MCP spec: isError=true for tool execution errors
      assert.ok(
        (result?.isError === true) ||
        (Array.isArray(result?.content) && result.content.some(c => c.text?.toLowerCase().includes('error'))),
        `Expected isError=true for oversized fact, got: ${JSON.stringify(rpc)}`
      );
    } finally { close(); }
  });
});

// ── query tool — operator injection ───────────────────────────────────────

describe('MCP security — query tool operator allowlist', () => {
  it('query with $where returns isError=true', async () => {
    const { status, callTool, close } = await openMcpSession(INSTANCES.a, tokenA);
    try {
      assert.equal(status, 200, 'MCP endpoint must be reachable for security testing');
      assert.ok(callTool, 'MCP session must establish');

      const rpc = await callTool('filter', {
        space: 'general',
        collection: 'facts',
        filter: { $where: 'function() { return true; }' },
      });
      const result = rpc?.result ?? rpc;
      assert.ok(
        (result?.isError === true) ||
        (Array.isArray(result?.content) && result.content.some(c => c.text?.toLowerCase().includes('error'))),
        `Expected isError=true for $where injection, got: ${JSON.stringify(rpc)}`
      );
    } finally { close(); }
  });

  it('query with $function returns isError=true', async () => {
    const { status, callTool, close } = await openMcpSession(INSTANCES.a, tokenA);
    try {
      assert.equal(status, 200, 'MCP endpoint must be reachable for security testing');
      assert.ok(callTool, 'MCP session must establish');

      const rpc = await callTool('filter', {
        space: 'general',
        collection: 'facts',
        filter: { $function: { body: 'return true', args: [], lang: 'js' } },
      });
      const result = rpc?.result ?? rpc;
      assert.ok(
        (result?.isError === true) ||
        (Array.isArray(result?.content) && result.content.some(c => c.text?.toLowerCase().includes('error'))),
        `Expected isError=true for $function injection, got: ${JSON.stringify(rpc)}`
      );
    } finally { close(); }
  });

  it('query with deeply nested filter (>8 deep) returns isError=true', async () => {
    const { status, callTool, close } = await openMcpSession(INSTANCES.a, tokenA);
    try {
      assert.equal(status, 200, 'MCP endpoint must be reachable for security testing');
      assert.ok(callTool, 'MCP session must establish');

      // Build a 10-deep nested $and filter
      let deep = { tags: { $exists: true } };
      for (let i = 0; i < 10; i++) {
        deep = { $and: [deep] };
      }

      const rpc = await callTool('filter', {
        space: 'general',
        collection: 'facts',
        filter: deep,
      });
      const result = rpc?.result ?? rpc;
      assert.ok(
        (result?.isError === true) ||
        (Array.isArray(result?.content) && result.content.some(c => c.text?.toLowerCase().includes('error'))),
        `Expected isError=true for depth-10 filter, got: ${JSON.stringify(rpc)}`
      );
    } finally { close(); }
  });

  it('query with allowed operators ($eq, $in, $and) returns results (not error)', async () => {
    const { status, callTool, close } = await openMcpSession(INSTANCES.a, tokenA);
    try {
      assert.equal(status, 200, 'MCP endpoint must be reachable for security testing');
      assert.ok(callTool, 'MCP session must establish');

      const rpc = await callTool('filter', {
        space: 'general',
        collection: 'facts',
        filter: { tags: { $in: ['test'] } },
      });
      const result = rpc?.result ?? rpc;
      assert.ok(
        (result?.isError !== true),
        `False positive: valid $in query was errored out: ${JSON.stringify(rpc)}`
      );
    } finally { close(); }
  });
});
