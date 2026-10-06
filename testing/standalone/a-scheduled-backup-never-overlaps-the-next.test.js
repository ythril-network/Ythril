/**
 * A scheduled backup that outlasts its period is skipped, not overlapped by the next (`Q-386`, the 5.6.6 patch).
 *
 * ## The defect it prevents
 *
 * `startBackupScheduler` handed node-cron a callback that called `runBackupNow()` directly. node-cron fires on its schedule whether or not
 * the last run has finished, so a dump that took longer than the cron's period was joined by a second dump, then a third: each its own
 * connection, its own read of every collection and its own write under `backups/`, every one slower for the others. The four sweeps got
 * `runExclusive` for the same reason (`util/single-flight.ts`); the backup was written before it and never joined them.
 *
 * ## How it is held
 *
 * Driven, not read: the real scheduler on a every-second cron, with the dump's one outbound act (`MongoClient.connect`, which
 * `dumpDatabase` opens its own client for) parked so the first dump never finishes. After a few ticks exactly ONE connect may have been
 * made, and the skipped ticks say so in the log. On the 5.6.5 tag every tick starts its own dump, so the count is the number of ticks.
 *
 * Needs no database: the parked connect is the first thing the dump does after creating its directory.
 *
 * Run: node --test testing/standalone/a-scheduled-backup-never-overlaps-the-next.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { logLinesDuring } from './_log-lines.mjs';

const TICKS_MS = 3_600;   // a cron of one second fires three times in this window

describe('a scheduled backup never overlaps the next', () => {
  let tmpDir; let realConnect; let scheduler;
  const parked = [];
  let connects = 0;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bkoverlap-'));
    process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
    process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
    process.env['MONGO_URI'] = 'mongodb://127.0.0.1:1/ythril_bkoverlap';
    process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
    fs.writeFileSync(path.join(tmpDir, 'backup.json'), JSON.stringify({ schedule: '* * * * * *' }), { mode: 0o600 });
    realConnect = MongoClient.prototype.connect;
    MongoClient.prototype.connect = function parkedConnect() {
      connects++;
      return new Promise((_resolve, reject) => parked.push(() => reject(new Error('released by the test'))));
    };
    scheduler = await import('../../server/dist/db/backup-scheduler.js');
  });

  after(() => {
    scheduler?.stopBackupScheduler();
    if (realConnect) MongoClient.prototype.connect = realConnect;
    for (const release of parked) release();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('starts one dump however many ticks fire while it runs, and says it skipped them', { timeout: 30_000 }, async () => {
    const { lines } = await logLinesDuring(async () => {
      scheduler.startBackupScheduler();
      await new Promise(r => setTimeout(r, TICKS_MS));
      scheduler.stopBackupScheduler();
    });
    assert.ok(lines.some(l => /Scheduled backup enabled/.test(l)), `the scheduler did not arm: ${lines.join(' | ')}`);
    assert.equal(connects, 1, `${connects} dumps were started inside ${TICKS_MS} ms of a one-second cron: the next tick overlapped the dump still running`);
    const skipped = lines.filter(l => /Scheduled backup: skipping this tick/.test(l));
    assert.ok(skipped.length >= 1, `no tick was reported skipped: ${lines.join(' | ')}`);
  });
});
