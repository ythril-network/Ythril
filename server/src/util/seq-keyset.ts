/**
 * "Which local records come AFTER this position" — answered in one place, and the answer includes the records that
 * share the position's seq (bundle-52, `Q-277`).
 *
 * ## What it prevents
 *
 * A record keeps its AUTHOR's seq when it replicates, so records relayed from several authors share seqs. A reader
 * that asks `seq > last` and sorts `{ seq: 1 }` loses the tail of a run of equal seqs at every page, batch or run
 * boundary: the next ask excludes the rest of the run, nothing reports it, and the reader's cursor has moved past
 * records it never saw. Five readers (the six record routes, the push, the tombstone read and the two scanners) each
 * wrote the filter, the sort and the horizon themselves, and the weakest copy won silently.
 *
 * A position is a PAIR, `(seq, _id)`, and "after it" is two index-bounded finds against `{ seq: 1, _id: 1 }`:
 *
 *   1. the rest of the run at the cursor's own seq: `{ seq: s, _id: { $gt: id } }` — only when `s` is below the
 *      horizon, because a cursor at or above it has nothing settled at `s`;
 *   2. then, for what is still owed, `{ seq: { $gt: s, $lt: horizon } }`.
 *
 * Two finds rather than one `$or`: each has tight index bounds, so no planner choice has to be trusted and a long run
 * is not re-walked per page (`a-keyset-read-uses-its-index-db` holds the plans).
 *
 * ## The forgettable parts, which are the reason to call this and not rebuild it
 *
 *   - the horizon (`settledSeqRange`, `util/seq.ts`) is applied HERE and nowhere else: a position that hands a reader a
 *     seq at or above an unsettled write moves it past that write for good (`Q-196`);
 *   - the caller's extra filter (a family's `pushFilter`, `ownedFilter`) is composed through `andPredicates` (an `$and`) into
 *     BOTH finds, never spread beside the position, so a key it happens to share with the guard cannot overwrite it;
 *   - the sort is `SEQ_KEYSET_SORT`, which ends in `_id`: a tie ordered by whatever the storage engine likes cannot be
 *     continued by the next page.
 *
 * ## The cursor
 *
 * `encodeSeqCursor` / `decodeSeqCursor` are the only codec. A cursor is opaque to a caller (echo it, never build one):
 * `base64url("<seq>:<id>")`, or `base64url("<seq>")` — exactly what a 5.6.x server emitted — when there is no id or the
 * id is longer than {@link MAX_CURSOR_ID_LENGTH}. That one boundary then behaves as it did before, instead of wedging on a
 * cursor nobody can read. A 5.6.x decoder `parseInt`s a pair to its seq, so a rollback reads what it always read.
 *
 * ## While a collection's compound index is still being built
 *
 * The compound is created in the background on an existing space (`spaces/ensure-query-indexes.ts`), never before the
 * server listens. Until a collection has it, a read behaves as it did before this module: `seq` only, strict `>`, sorted
 * `{ seq: 1 }` over the `{ seq: 1 }` index the collection still has. That is tie-unsafe and no slower than before; a
 * blocking in-memory sort over the tail would be worse than either. A pair cursor received in that window is read by its
 * seq alone. Readiness is one `listIndexes` per collection, cached, and refreshed by the pass that builds the index
 * ({@link noteKeysetIndexes}); a collection that does not exist yet has no indexes and is not ready, a store that did not answer
 * is not ready and is not remembered, and a "not ready" is looked at again within 30 s.
 */
import type { Document, Filter } from 'mongodb';
import { col, asFilter } from '../db/mongo.js';
import { andPredicates } from '../db/and-predicates.js';
import { indexNamesOf } from '../db/index-names.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { createProbeCache, type ProbeTtl } from './cached-probe.js';
import { MAX_SYNC_SEQ, SEQ_CARRYING, settledSeqRange } from './seq.js';

// ── The position and its cursor ────────────────────────────────────────────────

/** Where a read starts: strictly after `seq`, and — with an `id` — after that record within the run at `seq`. */
export interface SeqPosition {
  seq: number;
  id?: string | undefined;
}

/** The longest `_id` a pair cursor carries. A longer one (a deep file path) is encoded as its bare seq. */
export const MAX_CURSOR_ID_LENGTH = 1024;

const CURSOR_TEXT = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Is `value` a seq a position may name: a whole number of 0 or more, within what a record may carry (`MAX_SYNC_SEQ`)?
 *
 * The ONE spelling of that rule for every reader and writer of a position — the cursor codec below and the pager's reading of
 * an element it was served (`sync/seq-run-pager.ts`). It prevents a copy that forgets the upper bound: a position naming a
 * seq no cursor can carry is then accepted from a peer in one place and refused in another, and the two disagree about the
 * same element.
 */
export function isPositionSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SYNC_SEQ;
}

/** A seq written as a whole decimal number of 0 or more, within what a record may carry; `undefined` otherwise. */
export function parseSeqText(text: string): number | undefined {
  if (!/^\d{1,16}$/.test(text)) return undefined;
  const n = Number(text);
  return isPositionSeq(n) ? n : undefined;
}

/** The cursor for a position: opaque, base64url, a pair when it can carry the id and the bare seq when it cannot. */
export function encodeSeqCursor(position: SeqPosition): string {
  const { seq, id } = position;
  if (!isPositionSeq(seq)) throw new RangeError(`a cursor cannot name seq ${String(seq)}`);
  const text = id !== undefined && id !== '' && id.length <= MAX_CURSOR_ID_LENGTH ? `${seq}:${id}` : String(seq);
  return Buffer.from(text).toString('base64url');
}

/**
 * The position a cursor names, or `undefined` for anything it refuses — the route answers `400` with a fixed text and
 * never echoes the value. Type-checked (a string only, so `cursor[$ne]` is refused), split at the FIRST colon (a file's
 * `_id` is a path and may hold one), the seq a plain whole number within `MAX_SYNC_SEQ`, the id non-empty and bounded.
 * A bare seq reads as `{ seq }`: it is what a 5.6.x server emitted and what an over-long id is encoded as.
 */
export function decodeSeqCursor(cursor: unknown): SeqPosition | undefined {
  if (typeof cursor !== 'string' || !CURSOR_TEXT.test(cursor)) return undefined;
  const text = Buffer.from(cursor, 'base64url').toString();
  const colon = text.indexOf(':');
  const seq = parseSeqText(colon === -1 ? text : text.slice(0, colon));
  if (seq === undefined) return undefined;
  if (colon === -1) return { seq };
  const id = text.slice(colon + 1);
  if (id === '' || id.length > MAX_CURSOR_ID_LENGTH) return undefined;
  return { seq, id };
}

/**
 * Order two positions the way the store orders `(seq, _id)`: by seq, then by `_id` as UTF-8 BYTES. Mongo compares strings
 * by bytes, and JavaScript's `<` compares UTF-16 units — they disagree outside the BMP, so a client or scanner that
 * compared with `<` could call a position "not ahead" that the store served after it. A position without an id sorts
 * before every id at its seq.
 */
export function compareSeqPositions(a: SeqPosition, b: SeqPosition): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  if (a.id === b.id) return 0;
  if (a.id === undefined) return -1;
  if (b.id === undefined) return 1;
  return Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
}

// ── The filters and the sort ───────────────────────────────────────────────────

/** The order that goes with every keyset read; its last key makes a tie a total order. */
export const SEQ_KEYSET_SORT = Object.freeze({ seq: 1, _id: 1 } as const);

/** The sort of the read that is NOT keyset-safe, used only while a collection has no compound index (see the header). */
const SEQ_ONLY_SORT = Object.freeze({ seq: 1 } as const);

/**
 * `guard` AND `extra` through `andPredicates` (`db/and-predicates.ts`, an intersection by `$and` and never a spread), so a key
 * `extra` shares with the guard is a second condition and not a replacement. A guard here always names `seq`, so the answer is
 * never the empty `undefined` that `andPredicates` gives for no constraint at all.
 */
const composed = (guard: Record<string, unknown>, extra: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> =>
  andPredicates(guard, extra) as Record<string, unknown>;

/**
 * The two finds that read everything after `after`, below `horizon`: `tie` (the rest of the run at `after.seq`, or `null`
 * when there is none to read) and `range` (everything above it). Pure: the horizon is handed in, so the shapes are
 * testable without a database. `tie` exists only for a position with an id whose seq is below the horizon.
 */
export function seqKeysetFilters(
  after: SeqPosition, horizon: number, extra?: Readonly<Record<string, unknown>>,
): { tie: Record<string, unknown> | null; range: Record<string, unknown> } {
  const tie = after.id !== undefined && after.seq < horizon
    ? composed({ seq: after.seq, _id: { $gt: after.id } }, extra)
    : null;
  return { tie, range: composed({ seq: { $gt: after.seq, $lt: horizon } }, extra) };
}

/**
 * {@link seqKeysetFilters} below the space's CURRENT horizon — what a read of `spaceId` after `after` asks the store, and
 * the one place the horizon and the position meet. `readAfterSeq` uses it; so does a test that needs "the filter a keyset
 * reader of this space builds" without copying it.
 */
export async function settledSeqKeysetFilters(
  spaceId: string, after: SeqPosition, extra?: Readonly<Record<string, unknown>>,
): Promise<{ tie: Record<string, unknown> | null; range: Record<string, unknown>; horizon: number }> {
  const { $lt: horizon } = await settledSeqRange(spaceId, after.seq);
  return { ...seqKeysetFilters(after, horizon, extra), horizon };
}

// ── The indexes ────────────────────────────────────────────────────────────────

/** One keyset index: the space collection it is on and its keys. */
export interface SeqKeysetIndex {
  readonly part: SpacePart;
  readonly keys: Readonly<Record<string, 1>>;
}

/**
 * THE declaration of every seq-keyset index, created by `spaces/keyset-indexes.ts` and nowhere else: `{ seq: 1, _id: 1 }`
 * on every collection whose records carry a space seq, and the tombstones' typed twin for `GET /tombstones?type`. Each
 * replaces the bare `{ seq: 1 }` (`{ type: 1, seq: 1 }`) its collection had, which cannot deliver the sort a tie needs and
 * cost a second index's maintenance on every write if left beside it.
 */
export const SEQ_KEYSET_INDEXES: readonly SeqKeysetIndex[] = Object.freeze([
  ...SEQ_CARRYING.map((part): SeqKeysetIndex => ({ part, keys: { seq: 1, _id: 1 } })),
  { part: 'tombstones', keys: { type: 1, seq: 1, _id: 1 } },
]);

/** The index name MongoDB gives these keys. */
export const indexNameOf = (keys: Readonly<Record<string, 1>>): string => Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_');

/** The bare index a keyset index replaces: its keys without `_id`. */
export const bareKeysOf = (index: SeqKeysetIndex): Record<string, 1> =>
  Object.fromEntries(Object.entries(index.keys).filter(([k]) => k !== '_id')) as Record<string, 1>;

// ── Readiness: does this collection have its compound yet ──────────────────────

/**
 * The cache of "does this collection have its compound": a probe cache of its own (`util/cached-probe.ts`, which owns the
 * single flight, the LRU bound and the never-throws), sized for every collection of every space rather than for the few keys
 * the shared one is bounded to — a bound below the number of collections would make every read of an evicted one a `listIndexes`.
 */
const readiness = createProbeCache({ maxKeys: 50_000 });
/**
 * A positive answer is revalidated rarely; a negative one soon, so a build that finished is noticed even without the pass; and
 * a store that did not answer is not an answer about the index, so it is not remembered at all.
 */
const READINESS_TTL: ProbeTtl = { yesMs: 10 * 60_000, noMs: 30_000, failedMs: 0 };
const COMPOUND = indexNameOf({ seq: 1, _id: 1 });

/** Record what a collection's index list says. Called by the pass that builds the compound, after it has looked. */
export function noteKeysetIndexes(collName: string, indexNames: readonly string[]): void {
  readiness.prime(collName, indexNames.includes(COMPOUND));
}

/** Forget what is cached: the next read looks again. For tests that rebuild a collection's indexes underneath it. */
export function forgetKeysetReadiness(): void { readiness.forget(); }

/** Does the collection have the compound? `false` (and not remembered) when the store does not answer. */
const keysetReady = (collName: string): Promise<boolean> =>
  readiness.probe(collName, READINESS_TTL, async () => (await indexNamesOf(collName)).includes(COMPOUND));

// ── The read ───────────────────────────────────────────────────────────────────

/**
 * Up to `limit` records of one space collection that come after `after`, settled ones only, in `(seq, _id)` order.
 *
 * `extra` narrows what is read (composed with `$and`); `projection` is the caller's. The horizon is taken here, once,
 * before either find, so a seq allocated while the finds run is never handed out below one that has not settled.
 */
export async function readAfterSeq<T extends Document>(
  spaceId: string, part: SpacePart, after: SeqPosition,
  opts: { limit: number; extra?: Readonly<Record<string, unknown>> | undefined; projection?: Document | undefined },
): Promise<T[]> {
  const { limit, extra, projection } = opts;
  const collName = spaceCollection(spaceId, part);
  const find = async (filter: Record<string, unknown>, sort: Readonly<Record<string, 1>>, n: number): Promise<T[]> =>
    await col<T>(collName).find(asFilter<T>(filter as Filter<T>), projection ? { projection } : {}).sort({ ...sort }).limit(n).toArray() as T[];

  // One horizon for both finds, taken before either: a position past it reads nothing, and a seq that settles meanwhile waits.
  const { tie, range, horizon } = await settledSeqKeysetFilters(spaceId, after, extra);
  if (!(await keysetReady(collName))) {
    // No compound yet: by seq alone, strictly above, as before this module — a pair cursor is read by its seq.
    return find(seqKeysetFilters({ seq: after.seq }, horizon, extra).range, SEQ_ONLY_SORT, limit);
  }
  const first = tie ? await find(tie, SEQ_KEYSET_SORT, limit) : [];
  if (first.length >= limit) return first;
  return [...first, ...await find(range, SEQ_KEYSET_SORT, limit - first.length)];
}
