/**
 * A stale push cleans up only a tombstone that is still below the stored copy — `Q-253`, 5.6.3.
 *
 * ## The defect
 *
 * A pushed record older than the stored copy is `stale`: nothing is written, and 5.6.1's cleanup deletes the
 * record's tombstone, which the stored copy has already superseded. The verdict reads the tombstone and the stored
 * copy first, and the cleanup runs after — and it deleted by `_id` alone. A tombstone written for that id in between
 * (a peer's deletion arriving at a higher seq, or a local delete) was deleted with it: the deletion is lost here, and
 * the stored record it was meant to remove lives on.
 *
 * The landing branch already bounds its cleanup (`dropSupersededTombstone`: `seq < incoming.seq`). The stale branch
 * is the second copy of that rule, and it was the unbounded one.
 *
 * ## The rule
 *
 *  - the stale cleanup still deletes a tombstone below the stored seq (5.6.1's cleanup, kept);
 *  - its delete filter is bounded by the STORED copy's seq, `seq: { $lt: stored.seq }`, read from the command the
 *    harness database saw;
 *  - so a tombstone written at a higher seq between the verdict and the cleanup survives.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stale-push-cleans-only-a-tombstone-below-the-stored-copy-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, PEER_TOKEN } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'stale-cleanup';
const DB = 'ythril_harness_stalecleanup';
const ISSUER = PEER_TOKEN.peerInstanceId;   // the record's author, so the tombstone governs it
let door;

const stored = (part, id) => door.coll(S, part).findOne({ _id: id });
/** The stored entity at seq 20, its tombstone at seq 5, and a push of seq 10: the stale branch with a cleanup to do. */
async function seedStale(id) {
  await door.coll(S, 'entities').insertOne(build.entity(S, id, 20));
  await door.coll(S, 'tombstones').insertOne(build.tombstone(S, id, 'entity', 5, { instanceId: ISSUER }));
}
const pushStale = (id) => door.push('/batch-upsert', { entities: [build.entity(S, id, 10)] }, { spaceId: S });

describe('a stale push cleans up only a tombstone below the stored copy', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'stalecleanup', spaces: [{ id: S, label: 'Stale cleanup', folders: [] }], monitorCommands: true });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the stale cleanup deletes a tombstone below the stored seq, by a filter bounded by that seq', async () => {
    await seedStale('e1');
    const deletes = [];
    const listener = (ev) => {
      if (ev.databaseName === DB && ev.commandName === 'delete' && ev.command.delete === `${S}_tombstones`) {
        deletes.push(...(ev.command.deletes ?? []).map(d => d.q));
      }
    };
    door.mongo.getMongo().on('commandStarted', listener);
    let res;
    try { res = await pushStale('e1'); } finally { door.mongo.getMongo().off('commandStarted', listener); }
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal((await stored('entities', 'e1'))?.seq, 20, 'fixture check: the stale copy was written over the stored one');
    assert.equal(await stored('tombstones', 'e1'), null, 'the stale branch no longer cleans up a superseded tombstone');
    const forE1 = deletes.filter(q => q?._id === 'e1');
    assert.equal(forE1.length, 1, `expected one delete of the tombstone, saw ${JSON.stringify(deletes)}`);
    assert.deepEqual(forE1[0].seq, { $lt: 20 },
      `the stale cleanup deletes by ${JSON.stringify(forE1[0])}: unbounded by the stored copy's seq, it also deletes a `
      + 'tombstone written after the verdict read it');
  });

  it('a tombstone written at a higher seq between the verdict and the cleanup survives', async () => {
    await seedStale('e2');
    // The verdict reads the stored copy, then the cleanup runs: the deletion lands between the two.
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const original = proto.findOne;
    let landed = false;
    proto.findOne = async function verdictRead(filter, ...rest) {
      const out = await original.call(this, filter, ...rest);
      if (!landed && this.collectionName === `${S}_entities` && filter?._id === 'e2') {
        landed = true;
        await door.coll(S, 'tombstones').replaceOne({ _id: 'e2' },
          build.tombstone(S, 'e2', 'entity', 30, { instanceId: ISSUER }), { upsert: true });
      }
      return out;
    };
    let res;
    try { res = await pushStale('e2'); } finally { proto.findOne = original; }
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.ok(landed, 'fixture check: the verdict never read the stored copy, so the deletion never landed in between');
    assert.equal((await stored('tombstones', 'e2'))?.seq, 30,
      'a stale push deleted a tombstone written at seq 30, above the stored copy at 20: that deletion is lost here, and '
      + 'the record it removes lives on');
  });
});
