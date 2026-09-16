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

  for (const file of trackedSources(roots, { floor: 50 })) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/(\w*[Rr]outer)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*'([^']+)'/g)) {
      const [, router, method, routePath] = m;
      const prefix = mounts.prefixOf(router);
      // `undefined` means nothing mounts it — dead code or a helper. An empty string is a real answer (a
      // router mounted at the app root), so this cannot be a truthiness test.
      if (prefix === undefined) continue;
      const path = (prefix + routePath).replace(/\/+$/, '') || '/';
      out.push({ method: method.toUpperCase(), path, routePath, router, file });
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
