/**
 * What the last pass of housekeeping's completion of owed moves found, per space — the numbers the move gauges read.
 *
 * ## The question it answers
 *
 * "How many moves of this space are owed, how long has the oldest been waiting, and how many has housekeeping given up on?" A
 * gauge cannot ask the store itself: whether a move is owed is a marker, a stat of two paths and reads of records, per move, and
 * a scrape runs under a budget of its own. The completion (`files/finish-owed-moves.ts`) already judges every
 * marker it walks, so it says what it found here and the gauges (`metrics/registry.ts`) read it. Kept apart from both because
 * the registry cannot import the module that moves files, which imports the registry for its own counters.
 *
 * ## What it is not
 *
 * Not a count of the store's markers: it is the last COMPLETE pass's. A pass that is cut by its budget (`examineCap`) adds to the
 * pass in progress and publishes only when it has reached the end of the markers, so a space with more moves than one tick
 * examines still reads a whole figure, one pass late. A space the completion has never walked reads 0, and a gauge lists only the
 * spaces that exist, so a deleted one's last figure is never read.
 */

/** What one pass found: how many moves are owed, the oldest marker's write time among them, and how many are stranded. */
export interface OwedMovesFound {
  owed: number;
  stranded: number;
  /** The write time of the oldest owed move's marker, ISO; absent when none is owed. */
  oldestMarkedAt?: string | undefined;
}

const published = new Map<string, OwedMovesFound>();

/** Publish what a complete pass of `spaceId` found. */
export function publishOwedMoves(spaceId: string, found: OwedMovesFound): void {
  published.set(spaceId, found);
}

/** How many moves of `spaceId` the last complete pass found owed — stranded ones included, since they are owed still. */
export const owedMoveCount = (spaceId: string): number => published.get(spaceId)?.owed ?? 0;

/** How many of them housekeeping has given up on: the attempts were spent and the marker is kept. */
export const strandedMoveCount = (spaceId: string): number => published.get(spaceId)?.stranded ?? 0;

/** How long the oldest owed move of `spaceId` has been owed, in seconds; 0 when none is. */
export function oldestOwedMoveAgeSeconds(spaceId: string, now: number = Date.now()): number {
  const at = Date.parse(published.get(spaceId)?.oldestMarkedAt ?? '');
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : 0;
}
