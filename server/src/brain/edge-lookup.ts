/**
 * Find an edge by its identity triplet.
 *
 * ## Its own module because two sides need it and they must not import each other
 *
 * `(from, to, label)` IS an edge's identity — there is no id in an upsert request to signal that a repeat write
 * is an update — so both the write path and the validation path have to resolve it.
 *
 * Since 2026-08-29 `upsertEdge` validates the record it will produce, rather than trusting each caller to have
 * validated first (two doors did; `api/contradictions.ts` and `brain/bulk.ts` did not, and reached the
 * collection around the rule). That made `brain/edges.ts` import `brain/write-validation.ts` — which already
 * imported this lookup back out of `edges.ts`, closing a runtime import cycle that
 * `server-modules-form-no-runtime-import-cycle.test.js` refuses.
 *
 * In ESM such a cycle is legal until one side reads a binding during module evaluation, at which point it is
 * `undefined` and the failure surfaces as a `TypeError` a long way from its cause. So the shared leaf moves
 * here and both sides depend on it instead of on each other — the same reasoning that produced
 * `brain/spill-path.ts`.
 */
import { col, asFilter } from '../db/mongo.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import { storedEdgeKind } from './entity-refs.js';
import type { EdgeDoc } from '../config/types.js';
import type { RefKind } from '../config/types-knowledge.js';
import { spaceCollection } from '../db/space-collection.js';

/**
 * The stored edge with this identity, or `null`.
 *
 * Projected through `NEVER_RETURNED_PROJECTION` like every other read: the embedding vector never leaves the
 * database, and a validation path that accidentally carried one would put it into an error response.
 *
 * ## The KINDS are part of the identity too (M-3)
 *
 * Since M-1 an endpoint can be an entity, a fact, a chrono entry or a file, and each collection assigns its
 * own UUIDs — so `(X, Y, mentions)` with Y an entity and the same triplet with Y a fact are two
 * relationships. Filtering on the triplet alone, an upsert would read one of them and write the other.
 *
 * **`null` rather than `undefined`, and that distinction is the whole of the filter.** A `undefined` value is
 * DROPPED by the driver, so it is not a constraint at all — the query would match an edge of any kind and the
 * check would silently pass. `null` matches a missing field, which is what an entity endpoint stores:
 * `storedEdgeKind` normalises `'entity'` to absent so there is exactly one representation to match.
 */
export async function findEdgeByTriplet(
  spaceId: string, from: string, to: string, label: string,
  fromKind?: RefKind, toKind?: RefKind,
): Promise<EdgeDoc | null> {
  return await col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
    .findOne(asFilter<EdgeDoc>({ spaceId, ...tripletClause({ from, to, label, fromKind, toKind }) } as never),
      { projection: NEVER_RETURNED_PROJECTION }) as EdgeDoc | null;
}

/**
 * The exact match for one identity triplet, kinds included, as a filter clause. Shared with the write planners'
 * batched read, which `$or`s one clause per triplet: the `?? null` below is the line a hand-written copy drops,
 * and without it the clause matches an edge of ANY kind (see `findEdgeByTriplet`).
 */
export function tripletClause(
  t: { from: string; to: string; label: string; fromKind?: RefKind; toKind?: RefKind },
): Record<string, unknown> {
  return {
    from: t.from, to: t.to, label: t.label,
    fromKind: storedEdgeKind(t.fromKind) ?? null,
    toKind: storedEdgeKind(t.toKind) ?? null,
  };
}
