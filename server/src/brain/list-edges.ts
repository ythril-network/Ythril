import { col, asFilter } from '../db/mongo.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { toMongoSort, LANDING_ORDER, type SortSpec } from './list-sort.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import { conveniencePredicate, conveniencesFrom } from './list-conveniences.js';
import { listReadMaxMs } from './tag-filter.js';
import { spaceCollection } from '../db/space-collection.js';
import type { EdgeDoc } from '../config/types.js';

/**
 * The edge-list read, moved out of `brain/edges.ts` (Q-652) along its own seam: it is a read of the edges
 * collection by filter, page and sort, and shares nothing with the write paths that file holds. `edges.ts`
 * is a frozen file, so a read that lives there costs a write its room.
 */

/** List edges for a space, optionally filtering by from/to entity */
export async function listEdges(
  spaceId: string,
  filter: { from?: string; to?: string; label?: string; type?: string; tag?: string; search?: string; description?: string; properties?: string; fromIds?: string[]; toIds?: string[] } = {},
  limit = 50,
  skip = 0,
  sort?: SortSpec,
): Promise<EdgeDoc[]> {
  /*
   * The edge's OWN filters: its endpoints and its label. The five common conveniences —
   * `tag`, `type`, `description`, `properties`, `search` — go through `conveniencePredicate`, the module
   * the `filter` tool also calls, so an agent and the Edges tab cannot come to mean different things.
   */
  const base: Record<string, unknown> = { spaceId };
  if (filter.from) base['from'] = filter.from;
  if (filter.to) base['to'] = filter.to;
  if (filter.label) base['label'] = filter.label;
  // Name filters arrive already resolved to ids (per member). An EMPTY list means "no entity by that
  // name", so it must filter to nothing — not be skipped, which would silently show everything.
  if (filter.fromIds) base['from'] = { $in: filter.fromIds };
  if (filter.toIds) base['to'] = { $in: filter.toIds };
  // `filter` already spells the five convenience names exactly as the module reads them, so it is passed
  // whole rather than re-listed — a re-listing here is the sixth copy this module exists to remove.
  const merged = conveniencePredicate('edges', conveniencesFrom(filter as Record<string, unknown>), base);
  // `edges` has searchable fields, so the refusal branch is unreachable — throwing rather than falling
  // back to `base` keeps a silent full-collection read from ever being the answer here.
  if ('error' in merged) throw new Error(merged.error);
  const q = merged.predicate;
  return col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
    // The deadline is an option of the read, not a call on its cursor (Q-358; see `listChrono`).
    .find(asFilter<EdgeDoc>(q), {
      projection: NEVER_RETURNED_PROJECTION,
      maxTimeMS: listReadMaxMs(Boolean(q['$expr'])),
    })
    .sort(sort ? toMongoSort(sort) : { ...LANDING_ORDER })
    .skip(parseSkip(skip))
    .limit(parseLimit(limit, 20, 1000))
    .toArray() as Promise<EdgeDoc[]>;
}
