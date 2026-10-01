/**
 * A space whose config says `proxyFor: []` is a REAL space, to every part of the server (`Q-80`).
 *
 * The API refuses an empty member list (`ProxyForZ` is `min(1)`), so only a hand-edited `config.json` holds one.
 * `isProxy` has always read it as a real space — reads resolved it to itself — while every copy of the test that
 * read `proxyFor` for truthiness treated it as a proxy: never embedded, scanned or pruned, and deleted as a
 * config-only removal that left its collections behind. The loader removes the key on load and on reload, so
 * no reader of the config can meet the value the two spellings disagreed on.
 *
 * `concreteSpaces()` is here too because it is the other half of the same answer: the pre-setup case (no config
 * loaded yet) is an empty list, answered once, rather than a `try { getConfig() } catch` at every loop.
 *
 * Run: node --test testing/standalone/a-hand-edited-empty-proxy-list-is-a-real-space.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-empty-proxy-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const write = (spaces) => fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  instanceId: 'empty-proxy-test', instanceLabel: 'test', tokens: [], networks: [], spaces,
}, null, 2), { mode: 0o600 });

let loader, proxy;
before(async () => {
  loader = await import('../../server/dist/config/loader.js');
  proxy = await import('../../server/dist/spaces/proxy.js');
});

describe('before any config is loaded', () => {
  it('there are no concrete spaces, and asking does not throw', () => {
    assert.deepEqual(proxy.concreteSpaces(), []);
  });
});

describe('an empty member list is normalised away', () => {
  it('on load', () => {
    write([
      { id: 'hand', label: 'Hand-edited', folders: [], proxyFor: [] },
      { id: 'real', label: 'Real', folders: [] },
      { id: 'prox', label: 'Proxy', folders: [], proxyFor: ['real'] },
    ]);
    loader.loadConfig();
    const hand = loader.getConfig().spaces.find(s => s.id === 'hand');
    assert.equal('proxyFor' in hand, false, `the empty list survived the load: ${JSON.stringify(hand)}`);
    assert.equal(proxy.isProxy(hand), false);
    assert.deepEqual(proxy.concreteSpaces().map(s => s.id), ['hand', 'real'],
      'the hand-edited space owns collections, and the proxy does not');
  });

  it('on reload, which is how a hand edit usually arrives', () => {
    write([
      { id: 'hand', label: 'Hand-edited', folders: [], proxyFor: [] },
      { id: 'late', label: 'Edited in later', folders: [], proxyFor: [] },
    ]);
    loader.reloadConfig();
    for (const s of loader.getConfig().spaces) {
      assert.equal('proxyFor' in s, false, `${s.id} kept an empty member list across a reload`);
    }
    assert.deepEqual(proxy.concreteSpaces().map(s => s.id), ['hand', 'late']);
  });

  // 5.6.x only: main asserts this through `every-concrete-space-loop-uses-one-helper`, which needs every one of
  // the forty site conversions this patch does not carry. These are the two walks that CREATED something for a
  // proxy: the boot initialisation (a proxy's collections, every boot) and the restore index rebuild.
  it('the boot initialisation and the restore index rebuild walk only the concrete spaces', async () => {
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const lifecycle = stripComments(fs.readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));
    assert.match(bodyOf(lifecycle, 'initAllSpaces'), /\bconcreteSpaces\(\)/,
      'initAllSpaces walks every configured space — each boot creates a proxy\'s collections');
    const data = stripComments(fs.readFileSync('server/src/api/data.ts', 'utf8'));
    assert.match(data, /const spaces = concreteSpaces\(\);/,
      'the restore index rebuild walks every configured space, proxies included');
  });

  it('a real member list is left exactly as it was', () => {
    write([{ id: 'real', label: 'Real', folders: [] }, { id: 'all', label: 'All', folders: [], proxyFor: ['*'] }]);
    loader.reloadConfig();
    assert.deepEqual(loader.getConfig().spaces.find(s => s.id === 'all').proxyFor, ['*']);
    assert.deepEqual(proxy.concreteSpaces().map(s => s.id), ['real']);
  });
});
