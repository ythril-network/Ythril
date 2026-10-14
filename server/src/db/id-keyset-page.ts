/**
 * The next page of a collection's rows by `_id`, after the last id the caller saw — and the loop over those pages.
 *
 * ## What it prevents
 *
 * A walk that has to read a collection a page at a time, and has to be able to act on a page (delete it, flag it, decide on it)
 * between one read and the next, pages by `_id`: the cursor is the last id, so the rows the walk changes do not move it, and a row
 * written under it while it runs is either behind the cursor or read later, never read twice. It was written inline in each walk,
 * and each copy carried a different half of the same four lines: the sort that makes the cursor mean anything, the limit that
 * makes a page a page, the `$gt` that ANDs with the caller's own `_id` condition instead of replacing it (a prefix match on `_id`
 * and a cursor on `_id` are two conditions on one key, and a spread keeps only the later), and the end of the walk, which is a
 * page shorter than asked for.
 *
 * ## What it guarantees
 *
 * - **Sorted by `_id`, ascending, and limited to `size`**: the caller names neither, so no caller can page without them.
 * - **The cursor is ANDed with the caller's filter** (`andPredicates`), never spread into it: a filter that already conditions `_id`
 *   (a prefix, a range) is narrowed by the cursor.
 * - **The end is a page shorter than `size`**: {@link IdPage.end}. A walk whose cursor is stored between ticks reads one page per
 *   call ({@link idKeysetPage}); a walk that goes straight on takes {@link eachIdPage}, which stops there and hands the callback no
 *   empty page.
 * - **The bound is the caller's scope, not an option**: the reads go through `col()`, so inside a housekeeping scope each carries
 *   its figure (`a-housekeeping-op-carries-its-bound`). A page that is acted on is acted on by the caller's own writes, which carry
 *   theirs; nothing here writes.
 *
 * It answers one question: which rows are next, by `_id`. A read by a seq position, by another key, or of a list of ids is not this
 * question (`util/seq-keyset.ts`, `db/read-by-id.ts`).
 */
import type { Document } from 'mongodb';
import { col, asFilter } from './mongo.js';
import { andPredicates } from './and-predicates.js';

/** One page: its rows in `_id` order, the id to resume after, and whether it was the last. */
export interface IdPage<T> {
  rows: T[];
  /** The `_id` of the last row, to pass as `after` for the next page; absent for an empty page. */
  last?: string;
  /** The page was shorter than asked for, so the collection holds nothing after it. */
  end: boolean;
}

/** What names a page: where (`collection`), which rows (`filter`, which may condition `_id`), what to read of them, how many. */
export interface IdPageSpec {
  collection: string;
  /** The rows to page over; the cursor is ANDed to it. */
  filter: Readonly<Record<string, unknown>>;
  /** The fields to read: always named, because a page that reads whole rows reads a vector per row. */
  projection: Readonly<Record<string, 1>>;
  /** Rows per page: a positive integer. */
  size: number;
  /** Force the index the cursor walks, where the planner left to choose could read every row of the filter to sort one page. */
  hint?: Readonly<Record<string, 1>>;
}

/**
 * The page of rows after `after` (the first page when `after` is undefined). `T` is the shape the `projection` leaves.
 */
export async function idKeysetPage<T extends { _id: string }>(spec: IdPageSpec, after: string | undefined): Promise<IdPage<T>> {
  const { collection, filter, projection, size, hint } = spec;
  if (!Number.isInteger(size) || size < 1) throw new Error(`idKeysetPage: size must be a positive integer, got ${size}`);
  const cursor = after === undefined ? undefined : { _id: { $gt: after } };
  const rows = await col<Document>(collection)
    .find(asFilter<Document>(andPredicates(filter, cursor) ?? {}), {
      projection, sort: { _id: 1 }, limit: size, ...(hint === undefined ? {} : { hint }),
    })
    .toArray() as unknown as T[];
  const last = rows.length > 0 ? String(rows[rows.length - 1]!._id) : undefined;
  return { rows, ...(last !== undefined ? { last } : {}), end: rows.length < size };
}

/**
 * Every page of the filter in turn, from the start: `onPage` is awaited with each non-empty page BEFORE the next is read, so a page
 * the callback deletes or flags is not read again and the cursor does not depend on what it did. A throw from `onPage` ends the walk
 * at that page. Returns once the last page has been handed over.
 */
export async function eachIdPage<T extends { _id: string }>(spec: IdPageSpec, onPage: (rows: T[]) => Promise<void>): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const page = await idKeysetPage<T>(spec, after);
    if (page.rows.length === 0) return;
    await onPage(page.rows);
    if (page.end) return;
    after = page.last;
  }
}
