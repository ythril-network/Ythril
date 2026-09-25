/**
 * How the Networks page presents THIS instance's role in a network (`F-38.1`) — pure functions, beside the page
 * rather than inside it, so the role logic is testable on its own and the page stays within its size.
 *
 * The role itself is decided by the server (`networks/network-role.ts`) and arrives as `myRole`; nothing here
 * re-derives it. This only turns it into what the card shows.
 */
import type { Network, NetworkMember } from '../../core/api.types';
import type { NetworkRole } from '../../core/network-role.types';

/** The count the header shows for this role, or null when the role shows none (a subscriber, a lone root). */
export function roleCountKey(r: NetworkRole): string | null {
  if (r.role === 'publisher') return 'networks.role.count.subscribers';
  if (r.role === 'subscriber') return null;
  if (r.role === 'root' || r.role === 'node' || r.role === 'leaf') return r.members.length ? 'networks.role.count.below' : null;
  return 'networks.role.count.peers';
}

/** The network space a local space was mapped from on join, when it differs from the local id. */
export function remoteOf(net: Network, local: string): string | null {
  const hit = Object.entries(net.spaceMap ?? {}).find(([remote, l]) => l === local && remote !== local);
  return hit ? hit[0] : null;
}

/**
 * The member lists this instance's role acts on. A publisher sees its subscribers, a subscriber only its publisher,
 * a club or voted network its peers, a tree node the path to the root and what is below it. Without a role (an older
 * server) every member is listed, as before.
 */
export function memberGroups(net: Network): { titleKey: string; members: NetworkMember[]; emptyKey?: string }[] {
  const r = net.myRole;
  const pick = (ids: string[] | undefined) =>
    (ids ?? []).map(id => net.members.find(m => m.instanceId === id)).filter((m): m is NetworkMember => !!m);
  if (!r) return [{ titleKey: 'networks.network.members.title', members: net.members }];
  switch (r.role) {
    case 'publisher': return [{ titleKey: 'networks.network.members.subscribers', members: pick(r.members), emptyKey: 'networks.network.members.noSubscribers' }];
    case 'subscriber': return [{ titleKey: 'networks.network.members.publisher', members: pick(r.publisher ? [r.publisher] : []) }];
    case 'root': case 'node': case 'leaf': return [
      { titleKey: 'networks.network.members.pathToRoot', members: pick(r.pathToRoot), emptyKey: 'networks.network.members.isRoot' },
      { titleKey: 'networks.network.members.subtree', members: pick(r.subtree), emptyKey: 'networks.network.members.noneBelow' },
    ];
    default: return [{ titleKey: 'networks.network.members.peers', members: pick(r.members) }];
  }
}
