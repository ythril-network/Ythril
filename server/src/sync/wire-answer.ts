/**
 * What a 6.0 sync door answers: one builder per answer kind (bundle-81, design rev 8 §6, decision 23).
 *
 * ## The question it answers
 *
 * "What does a page of a position read look like on the wire?" — `{ items, nextCursor, through, head, positions: 1 }`, built from what the
 * reader returned (`util/position-keyset.ts`) and from nothing a route computes by hand.
 *
 * ## What is inside so no route can drop it
 *
 *  - **`through` never passes an unfinished tie.** It is "complete through": when more follows it is the position BEFORE the last item's, because
 *    a run of equal positions (the legacy band has them) may continue on the next page; when nothing follows it is the cap less one — every
 *    position below the cap is delivered or does not exist. A `through` that was the last item's set a mark inside a run, and the rest of
 *    the run was never read.
 *  - **`head` is the cap less one**: the highest position this instance can have handed out and settled, which a puller whose mark is above it
 *    reads as "this peer's numbers went backwards".
 *  - **The cap is the reader's own**, so a page cannot be answered against a different horizon from the one it was read under.
 *  - **`positions: 1`** says this is a position answer: a 6.0 client refuses an answer without it, and a 5.x client refuses this one.
 *
 * This slice holds the page answer of the position doors; the push answer, the client parsers and the refusal of a 5.x shape are the wire's
 * (`parsePageAnswer`, `pushAnswer`, `parsePushAnswer`).
 */
import { completeThrough } from './watermark.js';
import { encodePositionCursor, type PositionRead } from '../util/position-keyset.js';

/** One page of a position read, as the wire carries it. */
export interface PageAnswer<I> {
  items: I[];
  /** The cursor of the page after this one, or `null` on the last. */
  nextCursor: string | null;
  /** Complete through this position: every record at or below it is delivered or absent (never inside a tie). */
  through: number;
  /** The highest position this instance has handed out and settled (the settled cap less one). */
  head: number;
  /** The answer is by position (6.0). */
  positions: 1;
}

/**
 * Build the page answer from a read of `pageSize + 1` rows: the first `pageSize` are the page, and the one more says whether another follows.
 * `serve` is the family's served form (`SERVED_AS`), applied to each row's document; a listing (ids and seqs) passes none.
 */
export function pageAnswer<T extends { _id: string }, I = T>(
  read: PositionRead<T>, pageSize: number, serve?: (row: T) => I,
): PageAnswer<I> {
  const more = read.rows.length > pageSize;
  const page = more ? read.rows.slice(0, pageSize) : read.rows;
  const last = page[page.length - 1];
  return {
    items: page.map(r => (serve ? serve(r.row) : r.row as unknown as I)),
    nextCursor: more && last ? encodePositionCursor({ pos: last.pos, id: last.row._id }) : null,
    through: more && last ? completeThrough(last.pos, true) : Math.max(0, read.cap - 1),
    head: Math.max(0, read.cap - 1),
    positions: 1,
  };
}
