/**
 * What a housekeeping module says is countable, without importing whoever counts it (`Q-274`, bundle-53 G8).
 *
 * ## Why a registry of listeners and not an import
 *
 * The failure counters, the quarantine gauge and the skipped-tick counter live in `metrics/registry.ts`. The modules that
 * know when they happen live in `util/`: the reporter, the walk runner, `intervalJob`. `metrics/registry.ts` imports
 * `util/seq.ts` (a value import), `util/seq.ts` becomes an `intervalJob` client, and an `intervalJob` that imported the registry
 * would close registry -> seq -> interval-job -> registry, which `no-runtime-import-cycles` refuses. So the lower layer exposes
 * a subscription and the higher layer subscribes — the precedent is `onRecordCollectionWrite` in `db/mongo.ts`. The metric NAMES
 * stay literal in `metrics/registry.ts`, where the docs-coverage gate reads them.
 *
 * **This file imports nothing**, so no cycle can pass through it. A test holds that.
 *
 * ## What it must never do
 *
 * **Throw into the code that signalled.** A signal is raised from a `catch` and from a timer callback; a listener that fails
 * (the registry mid-reset) must not replace the failure being reported, or become an unhandled rejection of a tick.
 *
 * ## Pre-declared series
 *
 * A counter that does not exist until its first event cannot be told from a counter that is not wired: `rate()` over a series
 * that appears at the first failure shows nothing for the whole healthy period. `declareStep(step)` is called once per step name,
 * at module scope, by each site; the registry reads {@link declaredSteps} when it is built and listens for `step-declared` after
 * that, and starts the step's series at 0.
 */

/** The kinds a failure counter is labelled with. `failure` is a space's own, `timeout` a bound that ended an operation. */
export type SpaceFailureKind = 'failure' | 'timeout' | 'store_down' | 'stalled';

export type HousekeepingSignal =
  /** One failure of a step in a space, or a walk's stop (`store_down`, `stalled`). Counted on EVERY call, said or not. */
  | { type: 'space-failure'; step: string; kind: SpaceFailureKind }
  /** Records a retention cycle could not delete (`Q-359`): `count` of them, for `ythril_housekeeping_records_failed_total`. */
  | { type: 'records-failed'; step: string; count: number }
  /** A repeating job skipped its tick because the previous one was still running. */
  | { type: 'tick-skipped'; job: string }
  /** The number of spaces in quarantine right now: an absolute value, for a gauge. */
  | { type: 'quarantined-spaces'; count: number }
  /** A step named itself, so its series can start at 0. */
  | { type: 'step-declared'; step: string };

export type HousekeepingListener = (event: HousekeepingSignal) => void;

const listeners = new Set<HousekeepingListener>();
const steps: string[] = [];
const stepSet = new Set<string>();

/** Subscribe. Returns the function that unsubscribes. */
export function onHousekeepingSignal(listener: HousekeepingListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tell every listener. Never throws: a listener that does is skipped and the rest are still told. */
export function signalHousekeeping(event: HousekeepingSignal): void {
  // A copy, so a listener that unsubscribes itself (or another) while being called does not skip the next one.
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* a listener's failure is not the signaller's */ }
  }
}

/**
 * Declare a step name, once, at module scope: `const STEP = declareStep('TTL sweep');`. Returns the name for inline use.
 * Declaring a name again is a no-op. A name that is empty or not a string is a programming error and THROWS, at load, where it
 * is seen — a metric cannot be labelled with it.
 */
export function declareStep(step: string): string {
  if (typeof step !== 'string' || step.trim() === '') throw new Error(`declareStep: a step needs a name, got ${JSON.stringify(step)}`);
  if (!stepSet.has(step)) {
    stepSet.add(step);
    steps.push(step);
    signalHousekeeping({ type: 'step-declared', step });
  }
  return step;
}

/** Every step declared so far, in the order declared: a copy, so a caller cannot edit the list. */
export function declaredSteps(): string[] {
  return [...steps];
}
