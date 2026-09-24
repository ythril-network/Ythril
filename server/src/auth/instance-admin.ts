/**
 * Is this token an instance administrator? The MATRIX decides, with the legacy flag as the fallback.
 *
 * ## One predicate, because it used to be seven
 *
 * `enforceAdmin`, `enforceAdminOrSpaceAdmin`, the scoped guard, the peer-relay check in `notify`, the
 * trusted-relay check in `sync/tombstones`, the `maxGiB` carve-out and the last-admin lockout guard each
 * read `record.admin` their own way. Seven copies of one authorization question, where a copy that drifts
 * means a token reaching a route it never could — with no error and nothing in the response to say so.
 *
 * ## Why it lives in its own module rather than in `middleware.ts`
 *
 * `mcp/oauth.ts` needs it to stamp an identity, and `middleware.ts` already imports `mcpResourceMetadataUrl`
 * from `mcp/oauth.ts`. Putting the predicate in the middleware closed that loop — `no-runtime-import-cycles`
 * caught it, and it was right: in ESM a cycle is legal until one side reads a binding during evaluation, at
 * which point it is `undefined` and the failure lands far from the cause.
 *
 * The predicate depends on nothing but the rights shape, so it has no business living in either file.
 *
 * ## The fallback is load-bearing
 *
 * A record with no matrix falls back to the legacy boolean. An OIDC session is built per request from a claim
 * mapping and legitimately carries no matrix, while every PAT has one — `createToken` always writes it and a
 * boot migration backfills the rest. Dropping the fallback would be a silent NARROWING: every OIDC admin
 * would lose access, which is the opposite failure and just as bad.
 *
 * ## The two provably agree
 *
 * `rights-migration-never-widens.test.js` exercises `migrateToken` over the storable legacy shapes, and the
 * mint route refuses `admin` as an input so a divergent pair cannot be created.
 */
import type { TokenRights } from '../config/rights-shape.js';

export function isInstanceAdmin(
  // Structural, and deliberately NOT `Pick<TokenRecord, 'admin'>`: the field is gone from that type, and a
  // signature naming it would have to change again the day the OIDC record drops it too. What this reads is
  // a matrix, with a legacy boolean as the fallback — so that is what it asks for.
  record: { admin?: boolean; rights?: TokenRights | null },
): boolean {
  const rights = record.rights;
  if (rights) return rights.instanceAdmin === true;
  return record.admin === true;
}
