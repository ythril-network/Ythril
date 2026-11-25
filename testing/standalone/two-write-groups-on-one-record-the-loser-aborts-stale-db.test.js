/**
 * Two write groups that converge the same record: one lands, and the other re-runs its transaction and then aborts STALE (`Q-760`).
 *
 * ## The rule
 *
 * A group's transaction that meets a write conflict is run again from the top by the bound (`db/bounded-transaction.ts`), with fresh versions
 * and positions. On the re-run its converge filter (the seq it was planned against) matches nothing, because the winner moved the record:
 * the group aborts with reason `stale`, nothing of it lands, and the winner's change stands. Never a lost update, never a partial group.
 *
 * ## How the race is made deterministic
 *
 * No sleeps. The loser's record write is parked (`parkWrites`) after its transaction opened; the winner then writes the same record as a
 * group and commits; the gate opens. The loser's write meets the winner's committed change after its own snapshot: a write conflict.
 *
 * ## Seen red
 *
 * On the base (3f48206ac) the fixture writes both groups with `commitPlans`: the loser has no transaction to re-run, its insert lands beside
 * its stale converge's refusal (red line in the Q-760 Work-Log). Mutation: the converge's matched count not checked in the group (the loser
 * commits its insert).
 *
 * Run: node --test testing/standalone/two-write-groups-on-one-record-the-loser-aborts-stale-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { parkWrites } from './_write-faults.mjs';
import { SPACE, openWriteGroupFixture, factId, factDoc, insertFact, convergeFact, settle } from './_write-group.mjs';

const skip = await mongoSkipReason();
const HOLD_TIMEOUT = 30_000;

let fx;
let park = null;

describe('two write groups on one record', { skip }, () => {
  before(async () => { fx = await openWriteGroupFixture('writegrouprace'); });
  after(async () => { park?.restore(); await fx?.cleanup(); });
  beforeEach(async () => {
    park?.restore();
    park = parkWrites(Object.getPrototypeOf(fx.mongo.col('probe')));
    await fx.clear();
  });

  it('the winner lands; the loser re-runs, then aborts stale, and nothing of it lands', { timeout: HOLD_TIMEOUT }, async () => {
    const record = factId(1);
    await fx.coll('facts').insertOne({ ...factDoc(record, 'as stored'), seq: 5 });
    const loserInsert = factId(2);
    const winnerInsert = factId(3);

    const hold = park.arm(`${SPACE}_facts`, { when: (method) => method === 'bulkWrite' });
    const loser = settle(fx.commitGroup([insertFact(loserInsert, 'the loser\'s new fact'), convergeFact(record, 'the loser\'s text', 5)]));
    await hold.reached;
    let winner;
    try {
      winner = await settle(fx.commitGroup([insertFact(winnerInsert, 'the winner\'s new fact'), convergeFact(record, 'the winner\'s text', 5)]));
    } finally {
      hold.release();
    }
    const lost = await loser;

    assert.equal(winner.error, undefined, `the winning group failed: ${winner.error?.message}`);
    const stored = await fx.coll('facts').findOne({ _id: record });
    assert.equal(stored.fact, 'the winner\'s text', 'the winner\'s change did not stand: a lost update');
    assert.equal(await fx.coll('facts').countDocuments({ _id: loserInsert }), 0, 'the losing group\'s insert landed beside its stale converge: a partial group');
    assert.ok(lost.error, 'the losing group was answered as written');
    assert.equal(lost.error.name, 'GroupAborted', `the loser's failure is not the group's abort: ${lost.error.name}: ${lost.error.message}`);
    assert.equal(lost.error.reason, 'stale');
    assert.equal(lost.error.recordId, record);
    assert.equal(lost.error.attempts, 2, `the loser ran ${lost.error.attempts} time(s): it should have met the conflict once, re-run, and found its converge stale`);
  });
});
