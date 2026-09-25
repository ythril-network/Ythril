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
import { findBrokenLibraryRefs } from '../spaces/body-schemas.js';
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
    // Validated on its own, as the layer it becomes (F-39.2) — merged into nothing, so nothing local rides along.
    const merged = mergeReplicatedMeta({}, incoming);
    if (merged.invalid) {
      log.warn(`Schema from ${member.label} for '${spaceId}' refused whole, nothing merged: ${merged.invalid}`);
      return false;
    }
    const broken = findBrokenLibraryRefs(merged.meta.typeSchemas as Parameters<typeof findBrokenLibraryRefs>[0]);
    if (broken.length) {
      log.warn(`Schema from ${member.label} for '${spaceId}' refused whole: it references schema library entries this instance lacks (${broken.join(', ')})`);
      return false;
    }
    // Kept as this network's layer; the effective meta is rebuilt from own ⊕ layers in precedence.
    const changed = storeNetworkLayer(net.id, spaceId, merged.meta as SpaceMeta);
    if (changed) log.info(`Schema for '${spaceId}' merged from upstream ${member.label} (network ${net.id})`);
    return changed;
  } catch (err) {
    log.warn(`Schema from ${member.label} for '${spaceId}': ${err}`);
    return false;
  }
}
