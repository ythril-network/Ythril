/**
 * Who may remove a space from a network.
 *
 * ## The rule, and why leaving is the guarded direction
 *
 * Owner decision, 2026-08-09. Under the Networks column a token at **write** may join a network and may
 * leave one **it joined itself**. Removing a membership that another token established requires **admin**.
 *
 * That is the opposite of the instinct — surely stopping data leaving should be easy? It is not, and the
 * reason is that leaving does not stop anything retroactively: peers keep every record they already hold.
 * So "leave quickly to stop a leak" was never available. What leaving DOES do is dismantle somebody else's
 * topology: a publisher leaving strands its subscribers, a braintree parent leaving orphans its subtree.
 * One token quietly undoing another's deliberate join is the real hazard, and it is the one this guards.
 *
 * ## Unknown origin fails closed
 *
 * Every membership that predates `spaceOrigins` has no recorded establisher. Such a membership cannot be
 * proved to be yours, so it needs the admin rung. The alternative — treating unknown as "probably fine" —
 * would make the guard useless on exactly the memberships that have existed longest and are load-bearing
 * for the most peers.
 *
 * The cost of failing closed is a token being told to ask someone. The cost of failing open is a topology
 * dismantled by a token that was never meant to be able to.
 */

import type { Rung } from '../config/rights-shape.js';


export interface LeaveRequest {
  /** `spaceId` -> id of the token that established the membership. Absent entries are unknown. */
  origins: Record<string, string> | undefined;
  spaceId: string;
  /** The id of the token asking to leave. */
  tokenId: string;
  /**
   * This token's `networks` rung for this space — the standard four since F-34 gave Networks its column: `write`
   * may leave a membership it established, `admin` may leave any. (They were `out` and `leave` before.)
   */
  rung: Rung;
}

export type LeaveVerdict =
  | { allowed: true; because: 'admin-rung' | 'own-membership' }
  | { allowed: false; because: 'insufficient-rung' | 'not-your-membership' | 'origin-unknown' };

/**
 * Decide a leave request. Pure: no config, no database, no clock.
 *
 * Order matters and is deliberate — `admin` short-circuits before the ownership check, so an admin never
 * needs an origin record to act. Checking ownership first would make the admin rung depend on data that is
 * absent for every pre-existing membership, which is precisely the case the admin rung exists to unblock.
 */
export function mayLeaveNetwork(req: LeaveRequest): LeaveVerdict {
  if (req.rung === 'admin') return { allowed: true, because: 'admin-rung' };
  if (req.rung !== 'write') return { allowed: false, because: 'insufficient-rung' };

  const establisher = req.origins?.[req.spaceId];
  if (establisher === undefined) return { allowed: false, because: 'origin-unknown' };
  if (establisher !== req.tokenId) return { allowed: false, because: 'not-your-membership' };
  return { allowed: true, because: 'own-membership' };
}

/**
 * Record who established a membership, returning a NEW map.
 *
 * Returns a copy rather than mutating, so a caller cannot half-apply it: writing the origin and then failing
 * to persist the network would otherwise leave the map claiming an establisher for a membership that does
 * not exist.
 */
export function recordOrigin(
  origins: Record<string, string> | undefined,
  spaceId: string,
  tokenId: string,
): Record<string, string> {
  return { ...(origins ?? {}), [spaceId]: tokenId };
}

/**
 * Drop a membership's origin when the membership goes.
 *
 * Without this, a space removed and later re-added by a DIFFERENT token would inherit the first token's
 * claim — and that token could then leave a membership it never made. A stale entry here is not inert; it is
 * a permission.
 */
export function forgetOrigin(
  origins: Record<string, string> | undefined,
  spaceId: string,
): Record<string, string> | undefined {
  if (!origins || !(spaceId in origins)) return origins;
  const copy = { ...origins };
  delete copy[spaceId];
  return Object.keys(copy).length > 0 ? copy : undefined;
}
