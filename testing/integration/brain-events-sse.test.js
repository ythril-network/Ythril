/**
 * Integration: live brain-change SSE stream (F12) — GET /api/brain/spaces/:spaceId/events
 *
 *  - a REST write on the space pushes a `data:` event to a subscribed EventSource-style client
 *  - the event names the collection (`memory.created`) so the client can refresh the right tab
 *  - the stream authenticates via a single-use `?ticket=` minted by an authenticated POST (EventSource
 *    can't set headers; a raw token in the URL would leak into logs/history)
 *  - a raw `?token=` is REJECTED (the query-token fallback was removed from browser SSE)
 *  - a ticket is single-use, and no auth → 401
 *
 * Run: node --test testing/integration/brain-events-sse.test.js
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
let tokenA;

/** Open a raw SSE request with an arbitrary query string; resolves with { res, req } on headers. */
function openSse(urlPath, query = '') {
  const u = new URL(INSTANCES.a);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: Number(u.port || 80), path: `${urlPath}${query}`, method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => resolve({ res, req }),
    );
    req.on('error', reject);
    req.end();
  });
}

/** Mint a single-use SSE ticket for `streamPath` via the authenticated POST endpoint. */
async function mintTicket(streamPath, token) {
  const r = await post(INSTANCES.a, token, `${streamPath}/ticket`, {});
  assert.equal(r.status, 200, `ticket mint failed: ${JSON.stringify(r.body)}`);
  assert.ok(typeof r.body.ticket === 'string' && r.body.ticket.length >= 20, 'ticket should be an opaque string');
  return r.body.ticket;
}

/** Resolve with the first parsed `data:` JSON object that has an `event` field. */
function nextEvent(res) {
  return new Promise((resolve) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          try { const d = JSON.parse(line.slice(5).trim()); if (d && d.event) resolve(d); } catch { /* partial */ }
        }
      }
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('brain events SSE (F12)', () => {
  before(() => { tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim(); });

  it('a REST write pushes a matching event to a subscribed client', async () => {
    const ticket = await mintTicket('/api/brain/spaces/general/events', tokenA);
    const { res, req } = await openSse('/api/brain/spaces/general/events', `?ticket=${encodeURIComponent(ticket)}`);
    try {
      assert.equal(res.statusCode, 200, 'SSE should authenticate via the minted ticket');
      assert.match(res.headers['content-type'] ?? '', /text\/event-stream/);

      const eventP = nextEvent(res);
      await delay(300); // ensure the server-side subscription is active before we write

      const w = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', { fact: `sse-probe-${Date.now()}` });
      assert.equal(w.status, 201, JSON.stringify(w.body));

      const ev = await Promise.race([eventP, delay(10_000).then(() => { throw new Error('no SSE event within 10s'); })]);
      assert.equal(ev.event, 'fact.created', `unexpected event: ${JSON.stringify(ev)}`);
      assert.equal(ev.id, w.body._id, 'event should carry the new record id');

      await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/facts/${w.body._id}`).catch(() => {});
    } finally {
      req.destroy();
    }
  });

  it('rejects an unauthenticated stream (no ticket) with 401', async () => {
    const { res, req } = await openSse('/api/brain/spaces/general/events');
    try {
      assert.equal(res.statusCode, 401);
    } finally {
      req.destroy();
    }
  });

  it('rejects a raw ?token= on the stream (query-token fallback removed for browser SSE)', async () => {
    const { res, req } = await openSse('/api/brain/spaces/general/events', `?token=${encodeURIComponent(tokenA)}`);
    try {
      assert.equal(res.statusCode, 401, 'VULNERABILITY: raw token in the URL still authenticates the stream');
    } finally {
      req.destroy();
    }
  });

  it('a ticket is single-use — replaying it is rejected', async () => {
    const ticket = await mintTicket('/api/brain/spaces/general/events', tokenA);
    const first = await openSse('/api/brain/spaces/general/events', `?ticket=${encodeURIComponent(ticket)}`);
    try {
      assert.equal(first.res.statusCode, 200, 'first use of the ticket should connect');
    } finally {
      first.req.destroy();
    }
    const second = await openSse('/api/brain/spaces/general/events', `?ticket=${encodeURIComponent(ticket)}`);
    try {
      assert.equal(second.res.statusCode, 401, 'VULNERABILITY: a consumed ticket was accepted again');
    } finally {
      second.req.destroy();
    }
  });

  it('a ticket minted for one space does not open another space stream', async () => {
    const ticket = await mintTicket('/api/brain/spaces/general/events', tokenA);
    // Bound to /general/events — using it on a different space path must fail (unknown ticket for path).
    const { res, req } = await openSse('/api/brain/spaces/personal/events', `?ticket=${encodeURIComponent(ticket)}`);
    try {
      assert.equal(res.statusCode, 401, 'VULNERABILITY: a ticket crossed to another space stream');
    } finally {
      req.destroy();
    }
  });
});
