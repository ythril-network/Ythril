/**
 * The records stream: the positions of every record family and the brain tombstones of a space, and the one wrapper that stamps a
 * landing (`withLandingStamp`).
 *
 * ## The question it answers
 *
 * "What does a record landing here take as its position, and what does the write hold until it commits?" The clock (`util/position-clock.ts`)
 * hands out positions of any stream; this module is the stream the records are paged and ordered by: microseconds, a number, a BLOCK of
 * consecutive values per write, seeded from what is stored and from the marks this instance answers for, refusing a write whose seed it
 * could not read. The set it covers is `SEQ_CARRYING` (the six record collections and `tombstones`), read from `util/seq.ts`, never listed.
 *
 * ## The seed (`positionFloor`)
 *
 * The highest of the stored maximum `pos` over the space's collections (the `(pos, _id)` index read backwards) and the marks this instance
 * answers for over its members (`lastPosPushed`, `lastPosServed`), **each capped when it was recorded** at this instance's own settled cap
 * for the space at that moment (`ownPositionMark`, `sync/served-watermark.ts`; read by `positionFloor`). The wall
 * clock and the in-process `last` are the clock's own. A peer-supplied number never enters the seed uncapped: a puller that sends `afterPos` near 2^53 would otherwise drive every
 * later stamp toward the ceiling.
 *
 * ## `withLandingStamp`
 *
 * The versions of the rows are computed BEFORE it (`util/version-stamp.ts`: a local write's by the formula, an arrival's the issuer's own),
 * and passed in. This takes ONE question: "stamp these rows' positions and write them under the hold". It hands the write one patch per row,
 * `{ seq, pos, posAtSeq, writtenHere }` for a local write and `{ pos, posAtSeq }` for an arrival, so no caller spells `posAtSeq` by hand:
 * `posAtSeq` is the version the position was taken for, which is how a row a 5.6 build changed without a position is found at re-upgrade.
 * Whether a version is local or arrived is the row's `local`, not a mode of the wrapper.
 *
 * It replaces `withAllocatedSeqs`: paging is by position only, so a version needs no horizon.
 *
 * `write` should be the position-writing operation and nothing else: everything it awaits holds every position-paged reader of the space
 * below the block.
 */
import { createPositionStream, withPositionHeld, oldestPositionHoldSeconds, type PositionStream } from '../util/position-clock.js';
import { highestStored } from '../util/index-top.js';
import { SEQ_CARRYING } from '../util/seq.js';
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { getConfig } from '../config/loader.js';
import { eachMemberMarkOf } from './receive-marks.js';

/**
 * The highest position this instance may already have handed out for `spaceId`, in microseconds: see the module docblock.
 *
 * **The stored maximum, and the marks.** The marks this instance answers for (`lastPosPushed`, `lastPosServed`, each cut at the instance's own settled cap when it
 * was recorded, `ownPositionMark`, `sync/served-watermark.ts`) enter the seed beside the stored maximum, read through the one walk over every member's marks
 * (`eachMemberMarkOf`, `sync/receive-marks.ts`) of every network. After a restore that lost the stored maximum (a database replaced, the data folder lost) a peer
 * still holds a mark in OUR stream, and a stamp below it would never be offered again. `lastPosReceived` is the PEER's position space and never enters the seed.
 */
async function positionFloor(spaceId: string): Promise<number> {
  const stored = await highestStored<number>(SEQ_CARRYING.map(part => col(spaceCollection(spaceId, part))), 'pos', { $type: 'number' });
  return Math.max(stored ?? 0, ownMarksFloor(spaceId));
}

/** The highest `lastPosPushed` / `lastPosServed` any member of any network holds for the space: marks that were capped when they were recorded. */
function ownMarksFloor(spaceId: string): number {
  let top = 0;
  let cfg;
  try { cfg = getConfig(); } catch { return 0; } // before setup there is no member
  for (const net of cfg.networks ?? []) {
    eachMemberMarkOf(net, spaceId, (marks, _mark, _who) => {
      const v = marks[spaceId];
      if (typeof v === 'number' && Number.isSafeInteger(v) && v > top) top = v;
    }, ['lastPosPushed', 'lastPosServed']);
  }
  return top;
}

/** THE records stream. Its one export that is an object: the clock's functions take it, and nothing else builds a stream of records. */
export const recordPositions: PositionStream<number> = createPositionStream({
  name: 'record position',
  unit: 'microseconds',
  seed: positionFloor,
  wording: { noun: 'record position', floorKey: 'pos', floorName: 'position', readers: 'every position-paged reader of the space' },
  onSeedFailure: { policy: 'refuse' },
});

/** How long the oldest open hold on the records stream of `spaceId` has been held, in seconds — 0 when none. For the gauge. */
export function oldestRecordPositionHoldSeconds(spaceId: string): number {
  return oldestPositionHoldSeconds(recordPositions, spaceId);
}

/** A row about to land: the version it carries, and whether this instance wrote it (a local write) or it arrived (the issuer's version). */
export type LandingRow = { readonly local: true; readonly version: number } | { readonly local: false; readonly version: number };

/** The row of a local write: its version comes from `versionsFor` (`util/version-stamp.ts`). */
export const localRow = (version: number): { readonly local: true; readonly version: number } => ({ local: true, version });
/** The row of an arrival: its version is the issuer's, and is never changed here. */
export const arrivalRow = (version: number): { readonly local: false; readonly version: number } => ({ local: false, version });

/** What a local write sets on its row: the version, the position it took it at, the version that position is for, and that it was written here. */
export interface LocalLanding { readonly seq: number; readonly pos: number; readonly posAtSeq: number; readonly writtenHere: true }
/**
 * What an arrival sets on its row beside the version it already carries: where it landed, the version that is for, and — only when it is true —
 * that the row was written here (`sync/written-here.ts`: nobody delivered it, and it is authored here or has no author). A peer's delivery is never
 * written here whatever its author says; an admin push or an import of this instance's own rows is.
 */
export interface ArrivalLanding { readonly pos: number; readonly posAtSeq: number; readonly writtenHere?: true }

type PatchOf<R extends LandingRow> = R extends { readonly local: true } ? LocalLanding : ArrivalLanding;

/**
 * Take one block of positions for `rows` and run `write` with one patch per row, holding the block's first position until `write` settles.
 * `holder` names who holds (one word: `fact.update`, `sync.push`), REQUIRED for the release line, the watchdog and the gauge.
 * A write that throws releases too, or every reader of the space would stall below the block.
 */
export function withLandingStamp<R extends LandingRow, T>(
  spaceId: string, rows: readonly R[], write: (patches: PatchOf<R>[]) => Promise<T>, holder: string,
): Promise<T> {
  if (rows.length === 0) return write([]);
  return withPositionHeld(recordPositions, spaceId, (first) => write(rows.map((row, i): PatchOf<R> => {
    const pos = first + i;
    return (row.local
      ? { seq: row.version, pos, posAtSeq: row.version, writtenHere: true }
      : { pos, posAtSeq: row.version }) as PatchOf<R>;
  })), holder, { count: rows.length });
}
