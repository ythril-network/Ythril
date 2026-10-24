/**
 * How long a network-wide re-read takes: the one function the dialog's estimate is built from (bundle-81, decisions 40 and 42).
 *
 * A pull reads at most 10,000 records per cycle (`pull-family.ts`, until Q-264 lands) and a member reads ONE space per cycle, so a
 * re-read of several spaces takes the SUM over the spaces of `ceil(records / 10,000)` cycles, not the cycles of their total: three
 * spaces of 6,000 records are three cycles, where 18,000 records in one space are two. An empty space still takes its cycle, because
 * the member visits it once. Times the schedule's interval, that is the duration the dialog shows. What this prevents: an estimate
 * computed over the total, which is short whenever the records are spread over many small spaces, and understates the wait the
 * operator is asked to weigh before confirming.
 */

/** Records one pull reads per cycle. */
export const RECORDS_PER_CYCLE = 10_000;

/** Sync cycles a re-read of spaces holding these record counts takes: one list entry per chosen space. */
export function rereadCycles(recordCounts: readonly number[]): number {
  return recordCounts.reduce((cycles, records) => cycles + Math.max(1, Math.ceil(Math.max(0, records) / RECORDS_PER_CYCLE)), 0);
}
