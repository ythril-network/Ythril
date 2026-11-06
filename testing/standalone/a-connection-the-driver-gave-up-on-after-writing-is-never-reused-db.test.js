/**
 * A connection the driver gave up on after it had written a command is never handed to another operation (`Q-715`,
 * `db/abandoned-reply-guard.ts`).
 *
 * ## The defect
 *
 * A timed operation (the driver's `timeoutMS`: a read in a bound scope, a bounded transaction's statements, the seal, the
 * kill) is checked once more AFTER its command is on the wire: when what is left of its time is below the round trip the
 * driver measured, it throws `MongoOperationTimeoutError` "Server roundtrip time is greater than the time remaining"
 * (mongodb 7.1.1 `lib/cmap/connection.js` `sendWire`, unchanged in 7.8.0). That throw does not close the connection, and
 * the pool takes it back with the server's reply still unread. The driver never compares a reply's `responseTo` with the
 * request it sent, so the NEXT operation on that connection reads the abandoned reply as its own, and every one after it
 * reads one reply behind: a `find` answered `BSON element "cursor" is missing`, an update answered with no `nModified`, a
 * `currentOp` with no `inprog`. That was Full run 42240558711: 11 cases of
 * `a-bounded-transaction-ends-and-holds-no-horizon-db.test.js`, from the case where `withTransaction` retries a write
 * conflict until a 2 s scope ends and one retry crossed the check.
 *
 * ## The rule this file holds
 *
 * - After a timeout raised once the command was written, the next operation gets ITS OWN reply, and the timeout is still
 *   thrown to its caller as it came.
 * - A timeout raised BEFORE anything was written closes nothing (control: the connection is healthy, and dropping it
 *   would cost a reconnect for nothing).
 * - The guard refuses to install where the driver method it wraps is missing, so a driver upgrade that moves it fails at
 *   boot and here, never running unguarded; and installing twice wraps once.
 *
 * ## How the timeout is made to happen on demand
 *
 * The real trigger is a clock crossing between two checks a microsecond apart, which a test cannot time. The fixture
 * reaches the SAME branch deterministically: it wraps `Connection.prototype.writeCommand`, and for the one armed command
 * raises the timeout context's measured round trip above what is left (after the write for the defect, before it for the
 * control). Everything else is the driver's own code. The client is built from `mongoClientOptions`, as every server
 * client is (`every-mongo-client-goes-through-mongo-client-options.test.js`), with one connection in its pool so the next
 * operation is certain to get the same connection.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-connection-the-driver-gave-up-on-after-writing-is-never-reused-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const DB = 'abandonedreply';
const COLL = 'docs';
const req = createRequire(new URL('../../server/package.json', import.meta.url));

let client, docs, Connection, clientOptions;
/** The fault armed for the next timed command: 'after' the write (the defect), 'before' it (the control), or null. */
let armed = null;
let originalWriteCommand;
const closed = [];

/** Raise the measured round trip above what is left of the timeout, so the driver's own check throws. */
function exhaust(timeoutContext) { timeoutContext.minRoundTripTime = 1e9; }

describe('a connection the driver gave up on after writing is never reused', { skip }, () => {
  before(async () => {
    const { MongoClient } = req('mongodb');
    ({ Connection } = req('mongodb/lib/cmap/connection.js'));
    clientOptions = await import('../../server/dist/db/client-options.js');
    originalWriteCommand = Connection.prototype.writeCommand;
    Connection.prototype.writeCommand = async function writeCommandWithFault(command, options) {
      const timed = options?.timeoutContext?.csotEnabled?.() === true;
      const fault = timed ? armed : null;
      if (fault) armed = null;
      if (fault === 'before') exhaust(options.timeoutContext);
      await originalWriteCommand.call(this, command, options);
      if (fault === 'after') exhaust(options.timeoutContext);
    };
    const uri = testMongoUri(DB);
    client = new MongoClient(uri, { ...clientOptions.mongoClientOptions(uri), maxPoolSize: 1 });
    client.on('connectionClosed', (e) => closed.push(e.reason));
    docs = client.db(DB).collection(COLL);
    await docs.deleteMany({});
    await docs.insertMany([{ _id: 'a', marker: 'A' }, { _id: 'b', marker: 'B' }, { _id: 'c', marker: 'C' }]);
  });

  after(async () => {
    if (originalWriteCommand) Connection.prototype.writeCommand = originalWriteCommand;
    await client?.db(DB).dropDatabase().catch(() => {});
    await client?.close();
  });

  it('after a timeout raised once the command was written, the next operation gets its own reply, and the timeout still reaches its caller', async () => {
    armed = 'after';
    const first = await docs.updateOne({ _id: 'a' }, { $set: { touched: true } }, { timeoutMS: 5_000 }).then(
      () => 'answered', (err) => err);
    assert.equal(armed, null, 'fixture: the armed fault never met a timed command, so nothing was asked');
    assert.equal(first?.name, 'MongoOperationTimeoutError',
      `the timed update was answered ${first === 'answered' ? 'as a success' : `${first?.name}: ${first?.message}`}, not with the timeout the driver raised: the guard must not swallow it`);
    let second;
    try { second = await docs.findOne({ _id: 'b' }); } catch (err) { second = err; }
    assert.ok(!(second instanceof Error),
      `the read after the timed-out update failed with ${second?.name}: ${second?.message}. The connection the driver gave up on went back to the pool `
      + 'with the update\'s reply unread, and the read took that reply as its own (the driver never checks responseTo).');
    assert.equal(second?.marker, 'B', `the read of b was answered ${JSON.stringify(second)}: a reply that belongs to another command`);
    const third = await docs.findOne({ _id: 'c' });
    assert.equal(third?.marker, 'C', `the read after it was answered ${JSON.stringify(third)}: the replies are still one behind`);
  });

  it('control: a timeout raised before anything was written closes no connection', async () => {
    const closedBefore = closed.length;
    armed = 'before';
    const first = await docs.updateOne({ _id: 'a' }, { $set: { touchedAgain: true } }, { timeoutMS: 5_000 }).then(
      () => 'answered', (err) => err);
    assert.equal(armed, null, 'fixture: the armed fault never met a timed command, so nothing was asked');
    assert.equal(first?.name, 'MongoOperationTimeoutError', `the timed update was answered ${first === 'answered' ? 'as a success' : first?.message}`);
    assert.equal((await docs.findOne({ _id: 'b' }))?.marker, 'B', 'the read after a timeout that wrote nothing got a reply that is not its own');
    assert.deepEqual(closed.slice(closedBefore), [],
      'a connection was closed although the timed-out command never reached the socket: that drops a healthy connection and costs a reconnect for nothing');
  });

  it('refuses to install where the driver method it wraps is missing, and wraps once when installed twice', async () => {
    const guard = await import('../../server/dist/db/abandoned-reply-guard.js').catch((err) => {
      throw new Error(`server/dist/db/abandoned-reply-guard.js cannot be loaded (${err.message}): the guard does not exist yet`);
    });
    assert.throws(() => guard.guardAbandonedReplies({ onError() {} }), /sendWire/,
      'a prototype without sendWire was accepted: after a driver upgrade that moves it, every client would run unguarded without a word');
    const sendWire = async function* original() { yield 'reply'; };
    const proto = { sendWire, onError() {} };
    guard.guardAbandonedReplies(proto);
    const once = proto.sendWire;
    guard.guardAbandonedReplies(proto);
    assert.notEqual(once, sendWire, 'the guard did not wrap sendWire');
    assert.equal(proto.sendWire, once, 'a second install wrapped the wrapper again');
  });
});
