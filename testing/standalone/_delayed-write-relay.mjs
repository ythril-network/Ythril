/**
 * A TCP relay in front of the test Mongo that makes a chosen command ARRIVE LATE — by a fixed delay on every bounded write
 * (`Q-372`), or held by hand until the test releases it (`Q-530`) — and that tells the test what the server answered to a
 * message it held.
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
 * A command that arrives after its client has given up altogether is the second defect it reproduces (`Q-530`): a
 * transaction the bound ended whose statement — or commit — reaches the server afterwards opens or ends a transaction
 * no caller owns. A fixed delay cannot order that against what the code under test does next; a HOLD can: the test
 * holds the message, lets the code run to its answer, and releases the message when the case says so.
 *
 * ## Its two ways of making a command late
 *
 * - **`setDelay(ms)`**: every write command carrying `maxTimeMS` waits `ms` on the client-to-server direction. Nothing
 *   else is delayed — a seed, a wipe, a lock, a read, the driver's heartbeats (a delayed heartbeat would raise the
 *   round-trip time the driver subtracts, and the server's deadline would move back to where the client's is).
 * - **`hold(match, { nth, count })`**: the `nth` command for which `match(command)` is true, and the `count - 1` after it,
 *   are held until released by hand. `match` is handed the decoded command document (`lsidHex` names its session). Each
 *   held message carries `release()` and `reply`, a promise of the server's answer to THAT message once it is released —
 *   the latch a case awaits instead of a sleep. A message not released is released by `releaseAll()`, or dropped by
 *   `close()`.
 * - **`record(match)`**: every command for which `match` is true, in the order the client sent them — to count what the
 *   code under test sent (a seal, a kill) without holding it.
 *
 * ## The guards a hand-written copy drops
 *
 * - **Message order on a connection.** A delayed or held message that a later one overtakes is a protocol error the
 *   server answers by closing the connection. Every message of a connection is chained behind the one before it, so a
 *   held message holds back what its connection sent after it (and nothing on any other connection).
 * - **A held message outliving its client.** A driver that gives up destroys the socket; with `deliverAfterClientCloses`
 *   the relay still delivers what that client sent (`_tcp-relay.mjs` `clientClose: 'deliver'`), and keeps the upstream
 *   open until the server has answered every message it held — otherwise the "late" message is dropped and the case
 *   proves nothing.
 * - **A reply paired by request id across clients.** The reply to a held message is matched by `responseTo` on the SAME
 *   connection only (the relay's per-connection object), never in a table every connection shares.
 *
 * ## What it does not do
 *
 * It does not change what the server does with a command, and it never alters, drops or delays a reply: replies are
 * passed on as they come, and only READ to resolve `reply`. It reads the wire format far enough to name the command; a
 * message it cannot read (the handshake, a compressed one) is passed on at once.
 *
 * The relay itself (listen, dial the store, pipe both ways, reset on close) is `_tcp-relay.mjs`; what is written here is
 * only what happens to the bytes on their way: framing, the delay, the hold, the record, and the order.
 */
import { startTcpRelay } from './_tcp-relay.mjs';
import { elapse } from '../_shared/sleep.mjs';

const OP_MSG = 2013;
/** The commands a bound can end: a delay on a read would only slow the test down. */
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify', 'findandmodify']);

/** The session id of a command's (or a session's) `lsid`, as hex — or `undefined` when it has none. */
export function lsidHex(lsid) {
  const id = lsid?.id;
  if (!id?.buffer) return undefined;
  // A BSON Binary (a UUID is one): `buffer` holds the bytes, `position` how many of them are the value.
  return Buffer.from(id.buffer).subarray(0, id.position ?? id.buffer.length).toString('hex');
}

/**
 * Start a relay to `{ host, port }`.
 *
 * @param {{ host: string, port: number, deliverAfterClientCloses?: boolean }} opts `deliverAfterClientCloses`: a client's
 *   close still delivers what it sent (see the docblock); default false, a closed client's held bytes are dropped
 * @returns {Promise<{ port: number, setDelay: (ms: number) => void, delayedWrites: () => number,
 *   hold: (match: (command: object) => boolean, opts?: { nth?: number, count?: number }) => HoldHandle,
 *   record: (match: (command: object) => boolean) => { commands: object[], stop: () => void },
 *   releaseAll: () => HeldMessage[], close: () => Promise<void> }>}
 *   `port` is the relay's own (use it in place of the real one); `delayedWrites` counts the commands it held back by `setDelay`
 *
 * @typedef {{ command: object, release: () => void, released: () => boolean, reply: Promise<object|undefined> }} HeldMessage
 *   `reply` resolves with the server's decoded answer, or `undefined` when the connection ended without one
 * @typedef {{ held: HeldMessage[], first: Promise<HeldMessage>, whenHeld: (k: number) => Promise<HeldMessage>,
 *   disarm: () => void, releaseAll: () => void }} HoldHandle
 *   `whenHeld(k)` is the k-th message this hold took (1-based); `disarm` stops it taking more
 */
export async function startDelayedWriteRelay({ host, port, deliverAfterClientCloses = false }) {
  const { BSON } = await import('mongodb');
  let delayMs = 0;
  let delayed = 0;
  /** Armed holds, in arming order: the first whose turn has come takes a matching message. */
  const holds = new Set();
  const recorders = new Set();
  /** Every held message not yet released, so `releaseAll` and `close` leave none behind. */
  const unreleased = new Set();

  /** The command document of a message, or `null` when it is not one this relay reads. */
  function commandOf(message) {
    if (message.length < 26 || message.readInt32LE(12) !== OP_MSG) return null;
    if (message[20] !== 0) return null; // the body is section kind 0; anything else is not one we read
    try {
      return BSON.deserialize(message.subarray(21, 21 + message.readInt32LE(21)));
    } catch {
      return null;
    }
  }

  /** The delay this message gets: `delayMs` for a write command carrying `maxTimeMS`, else none. */
  function delayFor(command) {
    if (delayMs === 0 || command === null) return 0;
    return WRITE_COMMANDS.has(Object.keys(command)[0]) && typeof command['maxTimeMS'] === 'number' ? delayMs : 0;
  }

  /** The hold that takes this command, counting it against every armed hold it matches — or `null`. */
  function holdFor(command) {
    if (command === null) return null;
    let taker = null;
    for (const h of holds) {
      let matches = false;
      try { matches = h.match(command) === true; } catch { matches = false; }
      if (!matches) continue;
      h.seen += 1;
      if (taker === null && h.seen >= h.nth && h.taken < h.count) taker = h;
    }
    return taker;
  }

  const relay = await startTcpRelay({
    host,
    port,
    clientClose: deliverAfterClientCloses ? 'deliver' : 'reset',
    // Built per connection: the framing buffer, the ordering chain and the replies awaited belong to ONE client's stream.
    clientToServer: (forward, connection) => {
      let pending = Buffer.alloc(0);
      let chain = Promise.resolve();
      connection.awaiting ??= new Map();
      const replies = [];
      connection.drained = () => chain.then(() => Promise.all(replies));
      return (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
          const message = pending.subarray(0, pending.readInt32LE(0));
          pending = pending.subarray(message.length);
          const command = commandOf(message);
          for (const r of recorders) {
            try { if (r.match(command ?? {}) === true && command !== null) r.commands.push(command); } catch { /* a recorder's own error records nothing */ }
          }
          const hold = holdFor(command);
          let gate;
          if (hold) {
            let release;
            gate = new Promise((resolve) => { release = resolve; });
            const requestId = message.readInt32LE(4);
            const reply = new Promise((resolve) => connection.awaiting.set(requestId, resolve));
            replies.push(reply);
            let isReleased = false;
            const held = {
              command,
              reply,
              released: () => isReleased,
              release: () => { if (!isReleased) { isReleased = true; unreleased.delete(held); release(); } },
            };
            unreleased.add(held);
            hold.taken += 1;
            hold.held.push(held);
            hold.notify();
          }
          const wait = hold ? 0 : delayFor(command);
          if (wait > 0) delayed += 1;
          chain = chain
            .then(() => gate)
            .then(() => (wait > 0 ? elapse(wait, 'simulated latency: the relay holds a bounded write back so it reaches the server late') : undefined))
            .then(() => forward(message));
        }
      };
    },
    // Replies pass as they come; they are only READ, to resolve the `reply` of a message this relay held.
    serverToClient: (forward, connection) => {
      let pending = Buffer.alloc(0);
      connection.awaiting ??= new Map();
      return (chunk) => {
        forward(chunk);
        // Framed always, not only while a reply is awaited: a frame boundary skipped once misreads every length after it.
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 16 && pending.length >= pending.readInt32LE(0)) {
          const message = pending.subarray(0, pending.readInt32LE(0));
          pending = pending.subarray(message.length);
          const answered = connection.awaiting.get(message.readInt32LE(8));
          if (answered) {
            connection.awaiting.delete(message.readInt32LE(8));
            answered(commandOf(message) ?? undefined);
          }
        }
      };
    },
  });

  return {
    port: relay.port,
    setDelay(ms) { delayMs = ms; },
    delayedWrites: () => delayed,
    hold(match, { nth = 1, count = 1 } = {}) {
      const waiters = [];
      const h = {
        match, nth, count, seen: 0, taken: 0, held: [],
        notify() { for (const w of waiters.splice(0)) if (h.held.length >= w.k) w.resolve(h.held[w.k - 1]); else waiters.push(w); },
      };
      holds.add(h);
      const whenHeld = (k) => (h.held.length >= k ? Promise.resolve(h.held[k - 1]) : new Promise((resolve) => waiters.push({ k, resolve })));
      return {
        held: h.held,
        first: whenHeld(1),
        whenHeld,
        disarm: () => holds.delete(h),
        releaseAll: () => { for (const m of h.held) m.release(); },
      };
    },
    record(match) {
      const r = { match, commands: [] };
      recorders.add(r);
      return { commands: r.commands, stop: () => recorders.delete(r) };
    },
    /** Disarm every hold and release every message still held; returns what it released, so a caller can await their replies. */
    releaseAll() { holds.clear(); const released = [...unreleased]; for (const m of released) m.release(); return released; },
    async close() { holds.clear(); recorders.clear(); unreleased.clear(); await relay.close(); },
  };
}
