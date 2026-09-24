/**
 * Entity/record references — the real helpers, not a copy of them.
 *
 * Every link field in the brain (a memory's `entityIds`, an edge's `from`/`to`, a chrono entry's
 * `entityIds`/`memoryIds`, a file's three) names another record by its UUID v4 `_id`. This file tests
 * the canonical implementation in `brain/entity-refs.ts` and the real `isStrictLinkage` default.
 *
 * It tests the real functions, never a local copy: a private reimplementation passes whatever production
 * does, so it could never catch the default being wrong. A test that cannot fail is not coverage.
 *
 * Run: node --test testing/standalone/entity-refs.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-refs-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH; // read at module load — must be set before importing

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

let refs;
let proxy;
let loader;

function writeConfig(spaces) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'test-instance', instanceLabel: 'test', tokens: [], networks: [], spaces,
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

describe('reference format validation (canonical helpers)', () => {
  before(async () => {
    refs = await import('../../server/dist/brain/entity-refs.js');
    proxy = await import('../../server/dist/spaces/proxy.js');
    loader = await import('../../server/dist/config/loader.js');
  });

  it('accepts UUID v4 and nothing else', () => {
    assert.equal(refs.isUuidV4(UUID), true);
    assert.equal(refs.isUuidV4('Traefik'), false);
    assert.equal(refs.isUuidV4(''), false);
    assert.equal(refs.isUuidV4(undefined), false);
    // A v1 UUID is a UUID but not the id shape we mint — accepting it would let a foreign id in.
    assert.equal(refs.isUuidV4('2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d'), false);
  });

  it('an empty or absent field is not an error — omitting links is legal', () => {
    assert.equal(refs.invalidRefsMessage('entityIds', 'entity', undefined), null);
    assert.equal(refs.invalidRefsMessage('entityIds', 'entity', []), null);
  });

  it('the message names the field, the expected kind, and the offending value', () => {
    // The caller is usually an agent; "invalid reference" is not actionable, this is.
    const msg = refs.invalidRefsMessage('entityIds', 'entity', [UUID, 'Traefik']);
    assert.match(msg, /entityIds/);
    assert.match(msg, /entity ID/);
    assert.match(msg, /"Traefik"/);
    assert.doesNotMatch(msg, new RegExp(UUID), 'the valid id should not be reported as a problem');
  });

  it('names the right record kind per field', () => {
    assert.match(refs.invalidRefsMessage('memoryIds', 'fact', ['x']), /fact ID/);
    assert.match(refs.invalidRefsMessage('chronoIds', 'chrono', ['x']), /chrono ID/);
  });

  it('caps the list so a large bad payload cannot produce an unbounded error', () => {
    const many = Array.from({ length: 30 }, (_, i) => `bad-${i}`);
    const msg = refs.invalidRefsMessage('entityIds', 'entity', many);
    assert.match(msg, /\+25 more/);
  });

  it('assertRefs throws on a bad value and stays silent on a good one', () => {
    assert.throws(() => refs.assertRefs('entityIds', 'entity', ['nope']), /entityIds/);
    assert.doesNotThrow(() => refs.assertRefs('entityIds', 'entity', [UUID, UUID2]));
  });
});

describe('isStrictLinkage — the real function, and its default', () => {
  before(async () => {
    refs = await import('../../server/dist/brain/entity-refs.js');
    proxy = await import('../../server/dist/spaces/proxy.js');
    loader = await import('../../server/dist/config/loader.js');
  });

  it('defaults to STRICT when the space says nothing', () => {
    // This is the behaviour change: the safe mode used to be the one nobody opted into, so an
    // unvalidated reference was the default outcome for every space ever created.
    writeConfig([{ id: 'plain', label: 'Plain' }]);
    assert.equal(proxy.isStrictLinkage('plain'), true);
  });

  it('defaults to STRICT when meta exists but omits the flag', () => {
    writeConfig([{ id: 'withmeta', label: 'M', meta: { purpose: 'x' } }]);
    assert.equal(proxy.isStrictLinkage('withmeta'), true);
  });

  it('honours an explicit opt-out — the escape hatch survives', () => {
    // Staged imports that reference not-yet-created records still have a way out; it is now a
    // deliberate per-space choice rather than what you get by saying nothing.
    writeConfig([{ id: 'lax', label: 'Lax', meta: { strictLinkage: false } }]);
    assert.equal(proxy.isStrictLinkage('lax'), false);
  });

  it('honours an explicit opt-in', () => {
    writeConfig([{ id: 'strict', label: 'S', meta: { strictLinkage: true } }]);
    assert.equal(proxy.isStrictLinkage('strict'), true);
  });

  it('an unknown space is strict — an unknown target must not be the lax path', () => {
    writeConfig([{ id: 'only', label: 'O' }]);
    assert.equal(proxy.isStrictLinkage('does-not-exist'), true);
  });
});
