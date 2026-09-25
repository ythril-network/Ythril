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
import { administers } from './mint-cap.js';
import { administersAnySpace } from './editor-scope.js';

type Caller = Parameters<typeof isInstanceAdmin>[0] & { id?: string; rights?: TokenRights };

/**
 * May this token share `space` with a network it is creating or joining? `networks: write` on it, or administering
 * it (`F-37`, owner 2026-09-25: *"Space admin may create networks for his space and join network mapped onto his
 * space"*). Its own function rather than a widening of `SPACE_ADMIN_AREAS`: that would hand a space admin every
 * Networks act — votes, members, settings — where the owner granted these two.
 */
function mayShare(caller: Caller, space: string): boolean {
  return !!caller.rights && (holdsRung(caller.rights, space, 'networks', 'write') || administers(caller.rights, space));
}

/** Why this token may not create a network carrying `spaces`, or `null` when it may. */
export function networkCreateRefusal(caller: Caller, spaces: string[]): string | null {
  if (isInstanceAdmin(caller)) return null;
  const short = spaces.filter(s => !mayShare(caller, s));
  if (!short.length) return null;
  return `Creating a network with a space needs 'write' on networks, or administering it, for EVERY space it carries; this token is short on: `
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
  // Or administering every space it carries (`F-37`): a space admin may create one, so it must be able to see it.
  return networks.filter(n => holdsOnEvery(caller, n, 'read')
    || (!!caller.rights && n.spaces.length > 0 && n.spaces.every(s => administers(caller.rights, s))));
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
  const short = spaces.existing.filter(s => !mayShare(caller, s));
  const reasons: string[] = [];
  if (short.length) reasons.push(`'write' on networks, or administering the space, is short on: ${short.join(', ')}`);
  if (spaces.toCreate.length) {
    if (!rights?.createSpaces) reasons.push(`the join would create ${spaces.toCreate.join(', ')}, and this token may not create spaces (createSpaces)`);
    else if (!administersAnySpace(caller)) {
      // A space admin that may create spaces joins onto new ones (`F-37`); anyone else needs the floor, because a
      // space the join creates has no row yet and the floor is the only rung it can hold.
      const noFloor = spaces.toCreate.filter(s => !holdsRung(rights, s, 'networks', 'write'));
      if (noFloor.length) reasons.push(`the join would create ${noFloor.join(', ')}, which needs a floor of 'write' on networks — a new space has no row`);
    }
  }
  return reasons.length ? `This token may not join the network: ${reasons.join('; ')}.` : null;
}

/**
 * Why this token may not generate an invite into `net`, or `null` when it may (`F-37`).
 *
 * Invites stay instance-admin — except for a token that administers EVERY space the network carries. Without it a
 * space admin could create a network nobody could ever join. The Networks column alone is deliberately not enough:
 * the owner granted this to space administrators, not to the column.
 */
export function networkInviteRefusal(caller: Caller, net: { spaces: string[] }): string | null {
  if (isInstanceAdmin(caller)) return null;
  const short = net.spaces.filter(s => !caller.rights || !administers(caller.rights, s));
  if (!short.length && net.spaces.length) return null;
  return `Inviting into a network needs instance admin, or administering EVERY space it carries; this token does not administer: `
    + `${(short.length ? short : ['(the network carries no space)']).join(', ')}.`;
}

/**
 * Why this token may not add `space` to `net`, or `null` when it may (`F-38.3`).
 *
 * Two questions, because the act touches two things. The ADDED space is shared with every peer from now on, so it
 * needs what sharing a space at create needs (`mayShare`). The NETWORK changes what it carries for every space
 * already in it, which is a change to the network as a whole — `networks: admin` on every space it carries, or
 * administering every one of them, the same as `F-37` asks of an invite.
 */
export function networkAddSpaceRefusal(caller: Caller, net: { spaces: string[] }, space: string): string | null {
  if (isInstanceAdmin(caller)) return null;
  const reasons: string[] = [];
  if (!mayShare(caller, space)) reasons.push(`sharing '${space}' needs 'write' on networks, or administering it`);
  const governs = holdsOnEvery(caller, net, 'admin')
    || (!!caller.rights && net.spaces.length > 0 && net.spaces.every(s => administers(caller.rights, s)));
  if (!governs) reasons.push("changing what the network carries needs 'admin' on networks, or administering, for every space it already carries");
  return reasons.length ? `This token may not add the space: ${reasons.join('; ')}.` : null;
}
