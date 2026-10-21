/**
 * A restore act survives a crash, a failed attempt stays owed and held until a retry completes it, and a broken backup fails the act
 * WITHOUT emptying what is there (bundle-157, Q-552/Q-554; design rev 2 point 1, rev 3 R3.2/R3.10, rev 5 R5.5).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * Today the restore runs inline in the request: a process that dies half-way leaves some collections replaced and others not, with
 * nothing on disk saying a restore was owed, and a collection whose file is missing is dropped before the load fails. The rule: each
 * space's restore is a registered act, so
 *
 * - a crash before its completion leaves the entry on disk, and the resume after the restart runs the body again and completes it;
 * - an attempt that fails leaves the act OWED, the space held (a local write refused), and the retry completes it;
 * - an INPUT failure found by the body (`backupIsWhole` re-checked before replacing: a missing ndjson file, a count that does not match
 *   the manifest) fails the act and leaves the space's collection as it was - never emptied;
 * - the route refuses a backup that is not whole up front (400), registering nothing.
 *
 * ## How it is driven
 *
 * The runner's own hooks: `beforeComplete` throws for the crash and the failure, `afterDrain` breaks the backup on disk after the 202
 * (so the body, not the route, is the one that meets it). A restart is what the in-process boot can do: flush the config, reopen the
 * runner, reload the config, resume. Every space is seeded before the backup and written after it, and asserted by its record ids.
 *
 * ## Seen red
 *
 * On 14005a5c `POST /restore` answers 200 having restored inline, so no row reaches an act; the route-level row answers 500, not 400.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-restore-resumes-after-a-crash-and-a-failure-stays-owed-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreAsActs, requestRestore, restoreEntries, startRestoreActs } from './_restore-act.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'restorecrash';
const SPACES = ['crashed', 'failing', 'nofile', 'miscount', 'refused'];
const T = { timeout: 90_000 };
const DAY = 86_400_000;

let door, mods, writers;
const ids = async (space) => (await door.coll(space, 'facts').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();

/** Two facts before the backup, a third after it; the backup and the ids it holds. */
async function seedAndBackup(space) {
  await door.coll(space, 'facts').deleteMany({});
  await door.coll(space, 'facts').insertMany([1, 2].map(n => ({ _id: `${space}-${n}`, spaceId: space, fact: `${space} ${n}`, tags: [], seq: n })));
  await door.setCounter(space, 2);
  const backup = await takeBackup(SUITE, `${space}-${Date.now()}`);
  await door.coll(space, 'facts').insertOne({ _id: `${space}-3`, spaceId: space, fact: `${space} 3`, tags: [], seq: 3 });
  return { backup, backedUp: [`${space}-1`, `${space}-2`], live: [`${space}-1`, `${space}-2`, `${space}-3`] };
}
const entryOf = (space) => restoreEntries(mods.loader).find(e => e.localId === space);
const restart = async () => { await mods.loader.flushConfig(); mods.runner.reopenSpaceActsForTest(); mods.loader.loadConfig(); };

describe('a restore act resumes after a crash, a failure stays owed, a broken backup keeps the data (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    mods = await restoreModules();
    writers = { fact: await import('../../server/dist/brain/fact.js') };
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(() => { resetRunnerForTest(mods.runner); clearActEntries(mods.loader); });

  it('a crash before the completion: the entry is on disk, and the resume after the restart completes the restore', T, async () => {
    const { backup, backedUp } = await seedAndBackup('crashed');
    mods.runner.setSpaceActHooksForTest({ beforeComplete: (e) => { if (e.localId === 'crashed') throw new Error('crash before the completion'); } });
    await restoreAsActs(mods, { backupId: backup.id });
    await Promise.all(startRestoreActs(mods.runner, mods.loader));
    assert.ok(entryOf('crashed'), 'the crashed restore left no entry on disk: nothing says it is owed');
    mods.runner.setSpaceActHooksForTest(null);
    await restart();
    const later = Date.now() + DAY;
    await mods.runner.resumeSpaceActs(later);
    await untilRunnerIdle(mods.runner, mods.loader, { now: later });
    assert.equal(entryOf('crashed'), undefined, 'the resume did not complete the crashed restore');
    assert.deepEqual(await ids('crashed'), backedUp, 'after the resumed restore the space is not the backup');
  });

  it('a failed attempt stays owed and held, and the retry completes it', T, async () => {
    const { backup, backedUp } = await seedAndBackup('failing');
    mods.runner.setSpaceActHooksForTest({ beforeComplete: (e) => { if (e.localId === 'failing') throw new Error('the attempt failed'); } });
    await restoreAsActs(mods, { backupId: backup.id });
    await Promise.all(startRestoreActs(mods.runner, mods.loader));
    const owed = entryOf('failing');
    assert.equal(owed?.state, 'owed', `a failed restore is not owed: ${JSON.stringify(owed)}`);
    assert.ok(owed.attempts >= 1, 'the failed attempt was not counted');
    await assert.rejects(writers.fact.saveFact('failing', 'while owed', [], [], undefined, undefined, 'note'), 'a space whose restore is owed took a local write');
    mods.runner.setSpaceActHooksForTest(null);
    const at = Date.parse(owed.retryAt ?? new Date().toISOString()) + 1000;
    await mods.runner.retryOwedSpaceActs(at);
    await untilRunnerIdle(mods.runner, mods.loader, { now: at });
    assert.equal(entryOf('failing'), undefined, 'the retry did not complete the owed restore');
    assert.deepEqual(await ids('failing'), backedUp, 'after the retried restore the space is not the backup');
  });

  /** Break the backup on disk once the body is about to run, so the BODY meets it. */
  const INPUT_FAILURES = {
    nofile: (dir, space) => fs.rmSync(path.join(dir, `${space}_facts.ndjson`)),
    miscount: (dir, space) => {
      const file = path.join(dir, `${space}_facts.ndjson`);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n');
    },
  };
  for (const [space, breakIt] of Object.entries(INPUT_FAILURES)) {
    it(`${space}: a backup the body finds broken fails the act, and the space keeps the records it had`, T, async () => {
      const { backup, live } = await seedAndBackup(space);
      mods.runner.setSpaceActHooksForTest({ afterDrain: (e) => { if (e.kind === 'restore' && e.localId === space) breakIt(backup.dir, space); } });
      await restoreAsActs(mods, { backupId: backup.id });
      const results = await Promise.all(startRestoreActs(mods.runner, mods.loader));
      const mine = results.find(r => r.localId === space);
      assert.equal(mine?.ok, false, `the restore of ${space} completed over a broken backup: ${JSON.stringify(mine)}`);
      assert.ok(entryOf(space), `the failed restore of ${space} left no entry: nothing says it needs a retry or an abandon`);
      assert.deepEqual(await ids(space), live, `the broken backup emptied or changed ${space}'s facts`);
    });
  }

  it('the route refuses a backup that is not whole (400) and registers nothing', T, async () => {
    const { backup, live } = await seedAndBackup('refused');
    fs.rmSync(path.join(backup.dir, 'refused_facts.ndjson'));
    const answer = await requestRestore(mods.dataRouter, { backupId: backup.id });
    assert.equal(answer.status, 400, `a backup missing a file was answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(restoreEntries(mods.loader), [], 'a refused restore registered acts');
    assert.deepEqual(await ids('refused'), live, 'a refused restore changed the space');
  });
});
