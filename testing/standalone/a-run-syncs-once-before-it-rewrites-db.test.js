/**
 * A save- or vote-started run on a networked space syncs once with its peers before its first rewrite (Q-746, bundle-284 design r5 section 5.3
 * step 0; amendment A2: owner, 2026-11-18, "B but sync first so if another instance already converted its taken from there and be skipped"
 * and "why wait at all? that member gets the changes already completed").
 *
 * ## The rule
 *
 * - A run whose sources hold a `write` or a `round`, on a space in a network, asks ONE sync of each distinct peer it pulls from (a peer two
 *   networks share is asked once; a member this instance only pushes to is not asked) through the manual sync trigger, before it reads its
 *   first page, so before its first rewrite.
 * - A peer that throws or whose rows say it did not answer holds nothing up: the run goes on at once.
 * - `syncedFirst` records `{ asked, answered }`; an act-started run and a run on a space in no network ask none (`{ asked: 0, answered: 0 }`).
 * - Source gate: the run module calls `peerSyncOutcome` (`server/src/sync/trigger.ts`) and starts no sync cycle, timer or wait of its own.
 *
 * The trigger is injected (`syncPeer`), so the test runs no network.
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-run-syncs-once-before-it-rewrites-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { stripComments } from './_strip-comments.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const NET_SPACE = 'synced';
const SOLO = 'solo';
const SELF = 'b284-sync-self';
const RENAME = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
const AFTER = structuredClone(CONVERT_META);
AFTER.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, alias: { type: 'string' } };

const member = (instanceId, extra = {}) => ({ instanceId, label: instanceId, url: 'http://192.0.2.1:9', tokenHash: 'x', ...extra });
const NETWORKS = [
  { id: 'net-one', label: 'One', type: 'closed', origin: 'created', votes: [], votingDeadlineHours: 24, spaces: [NET_SPACE],
    members: [member('peer-a'), member('peer-b')] },
  { id: 'net-two', label: 'Two', type: 'closed', origin: 'created', votes: [], votingDeadlineHours: 24, spaces: [NET_SPACE],
    members: [member('peer-a'), member('peer-c')] },
  // This instance only pushes to `peer-d` (it is its publisher): a sync with it brings nothing converted here, so it is not asked.
  { id: 'net-pub', label: 'Pub', type: 'pubsub', origin: 'created', votes: [], votingDeadlineHours: 24, spaces: [NET_SPACE],
    members: [member('peer-d', { direction: 'push' })] },
];

const answered = (peerId, outcome) => ({ status: 200, body: { status: 'completed', peerId, wait: true,
  members: [{ networkId: 'net-one', instanceId: peerId, label: peerId, outcome, reason: 'r' }] } });

describe('a run syncs once before it rewrites (real MongoDB, injected trigger)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284syncfirst', spaces: [NET_SPACE, SOLO], networks: NETWORKS, instanceId: SELF });
    run = await door.runModule();
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  const settle = (space) => waitForValue(async () => { const d = await door.runDoc(space); return d?.state === 'complete' ? d : null; },
    20_000, 100, undefined, { what: `the run of ${space} to complete` });

  it('a save-started run on a networked space asks each distinct peer it pulls from once, before its first rewrite, and goes on past failures', async () => {
    await door.seed(NET_SPACE, 'entities', [{ _id: 'p-1', name: 'P', type: 'person', properties: { nick: 'n' } }]);
    door.setMeta(NET_SPACE, AFTER);
    const asked = [];
    const syncPeer = async (peerId, opts) => {
      const row = await door.coll(NET_SPACE, 'entities').findOne({ _id: 'p-1' });
      asked.push({ peerId, wait: opts?.wait, convertedYet: !row.properties.nick });
      if (peerId === 'peer-a') return answered(peerId, 'success');
      if (peerId === 'peer-b') throw new Error('peer-b: connection refused');
      return answered(peerId, 'failed');
    };
    const started = await run.startSchemaConvertRun(
      { spaceId: NET_SPACE, types: [{ kind: 'entity', type: 'person' }], steps: [RENAME], source: { kind: 'write' } }, { syncPeer });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await settle(NET_SPACE);

    assert.deepEqual(asked.map(a => a.peerId).sort(), ['peer-a', 'peer-b', 'peer-c'], 'each distinct peer pulled from, once');
    assert.ok(asked.every(a => a.wait === true), 'the sync is waited for');
    assert.ok(asked.every(a => a.convertedYet === false), 'every sync was asked before the first rewrite');
    assert.deepEqual(done.syncedFirst, { asked: 3, answered: 1 });
    assert.deepEqual((await door.coll(NET_SPACE, 'entities').findOne({ _id: 'p-1' })).properties, { alias: 'n' },
      'a peer that failed or threw held nothing up');
  });

  it('an act-started run asks none', async () => {
    await door.seed(NET_SPACE, 'entities', [{ _id: 'p-2', name: 'P2', type: 'person', properties: { nick: 'm' } }]);
    const asked = [];
    const started = await run.startSchemaConvertRun(
      { spaceId: NET_SPACE, types: [{ kind: 'entity', type: 'person' }], steps: [RENAME], source: { kind: 'act' } },
      { syncPeer: async (peerId) => { asked.push(peerId); return answered(peerId, 'success'); } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await settle(NET_SPACE);
    assert.deepEqual(asked, [], 'the act was asked for now: it syncs first with nobody');
    assert.deepEqual(done.syncedFirst, { asked: 0, answered: 0 });
  });

  it('a save-started run on a space in no network asks none', async () => {
    await door.seed(SOLO, 'entities', [{ _id: 's-1', name: 'S', type: 'person', properties: { age: 1 } }]);
    const asked = [];
    const started = await run.startSchemaConvertRun(
      { spaceId: SOLO, types: [{ kind: 'entity', type: 'person' }], steps: [], source: { kind: 'write' } },
      { syncPeer: async (peerId) => { asked.push(peerId); return answered(peerId, 'success'); } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await settle(SOLO);
    assert.deepEqual(asked, []);
    assert.deepEqual(done.syncedFirst, { asked: 0, answered: 0 });
  });

  it('source gate: the run module calls peerSyncOutcome and starts no sync cycle, timer or wait of its own', () => {
    const file = 'server/src/spaces/schema-convert-run.ts';
    assert.ok(existsSync(file), `${file} exists`);
    const src = stripComments(readFileSync(file, 'utf8'));
    assert.match(src, /import\s*\{[^}]*\bpeerSyncOutcome\b[^}]*\}\s*from\s*'\.\.\/sync\/trigger\.js'/, 'it imports the manual trigger');
    assert.match(src, /\bpeerSyncOutcome\b(?!\s*[,}])/, 'and uses it');
    assert.doesNotMatch(src, /\b(runSyncForPeer|networkSyncOutcome|joinSyncForNetwork|runSyncForMember|inCycle)\b/, 'no cycle of its own');
    assert.doesNotMatch(src, /\bset(Timeout|Interval)\(/, 'no timer or wait of its own');
  });
});
