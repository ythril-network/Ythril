/**
 * The ONE owner of every repeating timer in `server/src` (`Q-317`, bundle-53 G9).
 *
 * ## The defect it prevents
 *
 * Fifteen bare `setInterval` calls, each answering five questions by hand and mostly differently:
 *
 * 1. **What if the previous tick is still running?** Four overlapped; the rest skipped through `runExclusive`, each remembering to.
 * 2. **What if a tick throws?** An unhandled rejection that ends the process in strict Node configurations, or a line per tick for as
 *    long as the cause lasts.
 * 3. **Is a tick's database work bounded?** None was: a tick that touched a hung space held its lock, and with it every later tick,
 *    for as long as the driver waited. Under a skip guard that is worse than an overlap: the job is OFF, and nothing says so.
 * 4. **Is a tick that never ends ever named?** None was.
 * 5. **Does the timer keep the process alive?** Some forgot `unref`, so a shutdown waited for them.
 *
 * Written fifteen times that is fifteen chances to drop the half that fails silently. This is the only module with a `setInterval`
 * in it, and a test holds that (`every-repeating-timer-is-an-interval-job`): a sixteenth timer cannot be written without
 * deciding, at a gate, to be the exception.
 *
 * ## What a tick gets
 *
 * - **One at a time.** A `singleFlight` of its own (not the process-wide `runExclusive` registry, so no other caller can block the
 *   job by borrowing its label). A skipped tick is COUNTED (`tick-skipped` through `housekeeping-signals`, which
 *   `ythril_interval_tick_skipped_total{job}` is built from) and its warning is throttled by the instance.
 * - **A bounded database.** The tick runs inside `withinHousekeepingBound`: every operation it issues ends at `housekeepingOpMs()`.
 *   This is what makes the skip safe: a tick can no longer hang on the store for ever, so a job that skips is a job that is slow,
 *   not one that is stuck.
 * - **One walk budget.** The tick runs inside `withWalkBudget`, so every `eachSpace` / `claimAcross` it starts shares K = 3 timeouts
 *   (the store is stalled, not one space) instead of K per walk.
 * - **A contained throw.** `<label> failed: …`, said through `warnOnce` once per job per {@link INTERVAL_JOB_WINDOW_MS}. The job goes
 *   on.
 * - **A named overrun.** A tick that has been running longer than `max(3 x interval, housekeepingOpMs())` is said as
 *   `<label> tick running for Ns`, once per window, read from the instance's `runningForMs`. It is looked for on the tick that is
 *   skipped, because that is the moment a hung tick starts to matter. The floor is the housekeeping figure because a tick that
 *   touches many spaces legitimately uses it once per operation. **What it cannot see:** a wait that is not a database operation
 *   (a model call, a DNS lookup) is the job's own to bound; the report names it, it does not end it.
 * - **A timer that does not hold the process.** `unref`.
 * - **No request.** A timer inherits the `AsyncLocalStorage` context it was created in, and the logger stamps a line with the request
 *   id found there: a job started by a request (the TTL sweep, by `/setup` on a first run) logged every tick under that request's id.
 *   Each tick runs through `outsideRequest` (`util/log.ts`), so no caller has to remember it.
 *
 * ## What it is not
 *
 * - **Not cron.** A schedule written as a cron expression (`node-cron`) is `util/armed-schedule.ts`'s question: it remembers WHICH
 *   expression is armed so that re-arming the same one does not reset its phase. An interval has no expression to compare; it is
 *   read once at start. The two docblocks cross-refer for that reason, and a cron-chained pass can still use `singleFlight`.
 * - **Not a sleep loop.** A worker that waits on a signal between passes has no interval.
 * - **Not the per-connection SSE keepalive.** It is synchronous, lives and dies with one connection, and cannot overlap; it is the
 *   one named exemption in the gate.
 *
 * ## The interval is read at start
 *
 * `everyMs` is a number, or a function that is called at `start()` (the watchdog on `util/seq.ts` derives its figure from the hold
 * warning, `holdWarnMs() / 4`). A change to what the function reads does not move a RUNNING job; a restart (`stop(); start()`) takes
 * the new figure. That is also why the overrun threshold is a fixed figure for the job's run: it is derived from the interval the
 * timer was armed with.
 */
import { housekeepingOpMs, withinHousekeepingBound } from '../db/write-bound.js';
import { withWalkBudget } from './housekeeping-walk.js';
import { declareJob, signalHousekeeping } from './housekeeping-signals.js';
import { log, outsideRequest, peerText } from './log.js';
import { singleFlight, SKIP_WARNING_WINDOW_MS } from './single-flight.js';
import { warnOnce } from './warn-once.js';

/** A job's failure line, and its overrun line, are each said once per this long. */
export const INTERVAL_JOB_WINDOW_MS = SKIP_WARNING_WINDOW_MS;

/** A tick running longer than this many intervals (or {@link housekeepingOpMs}, whichever is more) is named. */
export const OVERRUN_INTERVALS = 3;

/** What a timer handle must answer: the one thing a job does to it besides clear it. */
export interface TimerHandle { unref(): unknown }

/**
 * The seams a test replaces: the clock, the timer and where lines go. The defaults are the real ones. There is no per-caller flag
 * here: production code never passes this.
 */
export interface IntervalJobDeps {
  now?: () => number;
  /** Arm a repeating timer. Default `setInterval`, the only one in `server/src`. */
  arm?: (fn: () => void, ms: number) => TimerHandle;
  disarm?: (handle: TimerHandle) => void;
  /** Where lines go INSTEAD of the process log. Never a forwarder to it: the default is a direct `log.warn(<bounded text>)`, which the log-line gate reads. */
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface IntervalJob {
  /** Arm the timer. Idempotent: a job that is armed is left alone (its phase is not reset). The first tick is one interval from now. */
  start(): void;
  /** Clear the timer. Idempotent. A tick that is running is left to finish; it still holds the job's lock. */
  stop(): void;
  /** Is the timer armed? */
  readonly armed: boolean;
}

const realArm = (fn: () => void, ms: number): TimerHandle => setInterval(fn, ms);
const realDisarm = (handle: TimerHandle): void => { clearInterval(handle as ReturnType<typeof setInterval>); };

export function intervalJob(
  label: string, everyMs: number | (() => number), run: () => Promise<unknown> | unknown, deps: IntervalJobDeps = {},
): IntervalJob {
  const now = deps.now ?? Date.now;
  const arm = deps.arm ?? realArm;
  const disarm = deps.disarm ?? realDisarm;
  const name = peerText(label);
  declareJob(label);   // so its skipped-tick series starts at 0; the label is the metric's `job`, so keep it constant

  const flight = singleFlight(label, { now, ...(deps.warn && { warn: deps.warn }), ...(deps.error && { error: deps.error }) });
  const failedOnce = warnOnce<string>({ max: 1, every: INTERVAL_JOB_WINDOW_MS, now });
  const overranOnce = warnOnce<string>({ max: 1, every: INTERVAL_JOB_WINDOW_MS, now });
  let timer: TimerHandle | null = null;
  let intervalMs = Infinity;

  const intervalFor = (): number => {
    const ms = typeof everyMs === 'function' ? everyMs() : everyMs;
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`intervalJob '${name}': the interval must be a finite positive number of milliseconds, got ${String(ms)}`);
    }
    return ms;
  };

  /** The one tick: bounded, one budget, a throw said once per window. Never rejects. */
  const body = async (): Promise<void> => {
    try {
      await withinHousekeepingBound(() => withWalkBudget(async () => { await run(); }));
    } catch (err) {
      failedOnce(label, () => {
        const text = `${name} failed: ${peerText(err)}`;
        if (deps.error) deps.error(text); else log.error(text);
      });
    }
  };

  const tick = async (): Promise<void> => {
    const ran = await flight.run(body);
    if (ran) return;
    signalHousekeeping({ type: 'tick-skipped', job: label });
    const running = flight.runningForMs();
    // Read now, not at start: the housekeeping figure is a setting, and the line must name the one in force.
    const overrunMs = Math.max(OVERRUN_INTERVALS * intervalMs, housekeepingOpMs());
    if (running !== null && running > overrunMs) {
      overranOnce(label, () => {
        const text = `${name} tick running for ${Math.round(running / 1000)}s — longer than ${Math.round(overrunMs / 1000)}s, `
          + `so it is hung or slower than its interval; the ticks behind it are skipped until it ends`;
        if (deps.warn) deps.warn(text); else log.warn(text);
      });
    }
  };

  return {
    start() {
      if (timer !== null) return;
      const ms = intervalFor();
      intervalMs = ms;
      // Every tick, not only the arm: a timer inherits the context it was created in, so a job started inside a request would
      // run (and log) under that request's id for as long as it lives. A seam's `arm` may call back from any context too.
      const handle = arm(() => {
        outsideRequest(() => { void tick().catch(() => { /* tick does not reject; a failing logger must not become an unhandled rejection */ }); });
      }, ms);
      handle.unref();
      timer = handle;
    },
    stop() {
      if (timer === null) return;
      const handle = timer;
      timer = null;
      disarm(handle);
    },
    get armed() { return timer !== null; },
  };
}
