/**
 * Every `resolved` row of the rights inventory belongs to a route under `/ld/` (bundle-271, Q-758, review of S3 finding 2).
 *
 * ## What it prevents
 *
 * A `resolved` row (`auth/space-rights.ts`) names an area and a rung that only the Linked Data door can ask: it resolves the space from the
 * address's base (`requireResolvedRung`). A `resolved` row on any other route has no asker: `enforceAreaRung` refuses it, so the route
 * answers 403 to everyone, and the rights gates written for `/api` (the capability map, the route-path docs) would read it as governed. The
 * place the row may live is the door that asks it, so a row whose route does not start with `/ld/` fails here, before the first request.
 *
 * ## Seen red
 *
 * The rule is proven on a planted row: a `resolved` row on an `/api` route is named, the real inventory's rows and a `path` row on an `/api`
 * route are not. Mutation on the real inventory: the scope of an `/api` row changed to `resolved`.
 *
 * Run: npm run build:server, then node --test testing/standalone/every-resolved-rights-row-is-a-linked-data-route.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');

/** The `resolved` rows of `rows` whose route is not under `/ld/`. */
function resolvedRowsOutsideLd(rows) {
  return rows.filter(r => r.scope === 'resolved' && !r.route.startsWith('/ld/')).map(r => `${r.method} ${r.route}`);
}

describe('every resolved rights row is a Linked Data route', () => {
  it('names a resolved row on an /api route, and no other', () => {
    const planted = [
      { route: '/api/brain/spaces/:spaceId/entities', method: 'GET', area: 'knowledge', needs: 'read', scope: 'resolved' },
      { route: '/api/brain/spaces/:spaceId/facts', method: 'GET', area: 'knowledge', needs: 'read', scope: 'path' },
      { route: '/ld/:spaceId/:kind/:id', method: 'GET', area: 'knowledge', needs: 'read', scope: 'resolved' },
    ];
    assert.deepEqual(resolvedRowsOutsideLd(planted), ['GET /api/brain/spaces/:spaceId/entities']);
  });

  it('the real inventory has resolved rows, all of them under /ld/', () => {
    assert.ok(ROUTE_RIGHTS.some(r => r.scope === 'resolved'), 'no resolved row: the Linked Data rows are not found, re-anchor this test');
    assert.deepEqual(resolvedRowsOutsideLd(ROUTE_RIGHTS), [], 'a resolved rights row belongs to the door that resolves the space: /ld/');
  });
});
