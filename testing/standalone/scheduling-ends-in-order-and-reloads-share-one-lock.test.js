/**
 * Ending scheduling closes its doors in order, the shutdown does it before any stop, and every reload takes one lock (`Q-570`).
 *
 * ## What it holds
 *
 * `closeScheduling` (`server/src/schedulers.ts`) ends cron scheduling for the rest of a process, and its order is the point:
 * the config watcher stops first (no new reload starts), a reload already running is waited for within a bound (it re-arms
 * the schedulers as its last step), arming closes (a reload that outlived the bound can no longer arm), and only then do the
 * schedulers stop. Each step closes a door the next relies on, so each case below takes one step away and shows what leaks:
 *
 * 1. A reload in flight that re-arms sync after `closeScheduling` gave up waiting arms nothing (arming closed before it
 *    could). Only once per process: closing is one-way, which is the point.
 * 2. The watcher is unwatched, by the listener it registered, before anything else.
 * 3. The shutdown sequence (`runShutdown` in `shutdown.ts`, started by `index.ts`) calls `closeScheduling(` before it stops
 *    any scheduler by name; a stop before it leaves a window in which a reload re-arms what was just stopped.
 * 4. `POST /api/admin/reload-config` runs under the watcher's reload lock (`runConfigReload(`), so the bounded wait waits
 *    for a manual reload too.
 *
 * Run: node --test testing/standalone/scheduling-ends-in-order-and-reloads-share-one-lock.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { SHUTDOWN_FILE, shutdownSequenceOf } from './_shutdown-sequence.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-close-scheduling-'));
process.env['CONFIG_PATH'] = path.join(dir, 'config.json');
const CRON = '*/15 * * * *';

const calls = [];
const realWatchFile = fs.watchFile;
const realUnwatchFile = fs.unwatchFile;
let loader, schedulers, sync, registered;

before(async () => {
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ spaces: [], networks: [], tokens: [] }));
  fs.watchFile = (_file, _opts, fn) => { registered = fn; calls.push('watch'); };
  fs.unwatchFile = (_file, fn) => { calls.push(fn === registered ? 'unwatch own listener' : 'unwatch other'); };
  loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  loader.getConfig().networks = [{ id: 'net-a', syncSchedule: CRON }];
  schedulers = await import('../../server/dist/schedulers.js');
  sync = await import('../../server/dist/sync/scheduler.js');
});

after(() => {
  fs.watchFile = realWatchFile;
  fs.unwatchFile = realUnwatchFile;
  sync?.stopSyncScheduler();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('closeScheduling', () => {
  it('a reload that re-arms after the bound gave up arms nothing; the watcher went first', async () => {
    loader.startConfigWatcher(() => {});
    let release;
    const gate = new Promise(r => { release = r; });
    // A reload stuck past the bound, which re-arms sync as its last step - what applyConfigFromDisk does.
    const stuck = loader.runConfigReload(async () => { await gate; sync.startSyncScheduler(); });

    await schedulers.closeScheduling({ withinMs: 100 });
    assert.equal(calls.at(-1), 'unwatch own listener', `the watcher was not stopped by its own listener: ${calls.join(', ')}`);
    assert.deepEqual(sync.scheduledSyncNetworks(), [], 'something was armed while closing');

    release();
    await stuck;
    assert.deepEqual(sync.scheduledSyncNetworks(), [],
      'a reload that outlived the bound re-armed sync after scheduling closed, and its cron timers hold the process');
  });
});

describe('the shutdown handler and the reload route', () => {
  const app = stripComments(readFileSync('server/src/app.ts', 'utf8'));

  it('the shutdown closes scheduling before it stops any scheduler by name', () => {
    const body = shutdownSequenceOf(stripComments(readFileSync(SHUTDOWN_FILE, 'utf8')));
    const close = body.search(/\bawait\s+closeScheduling\s*\(/);
    assert.ok(close > -1, 'the shutdown handler does not await closeScheduling(): a reload during the drain re-arms the schedulers it stops');
    const stops = [...body.matchAll(/\bstop(?:Sync|Backup)Scheduler\s*\(|\bstop(?:Dupe|Contradiction)Scanner\s*\(/g)].map(m => m.index);
    assert.ok(stops.length >= 4, `found ${stops.length} scheduler stops in the handler; the scan is broken`);
    const early = stops.filter(i => i < close);
    assert.deepEqual(early, [], 'a scheduler is stopped before closeScheduling ran, so a reload can re-arm it in between');
  });

  it('POST /api/admin/reload-config reloads under the watcher\'s lock', () => {
    const route = app.indexOf("'/api/admin/reload-config'");
    assert.ok(route > -1, 'no reload-config route in server/src/app.ts: this gate reads the wrong file');
    const tail = app.slice(route, app.indexOf('});', route));
    assert.match(tail, /\brunConfigReload\s*\(\s*\(\)\s*=>\s*applyConfigFromDisk\s*\(/,
      'the reload route calls applyConfigFromDisk outside runConfigReload, so it can overlap a watched reload and a shutdown does not wait for it');
  });
});
