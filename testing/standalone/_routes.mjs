/**
 * Every HTTP route this server actually mounts — the question, answered once.
 *
 * ## Why a module
 *
 * Three gates ask it: `route-guard-coverage` (is every route guarded?), `audit-route-coverage` (is every
 * mutating route audited?), and now the REST/MCP parity derivation (is every capability reachable from
 * both doors?). Each wrote its own scan, and a scan that misses a route makes its gate report clean about
 * something it never read — which is the failure `routerMounts` itself was extracted to end, one level
 * down.
 *
 * ## The two things a hand-written copy drops, and both have bitten
 *
 * **`\w*[Rr]outer`, never `\w+Router`.** A route registered inside a function names its PARAMETER, and
 * `registerUploadRoute(router: Router)` spells it `router`. `POST /api/files/:spaceId` was not in the
 * guard analysis for a release — not reported as unguarded, ABSENT. The mount graph resolves the parameter
 * to whatever its call sites pass, so the prefix is still right.
 *
 * **The full path, not the declared one.** A router mounted at `/api/brain` declaring `'/recall'` serves
 * `/api/brain/recall`, and a caller comparing the declared string against a documented path finds nothing.
 *
 * ## The floor, which is the un-skippable part
 *
 * A scan that matches nothing passes every loop written over it. This THROWS below a floor rather than
 * returning a short list, because a gate handed `[]` concludes that everything is fine.
 */
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { routerMounts } from './_router-mounts.mjs';
import { argumentsOf } from './_structural-window.mjs';

/**
 * Every mounted route, as `{ method, path, routePath, router, file }`.
 *
 * `path` is the full served path; `routePath` is what the file declared, for a message that points at
 * something greppable.
 *
 * @param {{roots?: string[], floor?: number}} [opts] `floor` is the fewest routes that may resolve before
 *   this throws. Raise it when the surface grows; never lower it to make a run pass.
 */
export function mountedRoutes({ roots = ['server/src'], floor = 150 } = {}) {
  const mounts = routerMounts({ roots });
  const out = [];

  /*
   * The local agent connector is EXCLUDED, and it is the one place `app` would otherwise lie.
   *
   * It is a second express app, in a second process, on its own port, with its own auth and its own two
   * routes — `/v1/status` and `/v1/actions/enable-networks`. This server does not serve them, so folding
   * them in would have every gate here assert its rules against something outside their reach: a route
   * with no `ROUTE_RIGHTS` row that correctly has none, reported for ever.
   */
  const CONNECTOR = 'server/src/local-agent-connector/index.ts';

  for (const file of trackedSources(roots, { floor: 50, exclude: [CONNECTOR] })) {
    const src = stripComments(readFileSync(file, 'utf8'));
    /*
     * `app` IS IN THE PATTERN, and leaving it out hid the five most destructive routes in the product.
     *
     * The scan matched `\w*[Rr]outer` only, so a route declared straight on the express app was not
     * reported as unguarded or unaudited — it was ABSENT. `app.ts` declares five that way and they are
     * not small ones: wiping a space, importing one, exporting one, reloading the config and rotating the
     * signing key. Every gate built on this module concluded about "every route" while never seeing them.
     *
     * It is the shape this module's own header describes one level down, arriving on the identifier
     * nobody thinks of as a router because it is the thing routers are mounted ON.
     */
    for (const m of src.matchAll(/(\w*[Rr]outer|\bapp)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*'([^']+)'/g)) {
      const [, router, method, routePath] = m;
      // The app serves at the root, so its declared path IS the served path. Nothing mounts it, so the
      // mount graph has no answer for it and every route it carries would otherwise be skipped below.
      const prefix = router === 'app' ? '' : mounts.prefixOf(router);
      // `undefined` means nothing mounts it — dead code or a helper. An empty string is a real answer (a
      // router mounted at the app root), so this cannot be a truthiness test.
      if (prefix === undefined) continue;
      const path = (prefix + routePath).replace(/\/+$/, '') || '/';
      /*
       * The MIDDLEWARE CHAIN travels with the route, because the gate that wanted it kept its own copy of
       * the matcher instead — and that copy was the one still blind to `app`.
       *
       * `route-guard-coverage` re-implemented this scan to get at the arguments between the path and the
       * handler. One rule, two implementations, and the weaker one wins silently: widening the module's
       * pattern moved 9 routes into every OTHER gate's view and left the guard analysis exactly as blind
       * as before. Argument 0 is the path and the last is the handler, so everything between them is the
       * chain — whatever the handler happens to look like.
       */
      const args = argumentsOf(src, src.indexOf('(', m.index), `${routePath}: the route registration`);
      const chain = args.slice(1, -1).join(',');
      out.push({ method: method.toUpperCase(), path, routePath, router, chain, file });
    }
  }

  if (out.length < floor) {
    throw new Error(
      `mountedRoutes found ${out.length} routes, below the floor of ${floor}. A short list is not a small `
      + 'API — it is a scan that stopped matching, and every gate built on it would report clean.',
    );
  }
  return out;
}
