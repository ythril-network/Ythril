/**
 * A move's marker — what a move writes on its tombstones so a failure that stopped it after its bytes can be told from an orphan, and
 * the questions asked of it.
 *
 * ## The question it answers
 *
 * *"Is the move from `from` to `to` still OWED, and may this row of the marker go?"* A move's tombstones also name the move
 * (`move: { from, to }`). With no bytes at `from` and bytes at `to`, that is the only thing that tells a move a store failure stopped
 * after its bytes from an orphan `from` beside an unrelated `to` — which the retry used to "complete", overwriting `to`'s derived
 * records (preship-3 P3-2). Cleared once the move is finished.
 *
 * **Whether a move is still OWED is one question, {@link moveIsOwed}, and every remover of a marker row or of the marker asks it**
 * (the settle's clearing, the prune, a supersede, a drop, a publish that removes a pending row, {@link forgetFinishedMove}) — the
 * space wipe alone does not, because the space no longer holds what a move would carry (`no-remover-drops-an-owed-move-marker.test.js`
 * derives the removers). A remover that cannot tell keeps the row. The marker also holds what finishing the move needs without the
 * request that began it ({@link MoveMarker}: what the bytes were, who asked, how often housekeeping has tried), all of it inside `move`
 * and off the wire.
 *
 * ## One place for the marker's query shapes
 *
 * The marker is read three ways: a WALK (every move begun before an instant, resumed — {@link createMoveMarkerPager}, the one door),
 * a PATH-SET read ({@link movesBegunInto}, the moves out of some paths) and a POINT read ({@link moveMarkerOf}). The shapes
 * ({@link MOVE_MARKER_QUERIES}, {@link moveMarker}) are spelled here and nowhere else, so a walk written by hand — a `find` on
 * `move.from` with a `limit` and no cursor, which looks at the same first moves for ever — is refused where it is written
 * (`move-marker-queries-are-read-through-the-pager.test.js`).
 *
 * ## Where it sits (Q-462)
 *
 * Split out of `files/tombstones.ts`. It imports the collection's store (`files/tombstone-store.ts`) and never `tombstones.ts`, so
 * `settleBegunMove` — the one marker-keyed act that must PUBLISH a tombstone — stays in `tombstones.ts`, which imports this module:
 * `the-move-marker-block-is-its-own-module.test.js` holds the three edges and that there is no cycle among them.
 */

import { toDocId } from '../util/paths.js';
import { asFilter, asUpdate } from '../db/mongo.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { log, peerText } from '../util/log.js';
import { inChunks } from '../util/chunks.js';
import { keyedLock } from '../util/keyed-lock.js';
import { removeConvergedLinks } from './move-links.js';
import { isTheMovedBytes, movedBytesOf, somethingOfTheFileIsAt } from './move-marker-reads.js';
import { fileLinkSourcesOf } from '../brain/link-adjacency.js';
import { kindAt, moveKey, movedPairs, parentOfSidecar } from './moved-paths.js';
import {
  ask, tombstonesAtPaths, tombstonesOf, type FileTombstoneQuery, type FileTombstoneQuerySample, type MoveMarker, type StoredFileTombstone,
} from './tombstone-store.js';

// The marker's type is defined with the stored row it lives in (the store), and read by the callers that carry a marker around (the
// delete's cascade, the housekeeping that finishes a move) from HERE: the store is imported by the lifecycle and this module only
// (`a-file-tombstone-is-read-through-its-one-module.test.js`), so a caller holding a marker never reaches the collection's door.
export type { MoveMarker } from './tombstone-store.js';

/** What a builder of {@link MOVE_MARKER_QUERIES} is asked with; each reads the parts it needs. */
export interface MoveMarkerQuerySample extends Pick<FileTombstoneQuerySample, 'before' | 'paths' | 'limit'> {
  /** Where the walk resumes: strictly after this move. Absent at the start. */
  afterMove?: { from: string; to: string } | undefined;
}

/**
 * THE questions asked of the marker, in the shape `ask` runs (`tombstone-store.ts`), each a function of one sample bag — the marker
 * half of what an index must answer. `file-tombstones-are-indexed-db` explains these objects together with the store's, so the plan
 * it checks is the plan the module runs and not a copy of it.
 */
export const MOVE_MARKER_QUERIES = {
  /**
   * The rows that carry a move's marker and were written before `before`, in `(move.from, move.to)` order, resuming after `afterMove`:
   * a keyset over the MOVE, not the row, so the many rows of one big move are passed in one step (the cursor skips them all) and
   * cannot pin the head of the window. Two reads as the page questions are — the rest of a run at the cursor's own `from`, then
   * the later `from`s — each bounded by the marker's index.
   */
  moveMarkers: ({ before, afterMove, limit }: Pick<MoveMarkerQuerySample, 'before' | 'afterMove' | 'limit'>): FileTombstoneQuery => {
    const settled = { deletedAt: { $lte: before } };
    return {
      filter: { ...settled, 'move.from': { $gt: afterMove?.from ?? '' } },
      tie: afterMove ? { ...settled, 'move.from': afterMove.from, 'move.to': { $gt: afterMove.to } } : null,
      sort: { 'move.from': 1, 'move.to': 1 }, limit,
    };
  },
  /** The rows whose move wrote them with one of `paths` as its source: what a media job at that path asks. */
  movesFrom: ({ paths }: Pick<MoveMarkerQuerySample, 'paths'>): FileTombstoneQuery =>
    ({ filter: { 'move.from': { $in: [...paths] } } }),
  /** The rows whose move carried a file to one of `paths`: what the delete of a path asks of the moves that ended there. */
  movesInto: ({ paths }: Pick<MoveMarkerQuerySample, 'paths'>): FileTombstoneQuery =>
    ({ filter: { 'move.to': { $in: [...paths] } } }),
} as const;

/** The marker a move writes on its tombstones, as a filter. */
export const moveMarker = (from: string, to: string) => ({ 'move.from': toDocId(from), 'move.to': toDocId(to) });

/** A marker as it is stored: its paths as the stores key them, and no field the caller left undefined (a stored `null` is a value). */
export const markerDocOf = (m: MoveMarker): MoveMarker => ({
  // `fromEntries` types its result as a bare record, so the cast restores the marker's type; the fields are NOT listed here instead, because
  // a listed marker silently drops the next field it gains.
  ...(Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as unknown as MoveMarker),
  from: toDocId(m.from), to: toDocId(m.to),
});

/**
 * Forget a move that is not owed, and take back the links it converged onto its destination. Called by the retry (a source with no
 * bytes and a move not owed) and by the settle sweep, so neither can forget a marker and leave the links a batch put at `to` behind
 * (a file arriving at that path later would inherit them). An owed move is left alone: `forgetFinishedMove` refuses it.
 * A move whose bytes are not at `to`, or are still at `from`, is not touched — it was not abandoned, it did not happen.
 *
 * Here and not in the cascade because the settle (`tombstones.ts`) cannot import the cascade (the cascade imports it).
 */
export async function abandonMove(spaceId: string, from: string, to: string): Promise<void> {
  const marker = await moveMarkerOf(spaceId, from, to);
  if (!marker || !(await movedBytesOf(spaceId, marker))) return;
  if (await moveIsOwed(spaceId, from, to)) return;
  const kind = await kindAt(spaceId, marker.to);
  const froms = await fileLinkSourcesOf(spaceId, from, kind);
  await removeConvergedLinks(spaceId, movedPairs(froms, from, to));
  await forgetFinishedMove(spaceId, from, to);
}

/** The marker of the move from `from` to `to` as stored — its extras included — or `undefined` when none was written or it was cleared. */
export async function moveMarkerOf(spaceId: string, from: string, to: string): Promise<MoveMarker | undefined> {
  const row = await tombstonesOf(spaceId).findOne(asFilter<StoredFileTombstone>(moveMarker(from, to)), { projection: { move: 1 } });
  return row?.move;
}

/**
 * Whether the move from `from` to `to` is OWED: begun here (its marker), its bytes at `to` (and none at `from`, bar a half-made link or one
 * entry under two spellings, `movedBytesOf`), those bytes are
 * the ones it moved, and something of the file is still at `from` — a live record, a link row or a job. THE one answer to "is
 * this move still unfinished", asked by the retry of a move, by the housekeeping that finishes it, by the media worker before it
 * reconciles a "deleted source", and by every remover of a marker ({@link movesStillOwed}).
 *
 * ## What it prevents
 *
 * A remover of a marker that decided for itself whether the marker was clutter, without asking whether the record is still at the
 * source, would strand the move's records for ever: the settle forgetting it ten minutes on, the prune taking its row a day on, a
 * supersede or a drop removing the row that carries it, the worker — finding no bytes at the old path — removing the record itself.
 * Each looks right where it stands (`no-remover-drops-an-owed-move-marker` derives the sites).
 *
 * ## The two ways it fails, and they run opposite ways
 *
 * - **The bytes at `to` are not shown to be the moved ones** (a size or mtime that differs from the marker's) is NOT owed: the
 *   move would be finished over an unrelated file, replacing its derived records, which is what the marker exists to prevent.
 *   A marker written before the identity was recorded carries neither and is judged on the other facts.
 * - **A path that cannot be looked at throws.** A caller that is about to REMOVE something reads that as "keep"
 *   ({@link movesStillOwed}); the one that is about to complete the move reads it as "not now".
 */
export async function moveIsOwed(spaceId: string, from: string, to: string): Promise<boolean> {
  const marker = await moveMarkerOf(spaceId, from, to);
  if (!marker) return false;
  const atTo = await movedBytesOf(spaceId, marker);
  if (!atTo) return false;
  if (!isTheMovedBytes(atTo, marker)) return false;
  return somethingOfTheFileIsAt(spaceId, marker.from, atTo.isDirectory ? 'directory' : 'file');
}

/**
 * Which of the moves the `rows` name are STILL OWED ({@link moveIsOwed}), by key — for a REMOVER, so it fails the other way: a move
 * whose paths cannot be looked at counts as owed, and its row is kept. A row with no marker names no move.
 */
export async function movesStillOwed(spaceId: string, rows: ReadonlyArray<{ move?: MoveMarker | undefined }>): Promise<Set<string>> {
  const owed = new Set<string>();
  const asked = new Set<string>();
  for (const { move } of rows) {
    if (!move || asked.has(moveKey(move))) continue;
    asked.add(moveKey(move));
    try {
      if (await moveIsOwed(spaceId, move.from, move.to)) owed.add(moveKey(move));
    } catch (err) {
      owed.add(moveKey(move));
      log.warn(`File tombstone move ${peerText(move.from)} → ${peerText(move.to)} of ${peerText(spaceId)} could not be judged owed or finished, so its marker is kept: ${peerText(err)}`);
    }
  }
  return owed;
}

/**
 * Delete the rows `rows` (by id, narrowed by `where`) — the one way a row that MAY carry a move's marker is removed. A move that
 * is still OWED needs its marker on at least one row, so its rows go while another row of the move stays, and when none would the
 * first of them is kept. A row of a move that is not owed, or of none, goes. Returns how many went.
 *
 * Not "keep every row of an owed move": a move writes the marker on every file it takes (and every sidecar), and the rows of a
 * sidecar that stayed behind are dropped by the move itself while it is still owed, with the file's own row carrying the marker on.
 *
 * ## One remover at a time per space, and the lock is here so no caller can leave it out
 *
 * "Does another row of the move survive?" and the delete are two steps, and two removers (the prune after an acknowledgement, a
 * supersede, a drop of pending rows) running together could each read the OTHER's row as the survivor and each delete its own: the
 * move lost its marker with its records still at the source. A remover takes its space's turn (`markerRemovalLock`) from its read of
 * the survivor to its delete, so a second one reads what the first left. The lock is in-process, like every hold of the tombstone modules: one
 * server process owns a data root.
 */
export function removeUnlessOwed(
  spaceId: string, rows: ReadonlyArray<{ _id: string; move?: MoveMarker | undefined }>, where: Record<string, unknown>,
): Promise<number> {
  return markerRemovalLock.run(spaceId, () => removeUnlessOwedUnlocked(spaceId, rows, where));
}

/** One remover of marker rows per space at a time ({@link removeUnlessOwed}). */
const markerRemovalLock = keyedLock();

async function removeUnlessOwedUnlocked(
  spaceId: string, rows: ReadonlyArray<{ _id: string; move?: MoveMarker | undefined }>, where: Record<string, unknown>,
): Promise<number> {
  const owed = await movesStillOwed(spaceId, rows);
  const kept = new Set<string>();
  for (const key of owed) {
    const ofTheMove = rows.filter(r => r.move && moveKey(r.move) === key);
    const marker = ofTheMove[0]!.move!;
    const survives = await tombstonesOf(spaceId).findOne(
      asFilter<StoredFileTombstone>({ ...moveMarker(marker.from, marker.to), _id: { $nin: ofTheMove.map(r => r._id) } }), { projection: { _id: 1 } });
    if (survives === null) kept.add(ofTheMove[0]!._id);
  }
  let removed = 0;
  for (const chunk of inChunks(rows.filter(r => !kept.has(r._id)).map(r => r._id), READ_CHUNK)) {
    removed += (await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: chunk }, ...where }))).deletedCount ?? 0;
  }
  return removed;
}

/**
 * Every move with a marker written before `before`, one entry per move (never per row), in `(from, to)` order — the moves that are
 * past their act, as the settle reads them. Each step is one indexed read of the next move after the last, so a directory move
 * with thousands of rows costs one step, and the caller stops when it has had enough.
 */
async function* movesBegunBefore(spaceId: string, before: string, after?: { from: string; to: string }): AsyncGenerator<MoveMarker & { markedAt: string }> {
  let at = after;
  for (;;) {
    const [row] = await ask<{ move?: MoveMarker; deletedAt: string }>(spaceId, MOVE_MARKER_QUERIES.moveMarkers({ before, afterMove: at, limit: 1 }), { move: 1, deletedAt: 1 });
    if (!row?.move) return;
    at = { from: row.move.from, to: row.move.to };
    yield { ...row.move, markedAt: row.deletedAt };
  }
}

/**
 * A cursor over each space's begun moves for a REPEATING pass: `next(spaceId, before, limit)` returns at most `limit` moves
 * ({@link movesBegunBefore}) beginning after the last move the previous call returned for that space, and `reachedTheEnd` says the
 * pass has seen them all — the cursor is then cleared and the next call starts at the head.
 *
 * ## What it prevents
 *
 * A pass that capped its batch and began at the head every time looked at the same first moves for ever once they could not be
 * cleared or finished (a stranded one, a path it cannot look at), and the moves behind them never got a look. Each pass over the
 * markers (the settle's clearing of the finished ones, housekeeping's finishing of the owed ones) keeps its OWN pager, so one
 * pass's cursor never moves another's. State is per pager and in memory: a restart begins at the head, which is only a delay.
 */
export function createMoveMarkerPager(): (spaceId: string, before: string, limit: number) => Promise<{ markers: Array<MoveMarker & { markedAt: string }>; reachedTheEnd: boolean }> {
  const resume = new Map<string, { from: string; to: string }>();
  return async (spaceId, before, limit) => {
    const markers: Array<MoveMarker & { markedAt: string }> = [];
    let reachedTheEnd = true;
    for await (const marker of movesBegunBefore(spaceId, before, resume.get(spaceId))) {
      if (markers.length >= limit) { reachedTheEnd = false; break; }
      markers.push(marker);
      resume.set(spaceId, { from: marker.from, to: marker.to });
    }
    if (reachedTheEnd) resume.delete(spaceId);
    return { markers, reachedTheEnd };
  };
}

/** The moves whose marker names any of `paths` as the SOURCE: the begun moves that were carrying a file from one of them. */
async function movesBegunFrom(spaceId: string, paths: readonly string[]): Promise<MoveMarker[]> {
  return distinctMoves(await tombstonesAtPaths<{ move?: MoveMarker }>(spaceId, paths.map(toDocId),
    chunk => MOVE_MARKER_QUERIES.movesFrom({ paths: chunk }).filter, { move: 1 }));
}

/** The moves whose marker names `to` as the DESTINATION: the begun moves that carried a file to that path. */
export async function movesBegunInto(spaceId: string, to: string): Promise<MoveMarker[]> {
  return distinctMoves(await tombstonesAtPaths<{ move?: MoveMarker }>(spaceId, [toDocId(to)],
    chunk => MOVE_MARKER_QUERIES.movesInto({ paths: chunk }).filter, { move: 1 }));
}

/** One marker per move among rows that carry one. */
function distinctMoves(rows: ReadonlyArray<{ move?: MoveMarker }>): MoveMarker[] {
  const byKey = new Map<string, MoveMarker>();
  for (const { move } of rows) if (move && !byKey.has(moveKey(move))) byKey.set(moveKey(move), move);
  return [...byKey.values()];
}

/**
 * Whether a move that began here is carrying the records at `path` — a file moved from it, a file under a directory moved from an
 * ancestor of it, or a sidecar of either — and is not known to be over: owed, or a move whose paths cannot be looked at. What the
 * media worker asks before it takes a path with no bytes for a DELETED source: a moved file's bytes are not at its old path
 * either, and what the worker would remove is the record the move still has to carry.
 */
export async function moveCarriesRecordsAt(spaceId: string, path: string): Promise<boolean> {
  const at = toDocId(path);
  const parent = parentOfSidecar(at)?.parent;
  const from = [at, ...(parent ? [parent] : [])].flatMap(p => p.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')));
  const owed = await movesStillOwed(spaceId, (await movesBegunFrom(spaceId, [...new Set(from)])).map(move => ({ move })));
  return owed.size > 0;
}

/**
 * Record that housekeeping is trying to finish the move now: `attempts` (counted BEFORE the try, so a try a restart ended is
 * counted) and the instant before which it is not tried again. On every row of the move, inside the marker, so forgetting the
 * marker forgets them.
 */
export async function recordMoveAttempt(spaceId: string, from: string, to: string, attempts: number, nextAttemptAt: string): Promise<void> {
  await tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>(moveMarker(from, to)),
    asUpdate<StoredFileTombstone>({ $set: { 'move.attempts': attempts, 'move.nextAttemptAt': nextAttemptAt } }));
}

/**
 * Forget a finished move's marker, so a later orphan at `from` beside a file at `to` is not taken for it — and, a move that is
 * still OWED is not forgotten ({@link moveIsOwed}): the marker is all that lets the retry, or housekeeping, finish it. Returns
 * whether the marker was cleared. Best effort: a marker left behind matters only to that history, and failing a finished move
 * over it would answer a failure for an act that happened; a move that cannot be judged keeps its marker.
 */
export async function forgetFinishedMove(spaceId: string, from: string, to: string): Promise<boolean> {
  try {
    if (await moveIsOwed(spaceId, from, to)) return false;
    await tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>(moveMarker(from, to)), asUpdate<StoredFileTombstone>({ $unset: { move: '' } }));
    return true;
  } catch (err) {
    log.warn(`forgetFinishedMove for space ${peerText(spaceId)}, ${peerText(from)} → ${peerText(to)}: ${peerText(err)}`);
    return false;
  }
}

/** How long a published tombstone that carries a move's marker is kept whatever was acknowledged: the marker is the only record that the move is owed. */
export const MOVE_MARKER_KEEP_MS = 24 * 3_600_000;

