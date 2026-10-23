/**
 * The one newest-first order of a script's rows (Q-590 pre-ship, L9).
 *
 * ## What it prevents
 *
 * "Which row is newest" decides which duplicate of a record survives and which run a baseline starts from, and it was spelled twice:
 * once inside `test-times.mjs`, once inline in the shared recorder module. Two spellings of one comparison drift (one gains a
 * tie-break, the other keeps returning 0 for equal times), and then two recorders collapse the same duplicates to different rows.
 * `testing/standalone/telemetry-record-declares-checks-and-upserts-by-key.test.js` holds that exactly one script spells it.
 */

/**
 * A comparator that puts the larger value of `field` first (ISO times compare as text). Its ascending twin is the same comparator
 * with its arguments swapped, never a second spelling of the comparison.
 *
 * @param {string} field
 * @returns {(a: Record<string, any>, b: Record<string, any>) => number}
 */
export const newestBy = (field) => (a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0);
