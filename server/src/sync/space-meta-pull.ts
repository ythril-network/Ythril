/**
 * Take a network's schema for a space from a member and keep it as that network's layer (`F-39.1`, `Q-966`).
 *
 * One call per space per cycle, from the sync engine's receive half. Who may supply it is decided here, inside, so a
 * second caller cannot forget it (`mayTakeLayerFrom`):
 *
 * - a pub/sub or tree network: only the member that IS this instance's upstream (`upstreamOf`) — a subscriber takes its
 *   publisher's schema, a tree node its parent's, every cycle, and nobody takes anything from below;
 * - a club, closed or democratic network: only from the member that admitted this instance (`admitterOf`), and only while the space's schema is
 *   not SEEDED here (`networks/schema-standing.ts`), never on the instance that created the network or on a space this instance proposed. A voted
 *   network's schema changes by passed rounds, each written into the layer by `sync/governance.ts`; what was missing is the start: a member that
 *   joined on a build whose join carried no schema, or whose join could not fetch it, held the space with no types and no validation mode, and one
 *   that then received a round held only that round's changed fields (`Q-966`). The join fetches it (`sync/join-layers.ts`); this is the heal
 *   for one that did not, and it replaces a partial layer with the network's whole schema.
 *
 * The door is `GET /api/sync/meta` on every path, and only to a caller that may read the space's schema. A directional network reads its `meta`
 * (the upstream's own definitions plus that network's layer, never another network's, F-39.2); a voted one reads the network's part of the
 * answer (`network`: the creator's own definitions and layer, a non-creator's layer and nothing of its own), so what a member stores as the
 * network's layer does not depend on who it asked.
 *
 * The write goes straight to `storeNetworkLayer`, NOT through `planSpaceMetaUpdate`: that planner turns a change to a
 * networked space into a vote, and this change is the network's decision arriving, not a local proposal to it —
 * the same reason a passed `meta_change` round applies through `updateSpace` in `sync/governance.ts`.
 *
 * Never throws. A schema that cannot be fetched or merged is logged and the data sync goes on: the owner's rule for
 * schema is that it never stops data.
 */
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { readPeerMeta, withoutBrokenLibraryRefs } from '../spaces/body-schemas.js';
import { storeNetworkLayer } from '../spaces/effective-meta.js';
import { log, peerList, peerText } from '../util/log.js';
import { boundedJson } from '../util/bounded-read.js';
import { isDirectionalNetwork, isUpstreamPeer } from '../networks/network-spaces.js';
import { admitterOf, createdHere, layerSeeded, markLayerSeeded } from '../networks/schema-standing.js';
import { peerSafeFetch } from './peer-fetch.js';
import { transferRefusal, turnSignal, type ExchangeTurn } from './held-answer.js';
import { layerRefusals, type LayerRefusals } from './layer-refusals.js';

/**
 * May this instance take network `net`'s schema for local space `spaceId` from `memberId` now? Its upstream on a pub/sub or tree network; on a
 * voted network the member that admitted it, while the space's schema is not seeded here (read live, so a layer stored earlier in the same
 * cycle ends the asking).
 */
export function mayTakeLayerFrom(net: NetworkConfig, memberId: string | undefined, spaceId: string): boolean {
  if (isDirectionalNetwork(net)) return isUpstreamPeer(net, memberId);
  const cfg = getConfig();
  const live = cfg.networks.find(n => n.id === net.id);
  if (!memberId || !live || layerSeeded(live, spaceId)) return false;
  // The instance that CREATED the network never takes one: its own definitions are where the network's schema began, and a layer
  // pulled back from a member would sit in front of them (a layer outranks own definitions) and change the variation it serves.
  if (createdHere(live, cfg.spaces.find(s => s.id === spaceId))) return false;
  return memberId === admitterOf(live);
}

/** @returns whether the local meta changed. */
export async function pullNetworkSchema(
  net: NetworkConfig,
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  opts: () => RequestInit,
  turn?: ExchangeTurn,
): Promise<boolean> {
  if (!mayTakeLayerFrom(net, member.instanceId, spaceId)) return false;
  const voted = !isDirectionalNetwork(net);
  const from = voted ? `member ${member.label}` : `upstream ${member.label}`;
  return fetchNetworkLayer({ networkId: net.id, peerUrl: member.url, from, spaceId, remoteSpaceId, init: opts(), turn, voted, memberId: member.instanceId });
}

/** What the door answers (`api/sync/meta.ts`): `network` and `networkSeeded` only for a voted network the instance carries the space of. */
interface MetaAnswer { meta?: unknown; network?: unknown; networkSeeded?: boolean }

/**
 * Fetch network `networkId`'s schema for `remoteSpaceId` from the member at `peerUrl` and keep it as that network's layer
 * for local space `spaceId` (`takeNetworkLayer`). The ONE fetch of a layer, for the cycle's pull above and for the join
 * (`Q-966`, `sync/join-layers.ts`), so both ask the same door the same way and read its answer the same way. Never throws: a refusal or a
 * failure is logged (a hold is not a failure) and answers `false`.
 *
 * `voted` marks the member as the ADMITTER of a voted network (`memberId`): the network's part of the answer is read, a layer taken whole from
 * it marks the space seeded, and a refusal is held against it for a backoff (`sync/layer-refusals.ts`). A member whose own schema is not
 * seeded says so (`networkSeeded: false`) and its answer is not taken: what it holds may be only a round's changed fields. `deadline` is a
 * signal the caller cut the fetch with (the join's): its abort is the caller's to report, not a failure of this member.
 */
export async function fetchNetworkLayer(args: {
  networkId: string; peerUrl: string; from: string; spaceId: string; remoteSpaceId: string; init: RequestInit; turn?: ExchangeTurn;
  voted?: boolean; memberId?: string; deadline?: AbortSignal; refusals?: LayerRefusals;
}): Promise<boolean> {
  const { networkId, peerUrl, from, spaceId, remoteSpaceId, init, turn, voted = false, memberId, deadline, refusals = layerRefusals } = args;
  const backoff = voted && memberId !== undefined;
  if (backoff && !refusals.mayAsk(networkId, memberId, spaceId)) return false;
  const refused = (what: string): false => {
    // One warning per backoff step: a refusal is only recorded when the member was asked, which is once per step.
    if (backoff) {
      const waitMs = refusals.refused(networkId, memberId, spaceId);
      log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': ${peerText(what)}; not asked again for ${Math.round(waitMs / 60_000)} min`);
    } else log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': ${peerText(what)}`);
    return false;
  };
  try {
    const q = new URLSearchParams({ spaceId: remoteSpaceId, networkId });
    const resp = await peerSafeFetch(`${peerUrl}/api/sync/meta?${q}`, { ...init, signal: turnSignal(init.signal, turn) });
    if (!resp.ok) {
      // A new build never holds this door (schema propagation is not data); an older one may, and that is a hold, not a failure.
      const verdict = await transferRefusal(resp);
      turn?.refusedBy(verdict);
      if (verdict !== 'failed') return false;
      // A caller's error (the member's rights, a door it does not have) lasts; a busy or failing member is asked again at the next cycle.
      const lasting = resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429;
      return lasting ? refused(`HTTP ${resp.status}`) : (log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': HTTP ${resp.status}`), false);
    }
    const answer = await boundedJson<MetaAnswer>(resp, 'sync peer');
    if (backoff) refusals.answered(networkId, memberId, spaceId);
    // A member that has not healed itself says so, and what it serves as the network's schema is then not the network's whole one.
    if (voted && answer.networkSeeded === false) return false;
    const incoming = voted && answer.network !== undefined ? answer.network : answer.meta;
    const taken = takeNetworkLayer(networkId, spaceId, incoming, from, voted ? 'layer' : undefined);
    if (taken.refused && backoff) refusals.refused(networkId, memberId, spaceId);
    return taken.changed;
  } catch (err) {
    if (deadline?.aborted) return false;
    log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': ${peerText(err)}`);
    return false;
  }
}

/**
 * Keep `incoming` as network `networkId`'s layer for local space `spaceId`, as the network's decision arriving —
 * the ONE place a layer is accepted from outside, whichever mechanism carried it: the meta pull above, or a passed
 * `space_addition` round that carries the space's schema (`Q-60`, `applySpaceAdditionRound`). So both validate it as
 * the layer it becomes, and both leave out only a type whose library reference neither side can resolve.
 * Never throws; `from` names the source in the log. `seeded` says what this layer is to the space once it is stored: the network's
 * WHOLE schema for it (`'layer'`), which the heal then never takes again (`networks/schema-standing.ts`), or `undefined` for one that may be partial.
 * `refused` is a layer the reader would not take, which no later ask of the same member changes.
 */
export function takeNetworkLayer(networkId: string, spaceId: string, incoming: unknown, from: string, seeded?: 'layer'): { changed: boolean; refused: boolean } {
  try {
    // Validated on its own, as the layer it becomes (F-39.2) — merged into nothing, so nothing local rides along. Read as a
    // TOLERANT reader (R6-7): what this release knows is kept and what it has never heard of is named, not a reason to refuse the
    // layer. A field that is known and WRONG still refuses it whole.
    const read = readPeerMeta(incoming);
    if (!read.ok) {
      log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}' refused whole, nothing merged: ${peerText(read.message)}`);
      return { changed: false, refused: true };
    }
    // Q-60: a type naming a library entry this instance lacks is left out, and only it. The sender inlines every
    // reference it can resolve, so what remains is one the sender could not resolve either; refusing the whole
    // schema for it cost the member every other type and the space's posture.
    const kept = withoutBrokenLibraryRefs(read.meta);
    if (kept.dropped.length) {
      log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': left out ${peerList(kept.dropped, ', ')}, which reference schema library entries neither side holds; the rest is merged`);
    }
    // Kept as this network's layer; the effective meta is rebuilt from own ⊕ layers in precedence.
    const changed = storeNetworkLayer(networkId, spaceId, kept.meta, read.unknown);
    if (changed) log.info(`Schema for '${peerText(spaceId)}' merged from ${peerText(from)} (network ${peerText(networkId)})`);
    // After the layer is stored: a crash between the two leaves the space unseeded, and the heal takes the same layer again.
    if (seeded !== undefined) markLayerSeeded(networkId, spaceId, seeded);
    return { changed, refused: false };
  } catch (err) {
    log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': ${peerText(err)}`);
    return { changed: false, refused: false };
  }
}

/** {@link takeNetworkLayer}, answering only whether the local meta changed: for the stores that carry the whole schema (a passed `space_addition`, an accepted pending space). */
export function acceptNetworkLayer(networkId: string, spaceId: string, incoming: unknown, from: string, seeded?: 'layer'): boolean {
  return takeNetworkLayer(networkId, spaceId, incoming, from, seeded).changed;
}
