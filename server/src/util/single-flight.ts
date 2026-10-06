/**
 * One pass at a time, for work that runs on a schedule.
 *
 * ## The failure this exists for
 *
 * Four background sweeps — the duplicate scanner, the contradiction scanner, candidate pruning and the TTL
 * sweep — were each started with `schedule(cron, …)` or `setInterval(…)` and **no reentrancy guard**. A timer
 * does not wait for the previous callback: if a pass takes longer than its interval, the next one starts
 * anyway, and they stack.
 *
 * That is not a hypothetical for these four. The contradiction scanner calls an NLI model **per pair**, so a
 * large space against a slow judge routinely outlives its schedule; and the duplicate scanner POSTs to an
 * operator-configured notify URL, which — until this was written — had no timeout at all, so a sink that
 * accepted the connection and never answered hung the pass **forever**. Every subsequent tick then began
 * another pass that hung in the same place: unbounded accumulation of pending requests, duplicated model
 * calls, two passes writing the same candidates collection, and not one error line to explain it.
 *
 * ## Why skip rather than queue
 *
 * These are sweeps, not jobs: each pass recomputes from current state, so a skipped tick costs nothing but a
 * delay, and the next one picks up everything the skipped one would have done. Queueing would preserve work
 * that is about to be redone anyway, and it is queueing that turns a slow dependency into an unbounded backlog.
 *
 * ## Why the skip is logged with an elapsed time
 *
 * "Skipped, a pass is still running" is not actionable. "Skipped, the previous pass has been running for
 * 412 s" says the sweep is slower than its schedule and roughly by how much — the same reason the stalled-job
 * warning carries its elapsed time rather than just announcing a re-queue.
 *
 * ## An instance, and the registry of them (`Q-317`)
 *
 * {@link singleFlight} makes a lock that belongs to the OBJECT. {@link runExclusive} — the original API, unchanged for its callers — is
 * the process-global registry of instances keyed by label. The two exist because a lock keyed by a string alone made two owners of
 * one label share a lock by accident (a second watcher, a test's copy), and the cure was a hand-invented unique label
 * (`Search readiness #2`). A repeating timer (`util/interval-job.ts`) holds an instance of its own, so it is never in the registry
 * and no other caller can block it by borrowing its name.
 *
 * **The skip warning is throttled per instance** (`warnOnce`, one line per {@link SKIP_WARNING_WINDOW_MS}). It used to be said on
 * every skipped tick, which for a pass slower than its schedule is one line per tick for as long as the pass runs: a stated
 * behaviour change. Every skip is still returned (`false`), so a caller that counts them (`intervalJob`) loses nothing.
 */
import { log, peerText } from './log.js';
import { warnOnce } from './warn-once.js';

/** A skipped tick is said once per this long, per instance. */
export const SKIP_WARNING_WINDOW_MS = 10 * 60_000;

export interface SingleFlightDeps {
  /** The clock, for a test. */
  now?: () => number;
  /**
   * Where the skip warning goes INSTEAD of the process log — a test seam. The default is a direct `log.warn(<the bounded text>)`
   * and not a forwarder, so the gate that holds a log line's slots bounded (`a-steerable-value-reaches-a-log-line-only-bounded`)
   * reads the text itself.
   */
  warn?: (message: string) => void;
  /** Where a pass's failure goes instead of the process log: a test seam, for the same reason. */
  error?: (message: string) => void;
}

export interface SingleFlight {
  readonly label: string;
  /**
   * Run `fn` unless a pass of THIS instance is still going. Returns `true` when it ran, `false` when the tick was skipped — so a
   * caller can count skips. Never throws: `fn`'s rejection is reported and swallowed, because the caller is a timer callback and an
   * unhandled rejection there takes the process down in strict Node configurations.
   */
  run(fn: () => Promise<unknown> | unknown): Promise<boolean>;
  /** True while a pass of this instance is running. */
  isRunning(): boolean;
  /** How long the in-flight pass has been going, in ms, or null when nothing is running. */
  runningForMs(at?: number): number | null;
}

/** A lock of its own. Two instances made with one label do NOT share it. */
export function singleFlight(label: string, deps: SingleFlightDeps = {}): SingleFlight {
  const now = deps.now ?? Date.now;
  const said = warnOnce<string>({ max: 1, every: SKIP_WARNING_WINDOW_MS, now });
  let startedAt: number | undefined;

  return {
    label,
    async run(fn) {
      if (startedAt !== undefined) {
        const seconds = Math.round((now() - startedAt) / 1000);
        said(label, () => {
          const text = `${peerText(label)}: skipping this tick — the previous pass has been running for ${seconds}s. `
            + `The sweep is slower than its schedule; overlapping passes would duplicate its work.`;
          if (deps.warn) deps.warn(text); else log.warn(text);
        });
        return false;
      }

      startedAt = now();
      try {
        await fn();
        return true;
      } catch (err) {
        const text = `${peerText(label)} failed: ${peerText(err)}`;
        if (deps.error) deps.error(text); else log.error(text);
        return true;   // it ran; it simply did not succeed
      } finally {
        // A `finally` and not a trailing statement: a throw that escaped the catch above (an error thrown while
        // logging, say) must still release the lock, or the sweep is off for the lifetime of the process.
        startedAt = undefined;
      }
    },
    isRunning: () => startedAt !== undefined,
    runningForMs: (at = now()) => (startedAt === undefined ? null : at - startedAt),
  };
}

/**
 * Label → its instance. Labels here are fixed names written in the source, so the registry is as small as the list of callers; a
 * caller whose lock must come and go with an owner (a timer, a per-job heartbeat) makes its own `singleFlight` instead.
 */
const registry = new Map<string, SingleFlight>();

function instanceOf(label: string): SingleFlight {
  let flight = registry.get(label);
  if (!flight) { flight = singleFlight(label); registry.set(label, flight); }
  return flight;
}

/**
 * Run `fn` unless a pass with the same label is still going, process-wide. The instance for the label is made on first use.
 *
 * Returns `true` when it ran, `false` when the tick was skipped. Never throws (see {@link SingleFlight.run}).
 */
export async function runExclusive(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  return instanceOf(label).run(fn);
}

/** True while a pass with this label is running. For tests and for a diagnostic endpoint. */
export function isRunning(label: string): boolean {
  return registry.get(label)?.isRunning() ?? false;
}

/** How long the in-flight pass has been going, in ms, or null when nothing is running. */
export function runningForMs(label: string, now = Date.now()): number | null {
  return registry.get(label)?.runningForMs(now) ?? null;
}

/** Release everything. Tests only — a leaked label between suites would silently disable a sweep. */
export function _resetSingleFlightForTests(): void {
  registry.clear();
}
