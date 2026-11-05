/**
 * Count a background scan's hold without importing the metrics registry.
 *
 * ## The question it answers
 *
 * "How does `brain/scan-cursor.ts` say that a scanner held a type because its index was not ready, when the registry reaches the
 * scanners?" The registry imports the modules that import the scan cursor, so the cursor cannot import the registry
 * (`no-runtime-import-cycles`); the registry gives this leaf a sink when it loads, as `metrics/embed-job-failed-count.ts` does for its
 * counter, and a count made before then (a unit test that never loads the registry) is dropped, as no scrape would have read it. The
 * counter is `ythril_scan_holds_total{scanner}`.
 *
 * ## What it prevents
 *
 * The scanners named in a hand-written list in the registry and again at each call: a scanner added to one and not the other is a series
 * nobody declared at zero. {@link SCAN_HOLD_SCANNERS} is the one list; the registry pre-declares one series per entry and the cursor's
 * `noteScanHold` takes only a member of it.
 */
import { countSink } from './count-sink.js';

/** The scanners that hold: the duplicate scanner (`dupe`) and the contradiction scanner (`contradiction`). One list, so every series is declared at zero. */
export const SCAN_HOLD_SCANNERS = ['dupe', 'contradiction'] as const;

/** A scanner that can hold, as `ythril_scan_holds_total` labels it. */
export type ScanHoldScanner = typeof SCAN_HOLD_SCANNERS[number];

const holds = countSink<[scanner: ScanHoldScanner]>();

/** Called once by the registry, at load. */
export const setScanHoldSink = holds.set;

/** `ythril_scan_holds_total`, as the scan cursor counts it: one type held by one scanner, under the scanner's name. */
export const scanHoldsTotal = { note: holds.add };
