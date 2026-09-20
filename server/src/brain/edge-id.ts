/**
 * An edge's `_id`, derived from the relationship it represents.
 *
 * ## Why derive it
 *
 * The id was `uuidv4()`. The collection carries a unique index on `(from, to, label)`
 * (`spaces/lifecycle.ts`), so the relationship itself can only be stored once — what happened instead was that
 * two peers each stored it under a DIFFERENT id, sync exchanged them, and the receiving insert violated that
 * index. One relationship, two identities, and a duplicate key on every cycle.
 *
 * Derived, the two peers arrive at the same `_id` without talking, and the collision becomes an idempotent
 * no-op instead of an error. Owner ruled this on 2026-08-30.
 *
 * ## `spaceId` is deliberately NOT part of the key
 *
 * It is the obvious thing to include, and the plan document still spells it that way. It is wrong.
 * `sync/space-map.ts` lets the same logical space live under a different local id on each peer, so a key
 * including `spaceId` derives differently on the two sides — reproducing the very defect this removes, and
 * reproducing it precisely on the networks that configured aliasing, where it is hardest to see. The
 * collection is per-space already: the space is in its name, not in the key.
 *
 * ## Why the parts are length-prefixed
 *
 * `${from}|${to}|${label}` is ambiguous the moment any part can contain the separator: `('a|b', 'c', 'd')` and
 * `('a', 'b|c', 'd')` produce one key for two different relationships, which would make them collide under the
 * unique index while being genuinely distinct. Endpoint ids are UUIDs today, but a **label is
 * operator-supplied text** and nothing forbids a pipe in it. Prefixing each part with its length makes the
 * encoding injective regardless of what the parts contain.
 *
 * ## An edge whose identity CHANGES is re-keyed onto the id it now derives
 *
 * Mongo's `_id` is **immutable**, and two paths change what an edge IS: `merge.ts` relinks an endpoint, and
 * `updateEdgeById` accepts a new `label`. Both used to write in place, which left the edge under an id its own
 * identity no longer derived — so the next peer to create that triplet derived the correct id, inserted, and
 * hit the unique index. The defect this file removes, surviving on the two paths that matter most.
 *
 * Both now call `rekeyEdge` (`edge-rekey.ts`), which does the delete-and-insert and owns what makes one safe
 * on a synced collection: a real tombstone for the old id, and an insert seq taken AFTER the tombstone's, so a
 * peer that pulls the delete and stops picks the edge up on its next pull rather than being left with neither.
 *
 * ## The narrowed limit: an edge this instance did not AUTHOR keeps its id
 *
 * A peer applies a tombstone only when the document it names was authored by the tombstone's issuer — the rule
 * that stops one instance deleting another's content. Edges replicate carrying their original author, so a
 * tombstone we issue for a peer-authored edge is silently dropped while the insert half propagates, leaving
 * that peer holding both rows. `rekeyEdge` therefore declines such an edge and the caller relinks it in place,
 * which is what happened before and which converges.
 *
 * Lifting that needs a delete a peer can apply without authorship — a tombstone naming its successor, applied
 * as a MOVE. That is a change to a sync contract two other parties consume.
 *
 * Existing edges keep their v4 ids. There is no migration, because a derived id only has to be agreed on by
 * peers creating an edge from now on.
 */
import { v5 as uuidv5 } from 'uuid';
import { edgeEndpointKind } from './entity-refs.js';
import type { RefKind } from '../config/types-knowledge.js';

/**
 * The namespace for edge identity. Fixed forever: changing it re-derives every future id and silently splits
 * new edges from ones already stored on a peer that has not upgraded.
 *
 * Itself a v5 UUID of `ythril.edge-identity` under the DNS namespace, so it is reproducible rather than a
 * number somebody typed — but written as a literal, because deriving it at import time would make the value
 * depend on a library detail rather than on this file.
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
 * ## The endpoint KINDS are part of the identity, and appended only when they have to be (M-3)
 *
 * Since M-1 an endpoint can be an entity, a fact, a chrono entry or a file, and **each collection assigns
 * its own UUIDs** — so a fact and an entity may hold the same id. Without the kinds in the key,
 * `(X) -[mentions]-> (Y as entity)` and `(X) -[mentions]-> (Y as fact)` are two relationships deriving one
 * id: a duplicate key under the unique index, on every sync cycle, which is the defect deriving the id was
 * introduced to remove arriving back through the widened endpoint.
 *
 * **They are appended only when at least one kind is not `entity`, and that is a compatibility requirement
 * rather than an optimisation.** A peer on an older build calls this with three arguments. If the kinds were
 * appended unconditionally, that peer and this one would derive different ids for the same ordinary edge and
 * re-open the duplicate-key loop — on precisely the networks that are mid-upgrade, where it is hardest to
 * attribute. So the entity-to-entity key is BYTE-IDENTICAL to the one this function has always produced, and
 * `an-edge-id-includes-its-endpoint-kinds.test.js` holds it to a hardcoded id rather than to a recomputed one.
 *
 * A combination involving any other kind could not exist before M-1, so it has no older peer to agree with and
 * is free to derive something new.
 *
 * The kinds go at the END for the same reason: prepending them would change the entity-to-entity key.
 *
 * The plan document words the rule as `uuidv5(canonical(fromKind, from, toKind, to, label))`, which read
 * literally re-derives every existing edge. The intent is that the kinds are part of the identity; the
 * placement above is what delivers that without splitting a live network.
 */
export function edgeIdFor(
  from: string,
  to: string,
  label: string,
  fromKind?: string,
  toKind?: string,
): string {
  /*
   * The SHARED coalescer, not a local `?? 'entity'`.
   *
   * This module had its own copy — a sixth, after the four doors and the definition — and it decides the
   * edge's IDENTITY. Agreeing today is not the property that matters: the day the default changes, an id
   * derived here would disagree with the kind stored beside it, and the two would describe different edges
   * while looking like one. Found by `Q-6` on 2026-09-07, when the gate whose title said "no door" stopped
   * reading four named files and started reading the server.
   */
  const fk = edgeEndpointKind(fromKind as RefKind | undefined);
  const tk = edgeEndpointKind(toKind as RefKind | undefined);
  const kinds = fk === 'entity' && tk === 'entity' ? '' : `${part(fk)}${part(tk)}`;
  return uuidv5(`${part(from)}${part(to)}${part(label)}${kinds}`, EDGE_NAMESPACE);
}

/**
 * The id of a SYNTHETIC traverse edge — the link from an entity to a chrono entry, fact or file.
 *
 * ## What it replaces, and why that was wrong in both directions
 *
 * These edges used to carry the TARGET DOCUMENT'S OWN `_id`, on this rationale: *"nothing has to invent an
 * edge id that does not exist — a caller looking it up finds the chrono, not a 404."*
 *
 * **The consumer half of that was the exact opposite of true.** `getEdgeById` queries `${spaceId}_edges` and
 * nothing else, and a chrono lives in `_chrono`, a fact in `_facts`, a file in `_files`. So the
 * "helpful" id 404s on every edge-lookup path the product actually has — `GET /edges/:id`, the PATCH, and
 * `update_edge`. The one lookup that does resolve is `GET /chrono/:id`, which needs an id the caller already
 * has from the NODE. The affordance was never delivered; only the collision was.
 *
 * **And it made the links disappear.** A graph library has ONE id namespace for nodes and edges — cytoscape
 * skips a repeated id with a bare `continue` inside its `Collection` constructor, before the code path that
 * would have thrown. Nodes are added before edges, so the node always won and the edge was always dropped,
 * silently. What an operator saw was a detached band of chrono bubbles floating above the graph, connected
 * to nothing, with no console output and an edge count that overreported by exactly that many.
 *
 * ## The shape
 *
 * Label-prefixed and carrying both endpoints, so it can collide with neither a stored edge `_id` (a UUID) nor
 * any node id (also a UUID). Two seeds linking to the SAME chrono entry produce two different edges, which is
 * correct — they are two different relationships — and under the old scheme they were one id twice.
 *
 * It is deliberately NOT a UUID: a synthetic edge has no stored record, and an id shaped like a real one
 * invites exactly the lookup that cannot work. This one says what it is.
 */
export function syntheticEdgeId(label: string, from: string, to: string): string {
  return `${label}:${from}:${to}`;
}
