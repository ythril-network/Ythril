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
 */
import { log, peerText } from './log.js';

/** Label → when the in-flight pass started. Absent means nothing is running. */
const _inFlight = new Map<string, number>();

/**
 * Run `fn` unless a pass with the same label is still going.
 *
 * Returns `true` when it ran, `false` when the tick was skipped — so a caller can count skips if it ever wants
 * to. Never throws: `fn`'s rejection is reported and swallowed, because the caller is a timer callback and an
 * unhandled rejection there takes the process down in strict Node configurations.
 */
export async function runExclusive(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  const startedAt = _inFlight.get(label);
  if (startedAt !== undefined) {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    log.warn(`${peerText(label)}: skipping this tick — the previous pass has been running for ${seconds}s. `
      + `The sweep is slower than its schedule; overlapping passes would duplicate its work.`);
    return false;
  }

  _inFlight.set(label, Date.now());
  try {
    await fn();
    return true;
  } catch (err) {
    log.error(`${peerText(label)} failed: ${err instanceof Error ? peerText(err.message) : peerText(String(err))}`);
    return true;   // it ran; it simply did not succeed
  } finally {
    // A `finally` and not a trailing statement: a throw that escaped the catch above (an error thrown while
    // logging, say) must still release the label, or the sweep is off for the lifetime of the process.
    _inFlight.delete(label);
  }
}

/** True while a pass with this label is running. For tests and for a diagnostic endpoint. */
export function isRunning(label: string): boolean {
  return _inFlight.has(label);
}

/** How long the in-flight pass has been going, in ms, or null when nothing is running. */
export function runningForMs(label: string, now = Date.now()): number | null {
  const startedAt = _inFlight.get(label);
  return startedAt === undefined ? null : now - startedAt;
}

/** Release everything. Tests only — a leaked label between suites would silently disable a sweep. */
export function _resetSingleFlightForTests(): void {
  _inFlight.clear();
}
