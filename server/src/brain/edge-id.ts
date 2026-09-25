/**
 * An edge's `_id`, derived from the relationship it represents.
 *
 * Derived so two peers creating the same relationship arrive at the same `_id` without talking: the collection
 * has a unique index on `(from, to, label)` (`spaces/lifecycle.ts`), and random ids made sync's insert of the
 * peer's copy a duplicate key on every cycle.
 *
 * - **`spaceId` is deliberately NOT part of the key.** `sync/space-map.ts` lets one logical space live under a
 *   different local id on each peer, so including it would re-split the id exactly on aliased networks. The
 *   space is in the collection name already.
 * - **Parts are length-prefixed** so the encoding is injective: a label is operator text and may contain any
 *   separator, and `('a|b','c','d')` must not collide with `('a','b|c','d')`.
 * - **An edge whose identity changes is re-keyed.** `_id` is immutable, and `merge.ts` (relinking an endpoint)
 *   and `updateEdgeById` (a new label) both change the identity; both call `rekeyEdge` (`edge-rekey.ts`), which
 *   tombstones the old id and takes the insert seq AFTER the tombstone's so a peer is never left with neither.
 * - **Except an edge this instance did not author**: a peer applies only its issuer's own tombstones, so the
 *   delete would be dropped while the insert propagates. `rekeyEdge` declines and the caller relinks in place.
 *   Lifting that needs a sync-contract change (a tombstone applied as a MOVE).
 *
 * Existing v4 ids are not migrated; only peers creating an edge from now on have to agree.
 */
import { v5 as uuidv5 } from 'uuid';
import { edgeEndpointKind } from './entity-refs.js';
import type { RefKind } from '../config/types-knowledge.js';

/**
 * The namespace for edge identity. Fixed forever: changing it re-derives every future id and silently splits
 * new edges from ones already stored on a peer that has not upgraded.
 *
 * It is the v5 UUID of `ythril.edge-identity` under the DNS namespace, written as a literal so the value
 * depends on this file rather than on a library detail.
 */
const EDGE_NAMESPACE = '8fdb66f3-a72f-574e-91a9-55e2a04e19a7';

/** Length-prefixed so no part can forge the separator. See the docblock. */
const part = (s: string): string => `${s.length}:${s}`;

/**
 * The `_id` for the relationship `(from) -[label]-> (to)`.
 *
 * Order matters: `(a)-[knows]->(b)` and `(b)-[knows]->(a)` are two rows under the unique index, so they must
 * be two ids. Sorting the endpoints to make this symmetric would silently merge them.
 *
 * **The endpoint kinds are part of the identity**, because each collection assigns its own UUIDs: an entity
 * and a fact may share an id, and without the kinds two relationships would derive one `_id`.
 *
 * **They are appended, at the END, only when a kind is not `entity`** — a compatibility requirement: older
 * peers derive from three arguments, so the entity-to-entity key must stay BYTE-IDENTICAL or mid-upgrade
 * networks split every ordinary edge. `an-edge-id-includes-its-endpoint-kinds.test.js` pins it to hardcoded
 * ids. Other kind combinations had no older peer, so they are free to derive something new.
 */
export function edgeIdFor(
  from: string,
  to: string,
  label: string,
  fromKind?: string,
  toKind?: string,
): string {
  // The SHARED coalescer, not a local `?? 'entity'`: if the default ever changes, a local copy would derive an
  // id that disagrees with the kind stored beside it.
  const fk = edgeEndpointKind(fromKind as RefKind | undefined);
  const tk = edgeEndpointKind(toKind as RefKind | undefined);
  const kinds = fk === 'entity' && tk === 'entity' ? '' : `${part(fk)}${part(tk)}`;
  return uuidv5(`${part(from)}${part(to)}${part(label)}${kinds}`, EDGE_NAMESPACE);
}

/**
 * The id of a SYNTHETIC traverse edge — the link from an entity to a chrono entry, fact or file.
 *
 * Must NOT reuse the target document's `_id`: a graph library has one id namespace for nodes and edges
 * (cytoscape silently drops the repeated id, so the edge vanishes), and edge lookups only search `_edges`, so
 * that id 404s anyway. Label-prefixed with both endpoints, it collides with no UUID, and two seeds linking one
 * chrono entry get two edges. Deliberately not UUID-shaped: there is no stored record to look up.
 */
export function syntheticEdgeId(label: string, from: string, to: string): string {
  return `${label}:${from}:${to}`;
}
