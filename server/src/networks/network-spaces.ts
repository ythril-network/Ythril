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
import type { Config, NetworkConfig, VoteRound } from '../config/types.js';
import { migrateToken } from '../auth/rights-migration.js';
import { reachesSpace } from '../auth/space-reach.js';
import { networkJoinRefusal } from '../auth/network-rights.js';
import { withInstanceAdminGrants } from '../auth/instance-admin-grants.js';
import type { TokenRights } from '../config/rights-shape.js';
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
  widenPeerTokensOf(cfg, net.members.map(m => m.instanceId), localIds);
}

/**
 * The same, for named peers rather than a network's members — what a handshake needs, because its peer is not a
 * member yet when a vote holds the join, and its token must still reach the spaces for when the vote passes.
 *
 * Why a handshake needs it at all (`Q-53`): each side keeps ONE token per peer and each handshake replaces it, minted
 * at apply as the networks the pair shared then. Two handshakes between the same pair whose applies both land before
 * either finalize each mint a token without the other network, and whichever is kept leaves that network at 403.
 * Widening EVERY token of the peer once its join is registered makes the one kept reach both, in either order.
 * Wider tokens are not wider access: `spaceAllowed` admits a peer only to the spaces of networks it is a member of.
 */
export function widenPeerTokensOf(cfg: Config, peerIds: readonly string[], localIds: readonly string[]): void {
  const peers = new Set(peerIds);
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
 * Add `entries` to network `networkId` here: create each local space that does not exist, add it to the network,
 * and widen the members' tokens to it. Returns the local ids added. The ONE place a network gains a space after
 * create, whichever mechanism decided it — an upstream's announcement or a passed `space_addition` round — so the
 * token half cannot be left out of one of them.
 *
 * Never throws: both callers run inside a sync exchange or a vote, whose other work must not be lost to this.
 */
export async function addSpacesToNetwork(
  networkId: string,
  entries: readonly { networkId: string; localId: string }[],
  why: string,
): Promise<string[]> {
  try {
    for (const { localId } of entries) {
      if (getConfig().spaces.some(s => s.id === localId)) continue;
      await createSpace({ id: localId, label: localId.charAt(0).toUpperCase() + localId.slice(1) });
    }
    // Re-read after the awaits: `createSpace` saved the config, and a stale copy would write that away.
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === networkId);
    if (!net) return [];
    const added = entries.map(e => e.localId).filter((id, i, all) => !net.spaces.includes(id) && all.indexOf(id) === i);
    if (!added.length) return [];
    for (const e of entries) if (e.localId !== e.networkId && added.includes(e.localId)) (net.spaceMap ??= {})[e.networkId] = e.localId;
    net.spaces.push(...added);
    widenPeerTokens(cfg, net, added);
    saveConfig(cfg);
    log.info(`Network ${networkId}: added space(s) ${added.join(', ')} (${why})`);
    return added;
  } catch (err) {
    log.warn(`Network ${networkId}: could not add space(s) (${why}): ${err}`);
    return [];
  }
}

/**
 * Which announced spaces may be added here, judged by the token that JOINED the network (S-9).
 *
 * Owner, 2026-09-26: *"on joining a network the space definition must come from the token that joins the network,
 * not from the peers."* An announcement is a proposal: each space is adopted only if `net.joinedBy` could have joined
 * it — the same `networkJoinRefusal` the join itself runs — and everything else waits in `pending` with the reason.
 * A local space that already has the id is never adopted this way, whoever joined: joining it would start syncing a
 * space that only shares a name, and only an explicit mapping by the operator may do that. No recorded joiner (a
 * network joined before this existed) or a revoked one adopts nothing.
 */
export function adoptionDecision(
  net: Pick<NetworkConfig, 'joinedBy'>,
  tokens: readonly { id: string; rights?: TokenRights | null; instanceAdmin?: boolean }[],
  localSpaceIds: readonly string[],
  entries: readonly { networkId: string; localId: string }[],
): { adopt: { networkId: string; localId: string }[]; pending: { networkId: string; localId: string; why: string }[] } {
  const joiner = net.joinedBy ? tokens.find(t => t.id === net.joinedBy) : undefined;
  const adopt: { networkId: string; localId: string }[] = [];
  const pending: { networkId: string; localId: string; why: string }[] = [];
  for (const e of entries) {
    if (localSpaceIds.includes(e.localId)) {
      pending.push({ ...e, why: `a local space '${e.localId}' already exists; it joins the network only by an explicit mapping` });
      continue;
    }
    if (!joiner) {
      pending.push({ ...e, why: net.joinedBy ? 'the token that joined this network no longer exists' : 'this network has no recorded joining token (joined before it was recorded)' });
      continue;
    }
    const caller = { ...joiner, rights: withInstanceAdminGrants(joiner.rights ?? undefined) };
    const refusal = networkJoinRefusal(caller as never, { existing: [], toCreate: [e.localId] });
    if (refusal) pending.push({ ...e, why: refusal });
    else adopt.push(e);
  }
  return { adopt, pending };
}

/**
 * Adopt what `fromInstanceId` announced for network `networkId` — only from the upstream, only what is missing, and
 * only what the joining token could have joined (`adoptionDecision`). The rest is recorded as pending.
 * Returns the local ids added.
 */
export async function adoptAnnouncedSpaces(networkId: string, fromInstanceId: string, announced: unknown): Promise<string[]> {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return [];
  const proposed = spacesToAdopt(net, fromInstanceId, announced);
  if (!proposed.length) return [];
  const { adopt: allowed, pending } = adoptionDecision(net, cfg.tokens, cfg.spaces.map(s => s.id), proposed);
  const fresh = pending.filter(p => !(net.pendingSpaces ?? []).some(q => q.networkId === p.networkId));
  if (fresh.length) {
    const at = new Date().toISOString();
    net.pendingSpaces = [...(net.pendingSpaces ?? []), ...fresh.map(p => ({ ...p, from: fromInstanceId, at }))];
    saveConfig(cfg);
    log.warn(`Network ${networkId}: upstream ${fromInstanceId} announced ${fresh.map(p => p.networkId).join(', ')}; held as pending, not adopted (${fresh[0]!.why})`);
  }
  return allowed.length ? addSpacesToNetwork(networkId, allowed, `announced by upstream ${fromInstanceId}, joined by ${net.joinedBy}`) : [];
}

/**
 * Where a passed `space_addition` round puts the space on THIS instance, or why it does not (`F-38.4`).
 *
 * The proposer carries its own space. Anyone else carries the network's id for it — creating the space when it has
 * none. **A local space that already has that id and is not in the network is left alone unless this instance voted
 * yes.** Club, closed and democratic networks sync both ways, so joining a same-named local space to the network
 * would start sending its records to every member; a member's own yes on the round is consent to that, and nothing
 * else is — on a club no member votes, and on a democratic network a majority can pass a round this member never
 * saw.
 */
export function spaceAdditionTarget(
  net: NetworkConfig,
  round: { spaceId?: string; proposedHere?: boolean; votes: { instanceId: string; vote: string }[] },
  selfId: string,
  localSpaceIds: readonly string[],
): { localId: string } | { skip: string } | null {
  if (!round.spaceId || !SPACE_ID.test(round.spaceId)) return null;
  const localId = remoteToLocal(net, round.spaceId);
  if (net.spaces.includes(localId)) return null;
  // The proposer is who opened the round HERE — never `subjectInstanceId`, which a peer sets (S-7).
  if (round.proposedHere) return { localId };
  const exists = localSpaceIds.includes(localId);
  const votedYes = round.votes.some(v => v.instanceId === selfId && v.vote === 'yes');
  if (exists && !votedYes) {
    return { skip: `a local space '${localId}' already exists and is not in the network; it is not shared without this instance voting yes` };
  }
  return { localId };
}

/** Apply a concluded `space_addition` round here, if it passed. Deferred a tick: the caller's config write runs first. */
export function applySpaceAdditionRound(net: NetworkConfig, round: VoteRound, where: string): boolean {
  if (!round.concluded || !round.passed || round.type !== 'space_addition') return false;
  const cfg = getConfig();
  const target = spaceAdditionTarget(net, round, cfg.instanceId, cfg.spaces.map(s => s.id));
  if (!target) return false;
  if ('skip' in target) {
    log.warn(`space_addition round ${round.roundId} on network ${net.id} passed (${where}) but was not applied: ${target.skip}`);
    return false;
  }
  const entry = { networkId: round.spaceId!, localId: target.localId };
  setImmediate(() => { void addSpacesToNetwork(net.id, [entry], `space_addition round ${round.roundId}, ${where}`); });
  return true;
}
