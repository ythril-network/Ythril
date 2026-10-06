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
 * So the check is structural: for every job the tree registers (`_scheduled-jobs.mjs`, derived, not listed), assert that a function the
 * boot path REACHES (`bootstrap.ts` and `index.ts`'s `main`, followed through what each call causes) starts it. Source-scanning rather
 * than behavioural on purpose — the bug is *absence of a call*, and no amount of testing the function itself can detect that the
 * function is never reached.
 *
 * Run: node --test testing/standalone/scheduler-wiring.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleIndex, walkFrom } from './_call-graph.mjs';
import { scheduledJobs, JOB_FLOORS } from './_scheduled-jobs.mjs';

/*
 * The schedulers are DERIVED from the registrations (`_scheduled-jobs.mjs`: every `intervalJob(` and every cron `schedule(`), where
 * this was a list of five modules. The list had two failures at once: the TTL sweep and the candidate prune moved to `intervalJob` and
 * the rest of the file did not notice, and the tombstone prune, the audit change-retention sweep, the seq watchdog, the workers and the
 * activity flush were never on it, so for each of them "nobody starts it" was not a thing this could say. A scheduler is whatever
 * REGISTERS a timer, and the file says so.
 */
const index = moduleIndex('server/src');
const { jobs } = scheduledJobs(index);

/** Where the process begins: the file `main()` lives in, and the one function it hands the instance's services to. */
const BOOT_ROOTS = ['server/src/bootstrap.ts:startConfiguredInstanceServices', 'server/src/index.ts:main'];

const escapeRe = text => text.replace(/[.?$()[\]*+^|\\{}]/g, '\\$&');

/** Every file that imports `file` (a static or a dynamic import: `relativeImports` reads both). */
const importersOf = file => [...index.imports].filter(([from, map]) => from !== file && [...map.values()].some(i => i.file === file)).map(([from]) => from);

/**
 * The functions that START a job: those whose body calls `<handle>.start(`; for a job with no handle or a cron registration, the function
 * the registration sits in. `null` means the registration is at module scope and started in place (`intervalJob(…).start();`).
 */
function startersOf(job) {
  if (job.kind === 'cron' || !job.handle) return job.container ? [job.container] : null;
  const calls = new RegExp(String.raw`\b${escapeRe(job.handle)}\s*\??\.\s*start\s*\(`);
  return [...index.bodies].filter(([, entry]) => entry.file === job.file && !entry.synthetic && calls.test(entry.body)).map(([key]) => key);
}

/** The `start…` / `stop…` functions a module exports. */
const exportedNamed = (src, prefix) => [...src.matchAll(new RegExp(String.raw`\bexport\s+(?:async\s+)?function\s+(${prefix}[A-Za-z0-9_$]*)\s*\(`, 'g'))].map(m => m[1]);

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
  it('reads a tree worth reading (the floors, and the entry points still exist)', () => {
    for (const [kind, floor] of Object.entries(JOB_FLOORS)) {
      assert.ok(jobs.filter(j => j.kind === kind).length >= floor, `fewer than ${floor} '${kind}' registrations: this gate would pass about nothing`);
    }
    for (const root of BOOT_ROOTS) assert.ok(index.bodies.has(root), `${root} is gone: re-anchor where the process begins`);
  });

  it('every registered job is started from the boot path', () => {
    // What a boot CALLS, to exhaustion (the dynamic `await import(…)` of a module and the call after it included), so a `start*` that is
    // exported, tested and called only from a function nothing calls is as dead as one never called. CALLS, not `closures: true`: that
    // follows a function handed on by REFERENCE too, and an imported-but-never-called `startTtlSweep` is exactly such a reference — the
    // import alone is as dead as no import, which is the whole defect this file exists for.
    const { seen } = walkFrom(index, BOOT_ROOTS);
    const findings = [];
    let started = 0;
    for (const job of jobs) {
      const where = `${job.file} (${job.kind} job ${job.label.slice(0, 40)})`;
      const starters = startersOf(job);
      if (starters === null) {
        // Registered at module scope and started in place: evaluating the module starts it, so the module has to be imported by something.
        if (importersOf(job.file).length === 0) findings.push(`${where}: starts when its module is evaluated, and no file imports the module`);
        else started++;
        continue;
      }
      if (starters.length === 0) findings.push(`${where}: nothing calls \`${job.handle}.start()\`: the job is registered and never armed`);
      else if (!starters.some(key => seen.has(key))) {
        findings.push(`${where}: started only by ${starters.map(k => k.split(':')[1]).join(', ')}, which the boot path never reaches`);
      } else started++;
    }
    assert.deepEqual(findings, [],
      `a scheduler nobody starts: the code compiles, its tests pass, the endpoint works when called, and the work simply never happens:\n  ${findings.join('\n  ')}`);
    assert.ok(started >= 12, `only ${started} job(s) were found started: the derivation has stopped reading the starters`);
  });

  it('pairs every start with a stop, so a config reload can restart it cleanly', () => {
    // Each scheduler holds a module-level task handle. Without a stop, a reload leaks the old cron task and
    // the sweep quietly runs twice per tick.
    const modules = [...new Set(jobs.map(j => j.file))];
    const findings = [];
    let paired = 0;
    for (const file of modules) {
      const src = index.sources.get(file);
      const starts = exportedNamed(src, 'start');
      if (starts.length === 0) continue;
      if (exportedNamed(src, 'stop').length === 0) findings.push(`${file} exports ${starts.join(', ')} and no stop…`);
      else paired++;
    }
    assert.deepEqual(findings, []);
    assert.ok(paired >= 10, `only ${paired} module(s) with a start were found paired with a stop`);
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
    // Position matters as much as presence: re-arming before `initSpace` could fire a scan against a space
    // that does not exist yet, so the call belongs at the END of the reload.
    //
    // The init and the re-arm live in `initAddedSpaces` since bundle-53 G21 (`spaces/lifecycle.ts`): the reload hands it the
    // re-arm helper, and it calls it after the spaces are initialised — and before it throws for a space that failed, so one
    // bad space does not leave the schedulers on their old schedule.
    const app = code('server/src/app.ts');
    assert.match(app, /rearm: rearmCronSchedulers\b/,
      'applyConfigFromDisk must re-arm, or POST /api/admin/reload-config reports success without applying');
    const lifecycle = code('server/src/spaces/lifecycle.ts');
    const fnAt = lifecycle.indexOf('export async function initAddedSpaces(');
    assert.ok(fnAt > -1, 'initAddedSpaces is gone — re-anchor this gate');
    const body = lifecycle.slice(fnAt);
    const initAt = body.indexOf('await initSpace(');
    const rearmAt = body.indexOf('await rearm()');
    const throwAt = body.indexOf('throw new AggregateError');
    assert.ok(initAt > -1 && rearmAt > initAt,
      're-arming before initSpace can schedule work against a space that does not exist yet');
    assert.ok(throwAt > rearmAt,
      'a space that failed must not skip the re-arm: the throw comes after it');
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
