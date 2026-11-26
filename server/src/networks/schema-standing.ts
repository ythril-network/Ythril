/**
 * Where this instance stands toward a voted network's schema for a space (`Q-966`): did it create the network, who admitted it, and does it hold
 * the network's whole schema for the space.
 *
 * ## What it prevents
 *
 * A voted network (club, closed, democratic) has no upstream to pull a schema from, so the member's schema is the network's layer, and each
 * answer here decides one thing the heal and the door must agree on:
 *
 * - `createdHere`: the instance that created the network never takes a layer (its own definitions are where the network's schema began), and
 *   serves them as the network's. A network stored before 5.2.0 has no `origin`, which everywhere else reads as JOINED; a creator of that age is
 *   told apart by what it holds: no `origin`, no `admittedVia`, and own definitions for the space.
 * - `admitterOf`: the one member a layer may be taken from. A network stored before the admitter was recorded has none, and the member the join
 *   pushed first (`members[0]`, the inviter) is it; any member answering would let one that has not healed hand over a bare meta.
 * - `layerSeeded` / `markLayerSeeded`: the heal runs while the layer is not SEEDED, never only while it is absent: a layer a passed round wrote
 *   onto nothing holds that round's changed fields, and a member holding only those was never healed.
 */
import type { NetworkConfig, SpaceConfig } from '../config/types.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { replicatedMetaOf } from '../sync/replicated-meta.js';

type Standing = Pick<NetworkConfig, 'origin' | 'admittedVia'>;

/** Does this instance's own definitions for the space hold anything a network could have been given? */
function holdsOwnDefinitions(space: Pick<SpaceConfig, 'ownMeta' | 'meta'> | undefined): boolean {
  return Object.keys(replicatedMetaOf(space?.ownMeta ?? space?.meta)).length > 0;
}

/** Did this instance create `net`, as far as it can tell for `space`? An absent `origin` reads as joined, but for a creator that predates the field. */
export function createdHere(net: Standing, space: Pick<SpaceConfig, 'ownMeta' | 'meta'> | undefined): boolean {
  if (net.origin !== undefined) return net.origin === 'created';
  return net.admittedVia === undefined && holdsOwnDefinitions(space);
}

/** The member a layer may be taken from: who admitted this instance, or the member the join pushed first when that was not recorded. */
export function admitterOf(net: Pick<NetworkConfig, 'admittedVia' | 'members'>): string | undefined {
  return net.admittedVia ?? net.members[0]?.instanceId;
}

/** Does this instance hold the network's whole schema for the space (`'layer'`), or is its own definitions the network's (`'own'`)? */
export function seededAs(net: Pick<NetworkConfig, 'schemaLayerSeeded'>, spaceId: string): 'layer' | 'own' | undefined {
  return net.schemaLayerSeeded?.[spaceId];
}

/** Is the space's schema in this network settled here: the heal has nothing to take? */
export const layerSeeded = (net: Pick<NetworkConfig, 'schemaLayerSeeded'>, spaceId: string): boolean => seededAs(net, spaceId) !== undefined;

/**
 * Record that the space's schema is settled in network `networkId` here, saving the config only when the mark changes (a pull that finds
 * the same layer again writes nothing). @returns whether it changed.
 */
export function markLayerSeeded(networkId: string, spaceId: string, as: 'layer' | 'own'): boolean {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net || net.schemaLayerSeeded?.[spaceId] === as) return false;
  (net.schemaLayerSeeded ??= {})[spaceId] = as;
  saveConfig(cfg);
  return true;
}
