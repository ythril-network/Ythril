/**
 * The route map names every route the source mounts, by its full registered pattern (bundle-231, Q-605, Q-700; split out by Q-969).
 *
 * `server/src/http/route-map.ts` is built ONCE as `createApp` ends, by a recursive walk over the mounted routers. The routes the source mounts are
 * `mountedRoutes()` (`_routes.mjs`, the mount graph read from the source, not from the running app); every one of them must be in the map. The map
 * may hold MORE (the OAuth library's own routes are mounted from `node_modules`, not from source); it may not hold fewer. The case needs the app
 * built, which takes an instance directory and no database, so it runs in the pure tier; it sat in the `-db` file
 * (`the-route-map-names-every-route-the-source-mounts-db.test.js`, which keeps the cases that read the app's own routers), so the local preflight
 * never ran it.
 *
 * Run: node --test testing/standalone/the-route-map-names-every-route-the-source-mounts.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance } from './_vote-round-instance.mjs';

const dir = tempInstanceDir('ythril-route-map-');

describe('the route map names every route the source mounts', () => {
  let app;
  before(async () => {
    await bootInstance(dir, { instanceId: 'aaaaaaaa-0000-4000-8000-0000000000a9' });
    app = await appRouter();
  });
  after(async () => {
    await app?.close();
    removeInstanceDir(dir);
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
});
