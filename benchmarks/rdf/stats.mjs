/**
 * The median and the 95th percentile of a run's timings.
 *
 * ## What this prevents
 *
 * The result table's two numbers per query come from here, and the cache decision rests on them. A caller
 * that sorts the input in place changes the order of the recorded timings; a caller that answers `0` or
 * `NaN` for an empty sample puts a fast-looking row into the table for a query that never ran. So the input
 * is copied before it is sorted, and an empty or non-finite sample is refused rather than summarised.
 *
 * ## The definitions, because two are in common use
 *
 * - **median**: the middle value of the sorted sample; for an even count, the mean of the two middle values.
 * - **percentile**: the nearest rank, the `ceil(p / 100 * n)`-th smallest value. For the harness's 20 measured
 *   runs, p95 is the 19th smallest. No interpolation: the reported number is a time that was observed.
 */

function sortedCopy(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('empty sample: there is nothing to take a median or a percentile of');
  }
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`sample holds a value that is not finite: ${String(v)}`);
    }
  }
  return [...values].sort((a, b) => a - b);
}

export function median(values) {
  const s = sortedCopy(values);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(values, p) {
  if (typeof p !== 'number' || !(p > 0 && p <= 100)) {
    throw new Error(`percentile must be between 0 (exclusive) and 100, got ${String(p)}`);
  }
  const s = sortedCopy(values);
  return s[Math.ceil((p / 100) * s.length) - 1];
}

/** The numbers a result record keeps per query. */
export function summarize(values) {
  const s = sortedCopy(values);
  return { n: s.length, median: median(s), p95: percentile(s, 95), min: s[0], max: s[s.length - 1] };
}
