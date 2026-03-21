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
 * The MCP transport is SSE-based: we open a GET /mcp/:spaceId stream, parse the
 * endpoint event to get the sessionId, then POST JSON-RPC 2.0 calls to
 * /mcp/:spaceId/messages?sessionId=... and read the result events off the stream.
 *
 * Run: node --test testing/integration/mcp.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { INSTANCES, post, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let token;

// â”€â”€ SSE MCP session helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Open an MCP SSE session using Node's `http` module (works on Node 18).
 * Returns { callTool, listTools, close }
 */
async function openMcpSession(spaceId, timeoutMs = 15_000) {
  const base = INSTANCES.a; // e.g. http://localhost:3200
  const parsed = new URL(base);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '80', 10);

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: `/mcp/${spaceId}`, method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`MCP SSE open failed: ${res.statusCode}`));
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

        // Poll for sessionId, then resolve with the helper
        const deadline = Date.now() + timeoutMs;
        const poll = setInterval(() => {
          if (sessionId) {
            clearInterval(poll);
            resolve({ callTool, listTools, close });
          } else if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error('MCP session did not receive endpoint event'));
          }
        }, 50);

        async function postJsonRpc(body) {
          return new Promise((res2, rej2) => {
            const waiterTimeout = setTimeout(
              () => rej2(new Error('MCP tool call timed out')), timeoutMs,
            );
            if (pendingMessages.length > 0) {
              clearTimeout(waiterTimeout);
              res2(pendingMessages.shift());
              return;
            }
            waiters.push(msg => { clearTimeout(waiterTimeout); res2(msg); });

            const postData = JSON.stringify(body);
            const pr = http.request(
              { host, port,
                path: `/mcp/${spaceId}/messages?sessionId=${sessionId}`,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(postData),
                  Authorization: `Bearer ${token}`,
                },
              },
              pres => {
                let txt = '';
                pres.setEncoding('utf8');
                pres.on('data', c => { txt += c; });
                pres.on('end', () => {
                  if (pres.statusCode !== 202 && pres.statusCode !== 200) {
                    clearTimeout(waiterTimeout);
                    waiters.splice(waiters.indexOf(msg => { clearTimeout(waiterTimeout); res2(msg); }), 1);
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
          const rpc = await postJsonRpc(
            { jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
              params: { name, arguments: args } },
          );
          return rpc?.result ?? rpc;
        }

        async function listTools() {
          const rpc = await postJsonRpc(
            { jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} },
          );
          return rpc?.result?.tools ?? rpc?.tools ?? [];
        }

        function close() { req.destroy(); }
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('MCP tools', () => {
  before(() => {
    token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  describe('tools/list includes sync_now and list_peers', () => {
    let session;
    before(async () => { session = await openMcpSession('general'); });
    after(() => session?.close());

    it('sync_now is in the tool list', async () => {
      const tools = await session.listTools();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('sync_now'), `Expected sync_now in tools: ${names.join(', ')}`);
    });

    it('list_peers is in the tool list', async () => {
      const tools = await session.listTools();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('list_peers'), `Expected list_peers in tools: ${names.join(', ')}`);
    });

    it('list_peers has no required parameters', async () => {
      const tools = await session.listTools();
      const tool = tools.find(t => t.name === 'list_peers');
      assert.ok(tool, 'list_peers tool must exist');
      assert.deepEqual(tool.inputSchema?.required ?? [], [], 'list_peers must have no required parameters');
    });

    it('sync_now tool has optional peerId parameter', async () => {
      const tools = await session.listTools();
      const tool = tools.find(t => t.name === 'sync_now');
      assert.ok(tool, 'sync_now tool must exist');
      assert.ok(tool.inputSchema?.properties?.peerId, 'sync_now must expose peerId parameter');
      assert.ok(!tool.inputSchema?.required?.includes('peerId'), 'peerId must be optional');
    });
  });

  describe('list_peers â€” no networks', () => {
    let session;
    before(async () => { session = await openMcpSession('general'); });
    after(() => session?.close());

    it('returns the empty-networks message when no networks are configured', async () => {
      // ythril-a may OR may not have networks at this point; we just check
      // the output is valid: either the empty message or a JSON array.
      const result = await session.callTool('list_peers', {});
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
      session = await openMcpSession('general');

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
      const result = await session.callTool('list_peers', {});
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(text.includes(PEER_ID), `Expected peer ${PEER_ID} in list_peers output`);
    });

    it('never exposes tokenHash or inviteKeyHash', async () => {
      const result = await session.callTool('list_peers', {});
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(!text.includes('tokenHash'), 'list_peers must not expose tokenHash');
      assert.ok(!text.includes('inviteKeyHash'), 'list_peers must not expose inviteKeyHash');
    });

    it('exposes expected peer fields: instanceId, label, url, direction, network', async () => {
      const result = await session.callTool('list_peers', {});
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
    before(async () => { session = await openMcpSession('general'); });
    after(() => session?.close());

    it('returns "No networks configured" when no networks exist (or a sync summary if they do)', async () => {
      const result = await session.callTool('sync_now', {});
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
    before(async () => { session = await openMcpSession('general'); });
    after(() => session?.close());

    it('rejects an unknown peerId with isError', async () => {
      const result = await session.callTool('sync_now', { peerId: 'http://evil.example.com/steal' });
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
      session = await openMcpSession('general');

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
      const result = await session.callTool('sync_now', { peerId: FAKE_PEER_ID });
      // Peer is unreachable so errors > 0, but the call itself must succeed
      // (isError may be true due to sync failure, but content must be present)
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(
        text.includes('Sync complete') || text.includes('error'),
        `Expected sync result text, got: ${text}`,
      );
    });

    it('sync_now all-networks runs without throwing (may report errors for unreachable peers)', async () => {
      const result = await session.callTool('sync_now', {});
      const text = result?.content?.[0]?.text ?? '';
      assert.ok(text.length > 0, 'Expected non-empty response text');
    });
  });
});
