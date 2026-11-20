/**
 * A `HEAD` of an RDF export is judged by the product's one rule for every route, never by a rule of the export's own (bundle-269, the
 * rebase onto the rights fix).
 *
 * ## The finding
 *
 * The bundle met a `HEAD` that skipped the area rung (the rights inventory keyed on the method and had no `HEAD` rows) before the product
 * did, and answered it for its two routes alone: `export/export-head.ts` wrapped their guards and rewrote `req.method` to `GET` while the
 * guard ran. Main then fixed the same hole for every route (`http/governed-method.ts`: a `HEAD` is governed as its `GET`, read by the
 * rights lookup and the audit alike). Two rules for one question drift: the wrapper's method rewrite is a second answer, and a change to
 * one leaves the other behind.
 *
 * ## What is asserted
 *
 *  1. **Each export route resolves to its rights row for every method it answers** (Express answers a `HEAD` with the `GET` route), in any
 *     casing of its path and with a trailing slash: the row the inventory holds for its `GET`, never `unclassified`, which main refuses.
 *     The routes and their rows are read from `ROUTE_RIGHTS`, never respelled here.
 *  2. **One rule**: no server module rewrites a request's method. The product's rule reads the method (`governedMethod`); a module that
 *     assigns `req.method` is a second rule.
 *
 * Seen red on the rebased branch before the change: `server/src/export/export-head.ts` assigns `req.method`.
 *
 * Run: node --test testing/standalone/a-head-of-an-export-is-governed-by-the-product-rule-alone.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';

const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
const { rungFor } = await import('../../server/dist/auth/required-rung.js');

/** The two RDF export routes, by the path the inventory writes. */
const EXPORT_ROUTES = ['/api/brain/spaces/:spaceId/export/rdf', '/api/spaces/:id/schema-rdf'];
/** Express runs a GET route for a HEAD, so a GET route answers both. */
const methodsAnswered = (method) => (method === 'GET' ? ['GET', 'HEAD'] : [method]);
/** The spellings a request may arrive in and still reach the route. */
const spellings = (route) => [route, route.toUpperCase(), `${route}/`];

describe('a HEAD of an RDF export is governed by the product rule alone', () => {
  for (const route of EXPORT_ROUTES) {
    const rows = ROUTE_RIGHTS.filter(r => r.route === route);
    it(`${route}: every method it answers resolves to its rights row, in every spelling`, () => {
      assert.ok(rows.length > 0, `${route} has no ROUTE_RIGHTS row`);
      for (const row of rows) {
        for (const method of methodsAnswered(row.method)) {
          for (const sent of spellings(route)) {
            const verdict = rungFor(method, sent);
            assert.equal(verdict.kind, 'requires', `${method} ${sent} is ${verdict.kind}: main refuses a request no row decides`);
            assert.deepEqual({ area: verdict.area, needs: verdict.needs, scope: verdict.scope }, { area: row.area, needs: row.needs, scope: row.scope },
              `${method} ${sent} must ask the row of ${row.method} ${route}`);
          }
        }
      }
    });
  }

  it('no server module rewrites a request\'s method: a HEAD has one rule, governedMethod', () => {
    const rewrite = /\.method\s*=(?!=)/;
    const found = readTrackedSources(SERVER_CODE_ROOTS, { specs: false })
      .filter(({ text }) => text.split('\n').some(line => rewrite.test(line) && !/^\s*(\/\/|\*)/.test(line)))
      .map(({ file }) => file);
    assert.deepEqual(found, [], 'a module that assigns req.method answers HEAD by a rule of its own beside http/governed-method.ts');
  });
});
