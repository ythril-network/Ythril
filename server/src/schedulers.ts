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
import { log } from './util/log.js';
import { closeCronArming } from './util/armed-schedule.js';
import { configReloadsSettled, stopConfigWatcher } from './config/loader.js';

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
      log.error(`Config reload: re-arming the ${name} failed, so it is still on its previous schedule: `
        + `${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * End every cron schedule for the rest of this process, so nothing can arm one again (`Q-474`, `Q-570`).
 *
 * The shutdown handler calls it before the drain, and so does a test's in-process app teardown
 * (`testing/_shared/in-process-app.mjs`): the one list of what "stop scheduling" means. In order, because each step closes a
 * door the next relies on: the config watcher stops (no new reload starts), a reload already running is waited for within
 * `withinMs` (it re-arms the schedulers as its last step), arming closes (a reload that outlived the bound, a network's
 * settings or the backup route can no longer arm), and then every cron scheduler stops. A cron task left armed holds the
 * process open, which is how a CI job sat out its 30-minute limit.
 */
export async function closeScheduling({ withinMs }: { withinMs: number }): Promise<void> {
  stopConfigWatcher();
  if (!(await configReloadsSettled({ withinMs }))) {
    log.warn(`Stopping schedulers: a config reload was still running after ${withinMs} ms; it can no longer arm anything`);
  }
  closeCronArming();
  const { stopSyncScheduler } = await import('./sync/scheduler.js');
  stopSyncScheduler();
  const { stopBackupScheduler } = await import('./db/backup-scheduler.js');
  stopBackupScheduler();
  const { stopDupeScanner } = await import('./brain/dupe-scanner.js');
  stopDupeScanner();
  const { stopContradictionScanner } = await import('./brain/contradiction-scanner.js');
  stopContradictionScanner();
}
