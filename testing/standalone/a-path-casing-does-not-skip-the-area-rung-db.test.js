/**
 * The area rung is asked of a route however its path is spelled (Q-700).
 *
 * ## The rule
 *
 * Express matches a route's literal segments without regard to case, so `/API/brain/spaces/s/stats` reaches the handler of
 * `/api/brain/spaces/:spaceId/stats`. The area guard reconstructs the route's inventory key from `req.baseUrl` (which is the
 * path as the caller TYPED it) and the route's registered path, and found no row for a mixed-case mount: the route was taken for
 * "unclassified", which falls through to the reach check alone with a warning. A token that reaches a space but holds no rung on
 * an area could read that area by changing the case of `api`.
 *
 * Every route the inventory prices with a path-scoped rung (`ROUTE_RIGHTS`, read through the module so no list is kept here) must
 * answer a casing variant of its path exactly as it answers the canonical spelling, and the canonical spelling must refuse a token that
 * holds the other areas but not this one.
 *
 * Only GET routes are driven: a refused call leaves no trace, and one that is wrongly admitted must not write.
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server, real tokens, the harness Mongo. Written red on d079607b3: the variants
 * are answered 200 where the canonical path is a 403. Q-605's route-map module will make the inventory key case-insensitive at the
 * source; this test holds the behaviour whichever way the key is built.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-path-casing-does-not-skip-the-area-rung-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
const SPACE = 'casingrung';
const AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'];

let door, server, base, app, routes;
const tokenWithout = {};

/** `/api/brain/spaces/:spaceId/stats` as a request path, params filled in, literal segments re-cased by `recase`. */
function pathOf(route, recase) {
  return route.split('/').map((seg) => (seg.startsWith(':') ? (seg === ':spaceId' ? SPACE : 'x1') : recase(seg))).join('/');
}
const capitalised = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const VARIANTS = [['Capitalised segments', capitalised], ['UPPER CASE segments', (s) => s.toUpperCase()]];

describe('a casing variant of a path is asked the area rung as the canonical path is (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    door = await openToolDoor({ suite: 'casingrung', spaces: [{ id: SPACE, label: 'Casing', folders: [] }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
    routes = ROUTE_RIGHTS.filter(r => r.scope === 'path' && r.method === 'GET');
    for (const area of AREAS) {
      // Reaches the space, holds every area but this one.
      const perArea = Object.fromEntries(AREAS.map(a => [a, a === area ? 'none' : 'admin']));
      const t = await tokens.createToken({ name: `casing-without-${area}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: perArea } } });
      tokenWithout[area] = t.plaintext;
    }
    app = await appRouter();
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await door?.close();
  });

  const ask = async (path, area) => (await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tokenWithout[area]}` } })).status;

  it('the inventory has path-scoped GET routes to drive (the sweep is not vacuous)', () => {
    assert.ok(routes.length >= 8, `only ${routes.length} path-scoped GET routes in ROUTE_RIGHTS`);
    assert.ok(new Set(routes.map(r => r.area)).size >= 3, 'the sweep covers fewer than three areas');
  });

  it('the canonical spelling refuses a token that lacks the route\'s area (a control: this holds today)', async () => {
    const unrefused = [];
    for (const r of routes) {
      const status = await ask(pathOf(r.route, s => s), r.area);
      if (status !== 403) unrefused.push(`${r.method} ${r.route} (${r.area}): ${status}`);
    }
    assert.deepEqual(unrefused, [], 'the canonical path of these routes did not refuse a token that holds no rung on their area');
  });

  for (const [label, recase] of VARIANTS) {
    it(`${label}: every route answers as its canonical path does`, async () => {
      const differs = [];
      for (const r of routes) {
        const canonical = await ask(pathOf(r.route, s => s), r.area);
        const variant = await ask(pathOf(r.route, recase), r.area);
        if (variant !== canonical) differs.push(`${r.method} ${pathOf(r.route, recase)} (${r.area}): ${variant}, canonical ${canonical}`);
      }
      assert.deepEqual(differs, [], 'a mixed-case path skipped the area rung: a token that holds no rung on the area was answered');
    });
  }
});
