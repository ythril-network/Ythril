/**
 * "Which local records come AFTER this position" — answered by POSITION, in one place, with the ties the legacy band has
 * (bundle-81, design rev 8 §6; the twin of `util/seq-keyset.ts` for the field a record is paged by now).
 *
 * ## What it prevents
 *
 * Every reader that pages by position needs the same three things, and each is the one a hand-written reader drops:
 *
 *  - **The cap** (`settledPositionCap`, `util/position-clock.ts`): a position a write has taken and not yet committed must stop every reader
 *    below it, or a puller stores the highest `through` it was handed and never comes back for the held record. The cap is applied HERE, to both
 *    finds, and nowhere else.
 *  - **The tie**: positions of the clock band never repeat, but the legacy band (every carried 5.6 seq, which a relayed record shares with its
 *    author's) does, so a cursor is a PAIR `(pos, _id)` and "after it" is the rest of the run at its own position and then everything above:
 *    two index-bounded finds, as `seq-keyset.ts`'s are, on `{ pos: 1, _id: 1 }`.
 *  - **The caller's extra filter** is composed with `$and` into BOTH finds (`andPredicates`), never spread beside the position, so a key it
 *    shares with the guard cannot replace it.
 *
 * It reads `pos` and hands it back beside each row, because the page's cursor and its `through` are built from it, and strips it from the
 * row: a position is local, and no answer carries one (`POSITION_FIELDS`). A caller cannot return it by forgetting a line.
 *
 * ## The cursor
 *
 * `p1.` followed by `base64url("<pos>:<id>")`, by `base64url("<pos>~<sha256 of the id>")` when the id is longer than {@link MAX_CURSOR_ID_LENGTH} (the reader
 * resolves the digest against the run at `pos`, so a page that ends on such a row never skips the rest of its run), or by `base64url("<pos>")` when there is no id.
 * Opaque to a caller (echo it, never build one), refusing every older form: a 5.x cursor is a position in another space of numbers.
 *
 * ## Readiness is asked here
 *
 * Whether the space's positions are READY (`sync/positions-owed.ts`: it owes no carry and no repair) is asked INSIDE the reader, before either find, so no
 * caller can drop it: an unready space throws `PositionsBuilding`, which the doors answer `503 positions_building` (a sender reads it as held) and a walk
 * reads as "not ready: skipped this tick".
 */
import { createHash } from 'node:crypto';
import type { Document, Filter } from 'mongodb';
import { col, asFilter } from '../db/mongo.js';
import { andPredicates } from '../db/and-predicates.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { settledPositionCap } from './position-clock.js';
import { tieThenRange } from './seq-keyset.js';
import { MAX_CURSOR_ID_LENGTH } from './seq-keyset.js';
import { recordPositions } from '../sync/record-position-stream.js';
import { assertPositionsReady } from '../sync/positions-ready.js';

/**
 * Where a position read starts: strictly after `pos`, and — with an `id` — after that record within the run at `pos`. `idDigest` names an id too long for a
 * cursor to carry (`cursorCanNameId`) by the digest of it ({@link idDigestOf}), which the reader resolves against the run at `pos` (`readAfterPosition`): a
 * cursor then still stands for "after THAT record" and the rest of its run is never skipped. A start has an `id` or an `idDigest`, never both.
 */
export interface PositionStart {
  pos: number;
  id?: string | undefined;
  idDigest?: string | undefined;
}

/** The cursor's prefix: what tells a 6.0 cursor from every older form, which are refused. */
export const POSITION_CURSOR_PREFIX = 'p1.';

const CURSOR_TEXT = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Is `value` a position a request may name: a safe integer of 0 or more, up to `Number.MAX_SAFE_INTEGER`?
 *
 * Its own bound, deliberately not `isPositionSeq`'s (`MAX_SYNC_SEQ`): a clock-band position is above it and would be refused. What bounds the
 * damage of a huge one is not this parse but the cap every read applies and `ownPositionMark`'s cut of every mark recorded from it.
 */
export function isPositionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A position written as a whole decimal number, within {@link isPositionNumber}; `undefined` otherwise. */
export function parsePositionText(text: string): number | undefined {
  if (!/^\d{1,16}$/.test(text)) return undefined;
  const n = Number(text);
  return isPositionNumber(n) ? n : undefined;
}

/**
 * Whether a cursor can name this id (a pair). One that is longer than {@link MAX_CURSOR_ID_LENGTH} degrades to the bare position, which continues from the
 * NEXT position and so skips the rest of a run of equal ones: a page must therefore never end inside a run on a row this says no to (`pageAnswer`).
 */
export const cursorCanNameId = (id: string | undefined): id is string => id !== undefined && id !== '' && id.length <= MAX_CURSOR_ID_LENGTH;

/** The digest a cursor names an id too long to carry by: SHA-256 of its UTF-8 bytes, in lower-case hex. */
export const idDigestOf = (id: string): string => createHash('sha256').update(id).digest('hex');

const DIGEST_TEXT = /^(\d{1,16})~([0-9a-f]{64})$/;

/**
 * The cursor for a position: opaque, `p1.` and base64url. A pair `pos:id` when it can carry the id; `pos~<digest>` for an id longer than {@link MAX_CURSOR_ID_LENGTH}
 * (the page that ends on such a row, the only row of the page included, would otherwise say "the next position" and skip the rest of its run); the bare position
 * when there is no id.
 */
export function encodePositionCursor(start: PositionStart): string {
  const { pos, id } = start;
  if (!isPositionNumber(pos)) throw new RangeError(`a cursor cannot name position ${String(pos)}`);
  const text = cursorCanNameId(id) ? `${pos}:${id}` : id !== undefined && id !== '' ? `${pos}~${idDigestOf(id)}` : String(pos);
  return POSITION_CURSOR_PREFIX + Buffer.from(text).toString('base64url');
}

/**
 * The position a cursor names, or `undefined` for anything it refuses — the route answers `400` with a fixed text and never echoes the value.
 * A string only (so `cursor[$ne]` is refused), the `p1.` prefix, the position a plain whole number, split at the FIRST colon (a file's `_id`
 * is a path and may hold one), the id non-empty and bounded.
 */
export function decodePositionCursor(cursor: unknown): PositionStart | undefined {
  if (typeof cursor !== 'string' || !cursor.startsWith(POSITION_CURSOR_PREFIX)) return undefined;
  const body = cursor.slice(POSITION_CURSOR_PREFIX.length);
  if (!CURSOR_TEXT.test(body)) return undefined;
  const text = Buffer.from(body, 'base64url').toString();
  const digested = DIGEST_TEXT.exec(text);
  if (digested) {
    const at = parsePositionText(digested[1]!);
    return at === undefined ? undefined : { pos: at, idDigest: digested[2]! };
  }
  const colon = text.indexOf(':');
  const pos = parsePositionText(colon === -1 ? text : text.slice(0, colon));
  if (pos === undefined) return undefined;
  if (colon === -1) return { pos };
  const id = text.slice(colon + 1);
  if (id === '' || id.length > MAX_CURSOR_ID_LENGTH) return undefined;
  return { pos, id };
}

/**
 * Order two positions the way the index does: by `pos`, then by `_id` as UTF-8 bytes (how MongoDB compares strings). A position with no id comes
 * before every id at the same `pos`. A client that follows a peer's cursor compares it with where it asked from, so a cursor that does not move
 * forward ends the transfer instead of looping.
 */
export function comparePositionStarts(a: PositionStart, b: PositionStart): number {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  // A digest names a row without its id, so two digests (or a digest and an id) at one position cannot be ordered by bytes: the same row is equal, and a different one is
  // taken as further on, which is the direction a peer's cursor only ever moves (a cursor that goes back is the pager's own bound to end).
  if (a.idDigest !== undefined || b.idDigest !== undefined) {
    const da = a.idDigest ?? (a.id !== undefined ? idDigestOf(a.id) : undefined);
    const db = b.idDigest ?? (b.id !== undefined ? idDigestOf(b.id) : undefined);
    if (da === undefined) return -1;
    if (db === undefined) return 1;
    return da === db ? 0 : 1;
  }
  if (a.id === b.id) return 0;
  if (a.id === undefined) return -1;
  if (b.id === undefined) return 1;
  return Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
}

/** The order that goes with every position read; its last key makes a tie a total order. */
export const POSITION_KEYSET_SORT = Object.freeze({ pos: 1, _id: 1 } as const);

const composed = (guard: Record<string, unknown>, extra: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> =>
  andPredicates(guard, extra) as Record<string, unknown>;

/**
 * The two finds that read everything after `after`, below `cap`: `tie` (the rest of the run at `after.pos`, or `null` when there is none to
 * read) and `range` (everything above it). Pure: the cap is handed in, so the shapes are testable without a database. `tie` exists only for a
 * position with an id that is below the cap.
 */
export function positionKeysetFilters(
  after: PositionStart, cap: number, extra?: Readonly<Record<string, unknown>>,
): { tie: Record<string, unknown> | null; range: Record<string, unknown> } {
  return {
    tie: after.id !== undefined && after.pos < cap ? composed({ pos: after.pos, _id: { $gt: after.id } }, extra) : null,
    range: composed({ pos: { $gt: after.pos, $lt: cap } }, extra),
  };
}

/** A row a position read hands back, with the position it sits at (the row itself carries none). */
export interface PositionedRow<T> {
  readonly row: T;
  readonly pos: number;
}

/** What a position read answers: the rows, and the cap it read below (the page's `through` and `head` are built from it). */
export interface PositionRead<T> {
  readonly rows: Array<PositionedRow<T>>;
  /** The settled cap both finds read strictly below: every position at or above it is held, or not yet handed out. */
  readonly cap: number;
}

/**
 * Up to `limit` records of one space collection that come after `after` and below the settled cap, in `(pos, _id)` order — each with its position.
 * `extra` narrows what is read (composed with `$and`); `projection` is the caller's, and it is read with `pos` whatever it says (the cursor needs
 * it), the position then taken off the row.
 */
export async function readAfterPosition<T extends Document>(
  spaceId: string, part: SpacePart, after: PositionStart,
  opts: { limit: number; extra?: Readonly<Record<string, unknown>> | undefined; projection?: Document | undefined },
): Promise<PositionRead<T>> {
  const { limit, extra } = opts;
  const collName = spaceCollection(spaceId, part);
  await assertPositionsReady(spaceId);
  if (after.idDigest !== undefined) after = await resolveDigestStart(collName, after);
  // One cap for both finds, taken before either: a position stamped meanwhile is at or above it, and waits.
  const cap = await settledPositionCap(recordPositions, spaceId);
  const { tie, range } = positionKeysetFilters(after, cap, extra);
  const projection = withPosition(opts.projection);
  const find = async (filter: Record<string, unknown>, n: number): Promise<Array<Record<string, unknown>>> =>
    await col<Record<string, unknown>>(collName)
      .find(asFilter<Record<string, unknown>>(filter as Filter<Record<string, unknown>>), projection ? { projection } : {})
      .sort({ ...POSITION_KEYSET_SORT }).limit(n).toArray();
  const rows = await tieThenRange(find, tie, range, limit);
  return {
    cap,
    rows: rows.map((raw) => {
      const { pos, ...row } = raw;
      return { row: row as unknown as T, pos: pos as number };
    }),
  };
}

/**
 * Resolve a start that names its id by digest: the rows at its position, in `_id` order, until one hashes to it, and the start is then `(pos, thatId)`. The run is the
 * legacy band's tie, small by nature, and read once per page (a cursor's page, not every row). A row that is gone (deleted since the cursor was handed out) leaves the
 * start at the position BEFORE the run, so the whole run is offered again: at-least-once, never a skip.
 */
async function resolveDigestStart(collName: string, after: PositionStart): Promise<PositionStart> {
  const run = col<{ _id: string }>(collName).find(asFilter<{ _id: string }>({ pos: after.pos }), { projection: { _id: 1 } }).sort({ _id: 1 });
  try {
    for await (const r of run) if (idDigestOf(r._id) === after.idDigest) return { pos: after.pos, id: r._id };
  } finally { await run.close(); }
  return { pos: Math.max(0, after.pos - 1) };
}

/** `projection` that also reads `pos`: an exclusion loses its `pos: 0`, an inclusion gains `pos: 1`, none stays none. */
function withPosition(projection: Document | undefined): Document | undefined {
  if (!projection) return undefined;
  const entries = Object.entries(projection).filter(([k]) => k !== 'pos');
  // `{ _id: 1 }` alone is an inclusion of `_id` and nothing else: it needs `pos` added as much as `{ name: 1 }` does (a scanner's projection is exactly that).
  const including = entries.some(([, v]) => v === 1 || v === true);
  return including ? { ...Object.fromEntries(entries), pos: 1 } : Object.fromEntries(entries);
}
