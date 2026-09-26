/**
 * Take a space's meta from this instance's upstream and merge it in, additively (`F-39.1`).
 *
 * One call per space per cycle, from the sync engine's receive half. It does nothing unless the member being synced
 * IS this instance's upstream for the network (`upstreamOf`) — a subscriber takes its publisher's schema, a tree
 * node its parent's, and nobody takes anything from below. That check is inside this function rather than at the
 * call so a second caller cannot forget it.
 *
 * The write goes straight to `updateSpace`, NOT through `planSpaceMetaUpdate`: that planner turns a change to a
 * networked space into a vote, and this change is the network's decision arriving, not a local proposal to it —
 * the same reason a passed `meta_change` round applies through `updateSpace` in `sync/governance.ts`.
 *
 * Never throws. A schema that cannot be fetched or merged is logged and the data sync goes on: the owner's rule for
 * schema is that it never stops data.
 */
import type { NetworkConfig, NetworkMember, SpaceMeta } from '../config/types.js';
import { withoutBrokenLibraryRefs } from '../spaces/body-schemas.js';
import { storeNetworkLayer } from '../spaces/effective-meta.js';
import { log } from '../util/log.js';
import { boundedJson } from '../util/bounded-read.js';
import { upstreamOf } from '../networks/network-spaces.js';
import { mergeReplicatedMeta } from './replicated-meta.js';
import { peerSafeFetch } from './peer-fetch.js';

/** @returns whether the local meta changed. */
export async function pullSpaceMetaFromUpstream(
  net: NetworkConfig,
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  opts: () => RequestInit,
): Promise<boolean> {
  if (upstreamOf(net) !== member.instanceId) return false;
  try {
    const q = new URLSearchParams({ spaceId: remoteSpaceId, networkId: net.id });
    const resp = await peerSafeFetch(`${member.url}/api/sync/meta?${q}`, opts());
    if (!resp.ok) {
      log.warn(`Schema from ${member.label} for '${spaceId}': HTTP ${resp.status}`);
      return false;
    }
    const { meta: incoming } = await boundedJson<{ meta?: unknown }>(resp, 'sync peer');
    return acceptNetworkLayer(net.id, spaceId, incoming, `upstream ${member.label}`);
  } catch (err) {
    log.warn(`Schema from ${member.label} for '${spaceId}': ${err}`);
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
    // Validated on its own, as the layer it becomes (F-39.2) — merged into nothing, so nothing local rides along.
    const merged = mergeReplicatedMeta({}, incoming);
    if (merged.invalid) {
      log.warn(`Schema from ${from} for '${spaceId}' refused whole, nothing merged: ${merged.invalid}`);
      return false;
    }
    // Q-60: a type naming a library entry this instance lacks is left out, and only it. The sender inlines every
    // reference it can resolve, so what remains is one the sender could not resolve either; refusing the whole
    // schema for it cost the member every other type and the space's posture.
    const kept = withoutBrokenLibraryRefs(merged.meta.typeSchemas as Record<string, Record<string, unknown> | undefined> | undefined);
    if (kept.dropped.length) {
      log.warn(`Schema from ${from} for '${spaceId}': left out ${kept.dropped.join(', ')}, which reference schema library entries neither side holds; the rest is merged`);
    }
    const layer = { ...merged.meta, ...(merged.meta.typeSchemas ? { typeSchemas: kept.typeSchemas } : {}) } as SpaceMeta;
    // Kept as this network's layer; the effective meta is rebuilt from own ⊕ layers in precedence.
    const changed = storeNetworkLayer(networkId, spaceId, layer);
    if (changed) log.info(`Schema for '${spaceId}' merged from ${from} (network ${networkId})`);
    return changed;
  } catch (err) {
    log.warn(`Schema from ${from} for '${spaceId}': ${err}`);
    return false;
  }
}
