/**
 * The `route` label of `ythril_http_requests_total` is one of a FIXED set, whatever the caller sends (bundle-231, Q-605).
 *
 * ## The defect this holds
 *
 * `app.ts` labels a finished request with `req.route?.path` when a route matched and a REGEX REWRITE OF THE RAW PATH when none did
 * (`req.path.replace(/\/[0-9a-f-]{8,}/gi, '/:id')`). Two faults sit in that one expression:
 *
 * 1. Every request that matches no route (a scanner's random path under a mount, a typo, a probe) mints a label value of its own, so the
 *    series count is chosen by whoever is sending requests. A label whose values the caller picks is unbounded cardinality.
 * 2. A matched route is labelled by its ROUTER-RELATIVE path, so `GET /api/tokens` and `GET /api/spaces` both read `"/"` and one series
 *    is several routes.
 *
 * ## The rule, not the site
 *
 * The label of a finished request is, by construction, a member of: the full mounted pattern of a route the server mounts
 * (`_routes.mjs`, the mount graph: `/api/tokens/:id`, never `/:id`), the one bucket `unmatched`, or the fixed per-mount label of a refusal that
 * a router-level guard (auth, rate limit), the flood backstop or maintenance answered before any route matched (derived here from the literal
 * mount strings of `app.ts`). Nothing else. So:
 *
 * - random paths under every mount, with and without a credential, only ever produce members of that set; a request that passes every guard
 *   and matches nothing is `unmatched` exactly;
 * - casing variants of a mounted path (Express matches mounts case-insensitively) keep the full LOWERCASE pattern, never a label spelled by
 *   the caller;
 * - a request whose handler failed (a 500 the app's error handler answered, where `req.baseUrl` is empty) keeps the same label as one that
 *   succeeded;
 * - a router-level refusal gets the mount's label and not `unmatched`, and the same label for every path under that mount;
 * - every GET route `mountedRoutes()` lists is labelled with its own full pattern when asked (the derived list, floored, not a hand copy).
 *
 * ## Why it is red today
 *
 * Random paths mint labels (`/api/brain/<random>` is its own label, rewritten only where the segment looks like a hex id), matched routes
 * under a sub-router read router-relative, and the error handler's requests read `req.route` as unset.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-metrics-route-label-is-a-fixed-set-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { mountedRoutes } from './_routes.mjs';
import { stripComments } from './_strip-comments.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();

const COUNTER = 'ythril_http_requests_total';

/**
 * Routes whose requests this test does not make, each with why. Everything else that is a GET is asked.
 * `/health`, `/ready` and `/metrics` are answered ABOVE the instrumentation (`app.ts` says so), so they have no label by design.
 */
const NOT_ASKED = new Map([
  ['/health', 'answered above the instrumentation: never counted'],
  ['/ready', 'answered above the instrumentation: never counted'],
  ['/metrics', 'answered above the instrumentation: never counted'],
  ['/api/about/logs/stream', 'a stream that does not end'],
  ['/api/brain/spaces/:spaceId/events', 'a stream that does not end'],
  ['/api/admin/spaces/:spaceId/export', 'a download of a whole space'],
  ['/', 'the SPA index and the fallback below it are one served page, asked as the fallback'],
]);

let door; let server; let base; let adminKey;

/** The counter's samples as `Map<"method|route|status", value>`. */
async function samples() {
  const { register } = await import('../../server/dist/metrics/registry.js');
  const out = new Map();
  for (const line of (await register.metrics()).split('\n')) {
    if (!line.startsWith(`${COUNTER}{`)) continue;
    const m = /^[^{]+\{(.*)\}\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels = Object.fromEntries([...m[1].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map(x => [x[1], x[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')]));
    out.set(`${labels.method}|${labels.route}|${labels.status_code}`, Number(m[2]));
  }
  return out;
}

/**
 * Ask one request and read the label it was counted under. The counter moves on the response's `finish`, a moment after the body is read,
 * so this polls the counter itself (never a fixed wait) until exactly one sample has risen.
 */
async function ask(method, path, { auth = true, body } = {}) {
  const before = await samples();
  const init = { method, headers: {}, signal: AbortSignal.timeout(20_000) };
  if (auth) init.headers.Authorization = `Bearer ${adminKey}`;
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = body; }
  const r = await fetch(`${base}${path}`, init);
  await r.arrayBuffer();
  for (let i = 0; i < 400; i++) {
    const after = await samples();
    const risen = [...after].filter(([k, v]) => v > (before.get(k) ?? 0));
    if (risen.length === 1) {
      const [method2, route, status] = risen[0][0].split('|');
      return { status: r.status, counted: { method: method2, route, status } };
    }
    if (risen.length > 1) assert.fail(`${method} ${path}: more than one series rose for one request: ${risen.map(x => x[0]).join(', ')}`);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`${method} ${path} (answered ${r.status}) was never counted: the counter did not move`);
}

/** The literal mount strings of `app.ts`: `app.use('/api/tokens', tokensRouter)`. */
function mountStrings() {
  const src = stripComments(fs.readFileSync('server/src/app.ts', 'utf8'));
  return [...new Set([...src.matchAll(/\bapp\.use\(\s*'(\/[^']*)'/g)].map(m => m[1]))];
}

/** A random lowercase token no route or id pattern could mistake for anything else. */
const rand = () => `zq${Math.random().toString(36).slice(2, 10)}`;

describe('the route label of the HTTP request counter is a fixed set', { skip }, () => {
  let MOUNTS; let PATTERNS;

  before(async () => {
    door = await openPushDoor({ suite: 'routelabel', spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
    base = server.url;
    MOUNTS = mountStrings();
    assert.ok(MOUNTS.length >= 25, `app.ts names ${MOUNTS.length} mounts: re-anchor this gate`);
    const routes = mountedRoutes();
    PATTERNS = new Set(routes.map(r => r.path));
  });

  after(async () => {
    await server?.close();
    await door?.close();
  });

  /** Is the label one the rule allows? */
  const allowed = (label) => label === 'unmatched' || PATTERNS.has(label) || MOUNTS.includes(label) || MOUNTS.some(m => label === m.toLowerCase());

  it('random paths under every mount produce only members of the fixed set, and a passed-guard miss is `unmatched`', async () => {
    const seen = new Map();
    for (const mount of MOUNTS) {
      if (mount === '/metrics') continue;
      for (const auth of [true, false]) {
        for (let i = 0; i < 3; i++) {
          const p = `${mount}/${rand()}/${rand()}`;
          const { counted } = await ask('GET', p, { auth });
          seen.set(counted.route, p);
          assert.ok(allowed(counted.route), `GET ${p} (auth ${auth}) was counted under "${counted.route}", which is not a mounted pattern, "unmatched" or a mount's label`);
        }
      }
    }
    const distinct = new Set(seen.keys());
    assert.ok(distinct.size <= MOUNTS.length + PATTERNS.size, `${distinct.size} distinct labels from ${MOUNTS.length} mounts`);
    // A credentialed request under a mount that no route of it matches passes every guard and falls to the 404: that is the bucket.
    const missed = await ask('GET', `/api/brain/${rand()}/${rand()}`, { auth: true });
    assert.equal(missed.counted.route, 'unmatched', `an authenticated request matching no route must be counted as "unmatched", got "${missed.counted.route}"`);
  });

  it('a hundred random paths mint no more than a handful of labels', async () => {
    const before = new Set([...await samples()].map(([k]) => k.split('|')[1]));
    const labels = new Set();
    for (let i = 0; i < 100; i++) {
      const { counted } = await ask('GET', `/api/${rand()}/${rand()}`, { auth: true });
      labels.add(counted.route);
    }
    const minted = [...labels].filter(l => !before.has(l));
    assert.ok(labels.size <= 2, `100 random paths were counted under ${labels.size} labels: ${[...labels].slice(0, 5).join(', ')} ...`);
    assert.ok(minted.length <= 2, `${minted.length} new labels were minted by random paths`);
  });

  it('a casing variant of a mounted path keeps the full lowercase pattern', async () => {
    const lower = await ask('GET', '/api/networks/aaaaaaaa-0000-4000-8000-000000000001/votes', { auth: true });
    assert.equal(lower.counted.route, '/api/networks/:id/votes', `the lowercase request is counted under "${lower.counted.route}"`);
    for (const variant of ['/API/networks/aaaaaaaa-0000-4000-8000-000000000001/votes', '/Api/Networks/AAAAAAAA-0000-4000-8000-000000000001/Votes', '/API/NETWORKS/x/VOTES']) {
      const v = await ask('GET', variant, { auth: true });
      assert.equal(v.counted.route, '/api/networks/:id/votes', `GET ${variant} was counted under "${v.counted.route}", not the lowercase pattern`);
    }
  });

  it('a request whose handler threw (the error handler answered) keeps the full pattern, whichever status it ended with', async () => {
    // A handler that fails is answered by the app's error handler, where `req.baseUrl` is empty. The route matched before the throw, so
    // the label is the route's, and the same label as a request that succeeded (the control, asked first).
    const ok = await ask('GET', '/api/networks/aaaaaaaa-0000-4000-8000-000000000001/votes', { auth: true });
    // A store that is gone: the route's handler throws, the error handler maps it (503 or 500), the label stays the route's.
    await door.mongo.closeMongo();
    try {
      const dead = await ask('GET', '/api/brain/spaces/general/stats', { auth: true });
      assert.ok(dead.status >= 500, `a read with the store closed answered ${dead.status}`);
      assert.equal(dead.counted.route, '/api/brain/spaces/:spaceId/stats', `a failed handler was counted under "${dead.counted.route}", not its full lowercase pattern`);
      const deadCase = await ask('GET', '/API/Brain/Spaces/general/STATS', { auth: true });
      assert.equal(deadCase.counted.route, '/api/brain/spaces/:spaceId/stats', `a failed handler asked in another casing was counted under "${deadCase.counted.route}"`);
    } finally {
      await door.mongo.connectMongo();
    }
    assert.equal(ok.counted.route, '/api/networks/:id/votes');
  });

  it('a router-level refusal gets its mount\'s label, the same for every path under it, never `unmatched`', async () => {
    const refusalMounts = ['/api/about', '/api/admin/data', '/api/admin/webhooks', '/mcp'];
    for (const mount of refusalMounts) {
      assert.ok(MOUNTS.includes(mount), `app.ts no longer mounts ${mount}: re-anchor this test`);
      const a = await ask('GET', `${mount}/${rand()}`, { auth: false });
      const b = await ask('GET', `${mount}/${rand()}/${rand()}`, { auth: false });
      assert.ok([401, 403, 404, 405].includes(a.status), `an unauthenticated request under ${mount} answered ${a.status}`);
      assert.equal(a.counted.route, b.counted.route, `two paths under ${mount} were counted under different labels: "${a.counted.route}" and "${b.counted.route}"`);
      assert.notEqual(a.counted.route, 'unmatched', `a refusal answered by ${mount}'s own guard was counted as "unmatched"`);
      assert.ok(a.counted.route.toLowerCase().startsWith(mount), `the refusal under ${mount} was counted under "${a.counted.route}", which does not name the mount`);
    }
  });

  it('every GET route the mount graph lists is counted under its own full pattern when asked', async () => {
    const routes = mountedRoutes().filter(r => r.method === 'GET' && !NOT_ASKED.has(r.path));
    assert.ok(routes.length >= 60, `${routes.length} GET routes are listed: the derivation lost most of them`);
    const wrong = [];
    for (const r of routes) {
      const concrete = r.path.replace(/\{\*\w+\}/g, 'x/y').replace(/:\w+/g, 'aaaaaaaa-0000-4000-8000-000000000001');
      const { counted } = await ask('GET', concrete, { auth: true });
      if (counted.route !== r.path) wrong.push(`${r.path} -> "${counted.route}"`);
    }
    assert.deepEqual(wrong, [], `routes counted under a label other than their own full pattern:\n  ${wrong.join('\n  ')}`);
  });
});
