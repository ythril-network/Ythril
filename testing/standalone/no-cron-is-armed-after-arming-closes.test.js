/**
 * Once cron arming is closed, no cron scheduler arms anything, by any path (`Q-474`, `Q-570`).
 *
 * ## The defect it holds closed
 *
 * Four schedulers capture a cron expression when they start (sync, duplicate scanner, contradiction scanner, backup), and
 * each can be started again after the shutdown, or a test's teardown, has stopped it: a config reload re-arms three of them
 * (`rearmCronSchedulers`), the network settings act armed sync after a dynamic import it did not await, a join arms its
 * default schedule, and the backup route re-arms backups. An arm that lands after the stop leaves a node-cron task whose
 * timers hold the process: in CI a test file closed its database and then sat in "Starting sync cycle ... MongoDB not
 * connected" until the job's 30-minute limit cancelled it (PR #1511, PR #1523).
 *
 * So arming has one switch, `closeCronArming()` in `util/armed-schedule.ts`, and once it is closed every start of every cron
 * scheduler arms nothing. A plain stop is NOT that switch: a process that is not ending may stop and start a scheduler
 * again (`sync-engine-lock.test.js` does), which the second case holds.
 *
 * What is armed is read from the schedulers' own memory (`armedCronKeys()`), the fact each of them records when it arms,
 * not from a name list here. The backup scheduler needs a backup volume to arm at all; it is held to the same switch by
 * `every-cron-scheduler-asks-whether-arming-is-closed.test.js`, which derives the set of cron schedulers from the code.
 *
 * Run: node --test testing/standalone/no-cron-is-armed-after-arming-closes.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-no-arm-'));
process.env['CONFIG_PATH'] = path.join(dir, 'config.json');

const CRON = '*/15 * * * *';
let config, armed, sync, dupe, contradiction;

before(async () => {
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ spaces: [], networks: [], tokens: [] }));
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  config = loader.getConfig();
  config.networks = [{ id: 'net-a', syncSchedule: CRON }];
  config.dupeScanner = { enabled: true, schedule: CRON };
  config.contradictionScanner = { enabled: true, schedule: CRON };
  armed = await import('../../server/dist/util/armed-schedule.js');
  sync = await import('../../server/dist/sync/scheduler.js');
  dupe = await import('../../server/dist/brain/dupe-scanner.js');
  contradiction = await import('../../server/dist/brain/contradiction-scanner.js');
});

after(() => {
  sync?.stopSyncScheduler();
  dupe?.stopDupeScanner();
  contradiction?.stopContradictionScanner();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function startEvery() {
  sync.startSyncScheduler();
  sync.scheduleSyncForNetwork('net-b', CRON);
  dupe.startDupeScanner();
  contradiction.startContradictionScanner();
}

function stopEvery() {
  sync.stopSyncScheduler();
  dupe.stopDupeScanner();
  contradiction.stopContradictionScanner();
}

describe('cron arming', () => {
  it('reports what is armed, and has a switch to close', () => {
    assert.equal(typeof armed.armedCronKeys, 'function', 'util/armed-schedule exports no armedCronKeys: nothing can say what is armed');
    assert.equal(typeof armed.closeCronArming, 'function', 'util/armed-schedule exports no closeCronArming: there is no switch to close');
  });

  it('a stop is not the switch: stop then start arms again', () => {
    assert.equal(typeof armed.armedCronKeys, 'function', 'no armedCronKeys to read');
    startEvery();
    const first = armed.armedCronKeys().length;
    assert.ok(first >= 4, `fixture: expected sync (two networks), dupe and contradiction armed, got ${first}`);
    stopEvery();
    assert.deepEqual(armed.armedCronKeys(), [], 'a stop left something recorded as armed');
    startEvery();
    assert.equal(armed.armedCronKeys().length, first, 'a stop without closing arming must not refuse the next start');
    stopEvery();
  });

  it('once closed, no start of any cron scheduler arms anything', async () => {
    assert.equal(typeof armed.closeCronArming, 'function', 'no closeCronArming to close');
    armed.closeCronArming();
    startEvery();
    // The settings act's old spelling: the arm lands after an import that the stop did not wait for.
    await import('../../server/dist/sync/scheduler.js').then(m => m.scheduleSyncForNetwork('net-c', CRON));
    assert.deepEqual(armed.armedCronKeys(), [],
      'a cron task was armed after arming closed, and its node-cron timers keep the process alive');
    assert.deepEqual(sync.scheduledSyncNetworks(), [], 'the sync scheduler holds a task after arming closed');
  });
});
