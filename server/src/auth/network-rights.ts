/**
 * May this token act on a network? The Networks column (`F-34`), for the acts on a network's SPACES.
 *
 * Owner decision 2026-08-09, confirmed 2026-09-24 (A): a token at `networks: write` may create a network with a
 * space and leave a membership it established; leaving one another token established needs `networks: admin`.
 * Before the column, every network route was instance-admin, so nobody below it could do either.
 *
 * ## A network is only as permitted as its least-permitted space
 *
 * A network carries SEVERAL spaces, and every one of them is shared with its peers. So an act on it needs the
 * rung on EVERY space it carries: holding it on two of three would let a token put the third into a network it
 * was never allowed to share — or take it out of one. The refusal names each space that is short, so one
 * answer says everything to fix.
 *
 * ## Seeing a network, and changing its settings
 *
 * The same rule read the other way. A network is visible to a token that holds `networks: read` on every space it
 * carries — listed, and readable by id — and invisible otherwise: a 404, never a 403, because a refusal that
 * says "forbidden" has told the caller the network exists. Its settings (label, schedule, signed votes) are
 * shared by every space it carries, so changing them needs `networks: admin` on every one. `GET /api/networks`
 * and MCP `network_peers` read `visibleNetworks`, so the two doors show the same networks.
 *
 * ## What stays instance-admin, deliberately
 *
 * Votes, topology, peer members, signing keys, invites and sync are acts on the network as a whole, not on a
 * space's membership of it.
 *
 * ## Joining a remote network (F-34.1)
 *
 * The remote network's space list arrives in the handshake's APPLY step, before anything is written locally and
 * before FINALIZE — so the check runs in that gap (`networkJoinRefusal`). Refused there, the handshake is simply
 * never finalized, and the token apply created on the inviter expires with the handshake.
 *
 * An instance admin passes both, as it always did.
 */
import type { TokenRights } from '../config/rights-shape.js';
import { isInstanceAdmin } from './instance-admin.js';
import { holdsRung } from './reachable-spaces.js';
import { effectiveRung } from './mint-cap.js';
import { mayLeaveNetwork, type LeaveVerdict } from './network-membership.js';

type Caller = Parameters<typeof isInstanceAdmin>[0] & { id?: string; rights?: TokenRights };

/** Why this token may not create a network carrying `spaces`, or `null` when it may. */
export function networkCreateRefusal(caller: Caller, spaces: string[]): string | null {
  if (isInstanceAdmin(caller)) return null;
  const short = spaces.filter(s => !caller.rights || !holdsRung(caller.rights, s, 'networks', 'write'));
  if (!short.length) return null;
  return `Creating a network with a space needs 'write' on networks for EVERY space it carries; this token is short on: `
    + `${short.join(', ')}. A network is shared with every peer, so it is only as permitted as its least-permitted space.`;
}

const LEAVE_REASON: Record<Exclude<LeaveVerdict, { allowed: true }>['because'], string> = {
  'insufficient-rung': "needs 'write' on networks (its own membership) or 'admin' (any)",
  'not-your-membership': "was established by another token — leaving it needs 'admin' on networks",
  'origin-unknown': "has an unknown establisher (the membership predates the record), so leaving it needs 'admin' on networks",
};

/** Why this token may not take `net`'s spaces out of it, or `null` when it may. */
export function networkLeaveRefusal(
  caller: Caller,
  net: { spaces: string[]; spaceOrigins?: Record<string, string> | undefined },
): string | null {
  if (isInstanceAdmin(caller)) return null;
  const refused = net.spaces.flatMap(spaceId => {
    const rung = caller.rights ? effectiveRung(caller.rights, spaceId, 'networks') : 'none';
    const v = mayLeaveNetwork({ origins: net.spaceOrigins, spaceId, tokenId: caller.id ?? '', rung });
    return v.allowed ? [] : [`'${spaceId}' ${LEAVE_REASON[v.because]}`];
  });
  return refused.length ? `This token may not leave the network: ${refused.join('; ')}.` : null;
}

/** Does this token hold `needs` on networks for EVERY space `net` carries? Instance admin always does. */
function holdsOnEvery(caller: Caller, net: { spaces: string[] }, needs: 'read' | 'write' | 'admin'): boolean {
  if (isInstanceAdmin(caller)) return true;
  return !!caller.rights && net.spaces.every(s => holdsRung(caller.rights!, s, 'networks', needs));
}

/** The networks this token may see: `networks: read` on every space each carries. One filter for both doors. */
export function visibleNetworks<N extends { spaces: string[] }>(caller: Caller, networks: N[]): N[] {
  return networks.filter(n => holdsOnEvery(caller, n, 'read'));
}

/** Why this token may not change `net`'s settings, or `null` when it may — `networks: admin` on every space. */
export function networkSettingsRefusal(caller: Caller, net: { spaces: string[] }): string | null {
  if (holdsOnEvery(caller, net, 'admin')) return null;
  return "Changing a network's settings needs 'admin' on networks for every space it carries: they are shared by all of them.";
}

/**
 * Why this token may not join a remote network whose spaces map to `existing` local spaces and would CREATE
 * `toCreate`, or `null` when it may. An existing space needs `networks: write`; a space the join creates needs
 * `createSpaces` and `networks: write` from the FLOOR — it has no row yet, so the floor is the only rung it can hold.
 */
export function networkJoinRefusal(caller: Caller, spaces: { existing: string[]; toCreate: string[] }): string | null {
  if (isInstanceAdmin(caller)) return null;
  const rights = caller.rights;
  const short = spaces.existing.filter(s => !rights || !holdsRung(rights, s, 'networks', 'write'));
  const reasons: string[] = [];
  if (short.length) reasons.push(`'write' on networks is short on: ${short.join(', ')}`);
  if (spaces.toCreate.length) {
    if (!rights?.createSpaces) reasons.push(`the join would create ${spaces.toCreate.join(', ')}, and this token may not create spaces (createSpaces)`);
    else {
      const noFloor = spaces.toCreate.filter(s => !holdsRung(rights, s, 'networks', 'write'));
      if (noFloor.length) reasons.push(`the join would create ${noFloor.join(', ')}, which needs a floor of 'write' on networks — a new space has no row`);
    }
  }
  return reasons.length ? `This token may not join the network: ${reasons.join('; ')}.` : null;
}
