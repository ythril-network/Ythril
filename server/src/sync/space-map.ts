/**
 * Translating space IDs between an instance and its peers.
 *
 * Extracted from `sync/engine.ts` during the god-file split. Pure: no config, no IO, no state. Pinned
 * by `testing/standalone/sync-engine-lock.test.js`, written against the original before this file
 * existed.
 *
 * `NetworkConfig.spaceMap` maps REMOTE space IDs to LOCAL ones, and exists for the case where a peer's
 * space name collides with one of yours and you want to alias rather than merge. Most networks never
 * configure it.
 *
 * Both directions fall back to the input unchanged when there is no mapping. That fallback is what
 * makes an unmapped space sync under its own id — returning undefined or an empty string instead
 * would make the space either sync under a broken id or drop out of the cycle silently, and both read
 * to an operator as "that space just doesn't sync".
 */
import type { NetworkConfig } from '../config/types.js';

/**
 * Resolve a remote (peer-side) space ID to its local equivalent.
 *
 * Returns the mapped local ID if one exists, otherwise `remoteId` unchanged (no aliasing).
 */
export function remoteToLocal(net: NetworkConfig, remoteId: string): string {
  return net.spaceMap?.[remoteId] ?? remoteId;
}

/**
 * The local id of a space a round names — or `null` unless THIS network carries it here.
 *
 * A round names its space by the network's id and a peer chooses that id, so acting on it unchecked lets any
 * member of any network reach any space on this instance, including one no network shares (`S-9`, and `S-7` for
 * `meta_change`). Every decision that acts on a concluded round's space resolves it through here, so the mapping and
 * the "is it carried" check cannot be taken one without the other.
 */
export function carriedLocalId(net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>, remoteId: string | undefined): string | null {
  if (!remoteId) return null;
  const localId = remoteToLocal(net as NetworkConfig, remoteId);
  return net.spaces.includes(localId) ? localId : null;
}

/**
 * Resolve a local space ID to its remote (peer-side) equivalent — a reverse lookup over `spaceMap`.
 *
 * **First match wins.** `spaceMap` is keyed by remote ID, so nothing prevents two remote spaces being
 * aliased onto the same local one; when that happens this returns whichever key comes first in
 * insertion order. That is the original behaviour and is deliberately preserved — building a reversed
 * Map here would resolve to the LAST such key instead, silently changing which peer receives a push.
 */
export function localToRemote(net: NetworkConfig, localId: string): string {
  if (!net.spaceMap) return localId;
  for (const [remote, local] of Object.entries(net.spaceMap)) {
    if (local === localId) return remote;
  }
  return localId;
}
