import { SPACE_AREAS, type TokenRights } from '../config/rights-shape.js';
import { satisfies } from './required-rung.js';

/**
 * Can this token write AT ALL — any area, any space?
 *
 * ## What it replaces, and the shape of the mistake it is easy to make here
 *
 * `denyReadOnly` used to answer this off the `readOnly` boolean, and that flag had **no area and no space**:
 * it meant "no writes, anywhere, in anything". The first version of this helper took an `area` parameter and
 * the middleware passed `'dataQuality'`, because the routes I had traced were the conflicts / contradictions
 * / duplicates ones. It is also on **eight brain route files**, where a `knowledge: write` token was then
 * refused for lacking a dataQuality rung it never needed. CI caught it; the point is that parameterising a
 * guard on an axis its predecessor did not have is how a replacement quietly becomes a different rule.
 *
 * So: no area, deliberately. The per-area precision is `enforceAreaRung`'s job and it already runs on every
 * space-scoped route. This one answers the coarse question its callers actually ask — "is this token allowed
 * to mutate at all" — and answers it the way the flag did.
 *
 * ## Why it reproduces the old answer rather than inventing a new policy
 *
 * `migrateToken` turned `readOnly: true` into a `read` rung, as the floor for an unscoped token or per-space
 * for a scoped one. So "holds write in some area somewhere" is the same predicate expressed against the
 * matrix: every token the migration produced answers here exactly as it answered before, which is pinned in
 * `write-anywhere-matches-readonly.test.js` shape by shape.
 *
 * ## What it is NOT
 *
 * It is not authorization for a specific record, space or area. A route that NAMES a space must go through
 * `enforceAreaRung` — this one would let a token scoped to space A mutate through a route touching space B,
 * which is why there is a gate that no route carrying it names a `:spaceId` outside the space-scoped guard.
 */
export function canWriteAnywhere(rights: TokenRights | undefined): boolean {
  // No matrix at all: refuse. Every PAT stores one (`createToken` always writes it, and a boot migration
  // backfills the rest) and every OIDC record derives one, so this is not a live path — and if a record
  // shape ever appears that has none, refusing a MUTATION is the safe direction. The old code's equivalent
  // was `readOnly` being absent, which read as "writable", and that default is how an unscoped token stored
  // as `null` ended up reaching everything.
  if (!rights) return false;

  if (rights.instanceAdmin) return true;
  // Administering a space IS `admin` in every data area of it (`grantedRung`), with no rung written anywhere, so a
  // token holding only the grant read as read-only here and every `denyReadOnly` route refused it.
  if (rights.spaceAdmin && (rights.spaceAdmin.floor || rights.spaceAdmin.spaces.length > 0)) return true;

  const floor = rights.floor;
  if (floor && SPACE_AREAS.some(a => satisfies(floor[a], 'write'))) return true;
  return Object.values(rights.perSpace).some(areas => SPACE_AREAS.some(a => satisfies(areas[a], 'write')));
}
