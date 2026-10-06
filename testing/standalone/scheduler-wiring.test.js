/**
 * Every background scheduler is actually started.
 *
 * This exists because one was not. `runContradictionScanAllSpaces` was written, exported, tested and
 * shipped — and nothing ever called it. `bootstrap.ts` started the duplicate scanner, the backup scheduler
 * and the TTL sweep, with no contradiction equivalent, so contradictions were only ever found when an admin
 * hit `POST /api/contradictions/scan` by hand. On any instance nobody had poked manually, the Review tab's
 * Contradictions view was permanently empty and the whole feature was inert.
 *
 * Nothing catches that. The code compiles, the unit tests pass, the endpoint works when called, and the
 * empty queue is indistinguishable from a clean one — which is the same failure shape as the sweep that
 * wrote every finding to `"undefined:undefined"` and the file listing that silently joined no metadata.
 *
 * So the check is structural: for each module that owns a scheduler, assert its `start*` export is named in
 * `bootstrap.ts`. Source-scanning rather than behavioural on purpose — the bug is *absence of a call*, and
 * no amount of testing the function itself can detect that the function is never reached.
 *
 * Run: node --test testing/standalone/scheduler-wiring.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Modules that own a background scheduler, and the export bootstrap must call. */
const SCHEDULERS = [
  { module: 'server/src/brain/dupe-scanner.ts', start: 'startDupeScanner' },
  { module: 'server/src/brain/contradiction-scanner.ts', start: 'startContradictionScanner' },
  { module: 'server/src/brain/ttl-sweep.ts', start: 'startTtlSweep' },
  { module: 'server/src/brain/candidate-prune.ts', start: 'startCandidatePrune' },
  { module: 'server/src/db/backup-scheduler.ts', start: 'startBackupScheduler' },
];

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/**
 * Source with comments removed.
 *
 * Required, not tidiness: a commented-out `// startContradictionScanner();` matches a naive search for the
 * call just as well as a real one, so the guard would pass on precisely the change it exists to catch.
 * (Found by trying it.)
 */
const code = (rel) => read(rel).replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('scheduler wiring — a scheduler nobody starts is dead code that looks alive', () => {
  let bootstrap;
  before(() => { bootstrap = code('server/src/bootstrap.ts'); });

  for (const { module, start } of SCHEDULERS) {
    it(`${start} is exported by its module`, () => {
      assert.match(read(module), new RegExp(`export function ${start}\\b`),
        `${module} should export ${start}`);
    });

    it(`${start} is CALLED in bootstrap`, () => {
      // The import alone is not enough — an unused import is exactly as dead as no import.
      assert.match(bootstrap, new RegExp(`${start}\\s*\\(`),
        `bootstrap.ts imports-but-never-calls or omits ${start}; the sweep would never run`);
    });
  }

  it('pairs every start with a stop, so a config reload can restart it cleanly', () => {
    // Each scheduler holds a module-level task handle. Without a stop, a reload leaks the old cron task and
    // the sweep quietly runs twice per tick.
    for (const { module, start } of SCHEDULERS) {
      const stop = start.replace(/^start/, 'stop');
      assert.match(read(module), new RegExp(`export function ${stop}\\b`),
        `${module} should export ${stop} alongside ${start}`);
    }
  });
});

/*
 * ── A scheduler nobody RE-ARMS runs on a schedule nobody chose ─────────────────────────────────────────────
 *
 * The pairing above says why it exists — *"so a config reload can restart it cleanly"* — and for three
 * schedulers no reload did. Their cron expression is read once inside `start*` and handed to `node-cron`, so:
 *
 *   - editing `dupeScanner.schedule` reloaded the config and left the scanner on the boot-time schedule;
 *   - ENABLING a scanner that was off did nothing at all until the instance was restarted;
 *   - `PUT /api/admin/data/backup-config` wrote `backup.json`, answered `{ ok: true }`, and an operator turning
 *     scheduled backups ON for the first time got no backups until a restart. Believing you have backups is
 *     worse than knowing you do not.
 *   - `POST /api/admin/reload-config` — an endpoint whose entire purpose is "apply what I just changed" —
 *     reported success without applying it.
 *
 * The mechanism was already there: every `start*` stops its own previous task, and `api/networks/crud.ts`
 * already re-armed a network's sync when its schedule changed. One rule, two implementations, and the weaker one
 * was silent — this repo's signature defect, in the operational layer.
 */
describe('a schedule that is captured at start time is re-armed when it changes', () => {
  /** Schedulers whose cron expression is fixed inside `start*`, and where the change that must re-arm them lives. */
  const CAPTURED_AT_START = [
    { start: 'startSyncScheduler', module: 'server/src/sync/engine.ts' },
    { start: 'startDupeScanner', module: 'server/src/brain/dupe-scanner.ts' },
    { start: 'startContradictionScanner', module: 'server/src/brain/contradiction-scanner.ts' },
  ];

  it('each one is named in the re-arm helper', () => {
    const rearm = read('server/src/schedulers.ts');
    for (const { start } of CAPTURED_AT_START) {
      assert.ok(rearm.includes(start),
        `${start} captures its cron at start time but is not re-armed on a config reload`);
    }
  });

  it('the reload path calls the re-arm helper', () => {
    // Position matters as much as presence: re-arming before the spaces are initialised could fire a scan against a space
    // that does not exist yet, so the call belongs at the END of the reload. The reload hands the helper to
    // `initAddedSpaces` (`spaces/lifecycle.ts`), which initialises each added space on its own, THEN re-arms, whether or not
    // every space landed, and only then reports the ones that did not.
    const app = read('server/src/app.ts');
    assert.match(app, /await initAddedSpaces\(\{ added, rearm: rearmCronSchedulers \}\)/,
      'applyConfigFromDisk must re-arm, or POST /api/admin/reload-config reports success without applying');
    const lifecycle = read('server/src/spaces/lifecycle.ts');
    const fn = lifecycle.slice(lifecycle.indexOf('export async function initAddedSpaces'));
    const initAt = fn.indexOf('await initOwedSpaces(');
    const rearmAt = fn.indexOf('await rearm()');
    const throwAt = fn.indexOf('throw new Error(');
    assert.ok(initAt > -1 && rearmAt > initAt,
      're-arming before the spaces are initialised can schedule work against a space that does not exist yet');
    assert.ok(throwAt > rearmAt, 'a space that failed must not stop the re-arm: the throw that names it comes after');
  });

  it('the backup route re-arms its own scheduler, because its schedule is not in config.json', () => {
    /*
     * `backup.json` is its own file with its own route, so the config-reload path never sees it. This is the
     * instance that mattered most: an operator enabling nightly backups saw `{ ok: true }` and got nothing.
     */
    const data = read('server/src/api/data.ts');
    assert.match(data, /startBackupScheduler\(\)/,
      'PUT /backup-config writes the schedule without arming it, so the new schedule does not exist');
    const writeAt = data.indexOf('fs.writeFileSync(BACKUP_CONFIG_PATH');
    const armAt = data.indexOf('startBackupScheduler()');
    assert.ok(writeAt > -1 && armAt > writeAt,
      'the re-arm must follow the write, or it reads the old file');
  });

  it('the INTERVAL-driven sweeps are deliberately NOT re-armed', () => {
    /*
     * The other direction, and it is a real cost rather than tidiness: the TTL sweep, candidate prune and
     * change retention read `getConfig()` on every fire, so a config change reaches them on the next tick.
     * Restarting them would reset the phase of a six-hour timer every time somebody saves a setting, pushing
     * the next run up to six hours away — repeatedly, if an operator is editing several settings.
     */
    const rearm = read('server/src/schedulers.ts');
    for (const start of ['startTtlSweep', 'startCandidatePrune', 'startChangeRetention', 'startTombstonePrune']) {
      assert.ok(!rearm.includes(`${start}(`),
        `${start} reads its config per run; re-arming it only resets the phase of its timer`);
    }
  });
});
