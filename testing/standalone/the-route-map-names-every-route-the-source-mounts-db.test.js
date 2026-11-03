/**
 * The route map knows every route the source mounts, by its full registered pattern (bundle-231, Q-605, Q-700).
 *
 * ## The rule
 *
 * `server/src/http/route-map.ts` is built ONCE as `createApp` ends, by a recursive walk over the mounted routers, and answers "which registered
 * full pattern is this request" for three callers: the metrics label, the area guard's inventory key and the error handler's labels. A route the
 * walk misses is labelled `unmatched` and keyed by the request's own spelling, so a router that is nested one level deeper than the walk reads
 * (a router mounted inside a router that is mounted with a path) would drop out of all three without a single failing request.
 *
 * The routes the source mounts are `mountedRoutes()` (`_routes.mjs`, the mount graph read from the source, not from the running app). Every one
 * of them must be in the map, and the map's literal mounts must include each mount string of `app.ts` (lowercased). The map may hold MORE
 * (the OAuth library's own routes are mounted from `node_modules`, not from source); it may not hold fewer.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/the-route-map-names-every-route-the-source-mounts-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { mountedRoutes } from './_routes.mjs';
import { stripComments } from './_strip-comments.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();

let door; let app;

describe('the route map names every route the source mounts', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'routemap', spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }] });
    app = await appRouter();
  });
  after(async () => {
    await app?.close();
    await door?.close();
  });

  it('every route mountedRoutes() lists is in the map under its full pattern', async () => {
    const { routeMapContents } = await import('../../server/dist/http/route-map.js');
    const { patterns } = routeMapContents();
    const have = new Set(patterns);
    const want = [...new Set(mountedRoutes().map(r => r.path))];
    assert.ok(want.length >= 100, `the source mounts ${want.length} distinct route paths: the derivation lost most of them`);
    const missing = want.filter(p => !have.has(p));
    assert.deepEqual(missing, [], `these mounted routes are not in the route map (a router nested deeper than the walk reads?): ${missing.join(', ')}`);
  });

  it('the map holds every literal mount string of app.ts, lowercased', async () => {
    const { routeMapContents } = await import('../../server/dist/http/route-map.js');
    const { mounts } = routeMapContents();
    const src = stripComments(fs.readFileSync('server/src/app.ts', 'utf8'));
    const literal = [...new Set([...src.matchAll(/\bapp\.use\(\s*'(\/[^']*)'/g)].map(m => m[1]))].filter(m => m !== '/metrics' && m !== '/api');
    const missing = literal.filter(m => !mounts.includes(m.toLowerCase()));
    assert.deepEqual(missing, [], `these mounts of app.ts are not in the route map's mount labels: ${missing.join(', ')}`);
  });

  it('a request is keyed by the registered pattern whatever its casing (registeredPathOf)', async () => {
    const { registeredPathOf, routeLabel } = await import('../../server/dist/http/route-map.js');
    // The Route object of GET /api/brain/spaces/:spaceId/stats, found by the same walk a request would reach it through.
    const stack = app.router.router.stack ?? app.router.stack;
    const found = [];
    (function walk(layers) {
      for (const l of layers) {
        if (l.route && l.route.path === '/spaces/:spaceId/stats') found.push(l.route);
        else if (Array.isArray(l.handle?.stack)) walk(l.handle.stack);
      }
    })(stack);
    assert.ok(found.length >= 1, 'fixture check: the stats route was not found in the app');
    const req = { method: 'GET', route: found[0], baseUrl: '/Api/Brain', originalUrl: '/Api/Brain/Spaces/x/Stats', url: '/spaces/x/stats' };
    assert.equal(registeredPathOf(req), '/api/brain/spaces/:spaceId/stats', 'the key is the registered pattern, not the caller\'s spelling');
    assert.equal(routeLabel(req, 200), '/api/brain/spaces/:spaceId/stats');
    assert.equal(routeLabel({ ...req, route: undefined }, 404), 'unmatched', 'a miss is `unmatched`');
    assert.equal(routeLabel({ ...req, route: undefined, originalUrl: '/Api/About/zz' }, 401), '/api/about', 'a refusal before any route is the mount\'s label, in any casing');
  });
});
