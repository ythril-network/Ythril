/**
 * A document whose own write the database DRIVER refuses as an invalid argument is refused alone, with a bounded
 * reason — and an argument error that is not the document's fails the page (bundle-30, stage I1 finding (a)).
 *
 * ## The rule
 *
 * Since bundle-30 a `MongoInvalidArgumentError` is no document refusal in `isDocumentRefusal`: it names the CALL's
 * arguments, and the bound this instance puts on every operation inside a seq hold makes the driver raise it for a
 * misused bound too — a defect of ours that, read as a refusal, dropped a peer's document from its sync page for
 * good. But read as the page's, a document that really does raise it (after the wire schema let it through) failed
 * the whole page on every send, for ever: the sender re-offers the same page each cycle and nothing after it lands.
 *
 * The arrival writer tells the two apart where it can: on ONE document's own write (its per-document fallback) the
 * call's arguments are that document plus the options every other document shares, so
 *  - an argument error naming the bound's machinery (`timeoutMS`, a negative `Timeout`) is OURS: the page fails;
 *  - any other argument error refuses that document, with a reason bounded in length, and the rest lands;
 *  - the same error from EVERY document of a chunk of several is the call's, not theirs: the page fails.
 *
 * ## How the error is made
 *
 * The driver's own collection methods are wrapped for one id (`POISON`): its write throws the case's error before
 * anything is sent, exactly where the driver raises an argument error. Everything else is the real push door.
 *
 * Run: node --test testing/standalone/a-document-the-driver-refuses-is-refused-alone-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoInvalidArgumentError } from 'mongodb';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'argrefused';
const POISON = 'fact-poison';
const DOC_MESSAGE = `a value the driver cannot send ${'x'.repeat(5000)}`;
const BOUND_MESSAGE = 'An operation cannot be given a timeoutMS setting when inside a withTransaction call that has a timeoutMS setting';

let door, proto, saved, writeErrors;

/** Make every write of the ids in `poisoned` to `<S>_facts` throw `make()`; a bulk write naming one throws too. */
function poison(poisoned, make) {
  const ids = new Set(poisoned);
  const named = (filter) => ids.has(filter?._id);
  proto.bulkWrite = async function bulkWrite(ops, ...rest) {
    if (this.collectionName === `${S}_facts` && ops.some(op => named(op.updateOne?.filter))) throw make();
    return saved.bulkWrite.call(this, ops, ...rest);
  };
  proto.updateOne = async function updateOne(filter, ...rest) {
    if (this.collectionName === `${S}_facts` && named(filter)) throw make();
    return saved.updateOne.call(this, filter, ...rest);
  };
}

const stored = async (id) => door.coll(S, 'facts').findOne({ _id: id });

describe('a document the driver refuses is refused alone', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'argrefused', spaces: [{ id: S, label: 'Arg', folders: [], meta: {} }] });
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    saved = { bulkWrite: proto.bulkWrite, updateOne: proto.updateOne };
    writeErrors = await import('../../server/dist/db/write-errors.js');
  });
  afterEach(() => { Object.assign(proto, saved); });
  after(async () => { if (proto) Object.assign(proto, saved); await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the classifier tells the bound\'s argument error from a document\'s', () => {
    const bound = new MongoInvalidArgumentError(BOUND_MESSAGE);
    const negative = new MongoInvalidArgumentError('Cannot create a Timeout with a negative duration');
    const own = new MongoInvalidArgumentError(DOC_MESSAGE);
    assert.equal(writeErrors.isBoundArgumentError(bound), true);
    assert.equal(writeErrors.isBoundArgumentError(negative), true);
    assert.equal(writeErrors.isArgumentErrorOfOneWrite(bound), false, 'the bound\'s error is never a document\'s');
    assert.equal(writeErrors.isArgumentErrorOfOneWrite(negative), false);
    assert.equal(writeErrors.isArgumentErrorOfOneWrite(own), true);
    assert.equal(writeErrors.isDocumentRefusal(own), false, 'a whole write\'s failure still never reads it as a refusal');
    assert.equal(writeErrors.isArgumentErrorOfOneWrite(new Error(DOC_MESSAGE)), false, 'only the driver\'s argument error');
  });

  it('batch: the document is refused alone with a bounded reason, and the rest of the page lands', async () => {
    poison([POISON], () => new MongoInvalidArgumentError(DOC_MESSAGE));
    const r = await door.push('/batch-upsert', { facts: [build.fact(S, 'fact-good', 5), build.fact(S, POISON, 6)] }, { spaceId: S });
    assert.equal(r.code, 200, `the whole page failed over one document: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.facts.rejected, 1, JSON.stringify(r.body));
    assert.ok(await stored('fact-good'), 'the document beside it did not land');
    assert.equal(await stored(POISON), null);
  });

  it('single: a page of one answers 400 with a bounded reason, never a 500 the sender repeats for ever', async () => {
    poison([POISON], () => new MongoInvalidArgumentError(DOC_MESSAGE));
    const r = await door.push('/facts', build.fact(S, POISON, 6), { spaceId: S });
    assert.equal(r.code, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /invalid argument/);
    assert.ok(r.body.error.length < 400, `the reason is not bounded: ${r.body.error.length} characters`);
    // Bundle-30 I5: the driver's message is quoted through `peerText`, so the cut says it was made.
    assert.match(r.body.error, /…\(\+\d+ chars\)/, `the driver's message was cut without saying so: ${r.body.error}`);
  });

  it('the bound\'s own argument error fails the page — a defect of ours, never a document dropped for good', async () => {
    poison([POISON], () => new MongoInvalidArgumentError(BOUND_MESSAGE));
    const r = await door.push('/batch-upsert', { facts: [build.fact(S, 'fact-good', 5), build.fact(S, POISON, 6)] }, { spaceId: S });
    assert.equal(r.code, 500, `the bound's argument error was read as the document's: ${JSON.stringify(r.body)}`);
  });

  it('the same argument error from every document of a chunk is the call\'s: the page fails', async () => {
    poison([POISON, 'fact-poison-2'], () => new MongoInvalidArgumentError(DOC_MESSAGE));
    const r = await door.push('/batch-upsert', { facts: [build.fact(S, POISON, 5), build.fact(S, 'fact-poison-2', 6)] }, { spaceId: S });
    assert.equal(r.code, 500, `every document refusing alike was read as each document's fault: ${JSON.stringify(r.body)}`);
  });
});
