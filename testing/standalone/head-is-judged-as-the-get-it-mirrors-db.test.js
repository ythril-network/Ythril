/**
 * A HEAD is judged, answered and audited as the GET it mirrors.
 *
 * ## The rule
 *
 * Express answers a `HEAD` with the route registered for `GET`: the same guard chain, the same handler, the body left out. The area
 * rung was looked up by the method as sent, the inventory holds GET rows, and a HEAD found none: the guard took it for unclassified
 * and asked the reach check alone. So on every path-scoped GET route a token that reached the space read the status and the headers
 * (a file's size, name and type; whether a type exists; the length and validator of any answer) of an area it held no rung on, made
 * the server do the work of the whole answer, and left no audit row.
 *
 * What must hold, each derived from the inventory (`ROUTE_RIGHTS`) so a new route is in front of it at once:
 *
 *  1. a HEAD to every path-scoped GET row, from a token that lacks the row's area, answers as the GET does (status and refusal length);
 *  2. from a token that holds it, it answers the GET's status, never a refusal, with no body;
 *  3. where the body is the expensive part, an allowed HEAD stops after its headers: a stored file is not opened for its content
 *     (its `Content-Length` is the plaintext size the stat reads), the event stream takes no slot, completeness walks no collection;
 *  4. an allowed HEAD on an audited GET leaves the GET's row (operation, token, space) with `method: 'HEAD'`; a refused one is
 *     recorded as a refused GET is;
 *  5. `OPTIONS` and an unknown method (`PROPFIND`) reach no handler of a path-scoped route.
 *
 * Plus a record of what Express, the compression layer and the ETag layer put on a HEAD of a JSON answer, beside the GET's.
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server, real tokens, the harness Mongo, as
 * `a-path-casing-does-not-skip-the-area-rung-db.test.js` drives it. The spies are in-process: `fs.createReadStream` (the stored-bytes
 * door opens a file's content with it, `stat` does not), the driver's `Collection.prototype.aggregate` (completeness is aggregations),
 * the event stream's own open count, and a counter wrapped round every handler of every route.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/head-is-judged-as-the-get-it-mirrors-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const SPACE = 'headrung';
const FILE = 'probe.txt';
const FILE_TEXT = 'a head request reads no byte of this';

let door, server, base, app, routes, allPathRows, loader, openStreams, SPACE_AREAS;
const tokenWithout = {};
let holder, holderId;
const handlerCalls = new Map();

/** A route's request path: the space parameter (`:spaceId`, or `:id` under `/api/spaces`) is the space, every other parameter `x1`. */
function pathOf(route) {
  const spaceParam = route.startsWith('/api/spaces/') ? ':id' : ':spaceId';
  return route.split('/').map((seg) => (seg === spaceParam ? SPACE : seg.startsWith(':') ? 'x1' : seg)).join('/');
}

/**
 * Ask once, on a connection of its own (`agent: false`, closed after the answer), so an answer the server never ends (a stream) cannot
 * hold up the next request on a shared socket. An event stream is cut as soon as its status is read, which frees its slot. A request
 * whose headers never come (a HEAD of a stream that writes its headers with its first body byte, which a HEAD never sends) answers
 * `no answer` once its socket has been idle for `IDLE_MS`, so it fails its assertion instead of hanging the file.
 */
const IDLE_MS = 5_000;
function ask(method, p, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method, agent: false, timeout: IDLE_MS, headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
      const got = { status: res.statusCode, length: res.headers['content-length'] ?? null, headers: new Headers(Object.entries(res.headers).map(([k, v]) => [k, String(v)])) };
      if ((res.headers['content-type'] ?? '').startsWith('text/event-stream') && method !== 'HEAD') { res.destroy(); resolve({ ...got, text: '' }); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ ...got, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'no answer', length: null, headers: new Headers(), text: '' }); });
    req.on('error', (err) => { if (!req.destroyed || err.code !== 'ECONNRESET') reject(err); });
    req.end();
  });
}

/** Every handler of every route the app serves, wrapped to count its calls under the route's pattern. */
function countRouteHandlers(stack, registeredPathOf, seen = new Set()) {
  for (const layer of stack) {
    if (layer.route) {
      const pattern = registeredPathOf({ route: layer.route });
      for (const l of layer.route.stack) {
        if (seen.has(l)) continue;
        seen.add(l);
        const fn = l.handle;
        // Three parameters, as the original: the router skips a handle declaring four (an error handler).
        l.handle = function counted(req, res, next) {
          handlerCalls.set(pattern, (handlerCalls.get(pattern) ?? 0) + 1);
          return fn.call(this, req, res, next);
        };
      }
      continue;
    }
    if (Array.isArray(layer.handle?.stack) && !seen.has(layer.handle)) {
      seen.add(layer.handle);
      countRouteHandlers(layer.handle.stack, registeredPathOf, seen);
    }
  }
}

describe('a HEAD is judged, answered and audited as the GET it mirrors (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    door = await openToolDoor({ suite: 'headrung', spaces: [{ id: SPACE, label: 'Head', folders: [] }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
    ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js'));
    loader = await import('../../server/dist/config/loader.js');
    ({ openStreams } = await import('../../server/dist/util/sse-stream.js'));
    const { registeredPathOf } = await import('../../server/dist/http/route-map.js');
    routes = ROUTE_RIGHTS.filter(r => r.scope === 'path' && r.method === 'GET');
    allPathRows = ROUTE_RIGHTS.filter(r => r.scope === 'path');
    const { RUNG_IMPLICATIONS } = await import('../../server/dist/config/rights-shape.js');
    const RUNGS = ['none', 'read', 'write', 'admin'];
    for (const area of SPACE_AREAS) {
      // Reaches the space, holds every area but this one, and no rung that implies it (`knowledge: write` implies `schema: read`).
      const perArea = Object.fromEntries(SPACE_AREAS.map(a => [a, a === area ? 'none' : 'admin']));
      for (const rule of RUNG_IMPLICATIONS) if (rule.grants === area) perArea[rule.when] = RUNGS[RUNGS.indexOf(rule.atLeast) - 1];
      tokenWithout[area] = (await tokens.createToken({ name: `head-without-${area}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: perArea } } })).plaintext;
    }
    const all = Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin']));
    const made = await tokens.createToken({ name: 'head-holder', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: all } } });
    holder = made.plaintext;
    holderId = made.record.id;
    app = await appRouter();
    countRouteHandlers(app.router.router.stack, registeredPathOf);
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
    const wrote = await fetch(`${base}/api/files/${SPACE}?path=${FILE}`, {
      method: 'POST', headers: { Authorization: `Bearer ${holder}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: FILE_TEXT }),
    });
    assert.ok(wrote.status < 300, `the fixture file was not stored: ${wrote.status} ${await wrote.text()}`);
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await door?.close();
  });

  it('the inventory has path-scoped GET routes to drive (the sweep is not vacuous)', () => {
    assert.ok(routes.length >= 15, `only ${routes.length} path-scoped GET routes in ROUTE_RIGHTS`);
    assert.ok(new Set(routes.map(r => r.area)).size >= 3, 'the sweep covers fewer than three areas');
  });

  it('1. a HEAD from a token without the area answers as the GET does, on every path-scoped GET route', async () => {
    const differs = [];
    for (const r of routes) {
      const p = pathOf(r.route);
      const get = await ask('GET', p, tokenWithout[r.area]);
      const head = await ask('HEAD', p, tokenWithout[r.area]);
      assert.equal(get.status, 403, `the control: GET ${p} does not refuse a token without ${r.area} (${get.status})`);
      if (head.status !== get.status || head.length !== get.length) differs.push(`HEAD ${r.route} (${r.area}): ${head.status} length ${head.length}, GET ${get.status} length ${get.length}`);
    }
    assert.deepEqual(differs, [], 'a HEAD was answered where its GET is refused');
  });

  it('2. a HEAD from a token holding the area answers the GET\'s status, never a refusal, with no body', async () => {
    const differs = [];
    for (const r of routes) {
      const p = pathOf(r.route);
      const get = await ask('GET', p, holder);
      const head = await ask('HEAD', p, holder);
      if (head.status !== get.status || head.status === 403 || head.text !== '') differs.push(`HEAD ${r.route}: ${head.status} (${head.text.length} body chars), GET ${get.status}`);
    }
    assert.deepEqual(differs, [], 'a HEAD answered otherwise than its GET for a token that holds the area');
  });

  describe('3. an allowed HEAD stops after its headers where the body is the expensive part', () => {
    it('a stored file: the headers are the GET\'s, and its content is never opened', async (t) => {
      const opened = [];
      const original = fs.createReadStream;
      fs.createReadStream = function spied(p, ...rest) {
        if (String(p).endsWith(path.join(SPACE, FILE))) opened.push(String(p));
        return original.call(this, p, ...rest);
      };
      try {
        const get = await ask('GET', `/api/files/${SPACE}?path=${FILE}`, holder);
        assert.equal(get.text, FILE_TEXT, 'the control: a GET reads the file');
        assert.equal(opened.length, 1, `the control: the spy did not see the GET open the file (${opened.length})`);
        opened.length = 0;
        const head = await ask('HEAD', `/api/files/${SPACE}?path=${FILE}`, holder);
        assert.equal(head.status, 200);
        for (const h of ['content-length', 'content-type', 'content-disposition', 'x-content-type-options']) {
          assert.equal(head.headers.get(h), get.headers.get(h), `HEAD's ${h} differs from GET's`);
        }
        assert.equal(Number(head.length), Buffer.byteLength(FILE_TEXT), 'Content-Length is the plaintext size');
        assert.deepEqual(opened, [], 'a HEAD opened the file\'s content: the whole file is read (and decrypted) to send nothing');
        t.diagnostic(`file HEAD headers: ${JSON.stringify(Object.fromEntries(head.headers))}`);
      } finally {
        fs.createReadStream = original;
      }
    });

    it('the event stream: the headers are answered and no stream slot is taken', async () => {
      // The streams the sweeps above opened are closed with their connections; start from none.
      await waitForValue(() => openStreams('brain-events') === 0, 5_000, 50, () => `${openStreams('brain-events')} event streams still open`);
      const before = 0;
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.request(`${base}/api/brain/spaces/${SPACE}/events`, { method: 'HEAD', agent, timeout: IDLE_MS, headers: { Authorization: `Bearer ${holder}` } }, resolve);
          req.on('timeout', () => { req.destroy(); reject(new Error(`a HEAD of the event stream got no headers within ${IDLE_MS} ms (${openStreams('brain-events')} streams open)`)); });
          req.on('error', reject);
          req.end();
        });
        res.resume();
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');
        // The socket is still open (keep-alive): a slot is taken before the headers are written, so one held for it shows here already.
        assert.equal(openStreams('brain-events'), before, `a HEAD holds an event-stream slot while its connection stays open (${openStreams('brain-events')} open)`);
      } finally {
        agent.destroy();
      }
    });

    it('completeness: no collection is walked for a HEAD', async () => {
      const req = createRequire(new URL('../../server/dist/app.js', import.meta.url));
      const { Collection } = req('mongodb');
      const walked = [];
      const original = Collection.prototype.aggregate;
      Collection.prototype.aggregate = function spied(...args) {
        if (String(this.collectionName).startsWith(`${SPACE}_`)) walked.push(this.collectionName);
        return original.apply(this, args);
      };
      try {
        const get = await ask('GET', `/api/spaces/${SPACE}/completeness`, holder);
        assert.equal(get.status, 200);
        assert.ok(walked.length > 0, 'the control: the spy did not see the GET walk the collections');
        walked.length = 0;
        const head = await ask('HEAD', `/api/spaces/${SPACE}/completeness`, holder);
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
        assert.deepEqual(walked, [], 'a HEAD walked every collection of the space to send nothing');
      } finally {
        Collection.prototype.aggregate = original;
      }
    });
  });

  describe('4. audit', () => {
    const auditColl = () => door.mongo.getDb().collection('audit_log');
    const rowOf = (filter) => waitForValue(() => auditColl().findOne(filter), 5_000, 100, `no audit row for ${JSON.stringify(filter)}`);

    it('an allowed HEAD leaves the GET\'s row, marked HEAD; a refused one is recorded as a refused GET is', async () => {
      loader.mutateConfig(c => { c.audit = { ...(c.audit ?? {}), logReads: true }; });
      const p = `/api/brain/spaces/${SPACE}/stats`;
      assert.equal((await ask('GET', p, holder)).status, 200);
      const getRow = await rowOf({ method: 'GET', path: p, tokenId: holderId });
      assert.equal((await ask('HEAD', p, holder)).status, 200);
      const headRow = await rowOf({ method: 'HEAD', path: p, tokenId: holderId });
      for (const k of ['operation', 'tokenId', 'spaceId', 'status']) assert.equal(headRow[k], getRow[k], `the HEAD row's ${k} differs from the GET row's`);

      // A refusal in the guard is recorded before the token is attached, so the rows are told apart by method and status alone.
      const refused = tokenWithout['knowledge'];
      assert.equal((await ask('GET', p, refused)).status, 403);
      const getRefused = await rowOf({ method: 'GET', path: p, status: 403 });
      assert.equal((await ask('HEAD', p, refused)).status, 403);
      const headRefused = await rowOf({ method: 'HEAD', path: p, status: 403 });
      for (const k of ['operation', 'tokenId', 'spaceId', 'status']) assert.equal(headRefused[k], getRefused[k], `the refused HEAD row's ${k} differs from the refused GET row's`);
    });
  });

  it('5. OPTIONS and an unknown method reach no handler of a path-scoped route', async (t) => {
    // The control: the counter sees a GET.
    handlerCalls.clear();
    assert.equal((await ask('GET', `/api/brain/spaces/${SPACE}/stats`, holder)).status, 200);
    assert.ok((handlerCalls.get('/api/brain/spaces/:spaceId/stats') ?? 0) > 0, 'the control: the handler counter did not see a GET');
    handlerCalls.clear();
    const statuses = new Map();
    for (const r of allPathRows) {
      for (const method of ['OPTIONS', 'PROPFIND']) {
        const { status, headers } = await ask(method, pathOf(r.route), holder);
        const k = `${method} ${status}${headers.get('allow') ? ` allow` : ''}`;
        statuses.set(k, (statuses.get(k) ?? 0) + 1);
      }
    }
    t.diagnostic(`answers: ${JSON.stringify(Object.fromEntries(statuses))}`);
    assert.deepEqual(Object.fromEntries(handlerCalls), {}, 'a route handler (a guard or the handler itself) ran for OPTIONS or PROPFIND');
  });

  it('what Express, compression and the ETag layer put on a HEAD of a JSON answer, beside the GET', async (t) => {
    const p = `/api/brain/spaces/${SPACE}/stats`;
    const enc = { 'Accept-Encoding': 'gzip' };
    const get = await ask('GET', p, holder, enc);
    const head = await ask('HEAD', p, holder, enc);
    const pick = (h) => Object.fromEntries(['content-type', 'content-length', 'etag', 'content-encoding', 'vary'].map(k => [k, h.get(k)]));
    t.diagnostic(`GET  ${JSON.stringify(pick(get.headers))}`);
    t.diagnostic(`HEAD ${JSON.stringify(pick(head.headers))}`);
    assert.equal(head.status, get.status);
    assert.equal(head.text, '');
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
  });
});
