/**
 * The space-act runner: an act is REGISTERED durably, keyed, run once in the slot, completed in one write, retried when it fails, and
 * stopped without a failure at shutdown (bundle-106 PR A, X1, X4, X6, X9, W2, W3, W6, W8, W15, W16, R7-a, VR15).
 *
 * ## What the rows assert, and what each is red for on the base
 *
 * The base has no runner: a wipe runs inline, a removal and a rename count themselves in a depth counter, a queued act exists only in memory
 * and closes nothing, a wipe that fails leaves nothing owed, and a deletion of one space from two networks has no key to be told apart by.
 * Every test imports the design's runner (`spaces/space-act-runner.ts`, §2.5) in `beforeEach`, so on the base each is red for exactly that:
 * the module is not there. Once it is, the assertions below are what each rule is held to.
 *
 * Hooks run INSIDE the real bodies (`setSpaceActHooksForTest`: `beforeBatch(collection, n)`, `atFileTree`, `beforeComplete`, …) — nothing replaces
 * a body, so the drain, the batches, the bounds, the entry and the completion run in every row. A "slow" act is a latch the test releases; a
 * "failing" act is a hook that throws; ordering is a shared event log, never a timestamp or a sleep. `collection` in `beforeBatch` is read as the
 * full collection name (`<space>_facts`), which is how the design's seam lists it.
 *
 * ## Rows
 *
 * - **R7-a / R7-a2 / R7-a3 / R-VR15 (runner half):** the same key joins and the body runs once; two spaces' bodies are serial in one slot; a
 *   deletion requested while a wipe of the same space runs is its own entry, runs AFTER it and is not merged; a delete retried after completion finds the space gone.
 * - **R-X4a / R-X4b / R-W15:** a deletion's key carries its network (two networks, two entries, the own copy removed once); a round that joins a running wipe is
 *   on disk in the same write; after a crash before completion the resume settles BOTH rounds and the wipe body runs once after the restart.
 * - **R-X1a (closure and restart) / R-X1b / R-X1c / R-X1d:** closed at registration while another space's body holds the slot; the entry is on disk and resumed after a
 *   restart; a failing `files` wipe and a completed `facts` wipe of one space are two entries; a stale `pendingSpaceOp` of one space does not make a
 *   rename and a delete of others refuse while a wipe of a third runs (the stand-aside asks by KEY).
 * - **R-W2a / R-W3 / R-W6a / R-W6b / R-W8:** a failed tree removal leaves the act owed with the space closed, others unaffected, and the tick completes it; a reload does
 *   not start a second run; a slow act is answered `202 queued` and finishes; a bounded operation that makes no progress fails into owed (no hang);
 *   shutdown closes the runner, answers `503`, and a fresh boot finishes the wipe and audits it.
 * - **R-X6a / R-X6b:** a batch the bound ended after earlier batches made progress is retried, not failed; a file-tree step that never resolves fails the attempt at its bound and frees the slot.
 * - **R-X9a / R-X9c / R-X9d:** a body that throws at the resume after listen is left owed and the tick retries; a body failing after `closeSpaceActs()` is `interrupted`,
 *   never `failed`; a door retry of an owed act before `retryAt` is `202 queued` with `retryAt` and starts nothing.
 * - **R-W16 (the runner's gauges, and a slow act's report from the round-expiry tick) and the completion's ONE write** (the driven half of `every-act-entry-is-cleared-with-its-post-steps`).
 *
 * ## Controls that pass once the runner exists, on purpose
 *
 * The basic register-run-complete test and the AM3 boot (a stale `pendingSpaceOp` delete resumed in phase 1 while an act entry of another space is left
 * alone) say the harness is a harness: they fail only for the runner's absence now and would pass for the wrong reason if a later assertion were relaxed.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-space-act-runner-runs-registers-and-retries-db.test.js` (a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import {
  actEntry, seedActEntry, clearActEntries, entriesOf, deferred, eventLog, untilRunnerIdle, resetRunnerForTest,
  netFixture, passedSpaceRound, roundOf, metricSample, auditRowsOf,
} from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const T = { timeout: 45_000 };
const SPACES = ['wipe-a', 'wipe-b', 'other-a', 'other-b', 'del-a', 'del-b', 'del-c', 'two-nets', 'files-a', 'stuck', 'ren-c', 'del-d', 'big-a', 'gone-a', 'boot-a', 'am3-del', 'am3-wipe', 'late-a', 'closing-a', 'gauge-a', 'ren-d', 'del-e'];

describe('the space-act runner registers, runs once, completes in one write, retries and stops without a failure', { skip }, () => {
  let door, loader, runner, lifecycle, renameMod, files, writers;

  before(async () => {
    door = await openToolDoor({ suite: 'actrunner', spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    renameMod = await import('../../server/dist/spaces/rename.js');
    files = await import('../../server/dist/files/files.js');
    writers = { fact: await import('../../server/dist/brain/fact.js') };
  });
  after(async () => {
    try { resetRunnerForTest(runner); } catch { /* the runner never loaded */ }
    await door?.close();
  });
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
  const factCount = (space) => door.coll(space, 'facts').countDocuments({});
  const register = (req, now = Date.now()) => { let out; loader.mutateConfig(cfg => { out = runner.registerSpaceAct(cfg, req, now); }); return out; };
  const resume = () => (runner.resumeSpaceActs ?? lifecycle.resumeSpaceActs)();
  const isOf = (collection, space) => String(collection).startsWith(`${space}_`);
  const fromDisk = () => JSON.parse(fs.readFileSync(process.env['CONFIG_PATH'], 'utf8'));
  /** What a restart does to the module state and the config: the in-process boot keeps both, so both are reset by hand. */
  const restart = async () => { await loader.flushConfig(); runner.reopenSpaceActsForTest(); loader.loadConfig(); };
  const settledOk = async (promise) => { const r = await promise; assert.equal(r.ok, true, `the act did not complete: ${JSON.stringify(r)}`); return r; };

  it('control: a registered wipe is on the handed config, runs once through the real body, and its entry is gone when it completes', T, async () => {
    await seed('wipe-a');
    const { entry, joined } = register({ kind: 'wipe', localId: 'wipe-a' });
    assert.equal(joined, false);
    assert.deepEqual(entriesOf(loader).map(e => e.id), [entry.id], 'registration did not put the entry on the config it was handed');
    assert.ok(['registered', 'draining', 'running'].includes(entry.state), `a fresh entry is in state '${entry.state}'`);
    await settledOk(runner.runSpaceAct(entry.id));
    assert.equal(await factCount('wipe-a'), 0);
    assert.deepEqual(entriesOf(loader), [], 'the entry outlived its completion');
    assert.equal(runner.spaceActBodyRuns().wipe, 1);
    assert.equal(runner.spaceActsRunning(), 0);
  });

  it('R7-a: two requests for the same deletion join one entry and the real body runs ONCE; nothing is left running', T, async () => {
    await seed('del-a');
    const first = register({ kind: 'delete', localId: 'del-a' });
    const second = register({ kind: 'delete', localId: 'del-a' });
    assert.equal(second.joined, true, 'an identical request did not join the standing entry');
    assert.equal(second.entry.id, first.entry.id);
    const [a, b] = await Promise.all([runner.runSpaceAct(first.entry.id), runner.runSpaceAct(second.entry.id)]);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(runner.spaceActBodyRuns().delete, 1, 'the deletion body ran more than once');
    assert.equal(runner.spaceActRunning('del-a'), false);
    assert.ok(!loader.getConfig().spaces.some(s => s.id === 'del-a'), 'the space is still configured');
    assert.deepEqual(entriesOf(loader), []);
  });

  it('R7-a2: two different spaces removed at once are both removed, one body at a time in the one slot', T, async () => {
    await seed('del-b'); await seed('del-c');
    let overlap = 0; let running = 0;
    runner.setSpaceActHooksForTest({ atFileTree: async () => { running = runner.spaceActsRunning(); overlap = Math.max(overlap, running); await new Promise(r => setImmediate(r)); } });
    const a = register({ kind: 'delete', localId: 'del-b' });
    const b = register({ kind: 'delete', localId: 'del-c' });
    assert.notEqual(a.entry.id, b.entry.id);
    const results = await Promise.all([runner.runSpaceAct(a.entry.id), runner.runSpaceAct(b.entry.id)]);
    for (const r of results) assert.equal(r.ok, true, `a removal failed beside another: ${JSON.stringify(r)}`);
    assert.ok(overlap >= 1, 'the file-tree hook never ran: the bodies were not observed');
    assert.equal(overlap, 1, 'two bodies were in the slot at once');
    for (const id of ['del-b', 'del-c']) assert.ok(!loader.getConfig().spaces.some(s => s.id === id), `${id} is still configured`);
  });

  it('R7-a3: a deletion requested while a wipe of the same space runs is its own entry, runs AFTER the wipe, and is not merged into it', T, async () => {
    await seed('del-d');
    const log = eventLog(); const hold = deferred();
    runner.setSpaceActHooksForTest({
      beforeBatch: async (collection) => { if (isOf(collection, 'del-d')) { log.mark('wipe:batch'); hold.arrive(); await hold.promise; } },
      beforeComplete: () => log.mark('beforeComplete'),
      atFileTree: () => log.mark('tree'),
    });
    const wipe = register({ kind: 'wipe', localId: 'del-d' });
    const wiping = runner.runSpaceAct(wipe.entry.id);
    await hold.reached;
    const del = register({ kind: 'delete', localId: 'del-d' });
    assert.equal(del.joined, false, 'a deletion joined a wipe of the same space');
    assert.notEqual(del.entry.id, wipe.entry.id);
    const deleting = runner.runSpaceAct(del.entry.id);
    hold.release();
    await settledOk(wiping); await settledOk(deleting);
    const names = log.names();
    assert.ok(names.includes('beforeComplete'), 'the wipe never reached its completion');
    assert.ok(names.lastIndexOf('tree') > names.indexOf('beforeComplete'), `the deletion's body started before the wipe completed: ${names.join(' < ')}`);
    assert.equal(runner.spaceActBodyRuns().wipe, 1); assert.equal(runner.spaceActBodyRuns().delete, 1);
    assert.ok(!loader.getConfig().spaces.some(s => s.id === 'del-d'));
  });

  it('R-VR15 (runner half): a DELETE retried after it completed finds the space gone', T, async () => {
    await seed('gone-a');
    const first = register({ kind: 'delete', localId: 'gone-a' });
    await settledOk(runner.runSpaceAct(first.entry.id));
    assert.equal(await lifecycle.removeSpace('gone-a'), false, 'a delete after completion did not answer "no such space" (the door\'s 404)');
    assert.deepEqual(entriesOf(loader), [], 'a delete of a space that is gone left an entry');
  });

  it('R-X4a: two networks\' deletions of one space are two entries (the key carries the network); the own copy is removed once', T, async () => {
    await seed('two-nets');
    loader.mutateConfig(cfg => {
      cfg.networks = [
        netFixture('n1', { spaces: ['two-nets'], rounds: [passedSpaceRound('r1', 'space_deletion', 'two-nets')] }),
        netFixture('n2', { spaces: ['two-nets'], rounds: [passedSpaceRound('r2', 'space_deletion', 'two-nets')] }),
      ];
    });
    const a = register({ kind: 'delete', localId: 'two-nets', networkId: 'n1', round: { networkId: 'n1', roundId: 'r1' } });
    const b = register({ kind: 'delete', localId: 'two-nets', networkId: 'n2', round: { networkId: 'n2', roundId: 'r2' } });
    assert.equal(b.joined, false, 'N2\'s deletion joined N1\'s job: its network half would never run');
    assert.notEqual(a.entry.id, b.entry.id);
    const c = register({ kind: 'delete', localId: 'two-nets', networkId: 'n1', round: { networkId: 'n1', roundId: 'r1' } });
    assert.equal(c.joined, true, 'the same network\'s identical deletion did not join');
    const results = await Promise.all([runner.runSpaceAct(a.entry.id), runner.runSpaceAct(b.entry.id)]);
    for (const r of results) assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(results.filter(r => r.removedHere === true).length, 1, 'the own copy was removed by more or fewer than one job');
    assert.ok(!loader.getConfig().spaces.some(s => s.id === 'two-nets'));
    for (const [n, r] of [['n1', 'r1'], ['n2', 'r2']]) assert.equal(roundOf(loader, n, r)?.appliedHere, true, `round ${r} of ${n} was not settled`);
    assert.deepEqual(entriesOf(loader), []);
  });

  it('R-X4b and R-W15: a round that joins a running wipe is on disk in the same write; after a crash before completion the resume settles BOTH and the body runs once', T, async () => {
    await seed('wipe-b');
    loader.mutateConfig(cfg => {
      cfg.networks = [netFixture('n1', { spaces: ['wipe-b'], rounds: [passedSpaceRound('w1', 'space_wipe', 'wipe-b')] }),
        netFixture('n2', { spaces: ['wipe-b'], rounds: [passedSpaceRound('w2', 'space_wipe', 'wipe-b')] })];
    });
    const crash = deferred();
    runner.setSpaceActHooksForTest({ beforeComplete: async () => { crash.arrive(); await crash.promise; throw new Error('crash after the deletes'); } });
    const first = register({ kind: 'wipe', localId: 'wipe-b', round: { networkId: 'n1', roundId: 'w1' } });
    const running = runner.runSpaceAct(first.entry.id);
    await crash.reached;
    assert.equal(await factCount('wipe-b'), 0, 'the deletes had not happened before the completion');
    const joined = register({ kind: 'wipe', localId: 'wipe-b', round: { networkId: 'n2', roundId: 'w2' } });
    assert.equal(joined.joined, true, 'a wipe of the same space and types did not join the running job');
    await loader.flushConfig();
    const onDisk = fromDisk().pendingSpaceActs;
    assert.deepEqual(onDisk[0].rounds.map(r => r.roundId).sort(), ['w1', 'w2'], 'the joining round was not on disk in the write that joined it');
    runner.closeSpaceActs();
    crash.release();
    await running;
    // The crash: a new process reads the config from disk and resumes after listen.
    runner.setSpaceActHooksForTest(null);
    await restart();
    await resume();
    await untilRunnerIdle(runner, loader);
    assert.equal(runner.spaceActBodyRuns().wipe, 1, 'the wipe body ran other than once after the restart');
    for (const [n, r] of [['n1', 'w1'], ['n2', 'w2']]) assert.equal(roundOf(loader, n, r)?.appliedHere, true, `round ${r} was not completed by the resume`);
    assert.deepEqual(entriesOf(loader), []);
  });

  it('R-X1a: registered while another space\'s body holds the slot, the space is closed at once, the entry is on disk, and writes reopen only at the completion', T, async () => {
    await seed('other-a'); await seed('closing-a');
    const hold = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async (collection) => { if (isOf(collection, 'other-a')) { hold.arrive(); await hold.promise; } } });
    const busy = register({ kind: 'wipe', localId: 'other-a' });
    const busyRun = runner.runSpaceAct(busy.entry.id);
    await hold.reached;
    const mine = register({ kind: 'wipe', localId: 'closing-a' });
    const mineRun = runner.runSpaceAct(mine.entry.id);
    await loader.flushConfig();
    assert.ok(fromDisk().pendingSpaceActs.some(e => e.id === mine.entry.id), 'the entry is not on disk although its act was registered');
    await assert.rejects(writers.fact.saveFact('closing-a', 'late write', [], [], undefined, undefined, 'note'), /being wiped|takes no/i, 'a write landed in a space whose wipe is registered and queued behind another body');
    assert.equal(runner.spaceActRunning('closing-a'), false, 'the queued act ran while another body held the slot');
    hold.release();
    await settledOk(busyRun); await settledOk(mineRun);
    assert.equal(await factCount('closing-a'), 0, 'the wipe did not delete what was there');
    await writers.fact.saveFact('closing-a', 'after the wipe', [], [], undefined, undefined, 'note');
    assert.equal(await factCount('closing-a'), 1, 'the space did not take writes again after the completion');
  });

  it('R-X1a (restart): an entry that was only registered is on disk, closes the space on the next boot before anything resumes, and is resumed after listen', T, async () => {
    await seed('late-a');
    register({ kind: 'wipe', localId: 'late-a' });
    await restart();
    await assert.rejects(writers.fact.saveFact('late-a', 'before the resume', [], [], undefined, undefined, 'note'), /being wiped|takes no/i, 'the restarted instance took a write before its entry resumed');
    assert.equal(await factCount('late-a'), 3, 'something deleted the data before the resume (nothing may run before listen)');
    await resume();
    await untilRunnerIdle(runner, loader);
    assert.equal(await factCount('late-a'), 0, 'the resume did not finish the wipe');
    assert.deepEqual(entriesOf(loader), []);
  });

  it('R-X1c: a failing files wipe and a completed facts wipe of one space are two entries; the files entry keeps file writes closed', T, async () => {
    await seed('files-a');
    runner.setSpaceActHooksForTest({ atFileTree: () => { throw new Error('the tree cannot be removed'); } });
    const filesWipe = register({ kind: 'wipe', localId: 'files-a', types: ['files'] });
    const failed = await runner.runSpaceAct(filesWipe.entry.id);
    assert.equal(failed.ok, false, 'a wipe whose tree removal throws reported success');
    runner.setSpaceActHooksForTest(null);
    const factsWipe = register({ kind: 'wipe', localId: 'files-a', types: ['facts'] });
    assert.notEqual(factsWipe.entry.id, filesWipe.entry.id, 'a wipe of other types joined the failed one: one entry per space (DI S6)');
    await settledOk(runner.runSpaceAct(factsWipe.entry.id));
    const left = entriesOf(loader);
    assert.deepEqual(left.map(e => e.id), [filesWipe.entry.id], 'completing the facts wipe erased the files debt (or left its own)');
    assert.deepEqual(left[0].types, ['files']);
    assert.equal(left[0].state, 'owed');
    await assert.rejects(files.writeFile('files-a', 'x.txt', 'x'), /takes no more file writes|being wiped/i, 'the owed files wipe no longer closes file writes');
    await writers.fact.saveFact('files-a', 'a fact after the facts wipe', [], [], undefined, undefined, 'note');
  });

  it('R-X1d: a stale pendingSpaceOp does not make a rename and a delete of other spaces refuse while a wipe of a third space runs (the stand-aside asks by key)', T, async () => {
    await seed('big-a'); await seed('stuck');
    const hold = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async (collection) => { if (isOf(collection, 'big-a')) { hold.arrive(); await hold.promise; } } });
    loader.mutateConfig(cfg => { cfg.pendingSpaceOp = { type: 'delete', spaceId: 'stuck', startedAt: '2026-10-16T00:00:00.000Z' }; });
    const wipe = register({ kind: 'wipe', localId: 'big-a' });
    const wiping = runner.runSpaceAct(wipe.entry.id);
    await hold.reached;
    const renamed = await renameMod.renameSpace('ren-c', 'ren-c2');
    assert.equal(renamed.id, 'ren-c2', 'a rename was refused behind a wipe of an unrelated space');
    // The rename met the stale marker and, asking by key, found its op not running: it finished that delete before its own body.
    assert.ok(!loader.getConfig().spaces.some(s => s.id === 'stuck'), 'the stale delete of another space was not finished by the next space op');
    assert.equal(await lifecycle.removeSpace('del-e'), true, 'a delete of a third space was refused behind a wipe of an unrelated space');
    assert.equal(runner.spaceActRunning('big-a'), true, 'the wipe was no longer running when the rename and the delete finished: the row proved nothing');
    hold.release();
    await settledOk(wiping);
    assert.ok(!loader.getConfig().pendingSpaceOp, 'the stale marker is still there');
  });

  it('R-W2a: a wipe whose tree removal fails is OWED, keeps the space closed to record and file writes, leaves other spaces\' rename and delete alone, and the tick completes it', T, async () => {
    await seed('wipe-a'); await seed('other-b');
    // Scoped to the wiped space: the rename and the delete below run file-tree steps of their own, which must not fail with it.
    runner.setSpaceActHooksForTest({ atFileTree: (localId) => { if (localId === 'wipe-a') throw new Error('EACCES under the tree'); } });
    const { entry } = register({ kind: 'wipe', localId: 'wipe-a' });
    const failed = await runner.runSpaceAct(entry.id);
    assert.equal(failed.ok, false);
    const owed = entriesOf(loader)[0];
    assert.equal(owed.state, 'owed'); assert.equal(owed.attempts, 1); assert.ok(Date.parse(owed.retryAt) > Date.now(), 'the retry is not in the future');
    assert.doesNotMatch(String(owed.lastError), /EACCES/, 'the stored sentence carries the failure\'s own text');
    await assert.rejects(writers.fact.saveFact('wipe-a', 'while owed', [], [], undefined, undefined, 'note'), /being wiped|takes no/i);
    await assert.rejects(files.writeFile('wipe-a', 'owed.txt', 'x'), /takes no more file writes|being wiped/i);
    const mcp = await door.call('save_fact', { space: 'wipe-a', fact: 'closed' }, { transport: 'mcp' });
    assert.equal(mcp.status, 409, `MCP answered ${mcp.status}: ${mcp.text}`);
    assert.equal((await renameMod.renameSpace('ren-d', 'ren-d2')).id, 'ren-d2', 'an owed wipe blocked the instance\'s other renames');
    assert.equal(await lifecycle.removeSpace('other-b'), true, 'an owed wipe blocked the instance\'s other deletes');
    runner.setSpaceActHooksForTest(null);
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    const at = Date.parse(owed.retryAt) + 1000;
    runRoundExpiryTick(at);
    await untilRunnerIdle(runner, loader, { now: at });
    assert.deepEqual(entriesOf(loader), [], 'the tick at retryAt did not complete the owed wipe');
    await writers.fact.saveFact('wipe-a', 'after the retry', [], [], undefined, undefined, 'note');
  });

  it('R-W3: a reload while a runner wipe is slowed starts no second run and logs no resume', T, async () => {
    await seed('wipe-b');
    const hold = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async (collection) => { if (isOf(collection, 'wipe-b')) { hold.arrive(); await hold.promise; } } });
    const { entry } = register({ kind: 'wipe', localId: 'wipe-b' });
    const running = runner.runSpaceAct(entry.id);
    await hold.reached;
    const { lines } = await logLinesDuring(() => lifecycle.reconcilePendingSpaceOp());
    assert.deepEqual(lines.filter(l => /Resuming interrupted/.test(l)), [], 'the reload path resumed an act the runner is running');
    hold.release();
    await settledOk(running);
    assert.equal(runner.spaceActBodyRuns().wipe, 1, 'the reload started a second wipe body');
  });

  it('R-W6a: an act that outlasts the door\'s budget is answered 202 queued, completes after, and its completion is audited because the door had answered', T, async () => {
    await seed('wipe-a');
    runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 25 });
    assert.equal(runner.spaceActAnswerMs(), 25, 'the answer budget is not read through the knob');
    const hold = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async (collection) => { if (isOf(collection, 'wipe-a')) { hold.arrive(); await hold.promise; } } });
    const answered = await door.call('delete_space_data', { space: 'wipe-a', confirm: true });
    await hold.reached;
    // An unnetworked wipe is not a vote: queued says `queued`, never `status: 'passed'` (an-unnetworked-act-is-not-a-vote-db holds the whole shape).
    assert.equal(answered.structured?.queued, true, `the door answered ${JSON.stringify(answered.structured)} / ${answered.text}`);
    assert.equal(answered.structured?.status, undefined, `an unnetworked wipe was answered as a vote that passed: ${JSON.stringify(answered.structured)}`);
    hold.release();
    await untilRunnerIdle(runner, loader);
    assert.equal(await factCount('wipe-a'), 0, 'the queued wipe did not complete');
    const audited = await auditRowsOf(door.mongo, 'space.act_completed');
    assert.ok(audited.length >= 1, 'a completion after the door answered was not audited as space.act_completed');
  });

  it('R-W6b: a bounded operation that ends with no progress FAILS the attempt into owed — the run answers, it does not hang', T, async () => {
    await seed('wipe-b');
    runner.setSpaceActKnobsForTest({ SPACE_ACT_OP_MS: 40, SPACE_ACT_BATCH: 10 });
    runner.setSpaceActHooksForTest({ beforeBatch: (collection) => (isOf(collection, 'wipe-b') ? new Promise(() => {}) : undefined) });
    const { entry } = register({ kind: 'wipe', localId: 'wipe-b' });
    const r = await runner.runSpaceAct(entry.id);
    assert.equal(r.ok, false, 'an operation the bound ended with nothing deleted reported success');
    const owed = entriesOf(loader)[0];
    assert.equal(owed?.state, 'owed'); assert.equal(owed?.attempts, 1);
    assert.equal(runner.spaceActsRunning(), 0, 'the slot was not released');
  });

  it('R-X6a: a batch the bound ended after earlier batches made progress is retried inside the attempt — no failure is counted and the wipe completes', T, async () => {
    await seed('big-a', 35);
    runner.setSpaceActKnobsForTest({ SPACE_ACT_BATCH: 10, SPACE_ACT_OP_MS: 40 });
    let call = 0; let hung = false;
    runner.setSpaceActHooksForTest({ beforeBatch: (collection) => {
      if (!isOf(collection, 'big-a')) return undefined;
      return (call++ === 2 && !hung && (hung = true)) ? new Promise(() => {}) : undefined;
    } });
    const failedBefore = await metricSample('ythril_space_acts_total', { outcome: 'failed' });
    const retriedBefore = await metricSample('ythril_space_act_batches_retried_total');
    const { entry } = register({ kind: 'wipe', localId: 'big-a' });
    await settledOk(runner.runSpaceAct(entry.id));
    assert.equal(hung, true, 'the hook never held a batch past the bound: the row proved nothing');
    assert.equal(await factCount('big-a'), 0);
    assert.equal(await metricSample('ythril_space_acts_total', { outcome: 'failed' }), failedBefore, 'a bound-ended batch that had made progress counted a failure');
    assert.equal(await metricSample('ythril_space_act_batches_retried_total'), retriedBefore + 1, 'the re-run of the bound-ended batch is not counted');
  });

  it('R-X6b: a file-tree step that never resolves fails the attempt at its own bound, frees the slot, and another space\'s act runs meanwhile', T, async () => {
    await seed('files-a'); await seed('wipe-a');
    runner.setSpaceActKnobsForTest({ SPACE_ACT_FS_MS: 40 });
    let hung = false;   // the first act's tree step hangs; the second act (another space) must not
    runner.setSpaceActHooksForTest({ atFileTree: () => (hung ? undefined : ((hung = true), new Promise(() => {}))) });
    const stuck = register({ kind: 'wipe', localId: 'files-a' });
    const r = await runner.runSpaceAct(stuck.entry.id);
    assert.equal(r.ok, false, 'a tree removal that never returned was waited for ever or reported success');
    assert.equal(runner.spaceActsRunning(), 0, 'the slot is still held by the stuck tree removal');
    const other = register({ kind: 'wipe', localId: 'wipe-a' });
    await settledOk(runner.runSpaceAct(other.entry.id));
    assert.equal(await factCount('wipe-a'), 0);
  });

  it('R-X9a: boot after a crash — an entry whose body throws is left OWED by the resume (which does not throw), and the tick completes it once the cause is gone', T, async () => {
    await seed('boot-a');
    register({ kind: 'wipe', localId: 'boot-a' });
    runner.setSpaceActHooksForTest({ beforeBatch: () => { throw new Error('the store refused'); } });
    await restart();
    await resume();
    await untilRunnerIdle(runner, loader);
    const owed = entriesOf(loader)[0];
    assert.equal(owed?.state, 'owed', 'the entry was dropped or left registered after a failing resume');
    assert.equal(owed?.attempts, 1);
    runner.setSpaceActHooksForTest(null);
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    const at = Date.parse(owed.retryAt) + 1000;
    runRoundExpiryTick(at);
    await untilRunnerIdle(runner, loader, { now: at });
    assert.deepEqual(entriesOf(loader), []);
    assert.equal(await factCount('boot-a'), 0);
  });

  it('AM3 control: phase 1 resumes a pendingSpaceOp delete and leaves a standing wipe entry of another space alone, running no wipe body', T, async () => {
    await seed('am3-del'); await seed('am3-wipe');
    const standing = await seedActEntry(loader, { kind: 'wipe', localId: 'am3-wipe', state: 'registered' });
    loader.mutateConfig(cfg => { cfg.pendingSpaceOp = { type: 'delete', spaceId: 'am3-del', startedAt: '2026-10-16T00:00:00.000Z' }; });
    await lifecycle.reconcilePendingSpaceOp();
    assert.ok(!loader.getConfig().spaces.some(s => s.id === 'am3-del'), 'the stale delete was not completed in phase 1');
    assert.equal(loader.getConfig().pendingSpaceOp, undefined);
    assert.deepEqual(entriesOf(loader), [structuredClone(standing)], 'phase 1 touched an act entry (those resume only after listen)');
    assert.equal(runner.spaceActBodyRuns().wipe, 0);
    assert.equal(await factCount('am3-wipe'), 3);
  });

  it('R-X9c, R-W8 and R-X1b: shutdown refuses new acts (503) and lists what is left; a body that fails after it is `interrupted`, never `failed`; the entry is unchanged on disk and a fresh boot completes it, audited', T, async () => {
    await seed('wipe-a');
    runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 25 });
    const hold = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async (collection) => { if (isOf(collection, 'wipe-a')) { hold.arrive(); await hold.promise; throw new Error('the store closed under the body'); } } });
    const answered = await door.call('delete_space_data', { space: 'wipe-a', confirm: true });
    assert.equal(answered.structured?.queued, true, `the door did not queue: ${answered.text}`);
    await hold.reached;
    const { left } = runner.closeSpaceActs();
    assert.ok(left.some(l => l.kind === 'wipe' && l.localId === 'wipe-a'), `closeSpaceActs did not list the running wipe: ${JSON.stringify(left)}`);
    const refused = await door.call('delete_space_data', { space: 'other-a', confirm: true });
    assert.equal(refused.status, 503, `a door reaching a closed runner answered ${refused.status}: ${refused.text}`);
    assert.match(JSON.stringify(refused.structured ?? refused.text), /shutting down/i);
    const failedBefore = await metricSample('ythril_space_acts_total', { outcome: 'failed' });
    const interruptedBefore = await metricSample('ythril_space_acts_total', { outcome: 'interrupted' });
    const before = entriesOf(loader);
    hold.release();
    await new Promise(r => setImmediate(r));
    while (runner.spaceActsRunning() > 0) await new Promise(r => setImmediate(r));
    assert.deepEqual(entriesOf(loader), before, 'a body failing after shutdown rewrote its entry (attempts, retryAt or state)');
    assert.equal(entriesOf(loader)[0].attempts, 0);
    assert.equal(await metricSample('ythril_space_acts_total', { outcome: 'failed' }), failedBefore, 'a failure after shutdown was counted as failed');
    assert.equal(await metricSample('ythril_space_acts_total', { outcome: 'interrupted' }), interruptedBefore + 1, 'the interruption was not counted');
    runner.setSpaceActHooksForTest(null);
    await restart();
    await resume();
    await untilRunnerIdle(runner, loader);
    assert.equal(await factCount('wipe-a'), 0, 'the fresh boot did not finish the wipe');
    assert.deepEqual(entriesOf(loader), []);
    assert.ok((await auditRowsOf(door.mongo, 'space.act_completed')).length >= 1, 'the completion at boot was not audited');
  });

  it('R-X9d: a door retry of an owed act before its retryAt is answered 202 queued with retryAt and starts no body', T, async () => {
    await seed('wipe-b');
    runner.setSpaceActHooksForTest({ beforeBatch: (collection) => { if (isOf(collection, 'wipe-b')) throw new Error('first attempt fails'); } });
    const { entry } = register({ kind: 'wipe', localId: 'wipe-b' });
    await runner.runSpaceAct(entry.id);
    const owed = entriesOf(loader)[0];
    assert.equal(owed.state, 'owed');
    assert.ok(Date.parse(owed.retryAt) > Date.now());
    const runsBefore = runner.spaceActBodyRuns().wipe;
    runner.setSpaceActHooksForTest(null);
    const retry = await door.call('delete_space_data', { space: 'wipe-b', confirm: true });
    // Unnetworked, so no vote: `queued` with its `retryAt`, and no `status: 'passed'`.
    assert.equal(retry.structured?.queued, true, `the retry was answered ${JSON.stringify(retry.structured)} / ${retry.text}`);
    assert.equal(retry.structured?.status, undefined, `an unnetworked retry was answered as a vote that passed: ${JSON.stringify(retry.structured)}`);
    assert.equal(typeof retry.structured?.retryAt, 'string', 'the retry answer does not say when the instance will retry');
    assert.equal(runner.spaceActBodyRuns().wipe, runsBefore, 'a door retry started the act before its retryAt');
    assert.equal(entriesOf(loader)[0].attempts, 1, 'a door retry before retryAt counted an attempt');
  });

  it('R-W16 (a slow act): the round-expiry tick reports an act running past SLOW_SPACE_ACT_MS once per window and never cuts it', T, async () => {
    // `reportSlowSpaceActs` was exported and never called, so an act stuck mid-body ran for hours and nothing said so. The tick is the one clock
    // the runner has (it also starts the owed retries), so the report is asked from there.
    await seed('wipe-a');
    const hold = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async (collection) => { if (isOf(collection, 'wipe-a')) { hold.arrive(); await hold.promise; } } });
    runner.setSpaceActKnobsForTest({ SLOW_SPACE_ACT_MS: 1000 });
    assert.equal(runner.spaceActKnob('SLOW_SPACE_ACT_MS'), 1000, 'the slow bound is not read through the knob');
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    const { entry } = register({ kind: 'wipe', localId: 'wipe-a' });
    const running = runner.runSpaceAct(entry.id);
    await hold.reached;
    const slowLine = (lines) => lines.filter(l => /wipe of 'wipe-a' has been running for \d+s/.test(l));
    const early = await logLinesDuring(() => runRoundExpiryTick(Date.now()));
    assert.deepEqual(slowLine(early.lines), [], 'a tick before the bound reported an act that had not run long');
    const at = Date.now() + 60_000;
    const first = await logLinesDuring(() => runRoundExpiryTick(at));
    assert.equal(slowLine(first.lines).length, 1, `one tick past the bound did not report the act once: ${JSON.stringify(first.lines)}`);
    const again = await logLinesDuring(() => runRoundExpiryTick(at + 1000));
    assert.deepEqual(slowLine(again.lines), [], 'the next tick said it again inside its window');
    assert.equal(runner.spaceActRunning('wipe-a'), true, 'reporting a slow act cut it');
    hold.release();
    await settledOk(running);
    assert.equal(await factCount('wipe-a'), 0, 'the slow act did not finish its wipe once released');
  });

  it('R-W16 (the runner\'s gauges): the owed and oldest-owed gauges show a failing act and return to 0 when it completes', T, async () => {
    await seed('gauge-a');
    runner.setSpaceActHooksForTest({ beforeBatch: (collection) => { if (isOf(collection, 'gauge-a')) throw new Error('fails'); } });
    const { entry } = register({ kind: 'wipe', localId: 'gauge-a' });
    await runner.runSpaceAct(entry.id);
    const dayAgo = new Date(Date.now() - 90_000_000).toISOString();
    loader.mutateConfig(cfg => { for (const e of cfg.pendingSpaceActs) e.registeredAt = dayAgo; });
    assert.ok(await metricSample('ythril_space_acts_owed') >= 1, 'ythril_space_acts_owed does not count the owed entry');
    assert.ok(await metricSample('ythril_space_act_oldest_owed_seconds') >= 3600, 'the oldest-owed gauge does not grow with the entry\'s age (its alert is > 3600)');
    runner.setSpaceActHooksForTest(null);
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    const at = Date.parse(entriesOf(loader)[0].retryAt) + 1000;
    runRoundExpiryTick(at);
    await untilRunnerIdle(runner, loader, { now: at });
    assert.equal(await metricSample('ythril_space_acts_owed'), 0);
    assert.equal(await metricSample('ythril_space_act_oldest_owed_seconds'), 0, 'the oldest-owed gauge did not return to 0');
  });

  it('the completion is ONE write: the entry goes, the receive marks are forgotten and the round is applied in a single step of the write generation', T, async () => {
    await seed('wipe-a');
    loader.mutateConfig(cfg => {
      const net = netFixture('n1', { spaces: ['wipe-a'], rounds: [passedSpaceRound('w1', 'space_wipe', 'wipe-a')] });
      net.members = [{ instanceId: 'bbbbbbbb-0000-4000-8000-0000000000b1', label: 'M', url: 'https://m.example', tokenHash: 'h', direction: 'both', lastSeqReceived: { 'wipe-a': 7 } }];
      cfg.networks = [net];
    });
    const atCompletion = deferred(); let generationBefore;
    runner.setSpaceActHooksForTest({ beforeComplete: async () => { generationBefore = loader.configWriteGeneration(); atCompletion.arrive(); } });
    const { entry } = register({ kind: 'wipe', localId: 'wipe-a', round: { networkId: 'n1', roundId: 'w1' } }, Date.now());
    loader.mutateConfig(cfg => { cfg.pendingSpaceActs.find(e => e.id === entry.id).postSteps = { forgetReceiveMarks: [{ networkId: 'n1', localSpaceId: 'wipe-a' }] }; });
    await settledOk(runner.runSpaceAct(entry.id));
    await atCompletion.reached;
    assert.equal(loader.configWriteGeneration() - generationBefore, 1, 'the completion took more or fewer than one config write');
    assert.deepEqual(entriesOf(loader), []);
    assert.equal(roundOf(loader, 'n1', 'w1')?.appliedHere, true);
    assert.equal(loader.getConfig().networks[0].members[0].lastSeqReceived?.['wipe-a'], undefined, 'the receive mark of the wiped space was not forgotten in the completion');
  });
});
