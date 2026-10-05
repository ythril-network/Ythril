/**
 * Re-arming the cron-driven schedulers after their schedule changes.
 *
 * ## Why this exists
 *
 * Three schedulers fix their cron expression when they START: the sync engine, the duplicate scanner and the
 * contradiction scanner all read `getConfig()` once inside `start*` and hand the expression to `node-cron`.
 * Nothing re-read it. So editing `dupeScanner.schedule` in `config.json` reloaded the config and left the
 * scanner running on the boot-time schedule — and **enabling a scanner that was off did nothing at all** until
 * the instance was restarted.
 *
 * `POST /api/admin/reload-config` answered `{ ok: true }` while that was true of it, which is the worst version:
 * an endpoint whose entire purpose is *"apply what I just changed"*, reporting success without applying it.
 *
 * ## The mechanism already existed
 *
 * Every one of these `start*` functions stops its own previous task before scheduling — `startBackupScheduler`
 * even carries the comment *"Stop any previously running task before (re-)scheduling"*. `scheduler-wiring.test.js`
 * pairs each `start*` with a `stop*` and says why: *"so a config reload can restart it cleanly"*. And
 * `api/networks/crud.ts` already calls `scheduleSyncForNetwork` when a network's schedule changes, which is this
 * pattern done right in one place. The re-arm was designed for, tested around, implemented once, and never
 * called from the reload path. One rule, two implementations, the weaker one silent.
 *
 * ## What is NOT here, and why
 *
 * The interval-driven sweeps — the TTL sweep, candidate prune, tombstone prune, change retention — read
 * `getConfig()` **on every fire**, so a config change reaches them on the next tick without any re-arm. Adding
 * them here would restart a timer for no reason and reset its phase, which on a six-hour sweep means the next
 * run moves by up to six hours every time somebody saves a setting.
 *
 * The distinction is exactly "is the schedule captured at start, or read per run" — not "is it a scheduler".
 */
import { log, peerText } from './util/log.js';
import { messageOf } from './util/errors.js';

/**
 * Re-arm every scheduler whose cron expression is captured at start time.
 *
 * Called from the config-reload path, after the new config is in memory. Each `start*` is idempotent and stops
 * its own previous task, so this is safe to call repeatedly and safe to call when nothing changed.
 *
 * Never throws: a reload that failed to re-arm one scheduler must not abandon the rest of the reload, and the
 * config in memory is already correct by this point. Each failure is logged with the scheduler that caused it.
 */
export async function rearmCronSchedulers(): Promise<void> {
  // Dynamic imports, matching `bootstrap.ts` — these modules are loaded late there on purpose, and importing
  // them statically here would pull them into the app-construction path and change that ordering.
  const jobs: Array<[string, () => Promise<void>]> = [
    ['sync scheduler', async () => {
      const { startSyncScheduler } = await import('./sync/scheduler.js');
      startSyncScheduler();
    }],
    ['duplicate scanner', async () => {
      const { startDupeScanner } = await import('./brain/dupe-scanner.js');
      startDupeScanner();
    }],
    ['contradiction scanner', async () => {
      const { startContradictionScanner } = await import('./brain/contradiction-scanner.js');
      startContradictionScanner();
    }],
  ];

  for (const [name, run] of jobs) {
    try {
      await run();
    } catch (err) {
      log.error(`Config reload: re-arming the ${peerText(name)} failed, so it is still on its previous schedule: `
        + `${peerText(messageOf(err))}`);
    }
  }
}
