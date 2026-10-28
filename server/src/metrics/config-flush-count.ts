/**
 * Count a failed background flush of config.json without importing the metrics registry.
 *
 * ## The question it answers
 *
 * "How does the config loader say that a coalesced flush failed, when the registry reads the loader?" The registry imports `config/loader.ts`,
 * so the loader cannot import the registry (`no-runtime-import-cycles`); the registry gives this leaf a sink when it loads, as
 * `metrics/brain-write-count.ts` does for the stamping modules, and a count made before then is dropped. The counter is
 * `ythril_config_flush_failures_total`.
 *
 * A failed flush matters more since the version mark rides on it (`util/version-mark.ts`): the mark is saved in the background, and a flush that keeps
 * failing is a mark that is not reaching the disk.
 */

let sink: (() => void) | undefined;

/** Called once by the registry, at load. */
export function setConfigFlushFailureSink(next: () => void): void {
  sink = next;
}

/** One failed background flush of config.json, counted. */
export function countConfigFlushFailure(): void {
  sink?.();
}
