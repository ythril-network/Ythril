/**
 * A conversion's leased write is bounded as the server bounded it before the write bound existed — no tighter (bundle-44, preship).
 *
 * ## The defect
 *
 * `writeUnderClaim` (`files/media/lease.ts`) carries a conversion's whole derived-row commit: every chunk, the converted Markdown and
 * the extracted images' rows, in one transaction under the job's claim. It was a bare `session.withTransaction`, which the server ended at
 * its own transaction lifetime (a minute by default). Moving it onto the write bound (`db/bounded-transaction.ts`) ended it at the write
 * bound instead: the commit capped at the per-operation figure and the whole at the hold deadline, both below a minute, so a large
 * conversion that used to land was refused with a `StoreTimeout`, its rows rolled back, and its job retried for ever at the same size.
 *
 * ## What is asserted
 *
 * - At the default write bound, the session of a leased write is given at least the server's own transaction lifetime, and its commit may take that long too: a
 *   commit that landed before still can. The figures are READ off the driver's session (`startSession`, `withTransaction`), at the
 *   point the write opens it; nothing here waits a minute.
 * - An enclosing hold's shorter deadline still wins: a bound is never raised by the thing inside it.
 * - Control: a transaction that asks for no bound of its own (the move's batches) keeps the write bound.
 *
 * What a real commit longer than the write bound does was not measured: a commit that takes more than half a minute needs a
 * conversion of a size no fixture here builds, and the figures above are what the driver is handed, which is what bounds it.
 *
 * Run: node --test testing/standalone/a-leased-write-is-bounded-no-tighter-than-it-was-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'leasebound';
/** What ended a leased write before the bound existed: the server's own transaction lifetime, a minute by default. */
const SERVER_TRANSACTION_LIFETIME_MS = 60_000;
/** The session's figure is what is LEFT of its deadline when it opens, so it reads a few ms short of the whole. */
const OPENING_SLACK_MS = 1_000;

let door, lease, bounded, bound, client, realStart, realWithTransaction, sessionProto, seen;

/** Start a processing job and hand back the claim that holds it. */
async function claimedJob(id) {
  await door.coll(S, 'media_jobs').insertOne({ _id: id, spaceId: S, status: 'processing', claimToken: 't-1' });
  return { jobId: id, claimToken: 't-1' };
}

describe('a leased write is bounded no tighter than the server bounded it', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'leasebound', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    lease = await import('../../server/dist/files/media/lease.js');
    bounded = await import('../../server/dist/db/bounded-transaction.js');
    bound = await import('../../server/dist/db/write-bound.js');
    client = door.mongo.getMongo();
    // The figures the driver is handed: the session's own timeout and the commit's, read where the transaction opens.
    realStart = client.startSession;
    client.startSession = function startSession(opts, ...rest) {
      const session = realStart.call(this, opts, ...rest);
      sessionProto ??= Object.getPrototypeOf(session);
      if (!realWithTransaction) {
        realWithTransaction = sessionProto.withTransaction;
        sessionProto.withTransaction = function withTransaction(fn, options) {
          seen.commitMs = options?.maxCommitTimeMS;
          return realWithTransaction.call(this, fn, options);
        };
      }
      seen.sessionMs = opts?.defaultTimeoutMS;
      return session;
    };
  });
  after(async () => {
    if (client && realStart) client.startSession = realStart;
    if (sessionProto && realWithTransaction) sessionProto.withTransaction = realWithTransaction;
    await door?.close();
  });
  beforeEach(async () => { seen = {}; await door.coll(S, 'media_jobs').deleteMany({}); });
  afterEach(() => { bound.setWriteBoundForTest(null); });

  it('the session and the commit of a leased write may take what the server\'s own transaction lifetime allowed', async () => {
    const claim = await claimedJob('job-1');
    await lease.writeUnderClaim(S, claim, async () => 'written');
    assert.ok(seen.sessionMs >= SERVER_TRANSACTION_LIFETIME_MS - OPENING_SLACK_MS,
      `the session of a leased write is bounded at ${seen.sessionMs} ms, below the ${SERVER_TRANSACTION_LIFETIME_MS} ms a commit had before: a large conversion that landed is now refused`);
    assert.ok(seen.commitMs >= SERVER_TRANSACTION_LIFETIME_MS - OPENING_SLACK_MS,
      `the commit of a leased write is bounded at ${seen.commitMs} ms, below the ${SERVER_TRANSACTION_LIFETIME_MS} ms a commit had before`);
  });

  it('an enclosing hold\'s shorter deadline still wins: the bound is never raised from inside', async () => {
    bound.setWriteBoundForTest({ holdDeadlineMs: 5_000, writeTimeoutMs: 4_000 });
    const claim = await claimedJob('job-2');
    await bound.withinWriteBound(() => lease.writeUnderClaim(S, claim, async () => 'written'));
    assert.ok(seen.sessionMs <= 5_000, `the session was given ${seen.sessionMs} ms inside a hold of 5000 ms`);
    assert.ok(seen.commitMs <= 4_000, `the commit was given ${seen.commitMs} ms inside a write bound of 4000 ms`);
  });

  it('control: a transaction that asks for no bound of its own keeps the write bound', async () => {
    await bounded.inBoundedTransaction(async () => 'written');
    assert.ok(seen.sessionMs <= bound.holdDeadlineMs(), `the default session was given ${seen.sessionMs} ms, above the hold deadline`);
    assert.equal(seen.commitMs, bound.writeTimeoutMs(), 'the default commit is not capped at the write bound');
  });
});
