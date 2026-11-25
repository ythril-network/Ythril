/**
 * Every route outside `/api` that names a space carries authentication and an area rung on the route itself (bundle-271, Q-758; design r2
 * R1.5, vet-3 S2).
 *
 * ## What it prevents
 *
 * The rights gates read `/api`: the capability map, the route-path docs and the guard coverage are written for it, and the app mounts its
 * global API limiter and its `/api` fallback there. A router mounted elsewhere (the Linked Data addresses at `/ld`, outside `/api` because
 * an address is the export's name for a record) sat in front of no `requireAuth` and no rung: the placeholder there read nothing, and the
 * first route that read a space would have answered every caller. So every route outside `/api` whose path names a space (`:spaceId`)
 * must carry, in its own middleware chain:
 *
 * - **authentication**: `requireAuth`, or an area guard of `auth/middleware.ts` (each resolves the token first);
 * - **an area rung**: an area guard of `auth/middleware.ts` (derived: its body calls `enforceAreaRung(`), or a guard of the route's own file
 *   that asks the rights inventory (`rungFor(`) and the rung (`mayReadArea(`, `holdsRung(`), for a route whose space is resolved from what
 *   it is asked (an address's base), not read from its path.
 *
 * The routes are the mount graph's (`mountedRoutes()`), the guards are derived from the source (`_area-guards.mjs`), so a new router
 * outside `/api` and a new guard are both in view without editing this file.
 *
 * ## Seen red
 *
 * On c647bd24f no route outside `/api` names a space (the `/ld` placeholder registers none): the floor case fails. Mutation: `requireAuth`
 * dropped from one `/ld` route's chain (named as unauthenticated).
 *
 * Run: npm run build:server, then node --test testing/standalone/every-space-route-outside-the-api-has-auth-and-an-area-rung.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';
import { areaGuards, resolvedRungGuards } from './_area-guards.mjs';

const namesASpace = (p) => /\/:(spaceId|space)(\/|$)/.test(p);
const insideApi = (p) => p === '/api' || p.startsWith('/api/');
const word = (names) => new RegExp(`\\b(${[...names].join('|')})\\b`);

let routes;
/** The routes outside `/api` whose path names a space. */
function outsideRoutes() {
  routes ??= mountedRoutes().filter(r => !insideApi(r.path) && namesASpace(r.path));
  return routes;
}

describe('every space route outside /api carries authentication and an area rung', () => {
  it('finds the routes outside /api that name a space, the Linked Data record address among them', () => {
    const found = outsideRoutes().map(r => `${r.method} ${r.path}`);
    assert.ok(found.includes('GET /ld/:spaceId/:kind/:id'), `the record address is not derived; found: ${found.join(', ') || 'none'}`);
    assert.ok(areaGuards().has('requireSpaceAuth'), 'requireSpaceAuth is not derived as an area guard; re-anchor _area-guards.mjs');
  });

  it('each one authenticates and asks an area rung in its own chain', () => {
    const area = areaGuards();
    const misses = [];
    for (const r of outsideRoutes()) {
      const rung = new Set([...area, ...resolvedRungGuards(r.file)]);
      const authenticates = word(new Set(['requireAuth', ...area])).test(r.chain);
      const asksRung = rung.size > 0 && word(rung).test(r.chain);
      if (!authenticates) misses.push(`${r.method} ${r.path} (${r.file}): no requireAuth or area guard`);
      if (!asksRung) misses.push(`${r.method} ${r.path} (${r.file}): no area rung`);
    }
    assert.deepEqual(misses, [], 'routes outside /api that name a space and answer without a token or a rung');
  });
});
