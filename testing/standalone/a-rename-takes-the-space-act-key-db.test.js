/**
 * A rename is a space act: it takes the runner's key, so a deletion or wipe of the same space cannot race it (bundle-106 PR A, X3, W14).
 *
 * ## What the rule prevents
 *
 * v4 asked "is a wipe owed for this space" ONCE at the start of a rename and then moved the data. A wipe concluded while the rename's body ran
 * was registered for the OLD id and deleted under a running `moveSpaceData` (CH1): it wiped nothing, or the half-moved collections, and the act's
 * recorded space no longer existed. The rule: the rename registers an entry and runs through the runner, the wipe waits for the slot the rename
 * holds, the rename's commit rewrites every entry and round naming the old id (`applySpaceRenameToConfig`), the wipe reads its space from its ENTRY
 * when it starts, and so it wipes the NEW id; and a rename that meets a deletion or wipe of its space that stands refuses, in one sentence, on both doors.
 *
 * ## Rows
 *
 * - **R-X3:** a rename held in its body; a concluded wipe of the old id registered meanwhile. The wipe does not run while the rename holds the slot; after the
 *   commit its entry and its round's `actLocalId` name the new id, the standing predicate and the write closure cover the new id until the wipe completes, and the
 *   wipe empties the NEW id's collections.
 * - **R-W14:** a rename of a space with an owed wipe is refused with the owed-act sentence (and registers nothing that stays); an owed wipe whose space was deleted is
 *   completed as absent and its round settled.
 *
 * ## Red on the base
 *
 * The base has no runner and no entry, so the first import fails; after it exists the assertions are what each rule is held to. The hook used to latch
 * the rename's body is `atFileTree`, the design's seam at the body's file-tree step (§2.5).
 *
 * Run: `node --test testing/standalone/a-rename-takes-the-space-act-key-db.test.js` (test Mongo; a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import {
  clearActEntries, entriesOf, deferred, untilRunnerIdle, resetRunnerForTest, netFixture, passedSpaceRound, roundOf,
} from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const T = { timeout: 45_000 };

describe('a rename takes the space-act key', { skip }, () => {
  let door, loader, runner, lifecycle, renameMod, writers;

  before(async () => {
    door = await openToolDoor({ suite: 'actrename', spaces: ['ren-x', 'w14'].map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    renameMod = await import('../../server/dist/spaces/rename.js');
    writers = { fact: await import('../../server/dist/brain/fact.js') };
  });
  after(async () => { try { resetRunnerForTest(runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(async () => {
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    resetRunnerForTest(runner);
    clearActEntries(loader);
    loader.mutateConfig(cfg => { cfg.networks = []; });
  });
  afterEach(() => { try { resetRunnerForTest(runner); } catch { /* best effort */ } });

  const seed = async (space, n = 3) => {
    await door.coll(space, 'facts').deleteMany({});
    await door.coll(space, 'facts').insertMany(Array.from({ length: n }, (_, i) => ({ _id: `${space}-f${i}`, spaceId: space, fact: `fact ${i}`, tags: [], seq: i + 1 })));
  };
  const register = (req, now = Date.now()) => { let out; loader.mutateConfig(cfg => { out = runner.registerSpaceAct(cfg, req, now); }); return out; };

  it('R-X3: a wipe concluded while the rename\'s body runs waits for it, is rewritten to the new id by the rename\'s commit, closes the NEW id, and wipes it', T, async () => {
    await seed('ren-x');
    loader.mutateConfig(cfg => {
      cfg.networks = [netFixture('n1', { spaces: ['ren-x'], rounds: [passedSpaceRound('w1', 'space_wipe', 'ren-x', { actLocalId: 'ren-x' })] })];
    });
    const hold = deferred();
    let sawAtCompletion;
    runner.setSpaceActHooksForTest({
      atFileTree: async () => { if (!hold.released) { hold.released = true; hold.arrive(); await hold.promise; } },
      beforeComplete: async () => {
        const entry = entriesOf(loader).find(e => e.kind === 'wipe');
        const refused = await writers.fact.saveFact('ren-y', 'a write while the wipe of the new id stands', [], [], undefined, undefined, 'note').then(() => null, err => err);
        sawAtCompletion = { localId: entry?.localId, actLocalId: roundOf(loader, 'n1', 'w1')?.actLocalId, refused: refused?.code };
      },
    });
    const rename = register({ kind: 'rename', localId: 'ren-x', newId: 'ren-y' });
    const renaming = runner.runSpaceAct(rename.entry.id);
    await hold.reached;
    const wipe = register({ kind: 'wipe', localId: 'ren-x', round: { networkId: 'n1', roundId: 'w1' } });
    assert.equal(wipe.joined, false, 'a wipe joined a rename');
    const wiping = runner.runSpaceAct(wipe.entry.id);
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
    assert.equal(runner.spaceActBodyRuns().wipe, 0, 'the wipe ran under the rename\'s running body');
    await assert.rejects(writers.fact.saveFact('ren-x', 'while the rename runs', [], [], undefined, undefined, 'note'), /renamed|being|takes no/i, 'the old id took a write while a rename and a wipe stand for it');
    hold.release();
    const [renamed, wiped] = [await renaming, await wiping];
    assert.equal(renamed.ok, true, JSON.stringify(renamed)); assert.equal(wiped.ok, true, JSON.stringify(wiped));
    assert.ok(loader.getConfig().spaces.some(s => s.id === 'ren-y'), 'the rename did not commit');
    assert.deepEqual(sawAtCompletion, { localId: 'ren-y', actLocalId: 'ren-y', refused: 'space_being_wiped' },
      'the rename\'s commit did not rewrite the wipe entry and the round\'s actLocalId to the new id, or the new id was not closed at the completion');
    assert.equal(await door.coll('ren-y', 'facts').countDocuments({}), 0, 'the wipe did not empty the renamed space');
    assert.equal(roundOf(loader, 'n1', 'w1')?.appliedHere, true);
    assert.deepEqual(entriesOf(loader), []);
  });

  it('R-W14: a rename of a space with an owed wipe is refused with the owed-act sentence, on the act both doors share; deleting the space completes the owed wipe as absent', T, async () => {
    await seed('w14');
    loader.mutateConfig(cfg => {
      cfg.networks = [netFixture('n1', { spaces: ['w14'], rounds: [passedSpaceRound('w1', 'space_wipe', 'w14')] })];
    });
    runner.setSpaceActHooksForTest({ atFileTree: () => { throw new Error('the tree cannot be removed'); } });
    const wipe = register({ kind: 'wipe', localId: 'w14', round: { networkId: 'n1', roundId: 'w1' } });
    assert.equal((await runner.runSpaceAct(wipe.entry.id)).ok, false);
    runner.setSpaceActHooksForTest(null);
    const refusal = await renameMod.renameSpaceAct('w14', { newId: 'w14b' });
    assert.ok(refusal.status >= 400 && refusal.status < 500, `the rename of a space with an owed wipe answered ${refusal.status}: ${refusal.error ?? ''}`);
    assert.match(String(refusal.error), /cannot be renamed while a deletion or wipe of it is owed or running/);
    assert.match(String(refusal.error), /owedSpaceActs/, 'the refusal does not say where the owed act is listed');
    assert.ok(loader.getConfig().spaces.some(s => s.id === 'w14') && !loader.getConfig().spaces.some(s => s.id === 'w14b'), 'the refused rename moved the space');
    assert.deepEqual(entriesOf(loader).map(e => e.kind), ['wipe'], 'the refused rename left an entry of its own behind');
    // The way out: delete the space. Its completion removes the owed wipe's entry and settles its round (nothing to wipe).
    assert.equal(await lifecycle.removeSpace('w14'), true);
    await untilRunnerIdle(runner, loader);
    assert.deepEqual(entriesOf(loader), [], 'the deletion left the wipe of a space that no longer exists owed');
    assert.equal(roundOf(loader, 'n1', 'w1')?.appliedHere, true, 'the round of the wipe of a deleted space was not settled');
  });
});
