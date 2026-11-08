/**
 * The floor of a space's file change feed: the lowest cursor position the feed still answers exactly (bundle-255, Q-724).
 *
 * ## The question it answers
 *
 * "Below which position has this space's file history been forgotten?" A deleted file is announced by the row it leaves at its path (a flagged audit row, or
 * a feed marker where soft delete is off: `files/feed-marker.ts`), and that row is removed sooner or later (the Files window, the feed window, a folder's
 * hard delete, a move over it, a wipe, a restore). A cursor from before such a removal would page past a deletion it never saw: a silent gap. So every
 * removal of a positioned deletion row raises this floor FIRST, to the highest position among the rows it is about to remove, and the feed refuses a cursor
 * below it (`410 cursor_expired`: start again with no cursor). A wipe and a restore raise it to the head: every file the client was told of may be gone or
 * different.
 *
 * ## Where it lives, and why there
 *
 * One document per space in `ythril_file_feed_floors`, keyed by the space id: OUTSIDE every collection a restore replaces (so a restore of a backup taken
 * before a purge keeps the purge's floor) and outside `ythril_counters` (which a restore rewrites and a rename moves with its own rules). A rename carries it
 * ({@link moveFileFeedFloor}); a raise is a `$max`, so two purges racing can never lower it.
 *
 * ## What it prevents
 *
 * A floor raised AFTER the rows are removed leaves a window in which a reader pages past the removal with an old cursor and is never told: the raise comes
 * first, and a raise whose removal then fails only re-lists a client that did not need to (safe direction).
 */
import { randomBytes } from 'node:crypto';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { settledPositionCap } from '../util/position-clock.js';
import { isPositionNumber } from '../util/position-number.js';

/** The collection holding each space's floor: `{ _id: <spaceId>, floor: <position> }`. */
export const FILE_FEED_FLOORS = 'ythril_file_feed_floors';

interface FloorDoc { _id: string; floor: number; stream?: string }

const floors = () => col<FloorDoc>(FILE_FEED_FLOORS);

/** The space's floor, 0 when nothing was ever forgotten. */
export async function fileFeedFloorOf(spaceId: string): Promise<number> {
  const doc = await floors().findOne(asFilter<FloorDoc>({ _id: spaceId }));
  return doc && isPositionNumber(doc.floor) ? doc.floor : 0;
}

/** Raise the floor to `pos` (never lowers it). A position that is not one is ignored. Called BEFORE the rows that held it are removed. */
export async function raiseFileFeedFloor(spaceId: string, pos: number | undefined): Promise<void> {
  if (!isPositionNumber(pos) || pos === 0) return;
  await floors().updateOne(asFilter<FloorDoc>({ _id: spaceId }), asUpdate<FloorDoc>({ $max: { floor: pos } }), { upsert: true });
}

/** Raise the floor to the highest `pos` among `rows` (the rows about to be removed). */
export async function raiseFileFeedFloorOver(spaceId: string, rows: ReadonlyArray<{ pos?: unknown }>): Promise<void> {
  let top = 0;
  for (const r of rows) if (isPositionNumber(r.pos) && r.pos > top) top = r.pos;
  await raiseFileFeedFloor(spaceId, top);
}

/** Raise the floor to the space's settled head: what a wipe and a restore do, so every cursor handed out before them re-lists. */
export async function raiseFileFeedFloorToHead(spaceId: string): Promise<void> {
  // Imported here, not at the top: the records stream seeds itself from this floor (`positionFloor`), so a static import would be a cycle.
  const { recordPositions } = await import('../sync/record-position-stream.js');
  const cap = await settledPositionCap(recordPositions, spaceId);
  await raiseFileFeedFloor(spaceId, Math.max(0, cap - 1));
}

/**
 * The space's feed STREAM tag, made on first ask and kept in the floor's document: a cursor carries it, so a cursor read from one space is refused by
 * another (positions are per space, and one space's position means nothing in another's stream), while a rename, which carries the document, keeps every
 * cursor valid. Answers the tag and the floor in one read.
 */
export async function fileFeedStateOf(spaceId: string): Promise<{ stream: string; floor: number }> {
  let doc = await floors().findOne(asFilter<FloorDoc>({ _id: spaceId }));
  if (typeof doc?.stream !== 'string') {
    await floors().updateOne(asFilter<FloorDoc>({ _id: spaceId }),
      [{ $set: { stream: { $ifNull: ['$stream', randomBytes(8).toString('hex')] }, floor: { $ifNull: ['$floor', 0] } } }] as never, { upsert: true });
    doc = await floors().findOne(asFilter<FloorDoc>({ _id: spaceId }));
  }
  return { stream: String(doc?.stream), floor: doc && isPositionNumber(doc.floor) ? doc.floor : 0 };
}

/**
 * Drop the space's floor document (a delete): its stream tag and its floor. The prefix drop of a space's collections cannot reach it (the collection is
 * instance-wide, keyed by the space id), and a space created again under the id would find the old tag, so a client's cursor from the deleted space would be
 * served as if nothing was lost. Without the document the new space makes a new tag, and the old cursor is refused as one from another stream. Idempotent.
 */
export async function dropFileFeedFloor(spaceId: string): Promise<void> {
  await floors().deleteOne(asFilter<FloorDoc>({ _id: spaceId }));
}

/** Carry the floor document of `oldId` to `newId` (a rename): the higher floor and the old stream tag stay, the old document goes. */
export async function moveFileFeedFloor(oldId: string, newId: string): Promise<void> {
  const old = await floors().findOne(asFilter<FloorDoc>({ _id: oldId }));
  if (!old) return;
  await floors().updateOne(asFilter<FloorDoc>({ _id: newId }), asUpdate<FloorDoc>({
    $max: { floor: isPositionNumber(old.floor) ? old.floor : 0 },
    ...(typeof old.stream === 'string' ? { $set: { stream: old.stream } } : {}),
  }), { upsert: true });
  await floors().deleteOne(asFilter<FloorDoc>({ _id: oldId }));
}
