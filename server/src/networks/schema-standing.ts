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
 *   serves them as the network's. `origin` says it and nothing else does: a network stored before 5.2.0 has none, which everywhere else reads as
 *   JOINED, and no other field tells a creator of that age from a joiner (the create path and the join path both write `joinedBy`,
 *   `spaceOrigins` and `createdAt`). Owning definitions never proves creation: a pre-5.2 joiner that proposed a change owns them too, and read as
 *   the creator it never healed. A pre-5.2 creator therefore reads as a member that has not healed: it serves `networkSeeded: false`, so no
 *   joiner takes its layer for the whole schema, and it takes a layer only from the member that admitted it, once that member serves one whole.
 * - `admitterOf`: the one member a layer may be taken from. A network stored before the admitter was recorded has none, and so has one whose
 *   admitter has left; the member the join pushed first (`members[0]`) is it. Any member answering would let one that has not healed hand over
 *   a bare meta.
 * - `layerSeeded` / `markLayerSeeded`: the heal runs while the layer is not SEEDED, never only while it is absent: a layer a passed round wrote
 *   onto nothing holds that round's changed fields, and a member holding only those was never healed.
 * - `servedNetworkPart`: what the door answers as the network's schema, so a test reaches the decision the route used to hold inline.
 */
import type { NetworkConfig } from '../config/types.js';
import { getConfig, saveConfig } from '../config/loader.js';

/** Did this instance create `net`? Only `origin` says so; an absent one reads as joined (see the file's header for what that costs a pre-5.2 creator). */
export function createdHere(net: Pick<NetworkConfig, 'origin'>): boolean {
  return net.origin === 'created';
}

/** The member a layer may be taken from: who admitted this instance while it is still a member, else the member the join pushed first. */
export function admitterOf(net: Pick<NetworkConfig, 'admittedVia' | 'members'>): string | undefined {
  if (net.admittedVia !== undefined && net.members.some(m => m.instanceId === net.admittedVia)) return net.admittedVia;
  return net.members[0]?.instanceId;
}

/** Does this instance hold the network's whole schema for the space (`'layer'`), or is its own definitions the network's (`'own'`)? */
export function seededAs(net: Pick<NetworkConfig, 'schemaLayerSeeded'>, spaceId: string): 'layer' | 'own' | undefined {
  return net.schemaLayerSeeded?.[spaceId];
}

/** Is the space's schema in this network settled here: the heal has nothing to take? */
export const layerSeeded = (net: Pick<NetworkConfig, 'schemaLayerSeeded'>, spaceId: string): boolean => seededAs(net, spaceId) !== undefined;

/**
 * What `GET /api/sync/meta` answers for a space of a voted network as the network's own part, and whether it is the whole schema. The creator's own
 * definitions are the network's, and so are a proposer's of a space it proposed; any other member holds the network's schema as its LAYER and its
 * own definitions are not the network's to hand on (what a joiner stored would depend on who invited it). `networkSeeded` is false for a member
 * that has not healed, whose layer may be only a round's changed fields: its answer is never taken as the whole schema. `layer` is read only when
 * it is what is served.
 */
export function servedNetworkPart<T>(
  net: Pick<NetworkConfig, 'origin' | 'schemaLayerSeeded'>, spaceId: string, own: T, layer: () => T,
): { network: T; networkSeeded: boolean } {
  const seeded = seededAs(net, spaceId);
  const ownIsNetworks = createdHere(net) || seeded === 'own';
  return { network: ownIsNetworks ? own : layer(), networkSeeded: ownIsNetworks || seeded === 'layer' };
}

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
