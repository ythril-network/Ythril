/**
 * Write `spaceAdmin` for every token that administered a space under the OLD rule, once, on boot.
 *
 * ## Why an upgrade needs this
 *
 * Until 5.0, administering a space WAS holding `admin` in its four areas — `isSpaceAdminFor` computed
 * exactly that. From 5.0 the two are not the same: `spaceAdmin` is its own grant, it INCLUDES the four
 * rungs, and the four rungs do not add up to it. Owner, 2026-09-16: *"Space admin is more than the four
 * area admin rungs. It must be its own"*.
 *
 * That is the right model, and it silently removes access from every existing token if nothing runs. A
 * token holding four admin rungs manages its space's tokens and settings TODAY. After the upgrade the
 * predicate reads the flag, the flag is absent, and an operator finds they can no longer mint a token for
 * a space they administer — with no error to explain it, because nothing failed. The rule changed.
 *
 * **So this is not migrating data into a new shape. It is preserving a decision somebody already made.**
 * Those tokens were administrators under the rule in force when they were granted, and an upgrade is not
 * the moment to reinterpret that.
 *
 * ## Why this may be a BOOT migration when synced data may not
 *
 * Tokens are local: they live in this instance's config and never replicate, so there is no peer to write
 * the old shape back and no lazy path to prefer. The rule against boot-migrating synced content does not
 * reach them.
 *
 * ## What it deliberately does NOT do
 *
 * **A floor of all-admin migrates to the FLOOR form, not to a list of today's spaces.** That token
 * administered every space including ones created later, and enumerating the spaces that happen to exist
 * at upgrade time would freeze a list that was never a list. This is the canary operator's shape — `Q-12`
 * — and turning it into a list would have quietly stopped them administering every space created after
 * the upgrade.
 *
 * Idempotent: a token already carrying the flag for a space is left alone.
 */
import type { TokenRecord } from './types.js';
import { SPACE_ADMIN_AREAS } from './rights-shape.js';
import { log } from '../util/log.js';

export interface SpaceAdminGrantOutcome {
  /** `token label → spaces it gained`, for a log line an operator can act on. */
  granted: { token: string; spaces: string[] }[];
}

/**
 * Rewrite in place, and report what was granted so the caller can log and persist it.
 *
 * Takes the tokens rather than the whole config so it can be exercised without a file on disk: the shape
 * it touches is the subject, and a test that has to write a config to check a grant is testing the loader.
 */
export function migrateSpaceAdminGrant(tokens: TokenRecord[] | undefined): SpaceAdminGrantOutcome {
  const out: SpaceAdminGrantOutcome = { granted: [] };

  for (const token of tokens ?? []) {
    const rights = token.rights;
    if (!rights?.perSpace) continue;

    const already = new Set(rights.spaceAdmin?.spaces ?? []);
    const floorAdmin = rights.spaceAdmin?.floor
      || SPACE_ADMIN_AREAS.every(area => rights.floor?.[area] === 'admin');
    const earned: string[] = [];
    for (const [spaceId, rungs] of Object.entries(rights.perSpace)) {
      if (already.has(spaceId)) continue;
      /*
       * THE OLD PREDICATE, WRITTEN OUT. Not `isSpaceAdminFor`, which now answers the NEW question — calling
       * it here would ask whether the flag is already set and migrate nothing, while looking exactly like
       * the right thing to call.
       */
      if (SPACE_ADMIN_AREAS.every(area => (rungs as Record<string, string>)[area] === 'admin')) {
        earned.push(spaceId);
      }
    }
    const gainsFloor = floorAdmin && !rights.spaceAdmin?.floor;
    if (earned.length === 0 && !gainsFloor) continue;

    rights.spaceAdmin = { floor: floorAdmin, spaces: [...already, ...earned] };
    out.granted.push({ token: token.id, spaces: gainsFloor ? ['(every space, by floor)', ...earned] : earned });
  }

  if (out.granted.length > 0) {
    const pairs = out.granted.reduce((n, g) => n + g.spaces.length, 0);
    log.info(`Space admin is its own grant at 5.0. Wrote it for ${pairs} (token, space) pair(s) across `
      + `${out.granted.length} token(s) that held admin on all four areas: `
      + `${out.granted.map(g => `${g.token} [${g.spaces.join(', ')}]`).join('; ')}. Under the previous rule `
      + 'those tokens administered those spaces, and the upgrade must not take that away silently.');
  }
  return out;
}
