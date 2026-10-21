/**
 * A restore says before it runs what it will leave and what it will empty, and refuses what it cannot do faithfully (bundle-157,
 * Q-554; design rev 3 R3.2 and R3.10, rev 4 R4.2).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * A backup names spaces by their collections. Three cases make "the database equals the backup" ambiguous, and the route decides each
 * BEFORE it registers anything:
 *
 * - a space id the backup holds and this instance does not serve (renamed or deleted after the backup): the restore is REFUSED, 400,
 *   naming the id - unless the request lists it in `leaveOut`, an acknowledgement that its data is not restored; the answer then lists
 *   it in `leftOut`. Today the dump is loaded whole and a renamed space's data lands under its old name, unreachable;
 * - a space this instance serves that the backup does not hold (created after it): it is EMPTIED, and listed in the answer's `emptied`;
 * - a restore requested while a restore stands: refused, registering nothing more.
 *
 * ## What is asserted, by identity
 *
 * `served` is in the backup; `vanished` has collections in the backup and is not configured; `later` is configured and written after
 * the backup. The 400 names `vanished` and changes nothing; with `leaveOut: ['vanished']` the 202 lists it as left out and `later` as
 * emptied; a second request while the first's acts stand (parked in `afterDrain`) is refused and adds no entry; when the acts complete,
 * `served` holds exactly the backup's facts and `later` none.
 *
 * ## Seen red
 *
 * On 14005a5c the route answers 200 to the first request and restores inline.
 *
 * Run: a Mongo the harness accepts, then
 * `node --test testing/standalone/a-restore-refuses-a-backup-naming-a-space-this-instance-does-not-serve-db.test.js` (a prior `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { deferred, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, requestRestore, restoreAsActs, restoreEntries, startRestoreActs } from './_restore-act.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'restorerefuse';
const T = { timeout: 90_000 };

let door, mods, backup;
const ids = async (space) => (await door.coll(space, 'facts').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
const facts = (space, ns) => ns.map(n => ({ _id: `${space}-${n}`, spaceId: space, fact: `${space} ${n}`, tags: [], seq: n }));
const entryIds = () => restoreEntries(mods.loader).map(e => e.id).sort();

describe('a restore refuses a backup naming a space this instance does not serve (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: [{ id: 'served', label: 'served', folders: [] }] });
    mods = await restoreModules();
    await door.coll('served', 'facts').insertMany(facts('served', [1, 2]));
    await door.coll('vanished', 'facts').insertMany(facts('vanished', [1]));
    backup = await takeBackup(SUITE, `refuse-${Date.now()}`);
    assert.ok(backup.manifest.collections.some(c => c.name === 'vanished_facts'), 'fixture: the backup does not hold the unserved space');
    // After the backup: one more fact in `served`, and a space `later` configured and written.
    await door.coll('served', 'facts').insertMany(facts('served', [3]));
    mods.loader.mutateConfig(cfg => { cfg.spaces.push({ id: 'later', label: 'later', folders: [] }); });
    await door.coll('later', 'facts').insertMany(facts('later', [1]));
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });

  it('a backup naming an unserved space is refused 400, naming it, and nothing is registered or changed', T, async () => {
    const answer = await requestRestore(mods.dataRouter, { backupId: backup.id });
    assert.equal(answer.status, 400, `a backup naming a space this instance does not serve was answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.match(JSON.stringify(answer.body), /vanished/, 'the refusal does not name the unserved space');
    assert.deepEqual(entryIds(), [], 'a refused restore registered acts');
    assert.deepEqual(await ids('served'), ['served-1', 'served-2', 'served-3'], 'a refused restore changed a served space');
  });

  it('with leaveOut it proceeds, lists what it left out and emptied, refuses a second restore while it stands, and ends equal to the backup', T, async () => {
    const hold = deferred();
    mods.runner.setSpaceActHooksForTest({ afterDrain: async (e) => { if (e.kind === 'restore') await hold.promise; } });
    const answer = await restoreAsActs(mods, { backupId: backup.id, leaveOut: ['vanished'] });
    assert.deepEqual(answer.body?.leftOut, ['vanished'], `the answer does not list the space it left out: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.body?.emptied, ['later'], `the answer does not list the space created after the backup as emptied: ${JSON.stringify(answer.body)}`);

    const standing = entryIds();
    const second = await requestRestore(mods.dataRouter, { backupId: backup.id, leaveOut: ['vanished'] });
    assert.ok(second.status >= 400 && second.status < 500, `a second restore while one stands was answered ${second.status}: ${JSON.stringify(second.body)}`);
    assert.deepEqual(entryIds(), standing, 'a refused second restore changed the standing acts');

    hold.release();
    const runs = startRestoreActs(mods.runner, mods.loader);
    for (const r of await Promise.all(runs)) assert.equal(r.ok, true, `a restore act did not complete: ${JSON.stringify(r)}`);
    mods.runner.setSpaceActHooksForTest(null);
    await untilRunnerIdle(mods.runner, mods.loader);
    assert.deepEqual(await ids('served'), ['served-1', 'served-2'], 'the served space is not the backup');
    assert.deepEqual(await ids('later'), [], 'the space created after the backup was not emptied');
  });
});
