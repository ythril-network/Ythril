/**
 * Whether this process may still arm a cron task - the switch that ends arming, and why a stop is not it (`Q-474`, `Q-570`).
 *
 * ## What it prevents
 *
 * A cron task armed after the process (or a test's teardown) stopped the schedulers keeps that process alive: node-cron's
 * timers are ref'd. The late arms are ordinary - a config reload re-arms three schedulers, a network's settings re-arm sync,
 * the backup route re-arms backups - and in CI one held a test file until the job's 30-minute limit cancelled it. So once
 * arming closes, every cron scheduler refuses to arm, for the rest of the process.
 *
 * ## Why a stop is not the switch
 *
 * A process that is not ending stops and starts its schedulers (a schedule cleared and set again, a test that restarts
 * one). Closing is the one-way step the shutdown takes (`closeScheduling` in `schedulers.ts`), and every function that
 * registers a cron task asks {@link cronArmingRefused} before it does; `every-cron-scheduler-asks-whether-arming-is-closed`
 * derives those functions from the code.
 *
 * ## Not here
 *
 * What each scheduler has armed is `util/armed-schedule.ts`'s question; this one answers only "may anything arm now".
 */
import { log, peerText } from './log.js';
import { warnOnce } from './warn-once.js';

let _armingClosed = false;
const refusalSaid = warnOnce<string>({ max: 16 });

/** Close cron arming for the rest of this process. Idempotent. */
export function closeCronArming(): void {
  _armingClosed = true;
}

/**
 * True once arming is closed, and then the caller arms nothing. Said once per scheduler at info: a reload during a drain
 * that answers `{ ok: true }` without re-arming is correct, and would otherwise be invisible.
 */
export function cronArmingRefused(what: string): boolean {
  if (!_armingClosed) return false;
  refusalSaid(what, () => log.info(`${peerText(what)} not armed: the process is stopping its schedulers`));
  return true;
}
