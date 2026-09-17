import { withEndpointNames } from './edge-endpoint-names.js';
import { attachJobProgress } from '../files/file-job-progress.js';
import { withDerivedStatusForPage } from './chrono.js';

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
/** What the CALLER asked for, as distinct from what the collection always gets. */
export interface PageDecorationAsks {
  /**
   * Present a chrono entry's DERIVED status rather than the stored one — `overdue` where a due moment
   * has passed, unless the type's `whenDuePasses` says otherwise.
   *
   * Opt-in, and default OFF, so every existing `filter` caller sees exactly what it saw before. The list
   * route derives unconditionally, so the client asks for `true` and its tab is unchanged too. Nothing
   * moves for anybody who does not ask — which is what makes surfacing the difference safe rather than
   * a behaviour change dressed as a feature.
   */
  deriveStatus?: boolean;
}

export async function decoratePage<T extends object>(
  collection: string,
  spaceId: string,
  rows: readonly T[],
  readAcrossMembers: (read: (memberId: string) => Promise<Record<string, unknown>[]>) => Promise<Record<string, unknown>[]>,
  asks: PageDecorationAsks = {},
): Promise<T[]> {
  if (rows.length === 0) return rows as T[];
  // One `now` for the page, so two rows in one answer cannot straddle the instant that flips a status.
  if (collection === 'chrono') {
    return asks.deriveStatus ? withDerivedStatusForPage(rows) : rows as T[];
  }
  if (collection !== 'edges') return rows as T[];
  // The cast is the shape `withEndpointNames` needs and the rows already have: an edge row carries
  // `from`/`to`, and the optional kinds decide which collection holds each endpoint's name.
  return await withEndpointNames(
    spaceId,
    rows as unknown as Array<{ from: string; to: string }>,
    readAcrossMembers,
  ) as unknown as T[];
}

/**
 * The page-decoration asks as JSON-Schema properties, spread into `filter`'s `inputSchema`.
 *
 * DECLARED HERE rather than in the tool, so the name, what it means and what applies it live in one
 * file. A tool spelling its own description is a second account of this module's behaviour — and a
 * description is what a caller reads while constructing arguments, which makes it the copy that rots
 * without anybody reporting it.
 */
export const PAGE_DECORATION_SCHEMA: Readonly<Record<string, { type: 'boolean'; default: boolean; description: string }>> = {
  deriveStatus: {
    type: 'boolean',
    default: false,
    description: 'CHRONO ONLY. Present the DERIVED status of each entry instead of the stored one: `overdue` where its due moment has passed, unless `whenDuePasses` on that type says a passed date means nothing. Default false, so this tool answers with what the COLLECTION holds — which is what you want when repairing data, and why the two are not the same question. The per-collection chrono list route derives unconditionally, so until 5.0 the meaning of `status` depended on which door you used and nothing said so. Sending it on any other collection is refused rather than ignored.',
  },
  includeDiagnostics: {
    type: 'boolean',
    default: false,
    description: 'Add back the two fields a listed record carries for the SYSTEM rather than for you: `matchedText` (the pre-embedding source string, which for a file chunk is the passage a SECOND time) and `embeddingModel` (identical for every record in a space). Default false on both doors, and false is what you want almost always. It was honoured by the per-collection list routes and by neither door of this tool, so a caller could ask and be answered without it — silently.',
  },
};
