/**
 * What granting instance admin writes onto a token: space admin on the FLOOR.
 *
 * Owner, 2026-09-26: *"instance admin inherits each and every right on the whole instance automatically"*, and
 * *"instance admin does not IMPLY, it grants, it sets the rung — as a floor so it covers new spaces as well"*.
 * A space admin already holds every area rung on the spaces it administers (`administers` → `grantedRung` in
 * `mint-cap.ts`), so a space-admin floor gives an instance admin every right on every space, including spaces
 * created after the grant, with no second rule anywhere.
 *
 * ## Why it is written, not read
 *
 * Deriving it at read time would make the stored matrix lie about what the token holds: the tokens page, the
 * audit log's rights diff and every export would show a token without the grant it has. So it is STORED, and
 * this is the one statement of it. Every write of a token's rights applies it — `createToken`, the OAuth mint
 * and `setTokenRights` in `tokens.ts`, gated by `every-minted-token-has-rights.test.js` — and
 * `config/migrate-instance-admin-floor.ts` repairs instance admins stored without it.
 *
 * Seen live without it (ythril-home, 2026-09-26): an instance-admin token with rows for one space got 403 on
 * three spaces a network had just created, and could not widen itself.
 */
import type { TokenRights } from '../config/rights-shape.js';

/** The rights as they must be stored: an instance admin always carries the space-admin floor. */
export function withInstanceAdminGrants<R extends TokenRights | null | undefined>(rights: R): R {
  if (!rights || rights.instanceAdmin !== true || rights.spaceAdmin?.floor === true) return rights;
  return { ...rights, spaceAdmin: { floor: true, spaces: [...(rights.spaceAdmin?.spaces ?? [])] } };
}
