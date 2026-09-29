/**
 * A network's sync schedule stops when the network is gone (`Q-144`).
 *
 * ## The defect
 *
 * `sync/scheduler.ts` arms one cron task per network, and nothing stopped it when the network went away: leaving or
 * deleting it (`networks/network-acts.ts`), being ejected (`api/notify.ts`), or a config reload that no longer lists
 * it. Each orphaned task kept firing and logged `Scheduled sync failed for network <id>: Network <id> not found` at
 * ERROR — seen in the sync suite for sixteen networks the tests had already deleted. `Q-137` arms a schedule on every
 * join, which turned it from an edge case into every network an instance ever leaves: a permanent false alarm.
 *
 * ## The rule, and where it lives
 *
 * In the scheduler, so no removal path has to remember it: a tick whose network is gone stops its own task without
 * an error, and a reload stops the tasks for networks it no longer lists while leaving the others' phase alone.
 *
 * Run: node --test testing/standalone/a-sync-schedule-stops-when-its-network-is-gone.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-sync-schedule-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const CRON = '*/15 * * * *';
let scheduler, config, log;

/** Network entries as the scheduler reads them: it needs the id and the schedule, nothing else. */
const listNetworks = (...ids) => { config.networks = ids.map(id => ({ id, syncSchedule: CRON })); };

describe('a sync schedule stops when its network is gone', () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [], networks: [], tokens: [] }, null, 2));
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    config = loader.getConfig();
    scheduler = await import('../../server/dist/sync/scheduler.js');
    ({ log } = await import('../../server/dist/util/log.js'));
  });

  after(() => {
    scheduler?.stopSyncScheduler();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a tick for a network that is no longer configured stops its task, and logs no error', async () => {
    assert.equal(typeof scheduler.runScheduledSync, 'function', 'the scheduler exports no runScheduledSync — the tick is not testable');
    assert.equal(typeof scheduler.scheduledSyncNetworks, 'function', 'the scheduler exports no scheduledSyncNetworks');
    listNetworks('gone');
    scheduler.scheduleSyncForNetwork('gone', CRON);
    assert.deepEqual(scheduler.scheduledSyncNetworks(), ['gone'], 'fixture: the schedule was not armed');

    listNetworks();
    const errors = [];
    const original = log.error;
    log.error = (msg) => { errors.push(msg); };
    try {
      await scheduler.runScheduledSync('gone');
    } finally {
      log.error = original;
    }
    assert.deepEqual(errors, [], `the tick for a removed network logged an error: ${errors.join(' | ')}`);
    assert.deepEqual(scheduler.scheduledSyncNetworks(), [], 'the removed network is still scheduled, so it fires every tick for ever');
  });

  it('a reload that no longer lists a network stops its task and keeps the rest armed', () => {
    assert.equal(typeof scheduler.scheduledSyncNetworks, 'function', 'the scheduler exports no scheduledSyncNetworks');
    listNetworks('kept', 'dropped');
    scheduler.startSyncScheduler();
    assert.deepEqual(scheduler.scheduledSyncNetworks().sort(), ['dropped', 'kept'], 'fixture: both schedules armed');

    listNetworks('kept');
    scheduler.startSyncScheduler();
    assert.deepEqual(scheduler.scheduledSyncNetworks(), ['kept'],
      'a reload left the dropped network scheduled — every tick now fails with "not found"');
  });
});
