/**
 * A connection whose reply nobody will read is closed, never handed to the next operation (`Q-715`).
 *
 * ## The question it answers
 *
 * "Can a connection the driver gave up on, after it had already written the command, go back to the pool?" It cannot: the
 * server still answers that command, and the next operation on the connection would read that answer as its own.
 *
 * ## The defect it prevents
 *
 * A timed operation (the driver's `timeoutMS`: a read in a bound scope, a bounded transaction's statements, the seal and
 * the kill in `bounded-transaction.ts`, anything inheriting a `timeoutMS` from `MONGO_URI`) is checked once more AFTER its
 * command is on the wire: when what is left of its time is below the round trip the driver measured, it throws
 * `MongoOperationTimeoutError` "Server roundtrip time is greater than the time remaining" (mongodb 7.1.1
 * `lib/cmap/connection.js` `sendWire`; 7.8.0 is the same). That throw does not close the connection, and `Server.command`
 * checks it back into the pool with the reply unread. The driver never compares a reply's `responseTo` with the request
 * it sent, so from then on every operation on that connection reads the reply of the one before it: a write answered by
 * a read's reply (`ok: 1` with no count), a read by a write's (`BSON element "cursor" is missing`), until the connection
 * dies. Under load the check is crossed by a millisecond of clock between two lines, most readily by `withTransaction`
 * retrying a write conflict until its bound runs out (Full run 42240558711: eleven cases of one file, all one reply behind).
 *
 * ## What it does
 *
 * It wraps the driver's `Connection.prototype.sendWire` (the one method every command passes through, whatever sent it)
 * and, when that throws, closes the connection through the driver's own error path (`onError`, which a read timeout
 * already takes) only when the command left the socket (`bytesWritten` grew) and no reply was read for it, and the
 * command expects one (`moreToCome` unset). The error is rethrown as it came. A timeout raised before anything was
 * written closes nothing: that connection is healthy.
 *
 * ## Why it imports a driver file by path, and why that is not silent
 *
 * `Connection` is not exported from the package, so its file is imported by path, statically and by name (never through
 * `createRequire`, which `store-condition.ts` O9 refuses: a class reached that way "stops matching, silently, on the upgrade
 * that moves it"). Here nothing is silent: a moved file fails the import at boot, and the install THROWS when the class,
 * the method it wraps or the one it calls is missing, so an upgrade fails every client at construction and fails the test
 * (`a-connection-the-driver-gave-up-on-after-writing-is-never-reused-db.test.js`), rather than running unguarded. The
 * file's types are declared in `mongodb-connection.d.ts`, the driver shipping none for it.
 *
 * ## Where it is installed
 *
 * `mongoClientOptions` (`client-options.ts`) calls it, because every `new MongoClient(` in `server/src` takes its options
 * from there (`every-mongo-client-goes-through-mongo-client-options.test.js`): no client can be built without the guard.
 * Installing is idempotent; the prototype is shared by every client in the process.
 */
import * as driverConnection from 'mongodb/lib/cmap/connection.js';

/** The mark of an installed guard: `Symbol.for`, so a second copy of this module in one process sees the first's mark. */
const GUARDED: unique symbol = Symbol.for('ythril.abandonedReplyGuard');

/** The parts of the driver's connection the guard reads and calls. */
interface WireConnection {
  socket?: { bytesWritten?: number };
  closed?: boolean;
  onError(error: unknown): void;
}

type SendWire = (this: WireConnection, message: { moreToCome?: boolean }, ...rest: unknown[]) => AsyncGenerator<unknown, void, unknown>;

interface ConnectionPrototype {
  sendWire?: SendWire;
  onError?: unknown;
  [GUARDED]?: true;
}

function driverConnectionPrototype(): ConnectionPrototype {
  const loaded = driverConnection as unknown as { Connection?: { prototype: ConnectionPrototype } };
  if (!loaded.Connection) {
    throw new Error('abandoned-reply guard: mongodb/lib/cmap/connection.js exports no Connection; the driver moved it, and every client '
      + 'would run without the guard that keeps a timed-out command\'s reply from reaching the next operation');
  }
  return loaded.Connection.prototype;
}

/**
 * Install the guard on the driver's connection (or on `proto`, for a test). Idempotent. Throws when `sendWire` or `onError`
 * is missing: an unguarded client is never built without a word.
 */
export function guardAbandonedReplies(proto: ConnectionPrototype = driverConnectionPrototype()): void {
  if (proto[GUARDED]) return;
  const sendWire = proto.sendWire;
  if (typeof sendWire !== 'function' || typeof proto.onError !== 'function') {
    throw new Error('abandoned-reply guard: the driver connection has no sendWire/onError to guard; after this driver upgrade a command '
      + 'it gave up on after writing would leave its reply for the next operation on the connection to read');
  }
  proto.sendWire = async function* guardedSendWire(this: WireConnection, message, ...rest) {
    const written = this.socket?.bytesWritten ?? 0;
    let answered = false;
    try {
      for await (const reply of sendWire.call(this, message, ...rest)) {
        answered = true;
        yield reply;
      }
    } catch (error) {
      const sent = (this.socket?.bytesWritten ?? 0) > written;
      if (sent && !answered && message?.moreToCome !== true && this.closed !== true) this.onError(error);
      throw error;
    }
  };
  proto[GUARDED] = true;
}
