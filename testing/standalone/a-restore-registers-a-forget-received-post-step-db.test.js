/**
 * A restore forgets what its space RECEIVED, by a post-step of its own named `forgetReceived`; a wipe's `forgetReceiveMarks` still means
 * EVERY mark (bundle-157 plan rev 5 R5.2).
 *
 * ## The rule
 *
 * A wipe empties a space, so every mark a member holds for it is a lie and `postSteps.forgetReceiveMarks` forgets all six
 * (`sync/receive-marks.ts`). A restore keeps what it SENT and forgets what it RECEIVED (`RECEIVE_MARKS`), and that is a different step with
 * a different key: `postSteps.forgetReceived`. Both are computed at REGISTRATION from the networks that carry the space then, and both
 * are persisted on the act's entry, so the one completion write applies whichever the entry holds. The old key keeps its meaning (a 5.x
 * entry on disk needs no migration), so it is not repurposed to mean "receive marks only": that would make a wipe entry written before an
 * upgrade forget less than it promised.
 *
 * ## Rows
 *
 * 1. A restore act registered on a space two networks are asked about carries `postSteps.forgetReceived` naming only the network that
 *    carries the space, and no `forgetReceiveMarks`. (Red today: the kind is unknown to the runner and no step is written.)
 * 2. A wipe act still carries `forgetReceiveMarks` for the same network and no `forgetReceived`. (Control, green today.)
 * 3. Completion: an entry holding `forgetReceived` forgets the three receive marks and KEEPS the three it sent. (Red today: the key is
 *    not read, nothing is forgotten.) It is driven through the wipe the runner runs today, with the step seeded, so the completion write -
 *    the one place that applies a post-step - is the thing under test and no restore body is needed.
 * 4. Completion: an entry holding the old `forgetReceiveMarks` forgets all six, including the ones a restore keeps. (Control, green today:
 *    the old key still means every mark.)
 *
 * The kept/forgotten split is the design's (rev 2), spelled out here as literals because this row asserts the completion's behaviour, not
 * the classification (`receive-marks-and-kept-marks-classify-every-mark.test.js` holds that).
 *
 * Run: node --test testing/standalone/a-restore-registers-a-forget-received-post-step-db.test.js (a Mongo the harness accepts; a prior `npx tsc -p server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, resetRunnerForTest, netFixture, seedActEntry } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();

const T = { timeout: 45_000 };
const RECEIVED = ['lastSeqReceived', 'tombstoneRereadAt', 'fileMetaRereadAt'];
const SENT = ['lastSeqPushed', 'lastSeqServed', 'lastFileTombstoneAckedAt'];
const SPACES = ['carried', 'plain', 'done-a', 'done-b'];

const member = (instanceId, space) => ({
  instanceId, label: instanceId, url: `http://${instanceId}.invalid`, tokenHash: 'x', joinedAt: '2026-01-01T00:00:00.000Z',
  lastSeqReceived: { [space]: 9 }, lastSeqPushed: { [space]: 8 }, lastSeqServed: { [space]: 7 },
  lastFileTombstoneAckedAt: { [space]: '2026-02-02T00:00:00.000Z' }, tombstoneRereadAt: { [space]: 'done' }, fileMetaRereadAt: { [space]: 'done' },
});

describe('a restore registers forgetReceived; a wipe keeps forgetReceiveMarks', { skip }, () => {
  let door, loader, runner;
  before(async () => {
    door = await openToolDoor({ suite: 'forgetreceived', spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => {
    try { resetRunnerForTest(runner); } catch { /* the runner never loaded */ }
    await door?.close();
  });
  beforeEach(async () => {
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    resetRunnerForTest(runner);
    clearActEntries(loader);
  });
  afterEach(() => { try { clearActEntries(loader); resetRunnerForTest(runner); } catch { /* best effort */ } });

  const register = (req) => { let out; loader.mutateConfig(cfg => { out = runner.registerSpaceAct(cfg, req, Date.now()); }); return out; };
  const twoNetworks = () => loader.mutateConfig(cfg => {
    cfg.networks = [
      { ...netFixture('carries-it', { spaces: ['carried'] }), members: [member('peer-a', 'carried')] },
      { ...netFixture('does-not', { spaces: ['plain'] }), members: [member('peer-b', 'carried')] },
    ];
  });

  it('a restore act names, in forgetReceived, only the networks that carry its space - and no forgetReceiveMarks', T, () => {
    twoNetworks();
    const { entry } = register({ kind: 'restore', localId: 'carried' });
    assert.equal(entry.kind, 'restore');
    assert.deepEqual(entry.postSteps.forgetReceived, [{ networkId: 'carries-it', localSpaceId: 'carried' }]);
    assert.equal(entry.postSteps.forgetReceiveMarks, undefined, 'a restore registered the every-mark step, which would forget what it sent');
  });

  it('control: a wipe act still names forgetReceiveMarks for the same network, and no forgetReceived', T, () => {
    twoNetworks();
    const { entry } = register({ kind: 'wipe', localId: 'carried' });
    assert.deepEqual(entry.postSteps.forgetReceiveMarks, [{ networkId: 'carries-it', localSpaceId: 'carried' }]);
    assert.equal(entry.postSteps.forgetReceived, undefined);
  });

  it('completing an entry that holds forgetReceived forgets the receive marks and keeps the three it sent', T, async () => {
    loader.mutateConfig(cfg => { cfg.networks = [{ ...netFixture('n-done-a', { spaces: ['done-a'] }), members: [member('peer-a', 'done-a')] }]; });
    const entry = await seedActEntry(loader, { kind: 'wipe', localId: 'done-a', postSteps: { forgetReceived: [{ networkId: 'n-done-a', localSpaceId: 'done-a' }] } });
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the act did not complete: ${JSON.stringify(settled)}`);
    const m = loader.getConfig().networks.find(n => n.id === 'n-done-a').members[0];
    assert.deepEqual(RECEIVED.filter(k => m[k]?.['done-a'] !== undefined), [], 'a receive mark survived forgetReceived');
    assert.deepEqual(SENT.filter(k => m[k]?.['done-a'] === undefined), [], 'forgetReceived forgot a mark this instance SENT');
  });

  it('control: completing an entry that holds the old forgetReceiveMarks still forgets every mark', T, async () => {
    loader.mutateConfig(cfg => { cfg.networks = [{ ...netFixture('n-done-b', { spaces: ['done-b'] }), members: [member('peer-b', 'done-b')] }]; });
    const entry = await seedActEntry(loader, { kind: 'wipe', localId: 'done-b', postSteps: { forgetReceiveMarks: [{ networkId: 'n-done-b', localSpaceId: 'done-b' }] } });
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the act did not complete: ${JSON.stringify(settled)}`);
    const m = loader.getConfig().networks.find(n => n.id === 'n-done-b').members[0];
    assert.deepEqual([...RECEIVED, ...SENT].filter(k => m[k]?.['done-b'] !== undefined), [], 'a mark survived the every-mark step');
  });
});
