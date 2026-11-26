/**
 * Who may decide a vote round on this network: on pub/sub the publisher alone, and on no network a round of a kind its type never opens (Q-968).
 *
 * ## What it prevents
 *
 * The pub/sub pass rule was "any yes and no veto", so a subscriber's own yes passed its own schema round, and the publisher adopted the round
 * and passed it on that same yes: one subscriber admin changed the network's schema for every member. The same rule let a subscriber serve a
 * forged join, removal or space addition the publisher passed, and on a club any member could serve a removal that ejected another member
 * everywhere, although neither type ever opens a join or a removal round (a club or pub/sub admits and removes members directly).
 *
 * Both answers are read from LOCAL topology and the round's kind, never from a field a peer wrote: the round's subject, its proposer field and
 * its `requiredVoters` all travel and can be forged. The guard is inside: with no single publisher derivable, `pubsubDecider` answers `null`,
 * and a caller that counts only the decider's cast then passes nothing.
 */
import type { NetworkConfig, NetworkType, VoteRoundType } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { publishesOn } from './network-role.js';

/**
 * The instance whose cast alone decides a round on the pub/sub network `net`: this instance when it publishes, otherwise the one member it pulls
 * from (`direction: 'pull'`). `null` when there is not exactly one such member, or when `net` is not pub/sub: then nobody decides and nothing passes.
 */
export function pubsubDecider(net: NetworkConfig, selfId: string = getConfig().instanceId): string | null {
  if (net.type !== 'pubsub') return null;
  if (publishesOn(net)) return selfId;
  const upstream = net.members.filter(m => m.direction === 'pull');
  return upstream.length === 1 ? upstream[0]!.instanceId : null;
}

/**
 * The round kinds each network type never opens. A club and a pub/sub network admit and remove members directly (`member-acts.ts`, `invite.ts`),
 * and a pub/sub network adds a space directly too (`ADD_SPACE_POSITION` in `network-acts.ts`: the publisher adds, the subscribers learn it from the
 * announcement), so such a round can only be a peer's forgery: it is never adopted (`adoptionRefusal`) and, held, never passes (`roundVerdict`).
 * The record type makes a new network type name its row.
 */
export const ROUND_KINDS_NEVER_OPENED: Readonly<Record<NetworkType, readonly VoteRoundType[]>> = {
  pubsub: ['join', 'remove', 'space_addition'],
  club: ['join', 'remove'],
  closed: [],
  democratic: [],
  braintree: [],
};

/** Is `kind` a round kind `net`'s type never opens? An unknown type opens nothing the table names. */
export function roundKindNeverOpenedOn(net: Pick<NetworkConfig, 'type'>, kind: unknown): boolean {
  const never = ROUND_KINDS_NEVER_OPENED[net.type] as readonly string[] | undefined;
  return typeof kind === 'string' && (never ?? []).includes(kind);
}
