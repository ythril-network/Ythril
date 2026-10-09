/**
 * An in-process instance for the tests that ask what a VOTE ROUND does — answered once.
 *
 * ## The question it answers
 *
 * *"With this config on disk, what do the instance's own doors do to a round?"* The round tests (the expiry job, the three
 * conclusion sites, gossip adoption, the join poll) each need the same four things: a temp `config.json` the server's own loader
 * reads, a way to wait until the deferred side-effects of a conclusion (they run on `setImmediate` and dynamic imports) have
 * landed, a way to read a Prometheus counter, and a peer the engine can actually reach. Each would otherwise write its own
 * copy, and the copy that drifts is the one that passes for the wrong reason.
 *
 * ## The guards a hand-written copy drops
 *
 * - **No fixed sleep.** {@link settled} polls a snapshot until it has not changed for several event-loop turns, so a
 *   side-effect that lands late is waited for and one that never lands is not waited out.
 * - **A peer on a real, non-loopback address.** The sync engine refuses loopback for ever (`util/ssrf.ts`), so a stub on
 *   127.0.0.1 would test nothing the engine can reach. {@link startFakePeer} listens on this host's own private address
 *   (`_private-address.mjs`); a suite that starts one skips with `privateAddressSkipReason()`, which throws on CI, so a gossip test
 *   cannot quietly become a no-op that reports success about nothing.
 * - **The route's own handler.** {@link handlerFor} returns the last handler of a registered route (past auth and rate limit),
 *   so what a test calls is the handler production runs, never a copy of its rule.
 *
 * ## What it does not do
 *
 * It does not stub the sync engine, the loader or the governance code. The fake peer answers HTTP; everything on the receiving
 * side is production's.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { privateHostAddress } from './_private-address.mjs';

/** Make a temp directory and point `CONFIG_PATH` at its `config.json`. Call BEFORE the first import of the server's loader. */
export function tempInstanceDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env['CONFIG_PATH'] = path.join(dir, 'config.json');
  return dir;
}

/** Remove the temp directory, best effort. */
export function removeInstanceDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Write a config the loader will accept and load it, plus the peer-token secrets. Returns the loader module.
 * `networks` are written as given: a test that needs a key MISSING simply leaves it out.
 */
export async function bootInstance(dir, { instanceId, networks = [], spaces, tokens = [], peerTokens = {}, extra = {} }) {
  assert.equal(process.env['CONFIG_PATH'], path.join(dir, 'config.json'), 'call tempInstanceDir before importing the loader');
  const loader = await import('../../server/dist/config/loader.js');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId, instanceLabel: 'self', tokens, networks,
    spaces: spaces ?? [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
    ...extra,
  }), { mode: 0o600 });
  loader.loadConfig();
  loader.saveSecrets({ peerTokens });
  return loader;
}

/**
 * Resolve once `read()` has answered the same text for `stable` consecutive event-loop turns.
 * The deferred side-effects of a conclusion (`setImmediate`, a dynamic `import()` then a write) are not awaitable, so the
 * condition is the state itself holding still — never a number of milliseconds.
 */
export async function settled(read, { stable = 8, maxTurns = 2000 } = {}) {
  let last = JSON.stringify(read());
  let same = 0;
  for (let i = 0; i < maxTurns; i++) {
    await new Promise(resolve => setImmediate(resolve));
    const now = JSON.stringify(read());
    if (now === last) { if (++same >= stable) return JSON.parse(now); } else { same = 0; last = now; }
  }
  throw new Error(`the state never held still for ${stable} turns: ${last.slice(0, 300)}`);
}

/** The sum of every sample of a counter, over every label set, read from the process registry; 0 when it is not declared. */
export async function counterTotal(name) {
  const { register } = await import('../../server/dist/metrics/registry.js');
  let total = 0;
  for (const line of (await register.metrics()).split('\n')) {
    if (line.startsWith('#')) continue;
    const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\S+)$`).exec(line);
    if (m) total += Number(m[1]);
  }
  return total;
}

/** Is the counter declared at all (a series exists, even at zero)? */
export async function counterDeclared(name) {
  const { register } = await import('../../server/dist/metrics/registry.js');
  return new RegExp(`^${name}(?:\\{[^}]*\\})?\\s`, 'm').test(await register.metrics());
}

/** The last handler of a registered route — what runs once auth and the rate limit have passed. */
export function handlerFor(router, method, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${routePath} on that router — re-anchor this harness`);
  return layer.route.stack.at(-1).handle;
}

/** A response that records what a handler answered. */
export function fakeRes() {
  return {
    code: 200, body: undefined, sent: false, headers: {},
    status(c) { this.code = c; return this; },
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.sent = true; return this; },
  };
}

/** Call a route's own handler with a request-shaped object; returns what it answered. */
export async function callRoute(router, method, routePath, { params = {}, body = {}, query = {}, authToken } = {}) {
  const res = fakeRes();
  await handlerFor(router, method, routePath)({ method: method.toUpperCase(), params, body, query, authToken, headers: {}, get: () => undefined }, res);
  assert.ok(res.sent, `${method.toUpperCase()} ${routePath} settled without answering`);
  return { code: res.code, body: res.body };
}

/**
 * A peer the engine can reach: HTTP on this host's private address (`_private-address.mjs` — the one place that asks the host
 * for it). `answer(method, url)` returns `{ status?, body? }` and the peer records every request it saw. A suite that starts
 * one skips with `privateAddressSkipReason()`, which THROWS on CI where there is no such address. Allow the engine to dial it
 * with `allowEngineToDialPrivatePeers()` first.
 */
export async function startFakePeer(answer) {
  const host = privateHostAddress();
  assert.ok(host, 'no non-private-address host: a suite that starts a fake peer must skip with privateAddressSkipReason()');
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: raw });
      const { status = 404, body = { error: 'not found' } } = answer(req.method, req.url, raw) ?? {};
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return {
    url: `http://${host}:${server.address().port}`,
    seen,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** The engine dials private, plaintext peers only when told to (`util/ssrf.ts`, `config/transport-security.ts`). */
export function allowEngineToDialPrivatePeers() {
  process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
  process.env['SYNC_ALLOW_INSECURE_PEERS'] = 'true';
}
