/**
 * Take a network's schema for a space from a member and keep it as that network's layer (`F-39.1`, `Q-966`).
 *
 * One call per space per cycle, from the sync engine's receive half. Who may supply it is decided here, inside, so a
 * second caller cannot forget it (`mayTakeLayerFrom`):
 *
 * - a pub/sub or tree network: only the member that IS this instance's upstream (`upstreamOf`) — a subscriber takes its
 *   publisher's schema, a tree node its parent's, every cycle, and nobody takes anything from below;
 * - a club, closed or democratic network: only on a member that JOINED it, from the member that admitted it, and only
 *   while it holds NO layer of that network for the space (never on the network's creator: see `mayTakeLayerFrom`). A voted network's schema changes by passed rounds, each written into the layer by `sync/governance.ts`;
 *   what was missing is the start: a member that joined on a build whose join carried no schema, or whose join could not
 *   fetch it, held the space with no types and no validation mode and was never sent them (`Q-966`). The join now
 *   fetches it (`networks/join-remote-act.ts`, through `fetchNetworkLayer` below); this is the heal for one that did not.
 *
 * The door is `GET /api/sync/meta` on every path: the member's own definitions plus that network's layer, never
 * another network's (F-39.2), and only to a caller that may read the space's schema.
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
import { peerSafeFetch } from './peer-fetch.js';
import { transferRefusal, turnSignal, type ExchangeTurn } from './held-answer.js';

/**
 * May this instance take network `net`'s schema for local space `spaceId` from `memberId` now? Its upstream on a pub/sub
 * or tree network; on a voted network the member that admitted it, while no layer of `net` for the space is stored here
 * (read live, so a layer stored earlier in the same cycle ends the asking).
 */
export function mayTakeLayerFrom(net: NetworkConfig, memberId: string | undefined, spaceId: string): boolean {
  if (isDirectionalNetwork(net)) return isUpstreamPeer(net, memberId);
  const live = getConfig().networks.find(n => n.id === net.id);
  if (!memberId || !live || live.schemaLayers?.[spaceId] !== undefined) return false;
  // The instance that CREATED the network never takes one: its own definitions are where the network's schema began, and a layer
  // pulled back from a member would sit in front of them (a layer outranks own definitions) and change the variation it serves.
  // A joiner takes it from the member that admitted it — the one its join asked — or, joined before that was recorded (Q-154),
  // from any member.
  if (live.origin !== 'joined') return false;
  return live.admittedVia === undefined || live.admittedVia === memberId;
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
  const from = isDirectionalNetwork(net) ? `upstream ${member.label}` : `member ${member.label}`;
  return fetchNetworkLayer({ networkId: net.id, peerUrl: member.url, from, spaceId, remoteSpaceId, init: opts(), turn });
}

/**
 * Fetch network `networkId`'s schema for `remoteSpaceId` from the member at `peerUrl` and keep it as that network's layer
 * for local space `spaceId` (`acceptNetworkLayer`). The ONE fetch of a layer, for the cycle's pull above and for the join
 * (`Q-966`), so both ask the same door the same way and read its answer the same way. Never throws: a refusal or a
 * failure is logged (a hold is not a failure) and answers `false`.
 */
export async function fetchNetworkLayer(args: {
  networkId: string; peerUrl: string; from: string; spaceId: string; remoteSpaceId: string; init: RequestInit; turn?: ExchangeTurn;
}): Promise<boolean> {
  const { networkId, peerUrl, from, spaceId, remoteSpaceId, init, turn } = args;
  try {
    const q = new URLSearchParams({ spaceId: remoteSpaceId, networkId });
    const resp = await peerSafeFetch(`${peerUrl}/api/sync/meta?${q}`, { ...init, signal: turnSignal(init.signal, turn) });
    if (!resp.ok) {
      // A new build never holds this door (schema propagation is not data); an older one may, and that is a hold, not a failure.
      const verdict = await transferRefusal(resp);
      turn?.refusedBy(verdict);
      if (verdict === 'failed') log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': HTTP ${resp.status}`);
      return false;
    }
    const { meta: incoming } = await boundedJson<{ meta?: unknown }>(resp, 'sync peer');
    return acceptNetworkLayer(networkId, spaceId, incoming, from);
  } catch (err) {
    log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': ${peerText(err)}`);
    return false;
  }
}

/**
 * Keep `incoming` as network `networkId`'s layer for local space `spaceId`, as the network's decision arriving —
 * the ONE place a layer is accepted from outside, whichever mechanism carried it: the meta pull above, or a passed
 * `space_addition` round that carries the space's schema (`Q-60`, `applySpaceAdditionRound`). So both validate it as
 * the layer it becomes, and both leave out only a type whose library reference neither side can resolve.
 * Never throws; `from` names the source in the log. Returns whether the local meta changed.
 */
export function acceptNetworkLayer(networkId: string, spaceId: string, incoming: unknown, from: string): boolean {
  try {
    // Validated on its own, as the layer it becomes (F-39.2) — merged into nothing, so nothing local rides along. Read as a
    // TOLERANT reader (R6-7): what this release knows is kept and what it has never heard of is named, not a reason to refuse the
    // layer. A field that is known and WRONG still refuses it whole.
    const read = readPeerMeta(incoming);
    if (!read.ok) {
      log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}' refused whole, nothing merged: ${peerText(read.message)}`);
      return false;
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
    return changed;
  } catch (err) {
    log.warn(`Schema from ${peerText(from)} for '${peerText(spaceId)}': ${peerText(err)}`);
    return false;
  }
}
