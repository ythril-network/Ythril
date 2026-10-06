/**
 * `concreteSpaceIds()` is the ids of `concreteSpaces()` and nothing else (`Q-274`, bundle-53 G8).
 *
 * ## The defect it prevents
 *
 * "The ids of the spaces that own collections" was spelled four ways: `spaceIds()` in `embed-worker.ts`, `getLocalSpaceIds()` in
 * `media/worker.ts`, and `.map(s => s.id)` over `concreteSpaces()` inline in more places. Each was correct while the others were,
 * and the proxy rule (`isProxy`, `Q-80`) is the one that must not be copied: a proxy holds no records, so a walk that includes
 * one reads a collection that does not exist. One function, derived from `concreteSpaces()`, so the proxy rule has one site.
 *
 * Run: node --test testing/standalone/concrete-space-ids.test.js   (requires a prior build of server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-concrete-ids-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const write = (spaces) => fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  instanceId: 'concrete-ids-test', instanceLabel: 'test', tokens: [], networks: [], spaces,
}, null, 2), { mode: 0o600 });

let loader, proxy;
before(async () => {
  loader = await import('../../server/dist/config/loader.js');
  proxy = await import('../../server/dist/spaces/proxy.js');
});

describe('concreteSpaceIds', () => {
  it('is exported', () => {
    assert.equal(typeof proxy.concreteSpaceIds, 'function', 'concreteSpaceIds is not exported by spaces/proxy');
  });

  it('before any config is loaded there are none, and asking does not throw', () => {
    assert.deepEqual(proxy.concreteSpaceIds(), []);
  });

  it('leaves proxies out and keeps the order of concreteSpaces()', () => {
    write([
      { id: 'zeta', label: 'Z', folders: [] },
      { id: 'wild', label: 'Wild proxy', folders: [], proxyFor: ['*'] },
      { id: 'alpha', label: 'A', folders: [] },
      { id: 'narrow', label: 'Narrow proxy', folders: [], proxyFor: ['alpha'] },
      { id: 'mid', label: 'M', folders: [] },
    ]);
    loader.loadConfig();
    const ids = proxy.concreteSpaceIds();
    assert.deepEqual(ids, ['zeta', 'alpha', 'mid'], 'config order, no proxy');
    assert.deepEqual(ids, proxy.concreteSpaces().map(s => s.id), 'the same answer as concreteSpaces()');
  });

  it('is a fresh array each call: a caller that mutates it changes nothing for the next', () => {
    const first = proxy.concreteSpaceIds();
    first.length = 0;
    assert.ok(proxy.concreteSpaceIds().length > 0);
  });

  it('follows a reload', () => {
    write([{ id: 'only', label: 'O', folders: [] }, { id: 'p', label: 'P', folders: [], proxyFor: ['only'] }]);
    loader.loadConfig();
    assert.deepEqual(proxy.concreteSpaceIds(), ['only']);
  });
});
