/**
 * The push doors the counter gate asks about, derived through the call graph — one copy for the pure cases and the database cases (Q-969).
 *
 * `no-push-door-moves-the-counter.test.js` holds that the doors are found, each has a case and none reaches the counter's raiser, and needs no
 * database; `no-push-door-moves-the-counter-db.test.js` sends a page to each door over a counter that will not move. Both read these doors, and
 * `CASE_PATHS` is the list of doors the database file has a case for: the pure file holds every derived door to it, the database file holds its
 * own table to it, so a door mounted next month is found by the local preflight.
 *
 * Imports no database harness: a module that did would make its pure caller a database file (`splitStandalone`).
 */
import { moduleIndex, routeHandlerRoots, walkFrom } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { SERVER_CODE_ROOTS } from './_sources.mjs';

/** The counter's one raiser: the function no push door may reach. */
export const RAISE = 'server/src/util/version-stamp.ts:raiseVersionTo';

export const INDEX = moduleIndex(SERVER_CODE_ROOTS);
/** The two writers of what a peer delivers: a page of records (`sync/arrivals.ts`) and a page of tombstones (`sync/tombstone-apply.ts`). */
export const ARRIVAL_WRITERS = ['server/src/sync/arrivals.ts:writeArrivals', 'server/src/sync/tombstone-apply.ts:applyPeerTombstones'];
/** The push doors: the POST routes of the sync surface whose handler reaches an arrival writer (closures followed). */
function pushDoors() {
  return mountedRoutes()
    .filter(r => r.method === 'POST' && r.file.startsWith('server/src/api/sync/'))
    .map(r => ({ path: r.path, routePath: r.routePath, file: r.file, roots: routeHandlerRoots(INDEX, r) }))
    .filter(d => ARRIVAL_WRITERS.some(w => walkFrom(INDEX, d.roots, { closures: true }).seen.has(w)));
}
export const DOORS = pushDoors();

/** The doors the database file has a case for (the keys of its `CASES`, by the route as the router declares it). */
export const CASE_PATHS = ['/facts', '/entities', '/edges', '/chrono', '/batch-upsert', '/tombstones'];
