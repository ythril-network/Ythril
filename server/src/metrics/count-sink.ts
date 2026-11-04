/**
 * The door a leaf module counts through, so the leaf never imports the metrics registry.
 *
 * ## What it prevents
 *
 * The registry imports the modules that read gauges from the stamping, queue and loader modules, so any of those importing the registry
 * for a counter closes a runtime import cycle (`no-runtime-import-cycles`), legal in ESM until a binding is read during evaluation.
 * A leaf made with `countSink()` holds no import of the registry: the registry gives it the function that does the counting when it loads
 * (`set`), and a `count` made before then (a unit test that never loads the registry) is dropped, as no scrape would have read it.
 * The "no sink yet" guard lives here, so no leaf can forget it and throw, or count into nothing, before the registry has loaded.
 *
 * `Args` is what one count carries (a reason, a collection and an outcome, nothing).
 */
export function countSink<Args extends unknown[]>(): { set(next: (...args: Args) => void): void; count(...args: Args): void } {
  let sink: ((...args: Args) => void) | undefined;
  return {
    set(next) { sink = next; },
    count(...args) { sink?.(...args); },
  };
}
