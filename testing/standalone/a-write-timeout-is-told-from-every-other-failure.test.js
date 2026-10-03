/**
 * A write that the bound ended is recognised as a TIMEOUT in every shape the driver gives it — and nothing else is
 * (bundle-30 plan §A5, `db/write-timeout.ts isWriteTimeout`).
 *
 * ## Why this is its own question
 *
 * The bundle-30 design probe (P1, `p1c-error-shapes.mjs`) ended blocked writes with a bound on this store and
 * recorded what came back. It is NOT one error:
 *
 * | how the write was bounded | what the caller receives |
 * |---|---|
 * | `updateOne` / `deleteMany` / `replaceOne` / `insertOne` / `findOneAndUpdate` + `timeoutMS` | `MongoOperationTimeoutError`, no code, a `MongoServerError` as its `cause` |
 * | any write + `maxTimeMS` | code 50 `MaxTimeMSExpired`, as `MongoServerError` |
 * | `bulkWrite` / `insertMany` + `maxTimeMS` | code 50 `MaxTimeMSExpired`, as `MongoBulkWriteError` |
 * | `bulkWrite` / `insertMany` + `timeoutMS`, client side first | `MongoBulkWriteError`, NO code, message `Timed out during socket read (<n>ms)` |
 * | the same, server side first | `MongoBulkWriteError`, NO code, message `Server reported a timeout error` |
 * | `withTransaction` under a session `defaultTimeoutMS` | the LAST attempt's error: `MongoServerError` 112 `WriteConflict`, labelled `TransientTransactionError` |
 *
 * A classifier keyed on `instanceof MongoOperationTimeoutError` answers "not a timeout" for a timed-out batched
 * write — and the arrival writer then reads it as one document's refusal or a generic fault. Today
 * `brain/store-failure.ts` matches none of the six (P1's finding). Every shape is asserted, all or nothing.
 *
 * ## And what it must never take for a timeout
 *
 * `MongoInvalidArgumentError` — including the two the driver's own timeout machinery raises, whose messages say
 * "timeoutMS" and "Timeout": a misconfigured bound is a defect to surface, not a store that was slow. The plan
 * adds the other half: it is not a DOCUMENT's refusal either, so the arrival writer must not refuse a document by
 * id (and drop it from a sync page for good) because the bound itself was misused. `db/write-errors.ts` today
 * lists `MongoInvalidArgumentError` among the document-refusal NAMES, so that half is red on the base too.
 * A document's own invalid argument (a `$`-prefixed key) is out of scope here: it is not raised by the bound.
 *
 * The errors are built with the DRIVER'S OWN classes in exactly the shapes P1 recorded from the real store (name,
 * code, codeName, labels, message). The -db tests of the bound (`a-write-inside-a-seq-hold-always-ends-db`,
 * `a-write-timeout-answers-503-on-every-door-db`) put the real ones through the same path end to end.
 *
 * Run: node --test testing/standalone/a-write-timeout-is-told-from-every-other-failure.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  MongoOperationTimeoutError, MongoServerError, MongoBulkWriteError, MongoInvalidArgumentError,
} from 'mongodb';

const serverError = (fields, labels = []) => {
  const e = new MongoServerError({ ok: 0, ...fields });
  for (const l of labels) e.addErrorLabel(l);
  return e;
};
const bulkError = (fields) => new MongoBulkWriteError({ writeErrors: [], ...fields }, {});

/** Every shape P1 recorded when a bound ended a write — each MUST be a timeout. */
const TIMEOUTS = [
  ['MongoOperationTimeoutError (single-document write + timeoutMS)',
    () => new MongoOperationTimeoutError('Timed out during operation execution', {
      cause: serverError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'operation exceeded time limit' }) })],
  ['MongoServerError code 50 (any write + maxTimeMS)',
    () => serverError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'operation exceeded time limit' })],
  ['MongoBulkWriteError code 50 (bulkWrite / insertMany + maxTimeMS)',
    () => bulkError({ code: 50, codeName: 'MaxTimeMSExpired', message: 'operation exceeded time limit', errmsg: 'operation exceeded time limit' })],
  ['MongoBulkWriteError, no code: "Timed out during socket read" (bulkWrite + timeoutMS, client side)',
    () => bulkError({ message: 'Timed out during socket read (2000ms)' })],
  ['MongoBulkWriteError, no code: "Server reported a timeout error" (bulkWrite + timeoutMS, server side)',
    () => bulkError({ message: 'Server reported a timeout error' })],
  ['MongoServerError 112 WriteConflict, TransientTransactionError (withTransaction under a session timeout)',
    () => serverError({ code: 112, codeName: 'WriteConflict', errmsg: 'Write conflict during plan execution and yielding is disabled.' },
      ['TransientTransactionError'])],
];

/** The driver's own invalid-argument errors raised by the timeout machinery — never a timeout, never a document's. */
const BOUND_MISUSE = [
  ['MongoInvalidArgumentError: timeoutMS inside a withTransaction that has one',
    () => new MongoInvalidArgumentError('An operation cannot be given a timeoutMS setting when inside a withTransaction call that has a timeoutMS setting')],
  ['MongoInvalidArgumentError: a negative Timeout',
    () => new MongoInvalidArgumentError('Cannot create a Timeout with a negative duration')],
];

/** Failures that are not timeouts for other reasons — controls, so "everything is a timeout" cannot pass. */
const NOT_TIMEOUTS = [
  ['a duplicate key (a document\'s outcome)', () => bulkError({ code: 11000, message: 'E11000 duplicate key error collection: x index: _id_ dup key: { _id: "x" }' })],
  ['a validator refusing the document', () => serverError({ code: 121, codeName: 'DocumentValidationFailure', errmsg: 'Document failed validation' })],
  ['a step-down (a store failure, not a timeout)', () => serverError({ code: 11602, codeName: 'InterruptedDueToReplStateChange', errmsg: 'operation was interrupted' })],
  ['a plain Error that says "timed out" (not the driver\'s)', () => new Error('upstream timed out')],
];

let isWriteTimeout, isDocumentRefusal, loadError;

describe('a write timeout is told from every other failure', () => {
  before(async () => {
    try {
      ({ isWriteTimeout } = await import('../../server/dist/db/write-timeout.js'));
    } catch (err) { loadError = err; }
    ({ isDocumentRefusal } = await import('../../server/dist/db/write-errors.js'));
  });

  it('db/write-timeout.ts exports isWriteTimeout', () => {
    assert.equal(loadError, undefined, `server/dist/db/write-timeout.js could not be loaded: ${loadError?.message}`);
    assert.equal(typeof isWriteTimeout, 'function', 'db/write-timeout.ts exports no isWriteTimeout');
  });

  it('every shape a bound ended a write in is a timeout — all of them', () => {
    assert.equal(typeof isWriteTimeout, 'function', 'isWriteTimeout is not available');
    const missed = TIMEOUTS.filter(([, make]) => isWriteTimeout(make()) !== true).map(([label]) => label);
    assert.deepEqual(missed, [],
      'a timed-out write this does not recognise is answered as a refusal of the document or a generic fault, and '
      + 'the bound that ended it is invisible to the door that must answer 503');
  });

  it('a misuse of the bound is neither a timeout nor a document\'s refusal', () => {
    const asTimeout = typeof isWriteTimeout === 'function'
      ? BOUND_MISUSE.filter(([, make]) => isWriteTimeout(make()) !== false).map(([label]) => label) : ['isWriteTimeout is not available'];
    const asRefusal = BOUND_MISUSE.filter(([, make]) => isDocumentRefusal(make()) !== false).map(([label]) => label);
    assert.deepEqual({ asTimeout, asRefusal }, { asTimeout: [], asRefusal: [] },
      'an invalid argument raised by the bound is a defect in the bound: read as a timeout it is retried for ever, '
      + 'read as a document refusal the document is dropped from its sync page for good');
  });

  it('failures that are not timeouts are not called timeouts', () => {
    assert.equal(typeof isWriteTimeout, 'function', 'isWriteTimeout is not available');
    const wrong = NOT_TIMEOUTS.filter(([, make]) => isWriteTimeout(make()) !== false).map(([label]) => label);
    assert.deepEqual(wrong, []);
  });
});
