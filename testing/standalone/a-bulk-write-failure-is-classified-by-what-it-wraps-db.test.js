/**
 * A failed bulk write is classified by what the DRIVER says happened — the error it wrapped, its write concern, or
 * its documents — never as "the server refused it" because the wrapper's class says so (bundle-30 I14, verify-drive-4
 * finding D1).
 *
 * ## The finding
 *
 * With the store paused during a file delete, the tombstone write (`insertMany`) failed with
 *
 *     MongoBulkWriteError: connection <monitor> to 172.16.0.9:27017 timed out
 *
 * and the classifier answered it `{ status: 400, retryable: false, error: <that text> }`. So `throwIfStoreSide` did not
 * throw, `writeFileTombstones` swallowed it as "not the store's", and the delete removed the bytes with no tombstone
 * the server knew of and answered `204`. Any door handed a `MongoBulkWriteError` answered `400` with the driver's host
 * and port.
 *
 * ## What the driver does, read from `bulk/common.js`
 *
 * `MongoBulkWriteError` extends `MongoServerError`, and the driver raises it in three ways:
 *
 * | how | `errorResponse` | `writeErrors` | what it is |
 * |---|---|---|---|
 * | `executeOperation` threw (transport, selection, a driver refusal): `new MongoBulkWriteError(thrownError, result)` | the thrown `Error` itself | `[]` | whatever it wrapped |
 * | the server reported a write concern failure | a plain `{ message, code }`, or a `WriteConcernError` | `[]` | the store could not confirm the write |
 * | the server refused documents (`handleWriteError`) | a plain `{ message, code, writeErrors }` | one per document | the documents' refusal |
 *
 * The wrapper copies the thrown error's own fields with `Object.assign` — its labels, if it had any — but not its
 * class and not as a `cause`. A selection failure carries no label, so nothing on the wrapper said "the store".
 *
 * ## What each shape is held to, over every shape the driver produced here
 *
 * - **A wrapped thrown error is what it wrapped**: the store gone is the store's (`503`, retryable); a driver-side
 *   refusal is a driver fault (`500` in our words). Never a `400`, and never the driver's text.
 * - **A write concern TIMEOUT is the store's**, bulk or single: the caller chose no write concern and cannot fix it, and
 *   it clears. **One that can never be met (code 100 / 79) is not**: a `500`, not retryable, carrying its code (bundle-53 G1).
 * - **A document's refusal stays the caller's**: a duplicate key is a `400` (null from `storeFailureAnswer`).
 *
 * Every error here is produced by the installed driver against the real store (`driverWriteFailures`) — never built
 * by hand, which is how the gates before this one passed: each hand-built error was the INNER one.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-bulk-write-failure-is-classified-by-what-it-wraps-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import { driverWriteFailures } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

let F, sf, writeErrors;

/** Every error the driver produced, flattened with a name: the set the rules below are asserted over. */
const produced = () => Object.entries(F).filter(([k]) => k !== 'address')
  .flatMap(([group, errs]) => Object.entries(errs).map(([shape, err]) => ({ name: `${group}.${shape}`, err })));

/** The answer a door gives, with its log captured so the console stays quiet. */
async function answerFor(err) {
  const { result } = await logLinesDuring(() => sf.storeFailureAnswer(err));
  return result;
}

describe('a failed bulk write is classified by what the driver says happened', { skip }, () => {
  before(async () => {
    await openTestMongo('bulkwrap');
    F = await driverWriteFailures('ythril_harness_bulkwrap');
    sf = await import('../../server/dist/brain/store-failure.js');
    writeErrors = await import('../../server/dist/db/write-errors.js');
  });
  after(async () => { await closeTestMongo(); });

  it('the driver produced the shapes the rules are about — or the rules below conclude nothing', () => {
    const { bulk } = F.storeGone;
    assert.equal(bulk.name, 'MongoBulkWriteError', `a write with the store gone threw ${bulk.name}, not the wrapper the drive saw`);
    assert.ok(bulk.errorResponse instanceof Error, 'the wrapper does not hold the thrown error as its errorResponse — re-read bulk/common.js');
    assert.equal(bulk.errorResponse.name, 'MongoServerSelectionError', `it wrapped ${bulk.errorResponse.name}, not a failed selection`);
    assert.deepEqual(bulk.errorLabels, [], 'the wrapper carries labels, so it is not the unlabelled shape the drive saw');
    assert.match(bulk.message, new RegExp(F.address.replace('.', '\\.')), 'the wrapper\'s text does not name the store\'s address');
    assert.equal(F.writeConcern.bulk.name, 'MongoBulkWriteError');
    assert.equal(F.writeConcern.bulk.writeErrors.length, 0, 'a write concern failure carried per-document errors');
    assert.ok(F.writeConcern.bulk.result.getWriteConcernError(), 'the test store is not a replica set: no write concern failure to classify');
    assert.equal(F.writeConcern.single.name, 'MongoWriteConcernError');
    assert.equal(F.refused.duplicateKey.writeErrors.length, 1);
    assert.equal(F.driverSide.bulk.name, 'MongoBulkWriteError');
    assert.ok(F.driverSide.bulk.errorResponse instanceof Error, 'the ended-session refusal was not wrapped by the bulk write');
  });

  it('the store gone is the store\'s, wrapped or not: 503, retryable, thrown by throwIfStoreSide', async () => {
    for (const [shape, err] of Object.entries(F.storeGone)) {
      const f = sf.classifyReadFailure(err);
      assert.equal(f.status, 503, `${shape} (${err.name}) answered ${f.status} ${f.error}`);
      assert.equal(f.retryable, true, `${shape} is not retryable`);
      assert.throws(() => sf.throwIfStoreSide(err), `throwIfStoreSide let ${shape} through — a writer that rethrows only the store's swallowed it`);
    }
  });

  // bundle-53 G1 (Q-343): the w:5 fixtures are a write concern the deployment can NEVER meet — code 100, and for a bulk
  // write on the RESULT, not the wrapper. That is a misconfiguration, not an outage: answered 503 it was retried for ever.
  it('an unsatisfiable write concern (w: 5 on one node) is code 100 — and is not the store\'s outage, bulk or single', async () => {
    const codes = {};
    for (const [shape, err] of Object.entries(F.writeConcern)) {
      codes[shape] = shape === 'bulk' ? err.result.getWriteConcernError()?.code : err.code;
      assert.equal(codes[shape], 100, `the ${shape} w:5 fixture no longer fails with 100 (UnsatisfiableWriteConcern): ${codes[shape]}`);
      const f = sf.classifyReadFailure(err);
      assert.equal(f.status, 500, `a ${shape} write concern failure the deployment cannot meet answered ${f.status}`);
      assert.equal(f.retryable, false);
      assert.equal(f.code, 100);
      assert.equal(f.codeName, 'UnsatisfiableWriteConcern');
      assert.equal(f.error, sf.UNSATISFIABLE_WRITE_CONCERN_MESSAGE);
      const answer = await answerFor(err);
      assert.equal(answer.status, 500);
      assert.equal(answer.retryAfterSeconds, undefined);
      assert.equal(answer.body.retryable, false);
      assert.equal(answer.body.code, 100);
      assert.doesNotMatch(JSON.stringify(answer.body), new RegExp(`${F.address.replace('.', '\\.')}|w: ?5|data-bearing`), 'the driver\'s text reached the answer');
      assert.throws(() => sf.throwIfStoreSide(err), `throwIfStoreSide let a ${shape} unsatisfiable write concern through`);
    }
    assert.deepEqual(Object.keys(codes).sort(), ['bulk', 'single'], 'both shapes are held to it');
  });

  it('through a SLICED bulk write: the stopping error is read through the wrapper, not the wrapper\'s class', async () => {
    const { SlicedBulkWriteError } = await import('../../server/dist/db/one-command.js');
    const sliced = new SlicedBulkWriteError([{ slice: 0, error: F.writeConcern.bulk }], [], 1, F.writeConcern.bulk);
    const f = sf.classifyReadFailure(sliced);
    assert.equal(f.status, 500, `a sliced write that stopped on w:5 answered ${f.status} ${f.error}`);
    assert.equal(f.retryable, false);
    assert.equal(f.code, 100);
  });

  it('a write concern TIMEOUT (code 64) stays the store\'s, bulk or single: it is a condition that clears', async () => {
    const { MongoWriteConcernError, MongoBulkWriteError } = await import('mongodb');
    const built = {
      single: new MongoWriteConcernError({ writeConcernError: { code: 64, codeName: 'WriteConcernTimeout', errmsg: 'waiting for replication timed out' } }),
      bulk: new MongoBulkWriteError({ message: 'waiting for replication timed out', writeErrors: [] },
        { getWriteConcernError: () => ({ code: 64, errmsg: 'waiting for replication timed out' }) }),
    };
    for (const [shape, err] of Object.entries(built)) {
      const f = sf.classifyReadFailure(err);
      assert.equal(f.status, 503, `a ${shape} write concern timeout answered ${f.status}: the caller chose no write concern`);
      assert.equal(f.retryable, true);
    }
  });

  it('a driver-side refusal the bulk write wrapped is a driver fault, not the server refusing the caller', () => {
    const f = sf.classifyReadFailure(F.driverSide.bulk);
    assert.equal(f.status, 500, `a wrapped ${F.driverSide.bulk.errorResponse.name} answered ${f.status} ${f.error}`);
  });

  it('a document the server refused stays the caller\'s: a duplicate key is a 400 and is still read as one', async () => {
    const err = F.refused.duplicateKey;
    assert.equal(sf.classifyReadFailure(err).status, 400, 'a duplicate key was taken for the store\'s condition');
    assert.equal(await answerFor(err), null);
    assert.doesNotThrow(() => sf.throwIfStoreSide(err));
    assert.equal(writeErrors.isDuplicateKeyOnly(err), true, 'the duplicate-key reader no longer recognises the shape');
  });

  it('no shape the driver produced is answered with the driver\'s text, and none but a document\'s refusal is a 400', async () => {
    const wrong = [];
    for (const { name, err } of produced()) {
      const f = sf.classifyReadFailure(err);
      if (f.status === 400 && name !== 'refused.duplicateKey') wrong.push(`${name} (${err.name}): 400 ${f.error}`);
      const answer = await answerFor(err);
      if (answer && JSON.stringify(answer.body).includes(F.address)) wrong.push(`${name}: answered with the store's address`);
    }
    assert.ok(produced().length >= 6, `only ${produced().length} shapes produced — the producer is broken`);
    assert.deepEqual(wrong, []);
  });
});
