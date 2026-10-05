/**
 * A TCP relay in front of the test Mongo that makes a BOUNDED write ARRIVE LATE — the one condition under which the
 * write bound's two clocks disagree by a measurable amount, produced on demand (`Q-372`).
 *
 * ## What it reproduces, and why a relay is the only honest way
 *
 * A bounded write has two deadlines: the driver's own (`timeoutMS`, started when the operation starts) and the
 * server's (`maxTimeMS`, which the driver computes from what is left when it BUILDS the command and subtracts the
 * round-trip time it has measured). When the server receives the command promptly the two are within a millisecond of
 * each other and which fires first is jitter — the race in main's CI run 37231507558 was that jitter going the CI way
 * once, and a test cannot be red on jitter. When the command arrives LATE, the server's deadline is that much later than
 * the client's: the client gives up and the door answers `503` while the server operation is still alive, for exactly as
 * long as the lateness. That window is the defect (the write lands after the answer), widened to a size a test can act
 * inside.
 *
 * The lateness is a delay on the CLIENT-to-server direction of the commands the bound itself put a `maxTimeMS` on, and
 * only those: a seed, a wipe, a lock, a read and the `abortTransaction` that releases a lock go through at once, and so
 * do the driver's own heartbeats — a delayed heartbeat would raise the round-trip time the driver subtracts, and the
 * server's deadline would move back to where the client's is.
 *
 * ## The guard a hand-written copy drops
 *
 * **Message order on a connection.** A delayed message that a later undelayed one overtakes is a protocol error the
 * server answers by closing the connection. Every message of a connection is chained behind the one before it.
 *
 * ## What it does not do
 *
 * It does not change what the server does with a command, and it does not touch replies. It only reads the wire format
 * far enough to name the command and see whether `maxTimeMS` is on it; a message it cannot read (the handshake, a
 * compressed one) is passed on at once.
 *
 * The relay itself (listen, dial the store, pipe both ways, reset on close) is `_tcp-relay.mjs`; what is written here is
 * only what happens to the client's bytes on their way: framing, the delay, and the order.
 */
import { startTcpRelay } from './_tcp-relay.mjs';

const OP_MSG = 2013;
/** The commands a bound can end: a delay on a read would only slow the test down. */
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify', 'findandmodify']);

/**
 * Start a relay to `{ host, port }`.
 *
 * @returns {Promise<{ port: number, setDelay: (ms: number) => void, delayedWrites: () => number, close: () => Promise<void> }>}
 *   `port` is the relay's own (use it in place of the real one); `delayedWrites` counts the commands it held back
 */
export async function startDelayedWriteRelay({ host, port }) {
  const { BSON } = await import('mongodb');
  let delayMs = 0;
  let delayed = 0;

  /** The delay this message gets: `delayMs` for a write command carrying `maxTimeMS`, else none. */
  function delayFor(message) {
    if (delayMs === 0 || message.length < 26 || message.readInt32LE(12) !== OP_MSG) return 0;
    if (message[20] !== 0) return 0; // the command is section kind 0; anything else is not one we read
    try {
      const command = BSON.deserialize(message.subarray(21, 21 + message.readInt32LE(21)));
      const name = Object.keys(command)[0];
      return WRITE_COMMANDS.has(name) && typeof command['maxTimeMS'] === 'number' ? delayMs : 0;
    } catch {
      return 0;
    }
  }

  const relay = await startTcpRelay({
    host,
    port,
    // Built per connection: the framing buffer and the ordering chain belong to ONE client's stream.
    clientToServer: (forward) => {
      let pending = Buffer.alloc(0);
      let chain = Promise.resolve();
      return (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
          const message = pending.subarray(0, pending.readInt32LE(0));
          pending = pending.subarray(message.length);
          const wait = delayFor(message);
          if (wait > 0) delayed += 1;
          chain = chain.then(() => (wait > 0 ? new Promise(r => setTimeout(r, wait)) : undefined))
            .then(() => forward(message));
        }
      };
    },
  });
  return {
    port: relay.port,
    setDelay(ms) { delayMs = ms; },
    delayedWrites: () => delayed,
    close: relay.close,
  };
}
