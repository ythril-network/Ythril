/**
 * A recorded RDF base conflict, once saved, is the same after a reload of the configuration and after a restart of the process
 * (bundle-269, review finding 5's second half).
 *
 * ## What it holds
 *
 * - The conflict a member records (`takeServedRdfBases`, what a gossip pass writes) and the configuration saves is in `config.json`
 *   under the network, and `reloadConfig()` (what the external-change watcher runs) reads it back unchanged: the doors still refuse.
 * - A fresh process that loads the same file (`loadConfig()`, the boot) reads the conflict through `rdfBaseConflictOf` as the process that
 *   wrote it did.
 * - The leave is saved the same way: a space taken out of its network and saved has no conflict in the file, and a restarted process
 *   reads none.
 *
 * Whether a gossip pass whose settle step throws still saves what it recorded is read, not driven: `sync/engine.ts` calls `settleRounds`,
 * which catches each round's failure itself, so the pass reaches `saveConfig` on every input; see the return of the slice.
 *
 * Run: node --test testing/standalone/a-saved-rdf-base-conflict-survives-a-reload-and-a-restart.test.js (after the server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance } from './_vote-round-instance.mjs';

const dir = tempInstanceDir('ythril-rdf-conflict-reload-');
const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const OFFERED = 'https://one.example.org/ld/notes/';
const DIST = new URL('../../server/dist', import.meta.url).href;

/** What a fresh process reads from the file at `CONFIG_PATH`: the stored entries of every network and the conflict the doors read. */
function readInFreshProcess() {
  const script = `
    const loader = await import(${JSON.stringify(`${DIST}/config/loader.js`)});
    const { rdfBaseConflictOf } = await import(${JSON.stringify(`${DIST}/spaces/rdf-settle.js`)});
    const cfg = loader.loadConfig();
    console.log(JSON.stringify({ stored: cfg.networks.map(n => n.rdfBaseConflicts ?? null), read: rdfBaseConflictOf(cfg, 'notes') ?? null }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: testChildEnv({ CONFIG_PATH: process.env['CONFIG_PATH'], DATA_ROOT: process.env['DATA_ROOT'] }), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(run.status, 0, `the fresh process failed: ${run.stderr.slice(0, 500)}`);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

describe('a saved RDF base conflict survives a reload of the configuration and a restart', () => {
  let loader, settle, takeOut;
  before(async () => {
    loader = await bootInstance(dir, {
      instanceId: 'aaaaaaaa-0000-4000-8000-0000000c0f1c',
      spaces: [{ id: 'notes', label: 'Notes', folders: [], meta: { rdf: OLD } }],
      networks: [{
        id: 'net-1', label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['notes'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: 'p1', label: 'P1', url: 'https://p1.example', tokenHash: 'h', direction: 'both' }],
      }],
    });
    settle = await import('../../server/dist/spaces/rdf-settle.js');
    ({ takeSpaceOutOfNetwork: takeOut } = await import('../../server/dist/networks/take-space-out-of-network.js'));
  });
  after(async () => { await loader.flushConfig(); removeInstanceDir(dir); });

  const net = () => loader.getConfig().networks.find(n => n.id === 'net-1');

  it('the conflict a member records and the configuration saves is in the file, and a reload reads it back unchanged', () => {
    const cfg = loader.getConfig();
    assert.equal(settle.takeServedRdfBases(net(), cfg.spaces, { notes: { base: OFFERED, vocab: `${OFFERED}vocab/`, baseEpoch: 1 } }, 'p1'), true);
    const recorded = JSON.parse(JSON.stringify(net().rdfBaseConflicts));
    loader.saveConfig(cfg);
    const inFile = JSON.parse(fs.readFileSync(process.env['CONFIG_PATH'], 'utf8')).networks[0].rdfBaseConflicts;
    assert.deepEqual(inFile, recorded, 'the saved file does not hold the conflict that was recorded');
    assert.ok(JSON.stringify(inFile).includes(OFFERED), 'the saved conflict names no offered base');
    loader.reloadConfig();
    assert.deepEqual(net().rdfBaseConflicts, recorded, 'a reload of the configuration changed the conflict');
    assert.ok(settle.rdfBaseConflictOf(loader.getConfig(), 'notes'), 'the doors no longer read a conflict after the reload');
  });

  it('a fresh process loading the file reads the same conflict the doors answer from', () => {
    const fresh = readInFreshProcess();
    assert.deepEqual(fresh.stored, [net().rdfBaseConflicts]);
    assert.deepEqual(fresh.read, JSON.parse(JSON.stringify(settle.rdfBaseConflictOf(loader.getConfig(), 'notes'))));
    assert.deepEqual(fresh.read.offered.map(o => o.base), [OFFERED]);
  });

  it('a space taken out of its network and saved leaves no conflict in the file, and a restarted process reads none', () => {
    const cfg = loader.getConfig();
    assert.equal(takeOut(net(), 'notes').carried, true);
    loader.saveConfig(cfg);
    assert.equal(JSON.parse(fs.readFileSync(process.env['CONFIG_PATH'], 'utf8')).networks[0].rdfBaseConflicts, undefined, 'the file still holds the conflict of a space that left');
    assert.deepEqual(readInFreshProcess(), { stored: [null], read: null });
  });
});
