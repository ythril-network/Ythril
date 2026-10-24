/**
 * One paging rule for every listing that spans the members of a proxy space.
 *
 * ## Why this is a shared function and not a pattern to copy
 *
 * `/query` shipped its own version of this in 2.8.0 and got it wrong: it fetched a window capped at 100 rows and then
 * sliced it at `skip`, so every page past row 100 came back EMPTY while the response's own `total` reported the true
 * count. A caller sweeping a large collection stopped silently at 100.
 *
 * The embed-job listing then needed the same paging, and copying the shape would have meant two implementations of one
 * rule — this codebase's most repeated defect, with the weaker copy winning silently. So the rule lives here and both
 * callers pass their own fetch function.
 *
 * ## The rule
 *
 * **One member: push `skip` down to the database.** Correct at any depth, no window, no slicing. This is the case for
 * every non-proxy space, which is nearly every request.
 *
 * **Several members: fetch `skip + limit` from each, merge, sort, take the window.** Rows `[skip, skip+limit)` of a merged
 * set genuinely require `skip + limit` from every member — there is no way to know which member holds row 200 without
 * reading the first 200 of each. That multiplies, so it is bounded, and exceeding the bound is an explicit refusal rather
 * than the empty page that made this necessary.
 */

export interface PageRequest<T> {
  /** The member spaces to read, already narrowed to what the caller may see. */
  members: readonly string[];
  /**
   * Read one member. `skip`/`limit` are what THIS member should be asked for — the caller does not compute the window.
   * For the single-member case `skip` is the caller's skip; for the merge it is 0 and `limit` is `skip + limit`.
   *
   * Named `readMember` rather than `fetch`: in this codebase `fetch` means HTTP egress, and the egress gate reads it that
   * way — it flagged this file the moment it existed. A name that misleads a gate misleads a reader too.
   */
  readMember: (memberId: string, limit: number, skip: number) => Promise<T[]>;
  /** Comparator for the merge, which must match the order `readMember` applies, or a proxy page is ordered differently. */
  compare: (a: T, b: T) => number;
  limit: number;
  skip: number;
  /** Max `skip + limit` for the MULTI-member case. Ignored when there is one member, which has no window. */
  ceiling: number;
  /**
   * What the merge takes off each row of the answer once it has ordered by it: the order keys a merge read added and the order-only
   * fields (`projectionForOrderedMerge`'s `finish`, which includes `withoutOrderOnly`). Applied HERE, to the rows of the window, so a
   * caller of the merge cannot hand a landing position to an answer by forgetting a line.
   */
  finish?: (row: T) => T;
}

export type PageResult<T> =
  | { ok: true; rows: T[] }
  /** Over the ceiling. The caller turns this into a 400 (REST) or an Error (MCP) with the same text. */
  | { ok: false; error: string };

export async function pageAcrossMembers<T>(req: PageRequest<T>): Promise<PageResult<T>> {
  const { members, readMember, compare, limit, skip, ceiling } = req;
  const finish = req.finish ?? ((row: T) => row);

  if (members.length === 0) return { ok: true, rows: [] };

  if (members.length === 1) {
    // No window and no slice: the database applies both bounds, so depth costs nothing extra and cannot truncate.
    return { ok: true, rows: (await readMember(members[0] as string, limit, skip)).map(finish) };
  }

  const window = skip + limit;
  if (window > ceiling) {
    return {
      ok: false,
      error: `skip + limit must not exceed ${ceiling} through a personal view (got ${window}). `
        + 'Page a member space directly for a deeper sweep.',
    };
  }

  const merged: T[] = [];
  for (const mid of members) merged.push(...await readMember(mid, window, 0));
  return { ok: true, rows: merged.sort(compare).slice(skip, skip + limit).map(finish) };
}
