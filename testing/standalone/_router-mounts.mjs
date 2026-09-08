/**
 * Where does each Express router hang? One answer, for every sweep that needs it.
 *
 * ## Why this exists
 *
 * A sweep over `server/src/api` cannot say anything true about a route without knowing the path its router
 * answers on. Four places need that, and each worked it out again:
 *
 * | sweep | what it asks | what it got wrong |
 * |---|---|---|
 * | `route-guard-coverage` | is this router reachable at all | a route registered onto a function's parameter |
 * | `a-rights-row-is-reachable-at-the-rung-it-names` | the full path, to match a rights row | both forms, at first |
 * | `audit-route-coverage` | the mount prefix, by router name | — |
 * | the `Q-9` accepted-key parser | the full path, to pair with a tool | both forms |
 *
 * The reachability gate resolved 117 of 217 registrations before this was extracted. The hundred it missed
 * were the whole brain tree — fifty of the eighty-five `ROUTE_RIGHTS` rows — and they were not reported as
 * unmatched, they were absent, so its floor passed on what remained.
 *
 * **This module answers ONE question and stops.** What each caller concludes from a path is its own
 * business, and those conclusions genuinely differ; herding them here would be the reuse rule's own failure
 * mode. See `Q-19`.
 *
 * ## The three mount forms, and the two that get missed
 *
 * ```
 * app.use('/api/spaces', spacesRouter)      // 1. the obvious one
 * brainRouter.use(memoriesRouter)           // 2. NO prefix — mounted at the parent's own path
 * export function registerUploadRoute(router: Router) { router.post('/:spaceId', …) }
 * registerUploadRoute(fileStoreRouter)      // 3. the registration names its PARAMETER
 * ```
 *
 * Form 2 is ten of the brain routers. Form 3 hid `POST /api/files/:spaceId` — a real route with a real
 * rights row — and `registerReembedRoute` escaped it only because its parameter happens to be spelled
 * `spacesRouter`, which is luck rather than design.
 *
 * ## The forgettable part is inside, on purpose
 *
 * A graph that resolves nothing makes every caller pass on an empty set, and that is exactly how this
 * stayed hidden for a release. {@link routerMounts} THROWS below a floor rather than returning a thin map,
 * so a caller cannot receive the failure quietly.
 */
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/**
 * The mount graph, resolved from the sources.
 *
 * Returns `{ prefixOf, isMounted, aliasOf }`:
 *
 *  - `prefixOf(name)` — the path its routes hang under, or `undefined` if nothing mounts it. An empty
 *    string is a real answer (a router mounted at the app root), so test with `!== undefined`.
 *  - `isMounted(name)` — reachable from the app at all.
 *  - `aliasOf(name)` — for a function parameter, the router every call site passes it.
 *
 * @param {{roots?: string[], floor?: number}} [opts] `floor` is the fewest routers that may resolve before
 *   this throws. Raise it, never lower it.
 */
export function routerMounts({ roots = ['server/src'], floor = 25 } = {}) {
  const sources = trackedSources(roots, { floor: 50 });
  const texts = new Map(sources.map(f => [f, stripComments(readFileSync(f, 'utf8'))]));

  const edges = [];
  const aliases = new Map();

  for (const src of texts.values()) {
    // 1. `parent.use('/prefix', child)`
    for (const m of src.matchAll(/\b(\w+)\.use\(\s*'([^']*)'\s*,\s*(\w+)/g)) {
      edges.push({ parent: m[1], prefix: m[2], child: m[3] });
    }
    // 2. `parent.use(child)` — no prefix of its own.
    for (const m of src.matchAll(/\b(\w+)\.use\(\s*(\w+Router)\s*\)/g)) {
      edges.push({ parent: m[1], prefix: '', child: m[2] });
    }
  }

  // 3. A function that registers routes onto the router it is handed. Bind its PARAMETER to whatever the
  //    call sites pass — and only when they all pass the same one, because two callers would make one
  //    parameter mean two prefixes, and a guess there is worse than the gap it fills.
  for (const src of texts.values()) {
    for (const m of src.matchAll(/(?:export )?function (\w+)\(\s*(\w+)\s*:\s*Router/g)) {
      const [, fn, param] = m;
      const callers = [];
      for (const other of texts.values()) {
        for (const c of other.matchAll(new RegExp(`\\b${fn}\\(\\s*(\\w+)\\s*\\)`, 'g'))) callers.push(c[1]);
      }
      if (callers.length && callers.every(c => c === callers[0])) {
        aliases.set(param, callers[0]);
        edges.push({ parent: callers[0], prefix: '', child: param });
      }
    }
  }

  // Mounts nest (`app` → `brainRouter` → `searchRouter`) and file order says nothing about the depth, so
  // walk to a fixed point rather than once.
  const at = new Map([['app', '']]);
  for (let pass = 0; pass < 20; pass++) {
    let grew = false;
    for (const e of edges) {
      if (at.has(e.parent) && !at.has(e.child)) { at.set(e.child, at.get(e.parent) + e.prefix); grew = true; }
    }
    if (!grew) break;
  }

  // A resolved graph, or an exception. Never a thin map that every caller loops over and passes.
  const routers = [...at.keys()].filter(k => k !== 'app');
  if (routers.length < floor) {
    throw new Error(`only ${routers.length} routers resolved to a mount point, expected at least ${floor} — `
      + 'the mount scan is wrong, not the code');
  }

  return {
    prefixOf: name => at.get(name),
    isMounted: name => at.has(name),
    aliasOf: name => aliases.get(name),
    /** Every mounted router, for a caller that wants to assert over the set. */
    mounted: () => routers.slice(),
  };
}
