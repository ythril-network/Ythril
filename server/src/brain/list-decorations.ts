import { withEndpointNames } from './edge-endpoint-names.js';
import { attachJobProgress } from '../files/file-job-progress.js';

/**
 * What does a page of this collection gain AFTER the query?
 *
 * ## The gap this closes, and why it was invisible
 *
 * Two of the nine per-collection list routes do work on their rows once the query has returned, and
 * `filter` — the one shape meant to replace all nine — did neither:
 *
 * | collection | what the list route adds | what `filter` returned |
 * |---|---|---|
 * | `edges` | `fromName` / `toName`, resolved per member and batched by endpoint kind | bare UUIDs |
 * | `files` | the embedding job's STEP PROGRESS, for rows still in flight | nothing, so a stage indicator never resolves |
 *
 * A decoration is not a parameter. It does not appear in a body allowlist, an `inputSchema` or a
 * capability map, so nothing compared the two doors and nobody reported the difference — and step 3 of
 * `B-9` deletes those routes, which would have taken both with it silently.
 *
 * ## Two functions, because there are two questions
 *
 * A file's progress is joined against the job collection of the member that OWNS the row, so it has to
 * run before a proxy page is merged and the member is forgotten. An edge's endpoint names are resolved
 * across every member at once, which is cheaper on the whole page than per slice. Folding the two into
 * one call taking a `perMember` flag would make every caller depend on the other caller's shape.
 *
 * ## What a hand-written copy drops
 *
 * Both of these are no-ops for most collections, and a copy that simply returned its rows for the
 * unknown case would be correct on the day it was written. These dispatch on the collection instead, so
 * a seventh collection with a decoration of its own has ONE place to declare it — and a caller cannot
 * apply the edge half and forget the file half, because it never sees either.
 */

/** Rows still inside their member's slice, before a proxy page is merged and the owner forgotten. */
export async function decorateMemberRows(
  collection: string,
  memberId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  /*
   * Files only, and only for rows in flight — `attachJobProgress` issues NO query at all when the slice
   * holds nothing pending, which is most slices. That property is the reason it is called rather than
   * re-implemented: a copy that looked the ids up unconditionally would put a query on the common path.
   */
  if (collection !== 'files') return rows;
  return attachJobProgress(memberId, rows);
}

/** The merged page, once every member has contributed. */
export async function decoratePage<T extends object>(
  collection: string,
  spaceId: string,
  rows: readonly T[],
  readAcrossMembers: (read: (memberId: string) => Promise<Record<string, unknown>[]>) => Promise<Record<string, unknown>[]>,
): Promise<T[]> {
  if (collection !== 'edges' || rows.length === 0) return rows as T[];
  // The cast is the shape `withEndpointNames` needs and the rows already have: an edge row carries
  // `from`/`to`, and the optional kinds decide which collection holds each endpoint's name.
  return await withEndpointNames(
    spaceId,
    rows as unknown as Array<{ from: string; to: string }>,
    readAcrossMembers,
  ) as unknown as T[];
}
