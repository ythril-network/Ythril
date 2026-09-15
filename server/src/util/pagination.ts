/**
 * Safe pagination-parameter parsing for list endpoints.
 *
 * `Number('abc')` is `NaN` and `Math.min(NaN, max)` is `NaN`, which flows
 * unbounded into MongoDB `.limit()`. These helpers coerce to a bounded integer
 * so a garbage or out-of-range `?limit=`/`?skip=` can never produce an
 * unbounded or degenerate query.
 */

/** Parse a `limit` query value into an integer in `[1, max]`, falling back to `def` on garbage. */
export function parseLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** Parse a `skip` query value into a non-negative integer (0 on garbage/negative). */
export function parseSkip(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/**
 * Cap a merged, cross-space (proxy) list result to `limit`. Each member space is
 * already limited to `limit`, so a proxy of N members can return up to N × limit
 * rows; this bounds the response to the requested page size. Only re-sorts when it
 * actually overflows, so single-space results — already sorted and limited by the
 * query — are returned untouched.
 *
 * The re-sort must agree with what the query asked for: when the route requested a
 * `sort`, a proxy overflow re-sorts by that same field/direction, otherwise it would
 * silently reorder the merged page against the caller's sort. With no requested sort
 * it falls back to `createdAt` desc — the collections' natural default.
 */
export function capPage<T>(rows: T[], limit: number, sort?: { field: string; dir: 1 | -1 }): T[] {
  if (rows.length <= limit) return rows;
  const field = sort?.field ?? 'createdAt';
  const dir = sort?.dir ?? -1;
  const val = (r: T) => String((r as Record<string, unknown>)[field] ?? '');
  return [...rows].sort((a, b) => dir * val(a).localeCompare(val(b))).slice(0, limit);
}

/**
 * Pagination parameter names we do NOT have, mapped to the one we do.
 *
 * The fleet integrator paged `/memories?limit=300&offset=N` in a loop. `offset` is not a parameter of ours — the routes read `skip` —
 * so it was accepted and ignored, every page was the same newest-300, and the loop ran until their own guard stopped it.
 * They summed 67 identical pages into 10,184 matching records where 152 exist, and were about to delete records on that
 * number. What caught it was `space_stats` disagreeing, not anything the paging response said.
 *
 * Their words, and the reason this is a refusal rather than an alias: *"accepting a parameter and ignoring it is worse
 * than rejecting it, because the caller writes a loop around it."*
 *
 * DELIBERATELY NOT a strict allowlist over the whole query string. A GET is reached by browsers, proxies and cache
 * busters (`?_=1699…`), so refusing every unknown key would break traffic that never asked for pagination. This list is
 * the plausible-but-wrong names a caller reaches for on purpose — each one a loop waiting to be written.
 */
export const UNSUPPORTED_PAGE_PARAMS: Readonly<Record<string, string>> = {
  offset: 'skip',
  page: 'skip',
  per_page: 'limit',
  perPage: 'limit',
  pageSize: 'limit',
  sortBy: 'sort',
  orderBy: 'sort',
  order: 'dir',
  direction: 'dir',
};

/** The 400 body for an unsupported pagination alias, or `null` when the query is clean. */
export function unsupportedPageParam(
  query: Record<string, unknown>,
): { error: string; unrecognized_keys: string[] } | null {
  const bad = Object.keys(UNSUPPORTED_PAGE_PARAMS).filter(k => query[k] !== undefined);
  if (bad.length === 0) return null;
  return {
    error: bad.map(k => `'${k}' is not a parameter of this endpoint — use '${UNSUPPORTED_PAGE_PARAMS[k]}'`).join('; '),
    unrecognized_keys: bad,
  };
}
