/**
 * The figures a file move is paced by, in one place a test can narrow — the way `db/write-bound.ts` keeps the write bound's.
 *
 * ## The question it answers
 *
 * *"How long does a move keep its jobs unclaimable, how close to the end of that may it run before it extends it, and how many bytes
 * of rows may one transaction carry?"* Three figures with one owner, so the job queue (which holds), the cascade (which batches) and
 * a test (which needs a 20 ms hold and a 1 KB batch to see a move stop between two batches) cannot disagree about them.
 *
 * ## The byte budget
 *
 * A move's rows commit in transactions bounded by BYTES, not by row count: a derived row carries a vector and its text, so a
 * count that is safe for chunks of a short note is not safe for a book. Measured on the test stack with real chunk rows (about 24 KB
 * each) and the files collection's own indexes: tens of megabytes committed reliably, and a transaction several times that failed on
 * the files text index. The budget sits well under the reliable figure, so a batch is a fraction of what the store has been seen to
 * commit; the measurement and its procedure are in the bundle-44 plan (probe P5), not copied here, because a figure written into a
 * docblock outlives the stack it was taken on.
 *
 * ## Why it MERGES and refuses
 *
 * As `setWriteBoundForTest`: a figure that is not a finite positive number, or a name that is not one of these, is refused, so a typo
 * cannot set nothing and let a test pass for the wrong reason.
 */

import { narrowedFigures } from '../util/figure-narrowing.js';

export interface MoveTiming {
  /** How long a move keeps the jobs it holds unclaimable before they run on their own, ms. */
  holdMs: number;
  /** A batch extends the hold only when what is left of it is under this, ms: one write per batch is the exception, not the rule. */
  holdMarginMs: number;
  /** The most bytes of stored rows one batch's transaction carries. A single file larger than this is split by row id range. */
  txnBytes: number;
  /** How many times a batch whose plan went stale (a destination row appeared or was revived) is planned again before the move stays owed. */
  maxReplans: number;
}

/** The real figures. */
export const MOVE_HOLD_MS = 10 * 60_000;
export const FILE_MOVE_TXN_BYTES = 8 * 1024 * 1024;
const DEFAULTS: Readonly<MoveTiming> = Object.freeze({
  holdMs: MOVE_HOLD_MS, holdMarginMs: 2 * 60_000, txnBytes: FILE_MOVE_TXN_BYTES, maxReplans: 3,
});

let current: MoveTiming = { ...DEFAULTS };

/** The figures now in force. */
export const moveTiming = (): Readonly<MoveTiming> => current;

/** Narrow some of the figures for a test, or `null` to restore the real ones. Merges; refuses what it cannot use. */
export function setMoveTimingForTest(given: Partial<MoveTiming> | null): void {
  current = given === null ? { ...DEFAULTS } : narrowedFigures('setMoveTimingForTest', 'a move', current, given);
}
