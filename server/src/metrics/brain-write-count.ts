/**
 * Count a brain write's version outcome without importing the metrics registry.
 *
 * ## The question it answers
 *
 * "How does a module that stamps versions say that a write was refused at the ceiling, or lost a race and retried, when the registry reaches it?"
 * The registry reads gauges from modules that stamp (the file tombstones' hold, the records' hold), and those modules reach the stamp
 * (`util/version-stamp.ts`, `brain/write-at-read-version.ts`); a static import back to the registry for the counter is a runtime import cycle
 * (`no-runtime-import-cycles`), legal in ESM until a binding is read during evaluation.
 *
 * So the counter is `ythril_brain_write_seq_total` in the registry as ever, and this leaf is the door to it: the registry gives it a sink when it
 * loads, and a count made before then (a unit test that never loads the registry) is dropped, as no scrape would have read it.
 */

/** Where a count goes: the registry's counter, `collection` the collection's name and `outcome` one of its labels. */
type Sink = (collection: string, outcome: string) => void;

let sink: Sink | undefined;

/** Called once by the registry, at load. */
export function setBrainWriteSink(next: Sink): void {
  sink = next;
}

/** One brain write's outcome, counted: `ceiling` (refused, the record's version is at the highest sync accepts) or `collision` (a retry). */
export function countBrainWriteSeq(collection: string, outcome: 'ceiling' | 'collision'): void {
  sink?.(collection, outcome);
}
