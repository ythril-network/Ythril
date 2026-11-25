/**
 * Every route outside `/api` that names a space, and every route under `/ld`, carries authentication and an area rung on the route itself,
 * both before its handler (bundle-271, Q-758; design r2 R1.5, vet-3 S2; review of S3 finding 4).
 *
 * ## What it prevents
 *
 * The rights gates read `/api`: the capability map, the route-path docs and the guard coverage are written for it, and the app mounts its
 * global API limiter and its `/api` fallback there. A router mounted elsewhere (the Linked Data addresses at `/ld`, outside `/api` because
 * an address is the export's name for a record) sat in front of no `requireAuth` and no rung: the placeholder there read nothing, and the
 * first route that read a space would have answered every caller. So every route outside `/api` whose path names a space (`:spaceId`), and
 * every route under `/ld` whether it names one or not (a route there that read a space from the address would name none), must carry, in
 * its own middleware chain:
 *
 * - **authentication**: `requireAuth`, or an area guard of `auth/middleware.ts` (each resolves the token first);
 * - **an area rung**: an area guard of `auth/middleware.ts` (derived: its body calls `enforceAreaRung(`), or a guard of the route's own file
 *   that asks the rights inventory (`rungFor(`) and the rung (`mayReadArea(`, `holdsRung(`), for a route whose space is resolved from what
 *   it is asked (an address's base), not read from its path.
 *
 * and both **before the handler**: the last argument of the registration is the handler and no guard, and no function written inline stands
 * in the chain ahead of the rung guard (it would answer before the rung is asked). A guard named after the handler, or as its last
 * argument, runs when the answer is already sent.
 *
 * The routes are the mount graph's (`mountedRoutes()`), the guards are derived from the source (`_area-guards.mjs`), so a new router
 * outside `/api` and a new guard are both in view without editing this file.
 *
 * ## Seen red
 *
 * On ce62acbbb the gate reads only the routes that name `:spaceId`, and a guard counts when it stands anywhere in the arguments between the
 * path and the last one: a planted `/ld/status` route with no guard at all is not tested, and a planted route with its guards after its
 * handler passes. Both planted routes (below) are named now. Mutation on the real tree: `requireAuth` dropped from one `/ld` route's chain.
 *
 * Run: npm run build:server, then node --test testing/standalone/every-space-route-outside-the-api-has-auth-and-an-area-rung.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';
import { areaGuards, resolvedRungGuards } from './_area-guards.mjs';
import { argumentsOf } from './_structural-window.mjs';

const namesASpace = (p) => /\/:(spaceId|space)(\/|$)/.test(p);
const insideApi = (p) => p === '/api' || p.startsWith('/api/');
const underLd = (p) => p === '/ld' || p.startsWith('/ld/');
const word = (names) => new RegExp(`\\b(${[...names].join('|')})\\b`);
/** A function written inline in a registration: a handler, which answers before a guard that stands after it. */
const INLINE_FUNCTION = /=>|\bfunction\b/;

/** Is `route` one this gate holds: outside `/api` and naming a space, or anywhere under `/ld`. */
const held = (route) => !insideApi(route.path) && (namesASpace(route.path) || underLd(route.path));

let routes;
/** The routes this gate holds. */
function heldRoutes() {
  routes ??= mountedRoutes().filter(held);
  return routes;
}

/**
 * What is missing from each of `routes`: authentication, an area rung, or either of them in front of the handler.
 * `rungGuardsOf(file)` names the guards of a route's own file that ask a resolved rung.
 */
function missesOf(routes_, area, rungGuardsOf) {
  const misses = [];
  for (const r of routes_) {
    const rung = new Set([...area, ...rungGuardsOf(r.file)]);
    const guards = new Set(['requireAuth', ...rung]);
    const middle = r.args.slice(1, -1);
    const handler = r.args.at(-1) ?? '';
    const at = `${r.method} ${r.path} (${r.file})`;
    const authenticates = middle.some(a => word(new Set(['requireAuth', ...area])).test(a));
    const rungAt = rung.size > 0 ? middle.findIndex(a => word(rung).test(a)) : -1;
    if (!authenticates) misses.push(`${at}: no requireAuth or area guard before its handler`);
    if (rungAt === -1) misses.push(`${at}: no area rung before its handler`);
    if (word(guards).test(handler)) misses.push(`${at}: its last argument is a guard, so the handler runs before it`);
    else if (rungAt !== -1 && middle.slice(0, rungAt).some(a => INLINE_FUNCTION.test(a))) misses.push(`${at}: a handler is written in the chain ahead of its rung guard`);
  }
  return misses;
}

/** A planted `router.get(...)` registration, parsed as the gate parses the real ones; `file` is the Linked Data door's, whose guards are read. */
function planted(call) {
  const m = /\w+\.get\(\s*'([^']+)'/.exec(call);
  assert.ok(m, `not a registration: ${call}`);
  return { method: 'GET', path: `/ld${m[1]}`, file: 'server/src/api/linked-data.ts', args: argumentsOf(call, call.indexOf('('), 'a planted route') };
}

describe('every space route outside /api carries authentication and an area rung', () => {
  it('finds the routes outside /api that name a space, the Linked Data record address among them', () => {
    const found = heldRoutes().map(r => `${r.method} ${r.path}`);
    assert.ok(found.includes('GET /ld/:spaceId/:kind/:id'), `the record address is not derived; found: ${found.join(', ') || 'none'}`);
    assert.ok(areaGuards().has('requireSpaceAuth'), 'requireSpaceAuth is not derived as an area guard; re-anchor _area-guards.mjs');
  });

  it('holds every route under /ld, with a space in its path or without', () => {
    assert.ok(held({ path: '/ld/status' }), 'a route under /ld with no :spaceId is not held');
    assert.ok(held({ path: '/ld/:spaceId/x' }) && !held({ path: '/api/brain/spaces/:spaceId/stats' }) && !held({ path: '/health' }));
  });

  it('names a planted route with no guard, and one whose guards stand after its handler; a guarded route passes', () => {
    const area = areaGuards();
    const rungs = () => new Set(['requireResolvedRung']);
    const bare = planted("router.get('/status', answer);");
    assert.equal(missesOf([bare], area, rungs).length, 2, 'a route under /ld with no :spaceId and no guard');
    const after = planted("router.get('/:spaceId/x', answer, requireAuth, requireResolvedRung);");
    assert.match(missesOf([after], area, rungs).join('\n'), /last argument is a guard/, 'a guard after the handler (the last argument)');
    const inside = planted("router.get('/:spaceId/x', (req, res) => res.end(), requireAuth, requireResolvedRung, answer);");
    assert.match(missesOf([inside], area, rungs).join('\n'), /handler is written in the chain ahead/, 'a handler ahead of its guards');
    const good = planted("router.get('/:spaceId/x', globalRateLimit, browsersToTheApp(fixed('x')), requireAuth, requireResolvedRung, answered('x', (req, res) => work(req, res)));");
    assert.deepEqual(missesOf([good], area, rungs), []);
  });

  it('each real route authenticates and asks an area rung in its own chain, before its handler', () => {
    const misses = missesOf(heldRoutes(), areaGuards(), resolvedRungGuards);
    assert.deepEqual(misses, [], 'routes outside /api that name a space (and every /ld route) answer without a token or a rung');
  });
});
