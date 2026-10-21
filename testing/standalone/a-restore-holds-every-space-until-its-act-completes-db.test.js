/**
 * A restore holds its space - local writes and exchanges alike - until the space's restore act completes, and never half-restores it
 * (bundle-157, Q-552/Q-554; design rev 2 "The fence is the space-act hold", rev 3 R3.1 and R3.10).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * Today `POST /restore` turns maintenance on and drops and reloads every collection inline. Maintenance stops HTTP callers that are
 * not admins, and nothing else: an exchange this instance starts, a timer's write, an admin's write, all land while collections are
 * dropped and reloaded - a write between the drop and the reload is lost or turns into a duplicate key, and an exchange writes a mark
 * past data that is being replaced. The rule is that a restore is a SPACE ACT: registered on every space at the 202, so the space-act
 * hold every writer and every exchange door already asks (`spaceHold`, the write gate) refuses them until that space's act completes,
 * and the hold lifts in the completion write.
 *
 * ## What is asserted, deterministically
 *
 * The space's restore act is parked in the runner's `afterDrain` hook (a latch the test releases; no sleep). While it is parked:
 *
 * - a local `saveFact` to the space is REFUSED, and nothing it wrote is stored afterwards;
 * - an exchange with the peer makes no page request for the space and stores none of the peer's records.
 *
 * After the act completes: the space's facts are exactly the backup's (no half-restore, nothing written during the restore kept), then a
 * local write is taken and the next exchange stores the peer's record.
 *
 * ## Seen red
 *
 * On 14005a5c `POST /restore` answers 200 having restored inline: there is no restore act to hold anything.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-restore-holds-every-space-until-its-act-completes-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { deferred, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreAsActs, startRestoreActs } from './_restore-act.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'restorehold';
const S = 'restoreheld';

let door, mods, writers;
const factIds = async () => (await door.coll(S, 'facts').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();

describe('a restore holds its space until its act completes (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: SUITE, spaces: [S] });
    mods = await restoreModules();
    writers = { fact: await import('../../server/dist/brain/fact.js') };
    door.state.family = door.serveFamily;
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });

  it('a local write and an exchange during the restore are refused; after completion the space equals the backup and both proceed', { timeout: 90_000 }, async () => {
    await door.coll(S, 'facts').insertMany([1, 2].map(n => ({ _id: `kept${n}`, spaceId: S, fact: `kept ${n}`, tags: [], seq: n })));
    await door.setCounter(S, 2);
    const backup = await takeBackup(SUITE, `restorehold-${Date.now()}`);
    const backedUp = await factIds();
    await door.coll(S, 'facts').insertOne({ _id: 'after-backup', spaceId: S, fact: 'after the backup', tags: [], seq: 3 });

    const hold = deferred();
    mods.runner.setSpaceActHooksForTest({
      afterDrain: async (entry) => { if (entry.kind === 'restore' && entry.localId === S) { hold.arrive(); await hold.promise; } },
    });
    await restoreAsActs(mods, { backupId: backup.id });
    const runs = startRestoreActs(mods.runner, mods.loader);
    await hold.reached;

    // While the act stands: a local write is refused, and an exchange neither asks for the space nor stores the peer's record.
    await assert.rejects(writers.fact.saveFact(S, 'written during the restore', [], [], undefined, undefined, 'note'),
      'a local write was taken while the space was being restored');
    await door.seedPeerRecords(S, 'facts', [build.fact(S, 'peer-during', 10, { author: PEER_AUTHOR })]);
    door.state.familyRequests.length = 0;
    await door.sync();
    assert.deepEqual(door.state.familyRequests.filter(q => q.spaceId === S).map(q => q.family), [],
      'the exchange asked the peer for pages of a space being restored');
    assert.equal(await door.coll(S, 'facts').findOne({ _id: 'peer-during' }), null, 'the exchange stored a record into a space being restored');

    hold.release();
    for (const r of await Promise.all(runs)) assert.equal(r.ok, true, `a restore act did not complete: ${JSON.stringify(r)}`);
    await untilRunnerIdle(mods.runner, mods.loader);
    assert.deepEqual(await factIds(), backedUp, 'after the restore the space is not the backup: a write during it, or a half-restore, is left');

    // After completion both proceed. The fake peer keeps its storage in this database as a served space of its own, so the restore
    // rolled the PEER back too (its act may run before or after the record was seeded): the record it holds is written again, as a real
    // peer's would still be - the re-receive test does the same.
    await door.mongo.col(`${door.peerSide(S)}_facts`).deleteMany({ _id: 'peer-during' });
    await door.seedPeerRecords(S, 'facts', [build.fact(S, 'peer-during', 10, { author: PEER_AUTHOR })]);
    const saved = await writers.fact.saveFact(S, 'after the restore', [], [], undefined, undefined, 'note');
    assert.ok(saved, 'a local write was refused after the restore completed');
    await door.sync();
    assert.ok(await door.coll(S, 'facts').findOne({ _id: 'peer-during' }), 'the exchange after the restore did not store the peer\'s record');
  });
});
