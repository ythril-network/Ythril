/**
 * A peer a test can make WAIT, and that says whether the receiver gave up waiting: the question "what was the receiver doing when the act arrived,
 * and did it stop", answered once for every test that registers a wipe or a deletion in the middle of an exchange (bundle-106, §3.3a).
 *
 * ## What it is
 *
 * A forwarding HTTP proxy between this instance's real engine and the pull door's fake peer (`_pull-door.mjs`). The member's url is pointed at
 * it (`loader.mutateConfig`), so every request the engine makes crosses it and is recorded, and a test PARKS the next request that matches a
 * predicate: the proxy has read the whole request, answers nothing, and waits for the test to release it. The receiver is then in the middle of
 * ONE unit (a page, a push, a file) when the test starts its act.
 *
 * ## The two things a hand-written copy drops
 *
 * **Whether the unit in flight was CUT.** A parked request the receiver abandons closes its socket; `aborted` resolves at that moment and not
 * when the test releases. A test that only released and looked at the data could not tell "the turn stopped at once" from "the turn ran to the end
 * of the unit and the data happened to be gone", which is the difference between an act that waits seconds and one that waits a transfer.
 * **A parked request that outlives the test.** `close` releases every gate and destroys every socket, because a parked handler keeps the process
 * alive and the runner then waits on the file for ever instead of reporting it.
 *
 * ## What it is not
 *
 * It does not interpret what crosses it, and it never rewrites a request or an answer: what the peer does is the fake peer's, and the proxy only
 * decides WHEN a request reaches it. Ordering in a test is by the latch (`reached` / `release`), never by a timer.
 */
import http from 'node:http';
import { privateHostAddress } from './_private-address.mjs';
import { listenOnPrivateAddress } from '../_shared/local-server.mjs';

/** A request as the proxy saw it: `n` is its place in the arrival order since `reset`. */
/** @typedef {{ n: number, method: string, path: string, query: Record<string, string> }} ProxiedRequest */

/**
 * @param {string} targetUrl  the fake peer's origin (`door.url`)
 * @returns {Promise<{
 *   url: string,
 *   requests: ProxiedRequest[],
 *   stallNext: (when: (r: ProxiedRequest) => boolean, o?: { skip?: number }) => { reached: Promise<ProxiedRequest>, release: () => void, aborted: Promise<ProxiedRequest> },
 *   requestsForSpace: (space: string, from?: number) => ProxiedRequest[],
 *   reset: () => void,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startStallingPeerProxy(targetUrl) {
  const target = new URL(targetUrl);
  /** @type {ProxiedRequest[]} */
  let requests = [];
  let rules = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    try { for await (const c of req) chunks.push(c); } catch { return; /* the receiver went away while sending */ }
    const u = new URL(req.url ?? '/', 'http://proxy.invalid');
    /** @type {ProxiedRequest} */
    const info = { n: requests.length, method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams) };
    requests.push(info);

    const rule = rules.find(r => !r.taken && r.when(info) && r.seen++ >= r.skip);
    if (rule) {
      rule.taken = true;
      let closed = false;
      res.on('close', () => { if (!res.writableFinished) { closed = true; rule.markAborted(info); } });
      rule.markReached(info);
      await rule.gate;
      if (closed || res.destroyed) return;
    }

    const upstream = http.request({
      host: target.hostname, port: target.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: target.host },
    }, (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
    upstream.on('error', (err) => { if (!res.headersSent) res.writeHead(502); res.end(String(err)); });
    res.on('close', () => upstream.destroy());
    upstream.end(Buffer.concat(chunks));
  });
  // The peer fetch refuses a loopback address, so the proxy answers on the private one; the shell (sockets remembered, close() that ends while a request is parked) is the shared module's.
  const local = await listenOnPrivateAddress(server, privateHostAddress());

  return {
    url: local.url,
    get requests() { return requests; },
    /**
     * Park the next request `when` admits (after `skip` earlier matches pass). `reached` resolves with the request once it is parked,
     * `release()` lets it through, `aborted` resolves when the receiver closed its end while it was parked.
     */
    stallNext(when, { skip = 0 } = {}) {
      let markReached; let markAborted; let release;
      const reached = new Promise(r => { markReached = r; });
      const aborted = new Promise(r => { markAborted = r; });
      const gate = new Promise(r => { release = r; });
      rules.push({ when, skip, seen: 0, taken: false, gate, release, markReached, markAborted });
      return { reached, release, aborted };
    },
    /**
     * Every DATA request that names `space`, from arrival number `from` on: a record page or push, a tombstone call, the manifest, a merkle read,
     * a file byte call. The governance routes and the schema door (`/meta`) are not data (§3.3 v5, X17) and are left out, so "no request for
     * the space" means no exchange of it.
     */
    requestsForSpace(space, from = 0) {
      return requests.filter(r => r.n >= from
        && !r.path.startsWith('/api/sync/networks') && r.path !== '/api/sync/meta'
        && (r.query.spaceId === space || [space, `peer-${space}`].some(id => r.path === `/api/files/${id}` || r.path.startsWith(`/api/files/${id}/`))));
    },
    reset() { for (const r of rules) r.release(); rules = []; requests = []; },
    async close() {
      for (const r of rules) r.release();
      rules = [];
      await local.close();
    },
  };
}
