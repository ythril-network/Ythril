/**
 * Count a raise of a space's version counter without importing the metrics registry.
 *
 * ## The question it answers
 *
 * "How does the module that keeps a space's version mark (`util/version-mark.ts`) say that it raised a counter, when the registry reaches
 * the stamping modules?" The same question `metrics/brain-write-count.ts` answers for the ceiling and collision counts, and for the same
 * reason: a static import back to the registry is a runtime import cycle (`no-runtime-import-cycles`). The counter is
 * `ythril_version_counter_raised_total` in the registry; the registry gives this leaf a sink when it loads, and a count made before then
 * (a unit test that never loads the registry) is dropped, as no scrape would have read it.
 */

/** Why a counter was raised: `start` (the first stamp of a space in this process) or `went_back` (the counter was found below one this process had seen). */
export type VersionRaiseReason = 'start' | 'went_back';

/** The reasons, so the registry pre-declares one series for each. */
export const VERSION_RAISE_REASONS: readonly VersionRaiseReason[] = ['start', 'went_back'];

let sink: ((reason: VersionRaiseReason) => void) | undefined;

/** Called once by the registry, at load. */
export function setVersionRaiseSink(next: (reason: VersionRaiseReason) => void): void {
  sink = next;
}

/** One raise of a counter that actually moved it, counted under its reason. */
export function countVersionCounterRaise(reason: VersionRaiseReason): void {
  sink?.(reason);
}
