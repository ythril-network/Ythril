/**
 * One in-flight job per key, with a coalesced rerun.
 *
 * Extracted verbatim in behaviour from `sync/engine.ts`, where it guarded sync cycles per network.
 * Concurrent sync cycles for the same network compete for bcrypt cache, MongoDB connections and peer
 * HTTP sockets, so a trigger arriving mid-cycle must not start a second one — but it must not be
 * dropped either, since the trigger exists because something changed.
 *
 * The contract, and each clause is load-bearing:
 *
 *   - While a job for `key` is in flight, another `run(key, …)` starts NOTHING. It joins the running
 *     job and resolves with its result.
 *   - A trigger that arrives mid-flight schedules exactly ONE follow-up job, however many triggers
 *     arrive. Ten triggers during one cycle produce one rerun, not ten.
 *   - The key is released in a `finally`, so a job that THROWS does not wedge that key forever. This
 *     is the failure with no symptom: the key would simply stop running again, every other key would
 *     be fine, and nothing would ever log.
 *
 * ── Why this is its own module ──────────────────────────────────────────────────────────────────
 *
 * Because it could not be tested where it lived. Both coalescing and rerun-once are invisible from
 * outside `runSyncForNetwork`: the function is `async`, so the in-flight promise it returns is never
 * referentially equal to the one it holds, and a sync cycle with no reachable members resolves in
 * microtasks — the queued rerun begins and ends before any caller's continuation runs. Neither
 * behaviour could be asserted without counting job invocations, and counting requires the job to be
 * injectable. That is the whole reason for this file: `run` takes the work as a parameter, so a test
 * can hand it a counter and a promise it controls.
 *
 * See `testing/standalone/coalescing-runner.test.js` for the two tests that were impossible before.
 */
import { log, peerText } from '../util/log.js';

/** Optional hooks, used by the sync engine for its debug logging. */
export interface CoalescingRunnerHooks {
  /** A trigger arrived while a job was in flight and a rerun was queued. */
  onQueued?(key: string): void;
  /** A queued rerun is starting. */
  onRerun?(key: string): void;
}

export interface CoalescingRunner<T> {
  /**
   * Run `job` for `key`, unless one is already running — in which case join it and queue a single
   * follow-up.
   *
   * Resolves with the result of the job the caller JOINED, not of the rerun. A caller that needs the
   * later result must call again once this settles; that is the same contract the sync engine had.
   */
  run(key: string, job: () => Promise<T>): Promise<T>;
  /** True while a job for `key` is in flight. Cheap and in-memory. */
  isRunning(key: string): boolean;
}

export function createCoalescingRunner<T>(hooks: CoalescingRunnerHooks = {}): CoalescingRunner<T> {
  const running = new Map<string, Promise<T>>();
  const rerunRequested = new Set<string>();

  async function run(key: string, job: () => Promise<T>): Promise<T> {
    const inflight = running.get(key);
    if (inflight) {
      // Join the running job and ask for one more pass after it. `add` on a Set is what makes this
      // "one more", not "one more per trigger".
      rerunRequested.add(key);
      hooks.onQueued?.(key);
      return inflight;
    }

    const started = job();
    running.set(key, started);
    try {
      return await started;
    } finally {
      // Release FIRST, so the rerun below sees a free key rather than joining the job that is ending.
      running.delete(key);
      if (rerunRequested.delete(key)) {
        hooks.onRerun?.(key);
        // Nothing awaits the rerun, so a job that throws would be an unhandled rejection — which ends the process.
        // Its failure is logged HERE, once, by the runner every caller shares: a caller's own catch only ever sees the
        // job it joined, never the pass this queued after it.
        run(key, job).catch(err => log.warn(`Coalesced rerun for '${peerText(key)}' failed: ${peerText(err)}`));
      }
    }
  }

  return { run, isRunning: (key: string) => running.has(key) };
}
