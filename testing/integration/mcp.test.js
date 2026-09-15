/**
 * Integration tests: MCP tool endpoint
 *
 * Covers:
 *  - tools/list returns expected tool names including sync_now and list_peers
 *  - list_peers returns structured peer data with NO credential fields
 *  - list_peers returns empty message when no networks configured
 *  - sync_now with no peerId returns "No networks configured" or a sync summary
 *  - sync_now with an unknown peerId returns isError + descriptive message
 *  - sync_now with a valid peerId triggers a sync and returns a result
 *
 * The transport is Streamable HTTP: one `POST /mcp` carries one JSON-RPC 2.0 call and answers it, either as
 * `application/json` or as a single SSE frame. It is stateless — no handshake, no session id, no reply
 * correlation to get wrong.
 *
 * SSE was the transport until 4.0 removed it (`GET /mcp` for the stream, `POST /mcp/messages?sessionId=…`
 * for the calls). This file held TWO clients while both existed, which is why the shared one is imported now
 * rather than written here.
 *
 * Run: node --test testing/integration/mcp.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del } from '../sync/helpers.js';
import { openMcpSession as openSharedMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let token;

// ── MCP client ───────────────────────────────────────────────────────────────

/*
 * Two wrappers over the shared client, because both of this file's call shapes predate it: the suites below
 * call `openMcpSession()` with no arguments (the token is a module-level `let`, assigned in `before`), and
 * three cases post a hand-built JSON-RPC body — including a deliberately unknown method, which `callTool`
 * cannot express.
 */
const openMcpSession = () => openSharedMcpSession(token);
const postMcpHttp = async (body) => (await openSharedMcpSession(token)).postJsonRpc(body);

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€



describe('MCP tools', () => {
  before(async () => {
    token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // Clean up stale networks left by previous test runs so sync_now doesn't
    // spend minutes iterating unreachable peers from old test state.
    const { body } = await get(INSTANCES.a, token, '/api/networks');
    if (body?.networks) {
      for (const net of body.networks) {
        await del(INSTANCES.a, token, `/api/networks/${net.id}`).catch(() => {});
      }
    }
  });

  describe('tools/list includes sync_now and list_peers', () => {
    let session;
    before(async () => { session = await openMcpSession(); });
    after(() => session?.close());

    it('sync_now is in the tool list', async () => {
      const tools = await session.listTools();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('network_sync'), `Expected sync_now in tools: ${names.join(', ')}`);
    });

    it('list_peers is in the tool list', async () => {
      const tools = await session.listTools();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('network_peers'), `Expected list_peers in tools: ${names.join(', ')}`);
    });

    it('list_peers has no required parameters', async () => {
      const tools = await session.listTools();
      const tool = tools.find(t => t.name === 'network_peers');
      assert.ok(tool, 'list_peers tool must exist');
      assert.deepEqual(tool.inputSchema?.required ?? [], [], 'list_peers must have no required parameters');
    });

    it('sync_now tool has optional peerId parameter', async () => {
      const tools = await session.listTools();
      const tool = tools.find(t => t.name === 'network_sync');
      assert.ok(tool, 'sync_now tool must exist');
      assert.ok(tool.inputSchema?.properties?.peerId, 'sync_now must expose peerId parameter');
      assert.ok(!tool.inputSchema?.required?.includes('peerId'), 'peerId must be optional');
    });
  });

  describe('list_peers â€” no networks', () => {
    let session;
    before(async () => { session = await openMcpSession(); });
    after(() => session?.close());

    it('returns the empty-networks message when no networks are configured', async () => {
      // ythril-a may OR may not have networks at this point; we just check
      // the output is valid: either the empty message or a JSON array.
      const result = await session.callTool('network_peers', {});
      assert.equal(result?.isError, undefined, `list_peers must not return isError`);
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(text.length > 0, 'list_peers must return non-empty text');
      // If there ARE networks, the output must not contain credential fields
      if (text !== 'No peers configured.') {
        assert.ok(!text.includes('tokenHash'), 'list_peers must never expose tokenHash');
        assert.ok(!text.includes('inviteKeyHash'), 'list_peers must never expose inviteKeyHash');
      }
    });
  });

  describe('list_peers â€” with a peer', () => {
    let session;
    let networkId;
    const PEER_ID = `list-peers-test-${Date.now()}`;

    before(async () => {
      session = await openMcpSession();

      // Create a club network and add a peer so list_peers has data to return
      const netRes = await post(INSTANCES.a, token, '/api/networks', {
        label: `List Peers Test ${Date.now()}`,
        type: 'club',
        spaces: ['general'],
        votingDeadlineHours: 1,
      });
      assert.equal(netRes.status, 201, `Network create failed: ${JSON.stringify(netRes.body)}`);
      networkId = netRes.body.id;

      const ptRes = await post(INSTANCES.a, token, '/api/tokens', { name: `lp-peer-${Date.now()}` });
      assert.equal(ptRes.status, 201);

      const addRes = await post(INSTANCES.a, token, `/api/networks/${networkId}/members`, {
        instanceId: PEER_ID,
        label: 'List Peers Test Peer',
        url: 'http://unreachable-list-peers-test.internal:3200',
        token: ptRes.body.plaintext,
        direction: 'both',
      });
      assert.equal(addRes.status, 201, `Add member failed: ${JSON.stringify(addRes.body)}`);
    });

    after(async () => {
      session?.close();
      if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
    });

    it('returns a list that includes the test peer instanceId', async () => {
      const result = await session.callTool('network_peers', {});
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(text.includes(PEER_ID), `Expected peer ${PEER_ID} in list_peers output`);
    });

    it('never exposes tokenHash or inviteKeyHash', async () => {
      const result = await session.callTool('network_peers', {});
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(!text.includes('tokenHash'), 'list_peers must not expose tokenHash');
      assert.ok(!text.includes('inviteKeyHash'), 'list_peers must not expose inviteKeyHash');
    });

    it('exposes expected peer fields: instanceId, label, url, direction, network', async () => {
      const result = await session.callTool('network_peers', {});
      const text = result?.content?.[0]?.text ?? '';
      // Output should be parseable JSON array of peer records
      let peers;
      try { peers = JSON.parse(text); } catch { assert.fail(`list_peers output is not JSON: ${text}`); }
      assert.ok(Array.isArray(peers), 'list_peers output must be a JSON array');
      const peer = peers.find(p => p.instanceId === PEER_ID);
      assert.ok(peer, `Peer ${PEER_ID} not found in list_peers JSON output`);
      assert.equal(peer.label, 'List Peers Test Peer');
      assert.ok(peer.url, 'peer.url must be present');
      assert.ok(peer.direction, 'peer.direction must be present');
      assert.ok(peer.network, 'peer.network must be present (network label)');
    });
  });

  describe('sync_now â€” no networks configured', () => {
    let session;
    before(async () => { session = await openMcpSession(); });
    after(() => session?.close());

    it('returns "No networks configured" when no networks exist (or a sync summary if they do)', async () => {
      const result = await session.callTool('network_sync', {});
      const text = result?.content?.[0]?.text ?? '';
      // Either no networks, or a valid sync summary line
      const valid =
        text === 'No networks configured.' ||
        /synced|error/i.test(text);
      assert.ok(valid, `Unexpected sync_now output: ${text}`);
    });
  });

  describe('sync_now â€” SSRF guard', () => {
    let session;
    before(async () => { session = await openMcpSession(); });
    after(() => session?.close());

    it('rejects an unknown peerId with isError', async () => {
      const result = await session.callTool('network_sync', { peerId: 'http://evil.example.com/steal' });
      assert.ok(result?.isError === true, 'Must return isError for unknown peerId');
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(
        text.includes('not a registered member'),
        `Expected "not a registered member" in error text, got: ${text}`,
      );
    });
  });

  describe('sync_now â€” with a real peer', () => {
    let session;
    let networkId;
    let peerTokenId;
    const FAKE_PEER_ID = `mcp-sync-test-peer-${Date.now()}`;

    before(async () => {
      session = await openMcpSession();

      // Create a minimal braintree network with a fake peer so sync_now has a
      // valid peerId to target.  The peer URL is unreachable â€” the test only
      // checks that the call is attempted and returns a result (error is fine).
      const ptRes = await post(INSTANCES.a, token, '/api/tokens', { name: `mcp-peer-${Date.now()}` });
      assert.equal(ptRes.status, 201);
      peerTokenId = ptRes.body.token.id;

      const netRes = await post(INSTANCES.a, token, '/api/networks', {
        label: `MCP Sync Test ${Date.now()}`,
        type: 'braintree',
        spaces: ['general'],
        votingDeadlineHours: 1,
      });
      assert.equal(netRes.status, 201, `Network create failed: ${JSON.stringify(netRes.body)}`);
      networkId = netRes.body.id;

      const addRes = await post(INSTANCES.a, token, `/api/networks/${networkId}/members`, {
        instanceId: FAKE_PEER_ID,
        label: 'MCP Sync Test Peer',
        url: 'http://unreachable-mcp-test-peer.internal:3200',
        token: ptRes.body.plaintext,
        direction: 'push',
      });
      assert.equal(addRes.status, 201, `Add member failed: ${JSON.stringify(addRes.body)}`);
    });

    after(async () => {
      session?.close();
      if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
      if (peerTokenId) await del(INSTANCES.a, token, `/api/tokens/${peerTokenId}`).catch(() => {});
    });

    it('accepts a valid peerId and returns a sync result', async () => {
      const result = await session.callTool('network_sync', { peerId: FAKE_PEER_ID });
      // Peer is unreachable so errors > 0, but the call itself must succeed
      // (isError may be true due to sync failure, but content must be present)
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(
        text.includes('Sync complete') || text.includes('error'),
        `Expected sync result text, got: ${text}`,
      );
    });

    it('sync_now all-networks runs without throwing (may report errors for unreachable peers)', async () => {
      const result = await session.callTool('network_sync', {});
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(text.length > 0, 'Expected non-empty response text');
    });
  });
});

// ── Transport-level behaviour ────────────────────────────────────────────────

/*
 * This block was titled "MCP Streamable HTTP transport (POST /mcp)" while SSE was the transport the rest of
 * the file used, and the title was the distinction. Every suite above speaks streamable HTTP now, so what is
 * left here is what only this level can assert: the response SHAPE (a stateless JSON body rather than a
 * stream frame) and a JSON-RPC error for a method the dispatcher does not know.
 */
describe('MCP transport-level behaviour (POST /mcp)', () => {
  before(async () => {
    token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('tools/list returns expected tool names via stateless JSON response', async () => {
    const rpc = await postMcpHttp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    const tools = rpc?.result?.tools ?? [];
    assert.ok(Array.isArray(tools) && tools.length > 0, 'tools/list must return a non-empty array');
    const names = tools.map(t => t.name);
    assert.ok(names.includes('save_fact'), `Expected 'save_fact' tool in list: ${names.join(', ')}`);
    assert.ok(names.includes('recall'), `Expected 'recall' tool in list: ${names.join(', ')}`);
    assert.ok(names.includes('network_sync'), `Expected 'network_sync' tool in list: ${names.join(', ')}`);
  });

  it('tools/call returns a result via stateless JSON response', async () => {
    const rpc = await postMcpHttp({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'network_peers', arguments: {} },
    });
    const result = rpc?.result;
    assert.ok(result !== undefined, `Expected a result from tools/call, got: ${JSON.stringify(rpc)}`);
    assert.ok(result?.isError !== true, `list_peers via Streamable HTTP returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'Expected non-empty content from list_peers via Streamable HTTP');
  });

  it('returns a JSON-RPC error for an unknown method', async () => {
    const rpc = await postMcpHttp(
      { jsonrpc: '2.0', id: 3, method: 'unknown/method', params: {} },
    );
    assert.ok(rpc?.error, `Expected a JSON-RPC error for unknown method, got: ${JSON.stringify(rpc)}`);
  });
});
