/**
 * Unit tests: SSRF IP pinning and configurable redirect cap (util/ssrf.ts).
 *
 *  - pinnedAgent(ip) connects to that exact IP regardless of the URL hostname,
 *    closing the validate-then-fetch DNS-rebind TOCTOU.
 *  - ssrfSafeFetch honours a caller-supplied maxRedirects.
 *
 * Pure in-process — starts a throwaway loopback HTTP server; no Docker. Run:
 *   node --test testing/standalone/ssrf-ip-pinning.test.js
 * (build the server first: npm run build:server)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { fetch as undiciFetch } from 'undici';
import { pinnedAgent, ssrfSafeFetch, SsrfBlockedError } from '../../server/dist/util/ssrf.js';

describe('pinnedAgent — connection is pinned to the validated IP', () => {
  let server, local, port, received;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        received = { method: req.method, headers: req.headers, body };
        res.writeHead(200); res.end('pinned-ok');
      });
    });
    local = await listenOnLoopback(server);
    port = local.port;
  });

  after(() => local.close());

  it('routes a request for an UNRESOLVABLE hostname to the pinned IP (DNS bypassed)', async () => {
    // The hostname could never resolve; if the request succeeds, the socket was
    // pinned to 127.0.0.1 by the agent rather than resolved from the hostname.
    const agent = pinnedAgent('127.0.0.1');
    try {
      const resp = await undiciFetch(`http://nonexistent-${Date.now()}.invalid:${port}/`, { dispatcher: agent });
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), 'pinned-ok');
    } finally {
      await agent.close();
    }
  });

  it('carries a webhook-style POST (headers + body) through the pinned connection', async () => {
    received = null;
    const agent = pinnedAgent('127.0.0.1');
    try {
      const resp = await undiciFetch(`http://webhook-host-${Date.now()}.invalid:${port}/hook`, {
        dispatcher: agent,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ythril-Signature': 'sha256=deadbeef' },
        body: '{"event":"test.ping"}',
      });
      assert.equal(resp.status, 200);
      assert.equal(received.method, 'POST');
      assert.equal(received.headers['x-ythril-signature'], 'sha256=deadbeef');
      assert.equal(received.body, '{"event":"test.ping"}');
    } finally {
      await agent.close();
    }
  });
});

describe('ssrfSafeFetch — configurable redirect cap', () => {
  // A public-looking resolver so validation passes; injected fetch simulates the
  // transport (a perpetual redirect loop) so we can assert the hop cap.
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('follows up to maxRedirects hops, then throws', async () => {
    let hops = 0;
    const fetchImpl = async () => {
      hops++;
      return new Response(null, { status: 302, headers: { location: 'http://loop.example.com/next' } });
    };
    await assert.rejects(
      () => ssrfSafeFetch('http://loop.example.com/', {}, { lookup: publicLookup, fetchImpl, maxRedirects: 2 }),
      SsrfBlockedError,
    );
    assert.equal(hops, 3, 'should attempt initial + 2 redirects = 3 fetches before giving up');
  });

  it('maxRedirects: 0 refuses to follow even a single redirect', async () => {
    let hops = 0;
    const fetchImpl = async () => {
      hops++;
      return new Response(null, { status: 301, headers: { location: 'http://elsewhere.example.com/' } });
    };
    await assert.rejects(
      () => ssrfSafeFetch('http://start.example.com/', {}, { lookup: publicLookup, fetchImpl, maxRedirects: 0 }),
      SsrfBlockedError,
    );
    assert.equal(hops, 1, 'exactly one fetch, no redirect followed');
  });
});
