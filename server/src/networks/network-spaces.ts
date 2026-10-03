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
import type { Config, NetworkConfig, SpaceMeta, VoteRound } from '../config/types.js';
import { migrateToken } from '../auth/rights-migration.js';
import { reachesSpace } from '../auth/space-reach.js';
import { networkJoinRefusal } from '../auth/network-rights.js';
import { withInstanceAdminGrants } from '../auth/instance-admin-grants.js';
import type { TokenRights } from '../config/rights-shape.js';
import { createSpace, type SpaceCreator } from '../spaces/lifecycle.js';
import { localToRemote, remoteToLocal, recordSpaceAlias, reverseSpaceMap, isSpaceId, forgetSpaceAliases } from '../sync/space-map.js';
import { PER_SPACE_WATERMARKS } from '../config/types-networks.js';
import { logInternalAudit } from '../audit/audit.js';
import { SPACE_ALIAS_HEAL_OPERATION } from '../audit/middleware.js';
import { log } from '../util/log.js';
import { networkRole } from './network-role.js';

/** The shape a space id has everywhere else it is accepted — create, rename, the join's space map. */
const SPACE_ID = /^[a-z0-9-]{1,40}$/;

/** At most this many spaces are adopted from one announcement: a bound on what one peer message may create. */
const MAX_ADOPTED_PER_ANNOUNCE = 50;

/** At most this many name hints per self-record, and read per announcement (`Q-133`) — the same bound, for the same reason. */
export const MAX_SPACE_NAMES = 50;

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
    if (net.dismissedSpaces?.includes(id)) continue;   // the operator answered it: dismissing is not a snooze
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
  /** Who a space created here is credited to (Q-134): the accepting token, or the network's joining token. */
  creator: SpaceCreator,
): Promise<string[]> {
  try {
    for (const { localId } of entries) {
      if (getConfig().spaces.some(s => s.id === localId)) continue;
      await createSpace({ id: localId, label: localId.charAt(0).toUpperCase() + localId.slice(1) }, creator);
    }
    // Re-read after the awaits: `createSpace` saved the config, and a stale copy would write that away.
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === networkId);
    if (!net) return [];
    const added = entries.map(e => e.localId).filter((id, i, all) => !net.spaces.includes(id) && all.indexOf(id) === i);
    if (!added.length) return [];
    for (const e of entries) {
      if (e.localId === e.networkId || !added.includes(e.localId)) continue;
      const why = recordSpaceAlias(net, e.networkId, e.localId);
      if (why) log.warn(`Network ${networkId}: alias '${e.networkId}' -> '${e.localId}' not recorded: ${why}`);
    }
    net.spaces.push(...added);
    clearSettledProposals(net, entries.filter(e => added.includes(e.localId)).map(e => e.networkId));
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
 * A network space that is now carried is no longer a proposal: a pending entry left behind would offer to add it a
 * second time, and the network view would say the opposite of what syncs. One clean-up for both ways a space becomes
 * carried after create — adoption and the Q-133 heal — so neither leaves its offer standing.
 */
function clearSettledProposals(net: NetworkConfig, networkIds: readonly string[]): void {
  const settled = new Set(networkIds);
  if (net.pendingSpaces?.some(p => settled.has(p.networkId))) net.pendingSpaces = net.pendingSpaces.filter(p => !settled.has(p.networkId));
}

/**
 * Take a space OUT of a network here, and keep it as a local space (`Q-70`).
 *
 * Owner, 2026-09-26: a network never deletes a member's space — *"remove space from network and delete for self so
 * everyone else can keep their copy locally or even readd"*. So a passed deletion round lands as this on every member,
 * and only the proposer goes on to delete its own copy. Everything the network held FOR the space goes with it — its
 * id mapping, the schema layer it sent (the effective schema is rebuilt without it), a pending offer of it — or a
 * re-add later would find the old mapping and layer waiting. The records themselves are untouched: they are the
 * member's.
 *
 * Works on the config as it is when it runs and saves it itself: the callers reach it through a dynamic import, so
 * whatever config object they held may already have been written. @returns whether the network carried the space.
 */
export function removeSpaceFromNetwork(networkId: string, localId: string, why: string): boolean {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net || !net.spaces.includes(localId)) return false;
  net.spaces = net.spaces.filter(s => s !== localId);
  forgetSpaceAliases(net, localId);
  const hadLayer = Boolean(net.schemaLayers?.[localId]);
  if (net.schemaLayers) delete net.schemaLayers[localId];
  if (net.spaceOrigins) delete net.spaceOrigins[localId];
  for (const member of net.members) {
    for (const key of PER_SPACE_WATERMARKS) delete (member[key] as Record<string, unknown> | undefined)?.[localId];
  }
  if (net.pendingSpaces?.some(p => p.localId === localId)) net.pendingSpaces = net.pendingSpaces.filter(p => p.localId !== localId);
  saveConfig(cfg);
  log.info(`Network ${networkId}: space '${localId}' left the network (${why}); this instance keeps it as a local space`);
  if (hadLayer) {
    void import('../spaces/effective-meta.js')
      .then(({ recomputeEffectiveMeta }) => recomputeEffectiveMeta(localId, true))
      .catch((err: unknown) => log.warn(`Network ${networkId}: schema of '${localId}' not rebuilt after it left: ${err}`));
  }
  return true;
}

/**
 * Which announced spaces may be added here, judged by the token that JOINED the network (S-9).
 *
 * Owner, 2026-09-26: *"on joining a network the space definition must come from the token that joins the network,
 * not from the peers."* An announcement is a proposal: each space is adopted only if `net.joinedBy` could have joined
 * it — the same `networkJoinRefusal` the join itself runs — and everything else waits in `pending` with the reason.
 * A local space that already has the id is never adopted this way, whoever joined: joining it would start syncing a
 * space that only shares a name, and only an explicit mapping by the operator may do that. No recorded joiner (a
 * network joined before this existed), a revoked one or an expired one adopts nothing.
 */
export function adoptionDecision(
  net: Pick<NetworkConfig, 'joinedBy'>,
  tokens: readonly { id: string; rights?: TokenRights | null; instanceAdmin?: boolean; expiresAt?: string | null }[],
  localSpaceIds: readonly string[],
  entries: readonly { networkId: string; localId: string }[],
  now = Date.now(),
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
    // Expired is revoked on a schedule: the token can no longer authenticate, so it can no longer authorise.
    if (joiner.expiresAt && Date.parse(joiner.expiresAt) <= now) {
      pending.push({ ...e, why: 'the token that joined this network has expired' });
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
 * Record `pending` on `net` for the operator, and save. The one place a proposal becomes pending — an announcement
 * and a passed round both land here — so neither can re-offer a space already pending or one the operator dismissed.
 */
function holdAsPending(
  cfg: Config,
  net: NetworkConfig,
  pending: readonly { networkId: string; localId: string; why: string; meta?: SpaceMeta }[],
  from: string,
  what: string,
): void {
  const fresh = pending.filter(p => !net.dismissedSpaces?.includes(p.networkId) && !(net.pendingSpaces ?? []).some(q => q.networkId === p.networkId));
  if (!fresh.length) return;
  const at = new Date().toISOString();
  net.pendingSpaces = [...(net.pendingSpaces ?? []), ...fresh.map(p => ({ ...p, from, at }))];
  saveConfig(cfg);
  log.warn(`Network ${net.id}: ${what} ${fresh.map(p => p.networkId).join(', ')}; held as pending, not adopted (${fresh[0]!.why})`);
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
  holdAsPending(cfg, net, pending, fromInstanceId, `upstream ${fromInstanceId} announced`);
  // Credited to the token that joined the network here — the authority adoptionDecision just judged by (Q-134).
  return allowed.length ? addSpacesToNetwork(networkId, allowed, `announced by upstream ${fromInstanceId}, joined by ${net.joinedBy}`, { tokenId: net.joinedBy ?? null }) : [];
}

/*
 * ─── The heal for a member that joined before Q-133 ─────────────────────────────────────────────────────────────
 *
 * Until Q-133 the invite answer handed a joiner the inviter's LOCAL names. A joiner of a renamed space therefore holds
 * it under the inviter's current name with no alias, while every announcement names it by the network's id — which
 * `spacesToAdopt` then offers as a new, empty space. The upstream's self-record carries `spaceNames` (network id ->
 * its own name) and this restores the alias instead.
 *
 * The rules, each a way the heal could otherwise re-point a LIVE space:
 * - only from the upstream (a subscriber's publisher, a tree node's parent), whose announcement is the network's;
 *   a sibling could otherwise aim any network id at any space here;
 * - only for a network id this instance neither carries nor aliases, and that the operator has not dismissed;
 * - only onto a local space this network carries, that answers to no network id but its own, and that the upstream
 *   does NOT itself announce — a space synced under its own id is live, not the one waiting for its alias;
 * - never when two network ids of one announcement point at the same local space.
 * It creates nothing and removes nothing.
 */

/** What the heal would record for this announcement, decided without touching config. */
export function healSpaceAliases(
  net: Pick<NetworkConfig, 'type' | 'spaces' | 'spaceMap' | 'members' | 'dismissedSpaces' | 'myParentInstanceId'>,
  fromInstanceId: string,
  announced: unknown,
  spaceNames: unknown,
): { networkId: string; localId: string }[] {
  if (!Array.isArray(announced) || !fromInstanceId || upstreamOf(net as NetworkConfig) !== fromInstanceId) return [];
  if (spaceNames === null || typeof spaceNames !== 'object' || Array.isArray(spaceNames)) return [];
  const names = new Map<string, string>();
  for (const [networkId, local] of Object.entries(spaceNames as Record<string, unknown>).slice(0, MAX_SPACE_NAMES)) {
    if (isSpaceId(networkId) && isSpaceId(local)) names.set(networkId, local);
  }
  const announcedIds = new Set(announced.slice(0, MAX_SPACE_NAMES).filter(isSpaceId));
  const reverse = reverseSpaceMap(net);
  const proposed: { networkId: string; localId: string }[] = [];
  for (const networkId of announcedIds) {
    if (net.dismissedSpaces?.includes(networkId)) continue;
    if (net.spaceMap?.[networkId] !== undefined || net.spaces.includes(networkId)) continue;
    const localId = names.get(networkId);
    if (!localId || !net.spaces.includes(localId)) continue;
    if (reverse.has(localId) || announcedIds.has(localId)) continue;
    proposed.push({ networkId, localId });
  }
  const targets = new Map<string, number>();
  for (const p of proposed) targets.set(p.localId, (targets.get(p.localId) ?? 0) + 1);
  const ambiguous = proposed.filter(p => targets.get(p.localId)! > 1);
  if (ambiguous.length) {
    log.warn(`Network: not healing ${ambiguous.map(p => `'${p.networkId}'`).join(', ')} — they point at the same local space '${ambiguous[0]!.localId}'`);
  }
  return proposed.filter(p => targets.get(p.localId) === 1);
}

/**
 * Apply the heal for one announcement. Never throws, so a bad announcement cannot cost the member exchange its other
 * work; writes nothing (and saves nothing) when there is nothing to heal, so an idle network does not rewrite config.
 * Decided and recorded on one config snapshot with no await between.
 */
export async function healAnnouncedAliases(networkId: string, fromInstanceId: string, announced: unknown, spaceNames: unknown): Promise<void> {
  try {
    const cfg = getConfig();
    if (cfg.pendingSpaceOp) return; // a rename or delete is moving a space: the next cycle heals against its result
    const net = cfg.networks.find(n => n.id === networkId);
    if (!net) return;
    const heals = healSpaceAliases(net, fromInstanceId, announced, spaceNames);
    const recorded = heals.filter(h => {
      const why = recordSpaceAlias(net, h.networkId, h.localId);
      if (why) log.warn(`Network ${networkId}: heal of '${h.networkId}' -> '${h.localId}' not recorded: ${why}`);
      return why === null;
    });
    if (!recorded.length) return;
    clearSettledProposals(net, recorded.map(h => h.networkId));
    saveConfig(cfg);
    for (const h of recorded) {
      log.info(`Network ${networkId}: healed the alias '${h.networkId}' -> '${h.localId}' from upstream ${fromInstanceId}`);
      logInternalAudit({
        method: 'SYNC', path: 'internal:space-alias-heal', spaceId: h.localId, operation: SPACE_ALIAS_HEAL_OPERATION,
      });
    }
  } catch (err) {
    log.warn(`Network ${networkId}: alias heal from ${fromInstanceId} failed: ${err}`);
  }
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
  // S-9 on the round path: a round this instance did not propose, for a space it does not have, would CREATE one on
  // the network's word. The same rule as an announcement decides — the joining token — and what it could not have
  // joined waits for the operator. A same-id local space got here only by this instance voting yes, which is consent.
  // Decided inside the deferred tick, on the config as it is then, so the caller's own write cannot overwrite it.
  setImmediate(() => {
    if (!round.proposedHere) {
      const now = getConfig();
      const liveNet = now.networks.find(n => n.id === net.id);
      if (!liveNet) return;
      const localIds = now.spaces.map(s => s.id);
      if (!localIds.includes(entry.localId)) {
        const { adopt, pending } = adoptionDecision(liveNet, now.tokens, localIds, [entry]);
        if (!adopt.length) {
          // Q-60: the schema the round carries waits with it, so an accept later adopts the space WITH its schema.
          const withMeta = round.pendingMeta ? pending.map(p => ({ ...p, meta: round.pendingMeta })) : pending;
          holdAsPending(now, liveNet, withMeta, round.subjectInstanceId ?? 'a passed round', `space_addition round ${round.roundId} passed (${where}) for`);
          return;
        }
      }
    }
    void addSpacesToNetwork(net.id, [entry], `space_addition round ${round.roundId}, ${where}`, { tokenId: net.joinedBy ?? null }).then(async added => {
      // Q-60: the round carries the space's schema, since a voted network has no meta pull — kept as the layer.
      if (!added.includes(entry.localId) || !round.pendingMeta || round.proposedHere) return;
      const { acceptNetworkLayer } = await import('../sync/space-meta-pull.js');
      acceptNetworkLayer(net.id, entry.localId, round.pendingMeta, `space_addition round ${round.roundId}`);
    });
  });
  return true;
}
