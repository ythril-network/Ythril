/**
 * A rewriting proxy between a sync engine and the fake peer of `_pull-door.mjs`: the one place a test chooses which WIRE
 * VERSION the peer speaks, without editing the shared fake peer (bundle-81, slice B).
 *
 * ## What it answers
 *
 * *"What does the peer's answer look like to the engine, in the 6.0 shape (`positions: 1` on every page and push answer) or
 * in the 5.x shape (none of `positions`, `through`, `head`)?"* The fake peer's POST answers (`{ status: 'ok' }`,
 * `{ applied, refused }`) are the 5.x shape and its page answers come from the real handler (the shape the code under test
 * serves), so a test that needs a definite version puts this in front of the peer and names the mode.
 *
 * - `'6.0'`: every 2xx JSON answer to a POST under `/api/sync/` gains `positions: 1` (the stamp the 6.0 push answer carries,
 *   design rev 8 §6, decision 23). Page answers are the real handler's, left as they are.
 * - `'5.x'`: every 2xx JSON answer under `/api/sync/` loses `positions`, `through` and `head`, which is what a 5.6 server
 *   sends. A page answer in the 5.x shape is `{ items, nextCursor }` (families) or the grouped body (tombstones).
 *
 * Every request that passes is recorded (`log`), so "no file byte route was called" is read off what the peer was asked, never
 * off a timer.
 *
 * ## Why a proxy and not a hook in the fake peer
 *
 * `_pull-door.mjs` creates its express app inside `openPullDoor` and exposes hooks for GET pages and batch-upsert only; its
 * tombstone POST answer is fixed. A hook added to it would be an edit of a shared helper, which a slice may not make.
 *
 * Usage: `const proxy = await openWireProxy(door.url, { mode: '6.0' }); door.member().url = proxy.url;` and `proxy.close()`.
 */
import http from 'node:http';
import { privateHostAddress } from './_private-address.mjs';

/** The members of a 6.0 answer that a 5.x server never sends. */
export const POSITION_ANSWER_KEYS = Object.freeze(['positions', 'through', 'head']);

const SYNC = /^\/api\/sync\//;

function rewrite(mode, method, path, status, json) {
  if (status < 200 || status >= 300 || json === null || typeof json !== 'object' || Array.isArray(json) || !SYNC.test(path)) return json;
  if (mode === '6.0') return method === 'POST' ? { ...json, positions: 1 } : json;
  if (mode === '5.x') {
    const out = { ...json };
    for (const k of POSITION_ANSWER_KEYS) delete out[k];
    return out;
  }
  throw new Error(`unknown wire mode ${mode}`);
}

/**
 * @param {string} targetUrl  the fake peer's base URL (`door.url`)
 * @param {{ mode?: '6.0' | '5.x' }} [o]
 */
export async function openWireProxy(targetUrl, { mode = '6.0' } = {}) {
  const host = privateHostAddress();
  const state = { mode };
  /** Every request the proxy forwarded: method, path, the query as sent, and the status the peer answered. */
  const log = [];
  const target = new URL(targetUrl);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const headers = { ...req.headers, host: target.host };
      delete headers['accept-encoding'];
      const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (ur) => {
        const out = [];
        ur.on('data', c => out.push(c));
        ur.on('end', () => {
          const asked = new URL(req.url, 'http://proxy.invalid');
          const path = asked.pathname;
          log.push({ method: req.method, path, query: Object.fromEntries(asked.searchParams), status: ur.statusCode });
          let body = Buffer.concat(out);
          const h = { ...ur.headers };
          delete h['content-length']; delete h['content-encoding']; delete h['transfer-encoding'];
          if (String(h['content-type'] ?? '').includes('json')) {
            try { body = Buffer.from(JSON.stringify(rewrite(state.mode, req.method, path, ur.statusCode ?? 0, JSON.parse(body.toString('utf8'))))); } catch { /* not JSON: as it came */ }
          }
          h['content-length'] = String(body.length);
          res.writeHead(ur.statusCode ?? 502, h);
          res.end(body);
        });
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const url = `http://${host}:${server.address().port}`;
  return {
    url, log, state,
    /** The requests whose path starts with `prefix`, in order. */
    requestsTo: (prefix) => log.filter(r => r.path.startsWith(prefix)),
    clear: () => { log.length = 0; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
