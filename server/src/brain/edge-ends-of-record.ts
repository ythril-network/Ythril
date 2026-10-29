/**
 * Which end of an edge IS a given record: the one place that asks, in a query and in memory.
 *
 * ## The question it answers
 *
 * "Is this edge's `from` (or `to`) record `id` of kind `kind`?" An edge end is a PAIR — an id and a kind (`fromKind` / `toKind`, absent for an
 * entity, `edgeEndpointKind`). Ids are minted per collection, so one string can name a fact and an entity at once; an end matches a record only when
 * both halves do.
 *
 * ## What it prevents (Q-321)
 *
 * The relink read `{ $or: [{ from: id }, { to: id }] }` and compared `edge.from === absorbedId`: by id alone. A merge of entity A therefore moved the
 * edges of a FACT that happened to hold A's id onto the survivor entity, and the fork resolve of a fact or a chrono entry did the same to an entity's
 * edges. The clause had been written three times (the relink, the reference scan `findEntityReferences`, the identity read `storedEdgeIdentities`)
 * and two of them had the kind. A reader and a writer that spell the rule differently count different sets: the relink's bound counted one set and
 * moved another. So the query form ({@link endIsRecord}, {@link edgeEndsAt}) and the in-memory form ({@link endsOfRecord}, {@link relinkedEnds}) live
 * here side by side, and `an-edge-end-is-matched-by-kind-as-well-as-id` holds that no brain module spells either by hand.
 *
 * An absent kind is an ENTITY end, which is why an entity matches a stored kind of absent or `'entity'` and nothing else matches an absent one.
 */
import { edgeEndpointKind } from './entity-refs.js';
import type { RefKind } from '../config/types-knowledge.js';

/** What of an edge this module reads: the two ends and their kinds. */
export interface EdgeEnds {
  from?: unknown;
  to?: unknown;
  fromKind?: RefKind;
  toKind?: RefKind;
}

/**
 * The Mongo clause for "this edge's `side` end is record `id` of `kind`". An entity end matches a stored kind of absent or `'entity'`
 * (`$in` with `null` matches a missing field, and the form can use the `from`/`to` index prefix, which `$exists: false` cannot).
 */
export function endIsRecord(side: 'from' | 'to', id: string, kind: RefKind): Record<string, unknown> {
  return { [side]: id, [`${side}Kind`]: kind === 'entity' ? { $in: [null, 'entity'] } : kind };
}

/** The filter fragment for "either end of this edge is record `id` of `kind`", to be spread into an edge filter beside `spaceId`. */
export function edgeEndsAt(id: string, kind: RefKind): { $or: Record<string, unknown>[] } {
  return { $or: [endIsRecord('from', id, kind), endIsRecord('to', id, kind)] };
}

/** Which ends of `edge` are record `id` of `kind` — the in-memory twin of {@link endIsRecord}, so a reader and a writer cannot disagree. */
export function endsOfRecord(edge: EdgeEnds, id: string, kind: RefKind): { from: boolean; to: boolean } {
  return {
    from: edge.from === id && edgeEndpointKind(edge.fromKind) === kind,
    to: edge.to === id && edgeEndpointKind(edge.toKind) === kind,
  };
}

/** `edge`'s ends with each end that is record `absorbed` of `kind` pointed at `survivor` — the relink's one spelling. The kinds travel with the edge unchanged. */
export function relinkedEnds(
  edge: EdgeEnds & { from: string; to: string }, absorbed: string, survivor: string, kind: RefKind,
): { from: string; to: string } {
  const is = endsOfRecord(edge, absorbed, kind);
  return { from: is.from ? survivor : edge.from, to: is.to ? survivor : edge.to };
}
