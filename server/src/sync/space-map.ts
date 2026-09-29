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
import type { NetworkRefusalCode } from '../networks/refusal-codes.js';

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

/**
 * The id to address a peer's space by on its PLAIN file routes (`GET`/`POST /api/files/:spaceId`) — `Q-68`.
 *
 * A peer is named a space by the network's id, and the sync routes translate that to the peer's local id
 * (`api/sync/space-alias.ts`). The file routes are not sync routes and translate nothing, so once a space was renamed
 * on both ends — the network id stays `flows`, both locals are `y-flows` — every file push and pull was refused 403
 * while records synced. The peer's manifest answer names the local id it resolved; this takes it when it is a space
 * id and falls back to the network's id for a peer that predates the field.
 */
export function peerFileSpaceId(answered: unknown, remoteId: string): string {
  return typeof answered === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(answered) ? answered : remoteId;
}

/*
 * ─── Writing spaceMap (`Q-133`) ─────────────────────────────────────────────────────────────────────────────────
 *
 * A space crosses the wire under its NETWORK id. spaceMap may hold several keys for one local space: the FIRST is its
 * network id (what `localToRemote` and every announcement report), and a later key is an INBOUND alias — kept because
 * a member that joined while the space had another local name still addresses it by that name.
 *
 * Every write goes through the two functions below, so the guards cannot be dropped by a caller: no self-alias, no
 * overwrite of an existing alias, no second network id for a local space, and nothing written under a key that is not
 * a space id. The joiner's defect this closes wrote nothing at all — a renamed space reached new joiners twice
 * because nobody recorded the alias the network already used.
 */

/** The shape a space id has everywhere one is accepted. A peer- or user-keyed map is checked against it BEFORE a write. */
const SPACE_ID = /^[a-z0-9-]{1,40}$/;

/** Whether `id` is shaped like a space id — the check that keeps `__proto__` and friends out of a keyed map. */
export function isSpaceId(id: unknown): id is string {
  return typeof id === 'string' && SPACE_ID.test(id);
}

/**
 * Local id -> network id for every aliased space, first match — built once, for a caller resolving many spaces. The
 * same answer as `localToRemote` for each, so the two cannot drift; `localToRemote` stays the one-off form.
 */
export function reverseSpaceMap(net: Pick<NetworkConfig, 'spaceMap'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [remote, local] of Object.entries(net.spaceMap ?? {})) if (!out.has(local)) out.set(local, remote);
  return out;
}

/**
 * Record that this network calls local space `localId` by `networkId`. Returns why it was NOT recorded, or `null`.
 *
 * Refuses a self-alias (nothing to translate), a `networkId` that already names another local space (an overwrite
 * would silently re-point a synced space), a `localId` that already has a network id of its own (one space, one
 * network id — a second would make `localToRemote` answer the older one while peers used the newer), and any id that
 * is not a space id. Only a rename adds a second key for one space, through `appendInboundAlias`.
 */
export function recordSpaceAlias(net: Pick<NetworkConfig, 'spaceMap'>, networkId: string, localId: string): string | null {
  if (!isSpaceId(networkId) || !isSpaceId(localId)) return `'${String(networkId)}' -> '${String(localId)}' is not a pair of space ids`;
  if (networkId === localId) return `'${localId}' needs no alias: the network uses its own id`;
  const existing = net.spaceMap?.[networkId];
  if (existing !== undefined) {
    return existing === localId ? null : `the network id '${networkId}' already reaches local space '${existing}'`;
  }
  const current = reverseSpaceMap(net).get(localId);
  if (current !== undefined) return `local space '${localId}' already syncs as '${current}' in this network`;
  (net.spaceMap ??= {})[networkId] = localId;
  return null;
}

/**
 * The inbound alias a rename leaves behind: peers that joined under `oldId` keep reaching the space now called
 * `newId`. Appended AFTER any existing key for the space, so the network id — the first key — is unchanged.
 */
export function appendInboundAlias(net: Pick<NetworkConfig, 'spaceMap'>, oldId: string, newId: string): void {
  if (oldId === newId || !isSpaceId(oldId) || !isSpaceId(newId)) return;
  const map = (net.spaceMap ??= {});
  if (map[oldId] === undefined || map[oldId] === oldId) map[oldId] = newId;
}

/**
 * A local space renamed from `oldId` to `newId`: the network keeps calling it by its network id, and only the LOCAL
 * end of each alias moves (Q-133).
 *
 * - Every key that pointed at `oldId` now points at `newId`, in place, so the first key — the network id — stays first
 *   and `localToRemote(newId)` answers what the network has always called it.
 * - Renaming a mapped space back to its network id leaves a self-alias; it is deleted, and no inbound alias is added,
 *   because the space now answers to the network id by its own name and an added key would come FIRST.
 * - Otherwise `oldId` is appended as an inbound alias (`appendInboundAlias`).
 */
export function retargetSpaceAliases(net: Pick<NetworkConfig, 'spaceMap'>, oldId: string, newId: string): void {
  const map = (net.spaceMap ??= {});
  for (const [remote, local] of Object.entries(map)) if (local === oldId) map[remote] = newId;
  if (map[newId] === newId) delete map[newId];
  else appendInboundAlias(net, oldId, newId);
  if (Object.keys(map).length === 0) delete net.spaceMap;
}

/**
 * A space leaving the network: EVERY key reaching it goes — its network id and any inbound alias a rename left. Deleting
 * only the first left the second behind to capture the next space re-added under that name.
 */
export function forgetSpaceAliases(net: Pick<NetworkConfig, 'spaceMap'>, localId: string): void {
  if (!net.spaceMap) return;
  for (const [remote, local] of Object.entries(net.spaceMap)) if (local === localId) delete net.spaceMap[remote];
  if (Object.keys(net.spaceMap).length === 0) delete net.spaceMap;
}

/**
 * Whether `id` is already the network id of ANOTHER local space here — so a space created or renamed to `id` could
 * not be told apart from it by any peer, and would never reach one (`api/sync/space-alias.ts` sends every request for
 * `id` to the space the alias names).
 */
export function networkIdTaken(net: Pick<NetworkConfig, 'spaceMap'>, id: string): boolean {
  const local = net.spaceMap?.[id];
  return local !== undefined && local !== id;
}

/**
 * Why a local space may not be called `id` in these networks, or `null` — one sentence for every door that asks
 * (create-into-network, add-space, rename), so REST and MCP refuse in the same words. Worded without "network id":
 * the operator knows their spaces by name, and the name is what collides.
 */
export function spaceNameInUseRefusal(
  networks: readonly Pick<NetworkConfig, 'label' | 'spaceMap'>[],
  id: string,
): string | null {
  const net = networks.find(n => networkIdTaken(n, id));
  if (!net) return null;
  return `Another space, '${net.spaceMap![id]}', already syncs as '${id}' in network '${net.label}', so a second `
    + `space under that name would never reach a peer. Choose another name.`;
}

/** A refusal with the machine code a client translates by. The code is additive; `message` stays the sentence. */
export class SpaceNameInUseError extends Error {
  readonly code: NetworkRefusalCode = 'space_name_in_use';
  constructor(message: string) { super(message); this.name = 'SpaceNameInUseError'; }
}

/**
 * The local space a space round is about here, or `null` when this network does not carry it.
 *
 * A round names its space twice since `Q-133`: `spaceId` as it always did (a 5.0 or 5.1 peer applies it raw), and
 * `networkSpaceId`, the network's id for it. A receiver prefers the network id and falls back to `spaceId` only for a
 * round from an older proposer — never after a `networkSpaceId` that resolves to nothing, or a round naming a space
 * this network does not carry could be pointed at one it does.
 */
export function roundSpaceLocalId(
  net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>,
  round: { spaceId?: string; networkSpaceId?: string },
): string | null {
  if (round.networkSpaceId !== undefined) return carriedLocalId(net, round.networkSpaceId);
  return carriedLocalId(net, round.spaceId);
}
