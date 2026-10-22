/**
 * The config watcher tells the instance's own writes from anybody else's, whatever stat its poll delivers (`Q-570`).
 *
 * ## The defect it holds closed
 *
 * `startConfigWatcher` polls config.json with `fs.watchFile` and used to judge the stat the poll DELIVERED: an mtime equal
 * to the one recorded after the last own write meant "ours". The poll samples the file on the threadpool, so two quick own
 * saves (a token mint writes config twice) hand it the FIRST save's mtime after the second was recorded. That stale stat
 * matched nothing and read as a foreign edit: the whole config was reloaded and every cron scheduler re-armed. In a test
 * the re-armed sync cron held the process after its teardown, so CI's database job ran into its 30-minute limit and was
 * cancelled (PR #1511, PR #1523); a green run held eight such reloads. In production it is a reload, audit entries and a
 * cron phase reset per burst of the instance's own writes.
 *
 * ## What it asserts
 *
 * 1. The verdict itself (`configChangeVerdict`), row by row: the file as it is NOW against what the instance last wrote.
 *    A failed stat is never "own" (it would hide an operator's edit until the next one), and neither is a file that only
 *    shares the mtime: size and inode are part of what was written.
 * 2. The watcher, end to end, with its listener captured: two own saves and the first save's stat delivered reload
 *    nothing; a foreign write then reloads exactly once, so the fix did not make the watcher deaf.
 *
 * Run: node --test testing/standalone/the-config-watcher-tells-its-own-writes-from-anothers.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { elapse } from '../_shared/sleep.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-own-write-'));
const cfgPath = path.join(dir, 'config.json');
process.env['CONFIG_PATH'] = cfgPath;

let loader;
let listener;
let reloads = 0;
const realWatchFile = fs.watchFile;

before(async () => {
  fs.writeFileSync(cfgPath, JSON.stringify({ spaces: [], networks: [], tokens: [] }));
  fs.watchFile = (_file, _opts, fn) => { listener = fn; };
  loader = await import('../../server/dist/config/loader.js');
});

after(() => {
  fs.watchFile = realWatchFile;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the verdict on a change to config.json', () => {
  const written = { mtimeMs: 1000, size: 50, ino: 7 };

  it('is exported, so it can be read row by row', () => {
    assert.equal(typeof loader.configChangeVerdict, 'function',
      'the loader exports no configChangeVerdict: the own-or-foreign decision is not one function a reader can test');
  });

  const rows = [
    { name: 'the file is exactly what this instance last wrote', now: { ...written }, inFlight: false, want: 'own' },
    { name: 'a newer write by somebody else', now: { mtimeMs: 2000, size: 60, ino: 8 }, inFlight: false, want: 'foreign' },
    { name: 'same mtime, different size (a same-tick foreign edit)', now: { ...written, size: 51 }, inFlight: false, want: 'foreign' },
    { name: 'same mtime and size, a different file (replaced by another hand)', now: { ...written, ino: 9 }, inFlight: false, want: 'foreign' },
    { name: 'the file could not be read just now', now: null, inFlight: false, want: 'unknown' },
    { name: 'a write of ours is still in flight', now: { mtimeMs: 2000, size: 60, ino: 8 }, inFlight: true, want: 'unknown' },
  ];
  for (const row of rows) {
    it(`${row.name}: ${row.want}`, () => {
      assert.equal(typeof loader.configChangeVerdict, 'function', 'no configChangeVerdict to ask');
      assert.equal(loader.configChangeVerdict(row.now, written, row.inFlight), row.want);
    });
  }
});

describe('the watcher, with its listener captured', () => {
  /** Hand the listener a stat as fs.watchFile would ((curr, prev) stats); the reload chain runs after it, so a case waits for what it expects. */
  function deliver(mtimeMs) {
    listener({ mtimeMs }, { mtimeMs: 0 });
  }

  it('does not reload when the poll delivers a stale stat of its own earlier write', async () => {
    loader.startConfigWatcher(() => { reloads++; });
    assert.equal(typeof listener, 'function', 'the watcher registered no listener through fs.watchFile');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    loader.saveConfig({ ...cfg, note: 'first own write' });
    const first = fs.statSync(cfgPath).mtimeMs;
    await elapse(30, 'timestamps differ: the two own writes must carry different mtimes');
    loader.saveConfig({ ...cfg, note: 'second own write' });
    assert.notEqual(fs.statSync(cfgPath).mtimeMs, first, 'fixture: the two own writes must differ in mtime for the case to mean anything');

    deliver(first);
    // Nothing observable says the chain decided not to reload; the next case is the control that a foreign edit does reload through this same listener.
    await elapse(50, 'absence window: no reload runs after a stale stat of the own write is delivered');
    assert.equal(reloads, 0, 'a stale stat of the instance\'s own write was read as a foreign edit and reloaded the config');
  });

  it('still reloads, once, for a write that is not its own', async () => {
    await elapse(30, 'timestamps differ: the operator edit must carry a different mtime from the own writes');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath, JSON.stringify({ ...raw, note: 'an operator edit' }));
    deliver(fs.statSync(cfgPath).mtimeMs);
    await waitFor(() => reloads >= 1, 5_000, 50, undefined, { what: 'the foreign edit to reload the config' });
    await elapse(50, 'absence window: no second reload after the first one ran');
    assert.equal(reloads, 1, 'a foreign edit must still reload, exactly once');
  });
});
