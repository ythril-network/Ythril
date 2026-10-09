/**
 * Which peers may be asked about a space, and through which network: the one resolver.
 *
 * ## What it prevents
 *
 * A file row's `syncBase.<peer>` outlives everything around it — the network the bytes crossed on may have been left, the space
 * taken out of it, the peer removed. A caller that resolved "the peer" from that key alone would spend a member's token on a
 * network that no longer shares the space: an outbound call nobody authorised for THIS space, and a question to a peer that may
 * no longer be entitled to answer it. So the resolution goes only through the networks that CURRENTLY carry the space
 * (`networksHolding`), and a second resolver — which could disagree with this one — has no reason to exist.
 *
 * ## The answer
 *
 * `peersCarryingSpace(spaceId, peerId)`: one entry per network that carries `spaceId` and has `peerId` as a member, ascending by
 * network id — the order a caller tries them in, whatever order the configuration lists the networks in. `remoteSpaceId` is the
 * network's own id for the space (`spaceMap`), which is what a peer is asked by. A peer in no such network gives `[]`.
 *
 * Which of several networks to use is the CALLER's decision (it knows what it needs and what failed); the order is this module's,
 * so two callers cannot try them in two orders.
 */
import { getConfig } from '../config/loader.js';
import type { NetworkMember } from '../config/types.js';
import { networksHolding } from '../spaces/wipe-vote.js';
import { localToRemote } from './space-map.js';

export interface PeerForSpace {
  member: NetworkMember;
  networkId: string;
  /** The network's id for the space: what the peer's sync routes are asked by. */
  remoteSpaceId: string;
}

/** Network ids ascending, by code unit — the order a caller tries them in. */
const byNetworkId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The networks through which `peerId` may be asked about `spaceId`, ascending by network id. Only networks that currently carry
 * the space; a network the peer is a member of but that does not carry it contributes nothing.
 */
export function peersCarryingSpace(spaceId: string, peerId: string): PeerForSpace[] {
  const out: PeerForSpace[] = [];
  for (const net of [...networksHolding(spaceId, getConfig())].sort(byNetworkId)) {
    const member = net.members.find(m => m.instanceId === peerId);
    if (member) out.push({ member, networkId: net.id, remoteSpaceId: localToRemote(net, spaceId) });
  }
  return out;
}

/** The instance ids of every member of every network that currently carries `spaceId`, ascending and without repeats. */
export function peerIdsCarryingSpace(spaceId: string): string[] {
  const ids = new Set<string>();
  for (const net of networksHolding(spaceId, getConfig())) for (const m of net.members) ids.add(m.instanceId);
  return [...ids].sort();
}
