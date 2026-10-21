/**
 * The pure half of taking a space out of a network: one cleanup for every way a space leaves one (Q-70, Q-531).
 *
 * ## What it is, and why it is a leaf
 *
 * Everything a network holds FOR a space goes with it - its place in `spaces`, its id mapping, the schema layer the network sent, the
 * layer's unread marker, the membership origin, every member's receive marks, and a pending offer of it - or a re-add later finds the old
 * mapping and layer waiting. It edits the network object it is handed, saves nothing and reads no config.
 *
 * Two callers share it: `removeSpaceFromNetwork` (a passed deletion round, which saves) and the 6.0 migration of a proxy to personal
 * views (`config/migrate-proxies-to-views.ts`, a transform of a parsed config that must not save). The loader runs the migration, so
 * this module must not import anything that imports the loader: `network-spaces.ts` does (it reads and saves the config), and a migration
 * importing it made the loader a member of an import cycle with half the server. The cleanup therefore lives here, imports only
 * leaves, and `network-spaces.ts` re-exports it.
 */
import type { NetworkConfig } from '../config/types.js';
import { forgetSpaceAliases, localToRemote } from '../sync/space-map.js';
import { forgetReceiveMarks } from '../sync/receive-marks.js';

/**
 * A network space that is now carried is no longer a proposal: a pending entry left behind would offer to add it a second time, and the
 * network view would say the opposite of what syncs. @returns whether an offer was forgotten.
 */
export function clearSettledProposals(net: NetworkConfig, networkIds: readonly string[]): boolean {
  const settled = new Set(networkIds);
  if (!net.pendingSpaces?.some(p => settled.has(p.networkId))) return false;
  net.pendingSpaces = net.pendingSpaces.filter(p => !settled.has(p.networkId));
  return true;
}

/**
 * Forget the pending offer of one network space (design v5 section 2.4, VR12) - the one spelling of "this network space is no longer on
 * offer here", so a passed deletion and a space leaving the network cannot clean it up two ways.
 * @returns whether an offer was forgotten.
 */
export function forgetPendingOffer(net: NetworkConfig, networkSpaceId: string): boolean {
  return clearSettledProposals(net, [networkSpaceId]);
}

/**
 * Take `localId` out of `net`, in place.
 * @returns whether the network carried the space, whether it held a schema layer for it (the effective schema is rebuilt then), and the
 * network's id for it (`null` when it was not carried).
 */
export function takeSpaceOutOfNetwork(
  net: NetworkConfig, localId: string,
): { carried: boolean; hadLayer: boolean; networkSpaceId: string | null } {
  if (!net.spaces.includes(localId)) return { carried: false, hadLayer: false, networkSpaceId: null };
  net.spaces = net.spaces.filter(s => s !== localId);
  // The network's id for it, read before its alias is forgotten: the offer of it is forgotten by that id.
  const networkSpaceId = localToRemote(net, localId);
  forgetSpaceAliases(net, localId);
  const hadLayer = Boolean(net.schemaLayers?.[localId]);
  if (net.schemaLayers) delete net.schemaLayers[localId];
  if (net.schemaLayerUnread) delete net.schemaLayerUnread[localId];
  if (net.spaceOrigins) delete net.spaceOrigins[localId];
  forgetReceiveMarks(net, localId);
  forgetPendingOffer(net, networkSpaceId);
  return { carried: true, hadLayer, networkSpaceId };
}
