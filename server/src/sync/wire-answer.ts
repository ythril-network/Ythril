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
 * ## Two kinds of answer, one builder and one parser each (decision 23)
 *
 *  - **Page answer** (`GET /api/sync/<family>`, `GET /api/sync/tombstones`): {@link pageAnswer} builds `{ items, nextCursor, through, head, positions: 1 }`;
 *    {@link parsePageAnswer} requires an `items` array, integer `through` and `head`, and `positions === 1`.
 *  - **Push answer** (batch-upsert, single POST, tombstone POST): {@link pushAnswer} adds `positions: 1` to the door's existing body;
 *    {@link parsePushAnswer} requires `positions === 1`. A push answer carries no `through` or `head`: the push mark is our own pager's `through`.
 *
 * Both parsers THROW {@link PeerPagesBySeq} on an answer without the 6.0 shape. A refusal returned as a page status would leave the member's turn going
 * (the file routes run next); a thrown error passes the pagers uncaught, ends the turn and writes no mark. The engine has its own branch for it.
 * The two refusals are one error because both kinds answer the same version question. No route spells `positions: 1` or computes `through`: a route
 * that did would be refused by its own 6.0 peers (`every-sync-door-answers-through-the-wire-module`).
 */
import { completeThrough } from './watermark.js';
import { cursorCanNameId, encodePositionCursor, isPositionNumber, type PositionRead } from '../util/position-keyset.js';
import { PeerPagesBySeq } from '../util/errors.js';

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
 * Where a page of `pageSize` rows ends when one more follows: at `pageSize`, unless the run of equal positions continues across the boundary and the last row's
 * id is too long for a cursor to name. A bare-position cursor there would continue from the NEXT position and lose the rest of the run for good, so the page ends
 * at the last row of the run whose id a cursor can name (the rows after it, long ids included, are the next page's). A page that is all long ids keeps its size:
 * the one case a cursor cannot help, and a run of more than a page of ids over 1024 characters.
 */
function pageEnd(rows: ReadonlyArray<{ pos: number; row: { _id: string } }>, pageSize: number): number {
  const next = rows[pageSize];
  if (!next) return pageSize;
  const stuck = (end: number): boolean => rows[end - 1]!.pos === next.pos && !cursorCanNameId(rows[end - 1]!.row._id);
  let end = pageSize;
  while (end > 1 && stuck(end)) end--;
  return stuck(end) ? pageSize : end;
}

/**
 * Build the page answer from a read of `pageSize + 1` rows: the first `pageSize` are the page, and the one more says whether another follows.
 * `serve` is the family's served form (`SERVED_AS`), applied to each row's document; a listing (ids and seqs) passes none.
 */
export function pageAnswer<T extends { _id: string }, I = T>(
  read: PositionRead<T>, pageSize: number, serve?: (row: T) => I,
): PageAnswer<I> {
  const more = read.rows.length > pageSize;
  const page = more ? read.rows.slice(0, pageEnd(read.rows, pageSize)) : read.rows;
  const last = page[page.length - 1];
  return {
    items: page.map(r => (serve ? serve(r.row) : r.row as unknown as I)),
    nextCursor: more && last ? encodePositionCursor({ pos: last.pos, id: last.row._id }) : null,
    through: more && last ? completeThrough(last.pos, true) : Math.max(0, read.cap - 1),
    head: Math.max(0, read.cap - 1),
    positions: 1,
  };
}

/** A body that is a plain object (not an array, not null), or `undefined`. */
const objectOf = (json: unknown): Record<string, unknown> | undefined =>
  json !== null && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : undefined;

/**
 * Read a page a peer answered: the 6.0 shape, or THROW {@link PeerPagesBySeq}. `items` must be an array, `through` and `head` whole numbers (the
 * peer's positions, which can sit anywhere in `0 … 2^53 - 1`), `positions` exactly `1`; `nextCursor` is a string or `null` (any other value is no
 * cursor at all). What is inside the items is the caller's: each is admitted by the receiver's own schema.
 */
export function parsePageAnswer(json: unknown): PageAnswer<unknown> {
  const body = objectOf(json);
  if (!body || body['positions'] !== 1 || !Array.isArray(body['items']) || !isPositionNumber(body['through']) || !isPositionNumber(body['head'])) {
    throw new PeerPagesBySeq();
  }
  const next = body['nextCursor'];
  return { items: body['items'], nextCursor: typeof next === 'string' ? next : null, through: body['through'], head: body['head'], positions: 1 };
}

/** What a push door answers: its own fields (counters, `status`, `applied`…) and the stamp. */
export type PushAnswer<B extends object = Record<string, unknown>> = B & { positions: 1 };

/** The push answer: the door's existing body with `positions: 1`. */
export function pushAnswer<B extends object>(body: B): PushAnswer<B> {
  return { ...body, positions: 1 };
}

/** Read a push answer a peer sent: its body with the stamp, or THROW {@link PeerPagesBySeq} for an answer a 5.x receiver gives (no `positions: 1`). */
export function parsePushAnswer(json: unknown): PushAnswer {
  const body = objectOf(json);
  if (!body || body['positions'] !== 1) throw new PeerPagesBySeq();
  return body as PushAnswer;
}
