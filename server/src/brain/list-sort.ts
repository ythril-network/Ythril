/**
 * Server-side sort for the brain list endpoints.
 *
 * The brain lists are paginated (`limit`/`skip`), so sorting can never be a client-only header
 * click: reordering just the visible page would lie about the rest of the set. The sort therefore
 * has to be a Mongo `.sort()` applied before `.skip().limit()`, threaded from the route into the
 * list function — which is what this module parses and validates.
 *
 * The field set is whitelisted per collection. A Mongo sort key is not injectable the way a
 * `$where` is, but an unbounded field set invites index misses and surprises, and a silently
 * ignored sort is the same dishonesty as a no-op control — so an unknown field is a 400, never a
 * quiet fall-back to natural order.
 */

/** A validated sort request: a whitelisted field and a direction (1 asc, -1 desc). */
export interface SortSpec {
  field: string;
  dir: 1 | -1;
}

/**
 * Sortable fields per collection. `createdAt` everywhere; the human-meaningful columns each tab
 * shows are added where they exist as stored, comparable fields. Derived values (e.g. chrono's
 * `overdue` status, which is computed from the due moment and never stored) are deliberately left
 * out — sorting by a stored `status` that disagrees with the displayed one would mislead.
 */
// Deliberately ABSENT and not an oversight: `properties` (a free-form JSON blob — there is no single
// value to order by) and every LINK field (`linkEntities` and its siblings are instructions to write link
// records, not stored values, and the 4.x array names they replaced are refused outright). Both were
// considered and rejected; leaving that unwritten is how they get "fixed" into the list later by someone
// reading it as a gap.
export const SORTABLE_FIELDS = {
  entities: new Set<string>(['createdAt', 'name', 'type']),
  edges: new Set<string>(['createdAt', 'label', 'from', 'to', 'type', 'weight']),
  facts: new Set<string>(['createdAt', 'type']),
  chrono: new Set<string>(['createdAt', 'title', 'startsAt', 'endsAt', 'status', 'type']),
  files: new Set<string>(['createdAt', 'updatedAt', 'path']),
  /*
   * `links` was MISSING while `query`'s `collection` enum already listed it, so the lookup was
   * `undefined` and `allowed.has()` threw a 500 where the tool text promises a refusal naming the
   * allowed fields. Reported by the canary operator 2026-09-15, reproduced with `sort: "createdAt"`.
   *
   * A link has no name, no title and no type of its own — it IS a pair of endpoints — so what is
   * sortable is when it was written and which records it joins.
   */
  links: new Set<string>(['createdAt', 'updatedAt', 'from', 'to']),
} as const;

/** Result of parsing `?sort=&dir=`: a spec, an explicit no-sort, or a client error to 400 on. */
export type SortParse = { sort: SortSpec } | { sort: undefined } | { error: string };

/** Parse a `dir` query value. Empty/absent defaults to descending (newest-first). */
function parseDir(raw: unknown): 1 | -1 | null {
  if (raw === undefined || raw === '') return -1;
  if (typeof raw !== 'string') return null;
  const s = raw.toLowerCase();
  if (s === 'asc' || s === '1') return 1;
  if (s === 'desc' || s === '-1') return -1;
  return null;
}

/**
 * Parse `?sort=field&dir=asc|desc` against a collection's whitelist.
 *
 * No `sort` at all → `{ sort: undefined }`, and the list function keeps its existing default order
 * (a characterization guarantee: no existing caller shifts). A `sort` outside the whitelist, or a
 * malformed `dir`, → `{ error }` for the route to answer with 400.
 */
export function parseSortParam(
  rawField: unknown,
  rawDir: unknown,
  /**
   * The collection's sortable set, or `undefined` for a collection that declares none.
   *
   * **`undefined` is accepted on purpose, and this is the forgettable part being put inside.** Both doors
   * index `SORTABLE_FIELDS[collection]` and hand the result straight here. When `links` was missing from
   * that map the value was `undefined`, `allowed.has()` threw, and a caller got a 500 where this function's
   * own contract promises a refusal naming the allowed fields — two call sites, one rule, and neither of
   * them the place to notice. A collection added to a `collection` enum and not to the map now REFUSES a
   * sort instead of crashing on one.
   */
  allowed: ReadonlySet<string> | undefined,
): SortParse {
  if (rawField === undefined || rawField === '') return { sort: undefined };
  if (!allowed) {
    return { error: 'Sorting is not supported on this collection' };
  }
  if (typeof rawField !== 'string') {
    return { error: '`sort` must be a single field name' };
  }
  if (!allowed.has(rawField)) {
    return { error: `Cannot sort by '${rawField}'. Sortable fields: ${[...allowed].join(', ')}` };
  }
  const dir = parseDir(rawDir);
  if (dir === null) {
    return { error: "`dir` must be 'asc' or 'desc'" };
  }
  return { sort: { field: rawField, dir } };
}

/**
 * Build the Mongo sort document for a validated spec, appending `_id` as a stable tiebreaker so
 * pagination is deterministic across a page boundary when the primary field has ties.
 */
export function toMongoSort(sort: SortSpec): Record<string, 1 | -1> {
  return { [sort.field]: sort.dir, _id: sort.dir };
}
