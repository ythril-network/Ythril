/**
 * Which messages a manual scan's answer owes its reader — one question, answered once for the Review tab's two scans.
 *
 * ## What it prevents
 *
 * A scan answers `200` with counts, and a count over a scan that did not finish reads as a result: "0 found" over a type whose search ran over an
 * index that was not ready (`indexHeld`, Q-697) reads as "nothing disagrees", and the same over a space that could not be scanned (`failedSpaces`,
 * Q-381) or a judge that was unreachable (`nliStalled`). Each is a different cause that sends the reader somewhere else, so each has its own
 * message, and the toast code of either scan asks here instead of testing the fields itself, where the next field added is forgotten by one of them.
 *
 * Answers translation KEYS, in the order they are said; the caller translates them (it owns the transloco service and the toast).
 */

/** The parts of a scan answer that say it did not finish. All optional: an older server omits them. */
export interface ScanAnswer {
  nliStalled?: boolean;
  failedSpaces?: readonly unknown[];
  indexHeld?: readonly unknown[];
}

/** The messages a contradiction scan's answer owes: the judge that was unreachable, a space that could not be scanned, a type whose index was not ready. */
export function contradictionScanNotices(r: ScanAnswer): string[] {
  return [
    ...(r.nliStalled ? ['review.contradictions.scanStalled'] : []),
    // The tab scans ONE space, so a space the scan could not scan is the whole scan: a `200` that names it (Q-381) must not read as done.
    ...(r.failedSpaces?.length ? ['duplicates.scanError'] : []),
    ...(r.indexHeld?.length ? ['review.contradictions.scanHeld'] : []),
  ];
}

/** The messages a duplicate scan's answer owes: a space that could not be scanned, a type whose index was not ready. */
export function duplicatesScanNotices(r: ScanAnswer): string[] {
  return [
    ...(r.failedSpaces?.length ? ['duplicates.scanError'] : []),
    ...(r.indexHeld?.length ? ['duplicates.scanHeld'] : []),
  ];
}
