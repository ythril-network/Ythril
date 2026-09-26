/**
 * Does this token reach a space at all?
 *
 * ## Why this exists before the guard uses it
 *
 * `enforceSpaceScope` currently answers the question from the legacy `spaces` allowlist. The rights matrix
 * answers it from `floor` and `perSpace`. Switching the guard from one to the other is the single change in
 * this feature where a mistake is SILENT WIDENING — a token reaching a space it never could, with no error
 * and nothing in the response to say so.
 *
 * So the replacement lands first, as a pure function, next to a test that asserts it agrees with the legacy
 * rule for every token shape. Only once the two provably answer the same question does the guard move onto
 * it. Behaviour changes when the guard changes; nothing here changes anything.
 *
 * ## Space-level, not area-level, and deliberately so
 *
 * The guard's question is "may this token touch this space at all". Area granularity comes from the route
 * inventory (`space-rights.ts`) and is a LATER step: wiring both at once means a defect in either reads as a
 * defect in the other, and the failure mode of the pair is the one nobody sees.
 */
import type { TokenRights } from '../config/rights-shape.js';
// The ONE list. This module kept its own copy of the four names, in the same file that decides whether a
// token may touch a space at all — so a fifth area would have been invisible to the reach check while every
// other reader saw it (`Q-6`, 2026-09-07).
import { SPACE_AREAS as AREAS } from '../config/rights-shape.js';
import { administers } from './mint-cap.js';

/**
 * True when the token holds ANY rung above `none` in this space — via its floor or its explicit row.
 *
 * Both are consulted. A floor reaches spaces with no row at all, which is exactly how an unscoped token is
 * represented, and a row can raise a space above the floor.
 */
export function reachesSpace(rights: TokenRights, spaceId: string): boolean {
  // A space admin reaches the spaces it administers, by floor or by name, with or without area rows: the grant
  // resolves to every rung there (`grantedRung`). Reading only rows and the area floor made a space admin with
  // no rows reach nothing — including an instance admin, whose grant is the space-admin floor (S-11).
  if (administers(rights, spaceId)) return true;
  const row = rights.perSpace[spaceId];
  // `?? 'none'`: a key the stored row does not carry is NO rung. Compared bare, `undefined !== 'none'` read a missing
  // area as reach — which is what adding an area (F-34) did to every matrix stored before it, until repaired.
  if (row && AREAS.some(a => (row[a] ?? 'none') !== 'none')) return true;
  const floor = rights.floor;
  return !!floor && AREAS.some(a => (floor[a] ?? 'none') !== 'none');
}

/**
 * Every space on this instance the token reaches at all — the CEILING any per-area check narrows from.
 *
 * Extracted at the second site, which is the threshold: the MCP router built this list inline and a
 * body-scoped REST route needed the identical one. A third hand-written copy is how one door ends up
 * reaching a space the other does not, and the last time this rule had two implementations MCP answered
 * from `tokenSpaces` while HTTP used `reachesSpace` — two surfaces, one rule, the weaker one reachable.
 *
 * **Reach is not permission.** This says which spaces exist for this token, never what it may do in them;
 * the area rung is a separate question and asking only this one is the mistake it is easy to make, because
 * the answer looks like an authorisation result. A caller with no matrix reaches NOTHING, not everything.
 */
export function reachableSpaceIds(rights: TokenRights | undefined, allSpaceIds: readonly string[]): string[] {
  if (!rights) return [];
  return allSpaceIds.filter(id => reachesSpace(rights, id));
}
