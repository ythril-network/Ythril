/**
 * Which spaces a network carries after it was created, and how the instances below the governing one learn a new
 * one (`F-38.3`).
 *
 * ## Why this exists
 *
 * A network's space list was fixed at create: nothing could add to it, so carrying one more space meant a second
 * network, a second handshake with every member, and a second token per peer. Now the position that governs a
 * pub/sub or braintree network adds it — the publisher, the root — and the instances below learn it from their
 * UPSTREAM through the member exchange they already run every cycle. No new route between peers, no new round.
 *
 * ## Why only from upstream
 *
 * The exchange runs in both directions, so every instance hears every neighbour announce its spaces. Adopting from
 * anyone would let a subscriber put a space into its publisher and, from there, into every other subscriber: a
 * space nobody with the right to add one ever added. `spacesToAdopt` refuses everything but the upstream, and that
 * refusal is the reason it is the one function both receiving sites call.
 *
 * ## Why additive
 *
 * An announcement adds what is missing and never takes a space out. A space leaving a network loses its peers'
 * copies from the sync, which is a governed decision rather than something an absent line in a gossip body may do.
 *
 * ## The token half, which is the half that is easy to forget
 *
 * A peer reaches a space only if the token it presents names it (`spaceAllowed`). Adding the space to the network
 * and not to the tokens gives a network that lists the space and a sync that answers 403 for it, on every cycle,
 * in both directions. So `widenPeerTokens` runs inside both the add and the adoption rather than beside them.
 */
import { getConfig, saveConfig } from '../config/loader.js';
import type { Config, NetworkConfig } from '../config/types.js';
import { migrateToken } from '../auth/rights-migration.js';
import { reachesSpace } from '../auth/space-reach.js';
import { createSpace } from '../spaces/lifecycle.js';
import { localToRemote, remoteToLocal } from '../sync/space-map.js';
import { log } from '../util/log.js';
import { networkRole } from './network-role.js';

/** The shape a space id has everywhere else it is accepted — create, rename, the join's space map. */
const SPACE_ID = /^[a-z0-9-]{1,40}$/;

/** At most this many spaces are adopted from one announcement: a bound on what one peer message may create. */
const MAX_ADOPTED_PER_ANNOUNCE = 50;

/**
 * The instance this one learns the network's spaces from, or `undefined` when nobody is above it: a subscriber's
 * publisher, a tree node's parent. A publisher, a root and every member of a club, closed or democratic network
 * have none — the last three change their spaces by vote, which is not this mechanism.
 */
export function upstreamOf(net: NetworkConfig): string | undefined {
  if (net.type === 'pubsub') return networkRole(net).publisher?.instanceId;
  if (net.type === 'braintree') return net.myParentInstanceId || undefined;
  return undefined;
}

/** The spaces this instance announces for `net`, in the network's ids — a local alias is never what a peer calls it. */
export function announcedSpaces(net: NetworkConfig): string[] {
  return net.spaces.map(s => localToRemote(net, s));
}

/**
 * What an announcement from `fromInstanceId` adds here: each space the upstream carries and this instance does not,
 * with the local id it will be carried under. Nothing when the sender is not the upstream, or the body is not a list
 * of ids a space could have.
 */
export function spacesToAdopt(
  net: NetworkConfig,
  fromInstanceId: string,
  announced: unknown,
): { networkId: string; localId: string }[] {
  if (!Array.isArray(announced) || !fromInstanceId || upstreamOf(net) !== fromInstanceId) return [];
  const out: { networkId: string; localId: string }[] = [];
  for (const id of announced) {
    if (typeof id !== 'string' || !SPACE_ID.test(id)) continue;
    const localId = remoteToLocal(net, id);
    if (net.spaces.includes(localId) || out.some(o => o.localId === localId)) continue;
    out.push({ networkId: id, localId });
    if (out.length >= MAX_ADOPTED_PER_ANNOUNCE) break;
  }
  return out;
}

/**
 * Let every peer token of `net`'s members reach `localIds`, at the rung a peer token is minted with. A token that
 * already reaches a space is left as it is — widening must never narrow a row somebody set by hand.
 */
export function widenPeerTokens(cfg: Config, net: NetworkConfig, localIds: readonly string[]): void {
  const peers = new Set(net.members.map(m => m.instanceId));
  for (const tok of cfg.tokens) {
    if (!tok.peerInstanceId || !peers.has(tok.peerInstanceId) || !tok.rights) continue;
    for (const id of localIds) {
      if (reachesSpace(tok.rights, id)) continue;
      const row = migrateToken({ admin: false, readOnly: false, spaces: [id] }).perSpace[id];
      if (row) tok.rights.perSpace[id] = row as (typeof tok.rights.perSpace)[string];
    }
  }
}

/**
 * Adopt what `fromInstanceId` announced for network `networkId`: create each missing space, add it to the network,
 * and widen the members' tokens to it. Returns the local ids added. Never throws — it runs inside the member
 * exchange, whose other halves (versions, keys, labels) must not be lost to a failure here.
 */
export async function adoptAnnouncedSpaces(networkId: string, fromInstanceId: string, announced: unknown): Promise<string[]> {
  try {
    const net = getConfig().networks.find(n => n.id === networkId);
    if (!net) return [];
    const adopt = spacesToAdopt(net, fromInstanceId, announced);
    if (!adopt.length) return [];
    for (const { localId } of adopt) {
      if (getConfig().spaces.some(s => s.id === localId)) continue;
      await createSpace({ id: localId, label: localId.charAt(0).toUpperCase() + localId.slice(1) });
    }
    // Re-read after the awaits: `createSpace` saved the config, and a stale copy would write that away.
    const cfg = getConfig();
    const fresh = cfg.networks.find(n => n.id === networkId);
    if (!fresh) return [];
    const added = spacesToAdopt(fresh, fromInstanceId, announced).map(a => a.localId);
    if (!added.length) return [];
    fresh.spaces.push(...added);
    widenPeerTokens(cfg, fresh, added);
    saveConfig(cfg);
    log.info(`Network ${networkId}: adopted space(s) ${added.join(', ')} announced by upstream ${fromInstanceId}`);
    return added;
  } catch (err) {
    log.warn(`Network ${networkId}: could not adopt the spaces ${fromInstanceId} announced: ${err}`);
    return [];
  }
}
