/**
 * `importBodyMaxBytes` and `importMaxDocuments` are refused at load and at reload unless they are positive whole numbers, naming the key, and a
 * refused reload keeps the limits in effect (bundle-40 pre-ship T4, `Q-267`; `config/body-limits.ts`, `validateImportLimits`).
 *
 * ## What it prevents
 *
 * A ceiling read as `NaN`, a string or a fraction compares false against every body, so the door would bound nothing; zero or a negative
 * refuses every body. Both loader paths (`loadConfig` at start, `reloadConfig` on the admin route and the file watcher) ask the one validator.
 *
 * ## Seen
 *
 * A PIN: it holds on 505b5790c, which had no test of either path.
 *
 * Run: `node --test testing/standalone/the-import-limits-are-refused-at-load-and-reload-unless-positive-whole-numbers.test.js` (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-import-limits-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const GOOD = { importBodyMaxBytes: 2048, importMaxDocuments: 10 };
const base = { instanceId: 'limits-test', instanceLabel: 'test', tokens: [], networks: [], spaces: [{ id: 'general', label: 'General', folders: [] }] };
const write = (over) => fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...base, ...over }, null, 2), { mode: 0o600 });

const BAD = { zero: 0, negative: -1, fraction: 1.5, string: '1024', 'a number past the safe integers': 2 ** 60, null: null, 'not a number': 'NaN' };

let loader;

describe('the import limits are positive whole numbers, at load and at reload', () => {
  before(async () => {
    write(GOOD);
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
  });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('control: positive whole numbers load, and an absent key is the default', () => {
    write(GOOD);
    assert.doesNotThrow(() => loader.loadConfig());
    write({});
    assert.doesNotThrow(() => loader.loadConfig());
    write(GOOD);
    loader.loadConfig();
  });

  for (const key of ['importBodyMaxBytes', 'importMaxDocuments']) {
    for (const [what, value] of Object.entries(BAD)) {
      it(`${key} as ${what} is refused at load, naming the key`, () => {
        write({ ...GOOD, [key]: value });
        try {
          assert.throws(() => loader.loadConfig(), (err) => new RegExp(key).test(err.message), `loadConfig() took ${key} = ${JSON.stringify(value)}`);
        } finally { write(GOOD); loader.loadConfig(); }
      });

      it(`${key} as ${what} is refused at reload, and the limits in effect stay`, () => {
        write({ ...GOOD, [key]: value });
        try {
          assert.throws(() => loader.reloadConfig(), (err) => new RegExp(key).test(err.message), `reloadConfig() took ${key} = ${JSON.stringify(value)}`);
          assert.equal(loader.getConfig()[key], GOOD[key], `a refused reload changed ${key} in effect`);
        } finally { write(GOOD); loader.loadConfig(); }
      });
    }
  }
});
