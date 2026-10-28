/**
 * A durable config save made while a background (coalesced) flush is in flight is what config.json holds afterwards (Q-638).
 *
 * ## What it prevents
 *
 * The background flush wrote its snapshot to a temp file, checked that no durable save had landed since, and only THEN renamed the temp
 * file over config.json, asynchronously. A `saveConfig` landing between that check and the rename was overwritten on disk by the older
 * snapshot. Memory still held the newer config until the next `reloadConfig`, which every `mutateConfig` does, and the write was gone:
 * a member's sync marks after a restore, in the CI run that found it, and any token, space or network write in principle.
 *
 * The flush is held at each of its two waits in turn - the temp-file write and the rename - and a durable save is made during the hold.
 * A fixed flush makes no asynchronous rename at all, so the rename hold is never reached: the case then runs the save after the flush,
 * which is the order a fixed flush leaves no window in.
 *
 * Run: node --test testing/standalone/a-durable-config-save-is-never-reverted-by-a-background-flush.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-cfg-race-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
// CONFIG_PATH is read at module-load time: set it BEFORE importing the loader.
process.env['CONFIG_PATH'] = CONFIG_PATH;

let loader;
const baseConfig = () => ({ instanceId: 'test-instance', instanceLabel: 'base', spaces: [], tokens: [], networks: [] });
const readDisk = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const turn = () => new Promise(r => setImmediate(r));

/**
 * Hold the next call of `fs.promises[method]` on the flush's temp file until released. `reached` resolves when the call is made; a
 * call never made leaves it unresolved, which the case bounds by turns.
 */
function holdFlushAt(method) {
  const original = fs.promises[method];
  let release;
  const gate = new Promise(r => { release = r; });
  let reached = false;
  fs.promises[method] = async function held(target, ...rest) {
    if (String(target).endsWith('.async.tmp')) {
      reached = true;
      fs.promises[method] = original;
      await gate;
    }
    return original.call(this, target, ...rest);
  };
  return {
    reached: () => reached,
    release: () => release(),
    restore: () => { fs.promises[method] = original; release(); },
  };
}

/** Wait until the hold is reached, or a bounded number of turns passes (a fixed flush never makes the held call). */
async function untilReachedOrSettled(hold) {
  for (let i = 0; i < 500 && !hold.reached(); i++) await turn();
  return hold.reached();
}

describe('a durable config save is never reverted by a background flush', () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(baseConfig(), null, 2), 'utf8');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  beforeEach(async () => {
    loader.saveConfig(baseConfig());
    await loader.flushConfig();
  });

  for (const method of ['rename', 'writeFile']) {
    it(`a save made while the flush waits on its ${method} is what the file and the reloaded config hold`, async () => {
      const hold = holdFlushAt(method);
      try {
        loader.saveConfigSoon({ ...baseConfig(), instanceLabel: 'background' });
        await untilReachedOrSettled(hold);
        loader.saveConfig({ ...baseConfig(), instanceLabel: 'durable' });
        hold.release();
        await loader.flushConfig();
        assert.equal(readDisk().instanceLabel, 'durable', `the background flush's older snapshot replaced the durable save on disk (held at ${method})`);
        loader.reloadConfig();
        assert.equal(loader.getConfig().instanceLabel, 'durable', 'the reload took the older snapshot back into memory');
      } finally {
        hold.restore();
      }
    });
  }
});
