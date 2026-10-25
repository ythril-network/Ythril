/**
 * The keyset helpers that are NOT the record stream: the instant-keyed read (the file tombstones), the one join of a tie's two finds, and the declaration of the
 * seq indexes (bundle-81, design rev 8 §6: `readAfterSeq` and everything that served it went when the wire moved to positions).
 *
 * ## What is here, and what moved
 *
 * Every read of the RECORD stream pages by position now (`util/position-keyset.ts`: the six record collections and the brain tombstones, by `(pos, _id)`). What
 * stays here answers other questions:
 *
 *  - **The instant-keyed read** (`IsoPosition`, `isoKeysetFilters`, the cursor codec): the file tombstones carry no seq but an instant (`positionAt`), and are
 *    paged by it with its ties, on a stream of their own that bundle-81 leaves untouched.
 *  - **`tieThenRange`**: the two finds of a keyset read in their order, written once for the position reader and the instant reader.
 *  - **`SEQ_KEYSET_INDEXES`**: the `(seq, _id)` compounds. A VERSION is no longer paged by, but the version floor reads the highest stored version through them
 *    (`highestVersionBelowCap`, `util/version-stamp.ts`), the first carry chunks by them, the rollback tool reads them, and after a rollback 5.6's pager finds
 *    them standing.
 *
 * ## What it prevents
 *
 * A record keeps its AUTHOR's position when it replicates in the legacy band, so records relayed from several authors share positions. A reader that asks
 * `pos > last` and sorts `{ pos: 1 }` loses the tail of a run of equal positions at every page, batch or run boundary: the next ask excludes the rest of the run, nothing
 * reports it, and the reader's cursor has moved past records it never saw (bundle-52, `Q-277`). A position is a PAIR and "after it" is two index-bounded finds, the rest of
 * the run and then everything above, joined by {@link tieThenRange} (a full tie page never costs a second find that is then thrown away).
 *
 * The cursor of an instant read is opaque to a caller (echo it, never build one): `base64url("<instant>:<id>")`, or `base64url("<instant>")` when there is no id or the id is
 * longer than {@link MAX_CURSOR_ID_LENGTH}.
 */
import { andPredicates } from '../db/and-predicates.js';
import type { SpacePart } from '../db/space-collection.js';
import { isComparableIso, COMPARABLE_ISO_LENGTH } from './comparable-iso.js';
import { SEQ_CARRYING } from './seq.js';

/** The longest `_id` a pair cursor carries. A longer one (a deep file path) is encoded without it. */
export const MAX_CURSOR_ID_LENGTH = 1024;

const CURSOR_TEXT = /^[A-Za-z0-9_-]+={0,2}$/;

// ── The position of a read that is keyed by a TIME, not a seq ──────────────────

/**
 * Where a read of records that carry no seq but an instant starts — the file tombstones, which are positioned by when
 * they were published or received here (`positionAt`): strictly after `at`, and — with an `id` — after that record within
 * the run of equal instants. `at` is a comparable ISO instant (`util/comparable-iso.ts`), or `''` for the start of time.
 */
export interface IsoPosition {
  at: string;
  id?: string | undefined;
}

/** The start of a read with no cursor: before every instant. */
export const ISO_READ_START: IsoPosition = Object.freeze({ at: '' });

/**
 * The one refusal text for an instant cursor that cannot be read. Fixed, so it never repeats what the caller sent — the
 * same rule as the position routes' (`Q-388`).
 */
export const BAD_ISO_CURSOR = 'cursor must be a cursor a previous page of this route returned';

/**
 * The cursor for an instant position: `base64url("<instant>:<id>")`, or `base64url("<instant>")` when there is no id or
 * the id is longer than {@link MAX_CURSOR_ID_LENGTH}. The twin of the position cursor, and for the same reason it is a
 * pair: two records published in one millisecond share an instant, and a cursor that named only the instant would skip the
 * rest of the run at every page boundary (`Q-277`, one level down).
 *
 * The instant is FIXED WIDTH, so the text is split at a known offset and never searched: an id that is a path holds colons,
 * and so does an ISO instant.
 */
export function encodeIsoCursor(position: IsoPosition): string {
  const { at, id } = position;
  if (!isComparableIso(at)) throw new RangeError(`a cursor cannot name instant ${String(at)}`);
  const text = id !== undefined && id !== '' && id.length <= MAX_CURSOR_ID_LENGTH ? `${at}:${id}` : at;
  return Buffer.from(text).toString('base64url');
}

/**
 * The position an instant cursor names, or `undefined` for anything it refuses (the route answers `400` with
 * {@link BAD_ISO_CURSOR}). Type-checked, the instant a comparable ISO value, the separator a colon, the id non-empty and
 * bounded. An absent or empty cursor is {@link ISO_READ_START}, so a caller reads one answer for "no cursor" and for "the
 * first page".
 */
export function isoReadStart(cursor: unknown): IsoPosition | undefined {
  if (cursor === undefined || cursor === '') return ISO_READ_START;
  if (typeof cursor !== 'string' || !CURSOR_TEXT.test(cursor)) return undefined;
  const text = Buffer.from(cursor, 'base64url').toString();
  const at = text.slice(0, COMPARABLE_ISO_LENGTH);
  if (!isComparableIso(at)) return undefined;
  if (text.length === COMPARABLE_ISO_LENGTH) return { at };
  if (text[COMPARABLE_ISO_LENGTH] !== ':') return undefined;
  const id = text.slice(COMPARABLE_ISO_LENGTH + 1);
  if (id === '' || id.length > MAX_CURSOR_ID_LENGTH) return undefined;
  return { at, id };
}

/**
 * The cursor of the start of time — what the FIRST request of a cursor-mode read of an instant-keyed route carries. An
 * empty cursor reads as "no cursor" (the legacy answer), so a client that wants the paged mode from the first request sends
 * this one; it sorts before every instant a position can name.
 */
export const ISO_START_CURSOR: string = encodeIsoCursor({ at: '1970-01-01T00:00:00.000Z' });

/**
 * The two finds that read everything strictly after `after` in an instant-keyed collection, in `(field, _id)` order: `tie`
 * (the rest of the run at the cursor's own instant, or `null` when the cursor names no id) and `range` (every later
 * instant). The twin of `isoKeysetFilters`, with no horizon of its own and no
 * readiness question. An instant IS stamped ahead of its write (a file tombstone's position is taken before the write
 * commits), so a reader of such a field caps itself through `extra` (`settledPositionCap`, `files/tombstones.ts`): one that does
 * not reads straight through an open hold. With the compound index the two finds are bounded scans, and without it — the window while it is
 * built — each is a scan that keeps the same ties, because a tie is decided by the filters and not by the index. `extra`
 * narrows both, composed with `$and` as the seq filters compose it.
 */
export function isoKeysetFilters(
  field: string, after: IsoPosition, extra?: Readonly<Record<string, unknown>>,
): { tie: Record<string, unknown> | null; range: Record<string, unknown> } {
  return {
    tie: after.id !== undefined && after.at !== '' ? composed({ [field]: after.at, _id: { $gt: after.id } }, extra) : null,
    range: composed({ [field]: { $gt: after.at } }, extra),
  };
}

/** The order that goes with {@link isoKeysetFilters}: the instant, then `_id`, so a run of equal instants has one order. */
export const isoKeysetSort = (field: string): Readonly<Record<string, 1>> => Object.freeze({ [field]: 1, _id: 1 });

/**
 * `guard` AND `extra` through `andPredicates` (`db/and-predicates.ts`, an intersection by `$and` and never a spread), so a key
 * `extra` shares with the guard is a second condition and not a replacement. A guard here always names a field, so the answer is
 * never the empty `undefined` that `andPredicates` gives for no constraint at all.
 */
const composed = (guard: Record<string, unknown>, extra: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> =>
  andPredicates(guard, extra) as Record<string, unknown>;

// ── The indexes ────────────────────────────────────────────────────────────────

/** One keyset index: the space collection it is on and its keys. */
export interface SeqKeysetIndex {
  readonly part: SpacePart;
  readonly keys: Readonly<Record<string, 1>>;
}

/**
 * THE declaration of every seq-keyset index, created by `spaces/keyset-indexes.ts` and nowhere else: `{ seq: 1, _id: 1 }`
 * on every collection whose records carry a space seq. Each replaces the bare `{ seq: 1 }` its collection had, which cannot deliver
 * the sort a tie needs and cost a second index's maintenance on every write if left beside it. (The tombstones' typed twin
 * `{ type, seq, _id }` went with the grouped per-type answer it served.) A VERSION is not paged by any more: these serve the version
 * floor, the first carry's chunking and the rollback tool.
 */
export const SEQ_KEYSET_INDEXES: readonly SeqKeysetIndex[] = Object.freeze([
  ...SEQ_CARRYING.map((part): SeqKeysetIndex => ({ part, keys: { seq: 1, _id: 1 } })),
]);

/** The index name MongoDB gives these keys. */
export const indexNameOf = (keys: Readonly<Record<string, 1>>): string => Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_');

/** The bare index a keyset index replaces: its keys without `_id`. */
export const bareKeysOf = (index: SeqKeysetIndex): Record<string, 1> =>
  Object.fromEntries(Object.entries(index.keys).filter(([k]) => k !== '_id')) as Record<string, 1>;

/**
 * Run the two finds of a keyset read in their order — `tie` (the rest of the run at the cursor's own position, `null` when
 * there is none) and then, only when the page is not yet full, `range` (everything after) — and join their answers.
 *
 * ## What it prevents
 *
 * The same four lines stood in every keyset reader (the seq reader, its fallback while the compound index builds, the file
 * tombstones' page): `first` read, `first.length >= limit` to stop, the rest asked for `limit - first.length`. The line a copy
 * drops is the middle one, which makes a full tie page cost a second find that is then thrown away, or hands back a page longer
 * than asked. `limit` is `undefined` for a read with no bound (a whole collection of tombstones), which asks both finds for
 * everything.
 *
 * `find` reads for both; `readRange` replaces it for the range alone, for a reader whose range read has a step of its own (the
 * fallback re-reads the run its last row ends in). Both are handed the filter and the number of rows still wanted.
 */
export async function tieThenRange<T, N extends number | undefined>(
  find: (filter: Record<string, unknown>, n: N) => Promise<T[]>,
  tie: Record<string, unknown> | null, range: Record<string, unknown>, limit: N,
  readRange: (filter: Record<string, unknown>, n: N) => Promise<T[]> = find,
): Promise<T[]> {
  const first = tie ? await find(tie, limit) : [];
  if (limit !== undefined && first.length >= limit) return first;
  // `N` is `undefined` exactly when `limit` is, so what is still wanted is too.
  return [...first, ...await readRange(range, (limit === undefined ? undefined : limit - first.length) as N)];
}

