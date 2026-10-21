/**
 * A config reloaded with pre-6.0 proxies is copied to `config.json.pre-6.0` before the reload converts it, exactly as a boot does
 * (Q-531, bundle-100 lens D3).
 *
 * ## The rule
 *
 * The way back to 5.x is the copy of the file taken before the first conversion. `loadConfig` takes it; `reloadConfig` converts a
 * restored 5.x file as well (a proxy must not come back as a writable space), and the next config write persists the converted
 * object over the file. Without the copy at the reload, the restored 5.x file is gone at that write, and nothing said so. One backup
 * step serves both, so neither can convert without it.
 *
 * ## Seen red
 *
 * At a4a1043d `reloadConfig` calls `migrateProxiesToViews` without the backup step: after the reload no `config.json.pre-6.0` exists.
 *
 * Run: npm run build:server, then node --test testing/standalone/a-restored-5x-config-is-backed-up-before-a-reload-converts-it.test.js
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-reload-backup-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const base = (spaces) => ({ instanceId: 'reload-backup-test', instanceLabel: 'test', tokens: [], networks: [], spaces });
const GENERAL = { id: 'general', label: 'General', builtIn: true, folders: [] };
const PROXY = { id: 'team', label: 'Team', folders: [], proxyFor: ['general'] };

describe('a reload that converts proxies backs the file up first (Q-531)', () => {
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('a restored 5.x config reloaded on a 6.0 instance leaves its copy in config.json.pre-6.0, and the live config holds no proxy', async () => {
    const loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base([GENERAL]), null, 2), { mode: 0o600 });
    loader.loadConfig();
    const backup = `${CONFIG_PATH}.pre-6.0`;
    assert.ok(!fs.existsSync(backup), 'control: a config with no proxy left a pre-6.0 copy at boot');

    const restored = JSON.stringify(base([GENERAL, PROXY]), null, 2);
    fs.writeFileSync(CONFIG_PATH, restored, { mode: 0o600 });
    loader.reloadConfig();
    assert.ok(!loader.getConfig().spaces.some(s => s.id === PROXY.id), 'control: the reload did not convert the proxy');
    assert.ok(fs.existsSync(backup), 'the reload converted a 5.x config and left no pre-6.0 copy: the next write loses the way back');
    assert.equal(fs.readFileSync(backup, 'utf8'), restored, 'the pre-6.0 copy is not the file the reload converted');
  });
});
