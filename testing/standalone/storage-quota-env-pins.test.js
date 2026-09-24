/**
 * Storage quotas are env-pinnable, and the pins actually bind.
 *
 * ## Two problems, one of them worse than the reported one
 *
 * **Reported:** storage limits were `config.json`-only, so on a host running several brains the disk
 * ceiling — the host operator's call, not the tenant's — was the one infra-shaped setting with no env
 * pin. Every other one (`allowPrivateModelEndpoints`, `modelPath`, the model endpoints) is pinnable and
 * lands in `lockedByInfra` precisely so it cannot be widened from inside the instance.
 *
 * *(The reporter believed the tenant could raise it from Settings. They could not — no route writes
 * `cfg.storage`, and none is added here. But they own the config volume, so config-only still meant
 * unpinnable: the same gap by a longer path.)*
 *
 * **Found while fixing it, and worse:** the client's `StorageLimits` type was
 * `{ totalLimitGiB, warnAtPercent }` — a shape the server has NEVER sent. The real payload is
 * `{ total: { softLimitGiB, hardLimitGiB }, … }`. So `limits.totalLimitGiB` was permanently undefined,
 * every `@if` guarding the quota UI was permanently false, and Settings → Storage showed no limit, no
 * usage bar and no health pill on an instance that had quotas configured. It read as "no quota set".
 * Reading a missing field is not an error, so nothing ever complained.
 *
 * Run: node --test testing/standalone/storage-quota-env-pins.test.js
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-storage-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let getStorageConfig;
let loader;

const ENV_KEYS = [
  'STORAGE_TOTAL_SOFT_GIB', 'STORAGE_TOTAL_HARD_GIB',
  'STORAGE_FILES_SOFT_GIB', 'STORAGE_FILES_HARD_GIB',
  'STORAGE_BRAIN_SOFT_GIB', 'STORAGE_BRAIN_HARD_GIB',
];
const clear = () => { for (const k of ENV_KEYS) delete process.env[k]; };

function seed(storage) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'storage-test', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
    ...(storage ? { storage } : {}),
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

describe('storage quota env pins', () => {
  before(async () => {
    loader = await import('../../server/dist/config/loader.js');
    ({ getStorageConfig } = loader);
  });
  beforeEach(clear);
  afterEach(clear);

  describe('resolution', () => {
    it('is undefined when nothing is configured — quota disabled, not "limit 0"', () => {
      // Every caller treats a falsy result as "no quota". Returning an object with only lockedByInfra
      // in it would be truthy and would switch enforcement on with no limits in it.
      seed(null);
      assert.equal(getStorageConfig(), undefined);
    });

    it('reads config.json when no env var is set', () => {
      seed({ total: { softLimitGiB: 80, hardLimitGiB: 100 } });
      const r = getStorageConfig();
      assert.deepEqual(r.total, { softLimitGiB: 80, hardLimitGiB: 100 });
      assert.deepEqual(r.lockedByInfra, []);
    });

    it('an env pin overrides config.json and is reported as locked', () => {
      seed({ total: { softLimitGiB: 80, hardLimitGiB: 100 } });
      process.env.STORAGE_TOTAL_HARD_GIB = '50';
      const r = getStorageConfig();
      assert.equal(r.total.hardLimitGiB, 50, 'the pin must win');
      assert.equal(r.total.softLimitGiB, 80, 'the unpinned tier still comes from config');
      assert.deepEqual(r.lockedByInfra, ['total.hardLimitGiB']);
    });

    it('pins an area that config.json never mentioned', () => {
      seed(null);
      process.env.STORAGE_FILES_HARD_GIB = '25';
      const r = getStorageConfig();
      assert.equal(r.files.hardLimitGiB, 25);
      assert.ok(r.lockedByInfra.includes('files.hardLimitGiB'));
    });

    it('all six are separately pinnable', () => {
      seed(null);
      process.env.STORAGE_TOTAL_SOFT_GIB = '1';
      process.env.STORAGE_TOTAL_HARD_GIB = '2';
      process.env.STORAGE_FILES_SOFT_GIB = '3';
      process.env.STORAGE_FILES_HARD_GIB = '4';
      process.env.STORAGE_BRAIN_SOFT_GIB = '5';
      process.env.STORAGE_BRAIN_HARD_GIB = '6';
      const r = getStorageConfig();
      assert.deepEqual(r.total, { softLimitGiB: 1, hardLimitGiB: 2 });
      assert.deepEqual(r.files, { softLimitGiB: 3, hardLimitGiB: 4 });
      assert.deepEqual(r.brain, { softLimitGiB: 5, hardLimitGiB: 6 });
      assert.equal(r.lockedByInfra.length, 6);
    });

    it('0 is a real pin, not an absent one', () => {
      // "No writes at all" is a legitimate ceiling, and `if (!value)` would silently discard it.
      seed(null);
      process.env.STORAGE_FILES_HARD_GIB = '0';
      assert.equal(getStorageConfig().files.hardLimitGiB, 0);
    });
  });

  describe('a malformed pin is refused, not turned into NaN', () => {
    // NaN compares false against every usage figure, so a NaN limit reads as configured and enforces
    // nothing — a quota that silently does not exist is worse than no quota at all.
    for (const bad of ['abc', '', '  ', '-5']) {
      it(`ignores ${JSON.stringify(bad)} and falls back to config.json`, () => {
        seed({ files: { hardLimitGiB: 10 } });
        process.env.STORAGE_FILES_HARD_GIB = bad;
        const r = getStorageConfig();
        assert.equal(r.files.hardLimitGiB, 10);
        assert.ok(!r.lockedByInfra.includes('files.hardLimitGiB'),
          'a rejected pin must not claim to have locked the field');
      });
    }
  });

  /**
   * Source with comment lines removed.
   *
   * Third time this has bitten in one session: an assertion that forbids a string trips on the comment
   * *explaining why the string is forbidden*. A gate that fails on its own justification teaches people
   * to delete the justification.
   */
  function codeOf(file) {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
      .join('\n');
  }

  describe('the pins actually bind', () => {
    // A resolver nothing calls is decoration. Each of these read `cfg.storage` directly before.
    const CONSUMERS = [
      ['server/src/quota/quota.ts', /const storage = getStorageConfig\(\)/],
      ['server/src/metrics/registry.ts', /const storage = getStorageConfig\(\)/],
      ['server/src/api/spaces.ts', /const resolvedStorage = getStorageConfig\(\)/],
    ];
    for (const [file, re] of CONSUMERS) {
      it(file, () => {
        const code = codeOf(file);
        assert.match(code, re);
        assert.doesNotMatch(code, /cfg\.storage/, 'must not read the raw config, which skips the env layer');
      });
    }
  });

  describe('the client reads the shape the server sends', () => {
    it('StorageLimits is the per-area shape, not the invented flat one', () => {
      const types = codeOf('client/src/app/core/api.types.ts');
      assert.match(types, /export interface StorageLimits \{[\s\S]*?total\?: StorageAreaLimit/);
      assert.doesNotMatch(types, /totalLimitGiB/,
        'the flat shape was never sent by the server; reintroducing it re-hides the whole quota UI');
    });

    it('the Storage page no longer reads the field that does not exist', () => {
      const ui = codeOf('client/src/app/pages/settings/storage.component.ts');
      assert.doesNotMatch(ui, /totalLimitGiB/);
      assert.doesNotMatch(ui, /warnAtPercent \?\? 80/,
        'the warn threshold is derived from the soft limit now, not a hard-coded fallback for a field ' +
        'the server never sent');
      assert.match(ui, /totalHard = computed/);
      assert.match(ui, /limitRows = computed/);
    });

    it('an env-pinned limit is rendered read-only', () => {
      const ui = codeOf('client/src/app/pages/settings/storage.component.ts');
      assert.match(ui, /lockedByInfra/);
      assert.match(ui, /mediaProcessing\.pill\.env/);
    });
  });
});
