/**
 * A write group whose commit LANDED but was reported failed is answered as written; one whose read-back cannot confirm it is answered
 * "outcome unknown", never "nothing landed" (`Q-760`; design-r2 R8).
 *
 * ## The rule
 *
 * A commit may land and still fail on the wire. The group reads back one row it inserted (its marker, stamped with this run's version) inside
 * the hold: found, the group is answered as written and what follows a write runs; not found, the group cannot say what happened, and answers
 * `WriteGroupOutcomeUnknown` (a store-side failure, 503 on every door), so a caller reads back before it retries. A converged row is never the
 * marker: it existed before, so finding it proves nothing.
 *
 * ## The faults
 *
 * `loseNextCommitReply` (`_write-faults.mjs`): the commit really commits, then the caller is handed a `MaxTimeMSExpired`. And its opposite,
 * built here because no other test needs it: the commit is aborted, then the caller is handed the same error — a commit that did not land,
 * which the read-back cannot tell from one whose row it cannot see.
 *
 * ## Seen red
 *
 * On the base (3f48206ac) the fixture writes the plans with `commitPlans`, which runs no transaction: no commit is made, so no reply is lost
 * (red line in the Q-760 Work-Log). Mutation: the `landed` read-back removed from the group (the first case answers a landed group failed).
 *
 * Run: node --test testing/standalone/a-write-group-whose-commit-reply-is-lost-is-read-back-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loseNextCommitReply } from './_write-faults.mjs';
import { openWriteGroupFixture, factId, insertFact, settle } from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;

/** The next commit is ABORTED, and the caller is handed the error a commit past its time limit gives: nothing landed, and nobody can tell. */
async function abortNextCommit(mongo) {
  const { MongoServerError } = await import('mongodb');
  const session = mongo.getMongo().startSession();
  const proto = Object.getPrototypeOf(session);
  await session.endSession();
  const original = proto.commitTransaction;
  let fired = false;
  proto.commitTransaction = async function abortedInstead(...args) {
    if (fired) return original.apply(this, args);
    fired = true;
    await this.abortTransaction();
    throw new MongoServerError({ ok: 0, code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'operation exceeded time limit' });
  };
  return { fired: () => fired, restore: () => { proto.commitTransaction = original; } };
}

describe('a write group whose commit reply is lost', { skip }, () => {
  before(async () => { fx = await openWriteGroupFixture('writegrouplost'); });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('a commit that landed and was reported failed is answered as written, and its embed jobs are queued', async () => {
    const plans = [1, 2, 3].map(n => insertFact(factId(n), `fact ${n}`, { enqueue: true }));
    const lost = await loseNextCommitReply(fx.mongo);
    let out;
    try { out = await settle(fx.commitGroup(plans)); } finally { lost.restore(); }
    assert.ok(lost.fired(), 'no commit reply was lost: the group was not written in one transaction');
    assert.equal(await fx.coll('facts').countDocuments({}), 3, 'premise: the commit did not land');
    assert.equal(out.error, undefined, `a group that LANDED was answered as failed (${out.error?.name}: ${out.error?.message}), inviting a resend`);
    assert.equal(await fx.coll('embed_jobs').countDocuments({}), 3, 'the landed group\'s embed jobs were not queued after its lost reply');
  });

  it('a commit whose read-back cannot confirm it is answered outcome unknown, never nothing landed', async () => {
    const plans = [4, 5].map(n => insertFact(factId(n), `fact ${n}`, { enqueue: true }));
    const aborted = await abortNextCommit(fx.mongo);
    let out;
    try { out = await settle(fx.commitGroup(plans)); } finally { aborted.restore(); }
    assert.ok(aborted.fired(), 'no commit was made: the group was not written in one transaction');
    assert.equal(await fx.coll('facts').countDocuments({}), 0, 'premise: the aborted commit landed');
    assert.ok(out.error, 'a group whose commit failed was answered as written');
    assert.equal(out.error.name, 'WriteGroupOutcomeUnknown', `an unconfirmed commit was answered ${out.error.name}: ${out.error.message}`);
    assert.equal(out.error.code, 'write_group_outcome_unknown');
    const { classifyReadFailure } = await import('../../server/dist/brain/store-failure.js');
    const answer = classifyReadFailure(out.error);
    assert.deepEqual([answer.status, answer.retryable], [503, true], 'the outcome-unknown answer is not classified as the store\'s failure (503, retryable)');
    assert.equal(await fx.coll('embed_jobs').countDocuments({}), 0, 'an embed job was queued for a group not known to have landed');
  });
});
