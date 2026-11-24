/**
 * The close of a connection whose request body the server did not read to its end: half-close, read and discard what the sender still sends, up to
 * a byte bound and a time bound, then close (bundle-270, Q-953; the Full run 45431865235, attempt 2).
 *
 * ## What it prevents
 *
 * - **A refusal that a sender still sending never reads.** An answer that says `Connection: close` ends the connection as soon as it is flushed:
 *   Node's `resOnFinish` calls `socket.destroySoon()`, which closes the socket while the sender's bytes are still unread. The kernel then answers
 *   the sender's next bytes with a reset: its next write fails (`write EPIPE`), or the answer it was sent is dropped with the reset. The refusal
 *   of every upload door ({@link closeUnreadBody}: the 408s, 413, 415, 429, 409, 507 and a fault) reached a sender that had stopped sending, never
 *   one still sending at full speed. A lingering close ends our side only (the sender reads the answer, then the end of it) and keeps reading
 *   until the sender's body ends, so no reset is sent while it writes.
 * - **A request run on a socket that has answered its last.** Node's HTTP parser stays attached to the socket during the linger, and a request the
 *   sender pipelines behind its refused upload (after the end of the body, inside the window) would be parsed and run, with all its side effects, its
 *   answer lost on the ended socket: the sender may then retry a call that must run once (Q-953, review F1). The drain takes the socket's bytes
 *   from the parser: the lingering socket reads, counts and drops, and no byte of it reaches a request.
 * - **A socket held for a sender that never stops.** The drain is bounded twice: it reads no more than {@link LINGER_MAX_BYTES} after the answer
 *   and holds the socket no longer than {@link LINGER_MAX_MS}; a sender past either is cut as before. Both bounds are read when a drain starts
 *   (a test narrows them with {@link setLingerBoundsForTest}).
 *
 * The guard is inside: a connection is marked once, by replacing `destroySoon` on its socket, so Node's own close path is the one that lingers
 * and no door can answer a refusal without it. Never reads the body into memory: the bytes are counted and dropped.
 */
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

/**
 * The most the drain reads after the answer, in bytes. A refused sender has this much in flight when the answer is written (its kernel send
 * buffer and ours, a few megabytes on a fast link); eight mebibytes reads that out and a little more, and an upload that is still far from its
 * end is cut, since the answer it was sent is long read.
 */
export const LINGER_MAX_BYTES = 8 * 1024 * 1024;
/**
 * The longest the drain holds the socket after the answer, in milliseconds. Long enough for a sender to read the answer and stop on a slow link
 * (eight mebibytes at a megabit takes a minute, so a slower sender is cut by this bound), short enough that a sender which never stops holds a
 * connection for seconds, not for Node's request timeout.
 */
export const LINGER_MAX_MS = 5_000;

/** The bounds of a drain. */
export interface LingerBounds {
  /** The most bytes read after the answer. */
  maxBytes: number;
  /** The longest the socket is held after the answer, in milliseconds. */
  maxMs: number;
}

const PRODUCTION_BOUNDS: Readonly<LingerBounds> = Object.freeze({ maxBytes: LINGER_MAX_BYTES, maxMs: LINGER_MAX_MS });
let bounds: Readonly<LingerBounds> = PRODUCTION_BOUNDS;
/** Replace parts of the bounds (a test that needs them to bind in kilobytes and milliseconds); `null` restores production's. */
export function setLingerBoundsForTest(b: Partial<LingerBounds> | null): void {
  bounds = b ? Object.freeze({ ...PRODUCTION_BOUNDS, ...b }) : PRODUCTION_BOUNDS;
}

const marked = new WeakSet<Socket>();

/** Half-close `socket` once its answer is flushed, read and drop what the sender still sends within the bounds, then destroy it. */
function lingerThenDestroy(socket: Socket): void {
  const { maxBytes, maxMs } = bounds;
  let read = 0;
  const onData = (chunk: Buffer): void => {
    read += chunk.length;
    if (read > maxBytes) socket.destroy();
  };
  const timer = setTimeout(() => socket.destroy(), maxMs);
  timer.unref();
  // Our listener first, then the server's removed. Node feeds its parser straight from the socket's handle until a 'data' listener is added; adding
  // one hands the socket back, and the server's own listener then feeds every byte to the parser. Without the removal the parser goes on to
  // parse a request pipelined behind the refused one and runs it, its answer lost on the ended socket.
  socket.on('data', onData);
  for (const listener of socket.listeners('data') as Array<(...args: unknown[]) => void>) if (listener !== onData) socket.removeListener('data', listener);
  socket.once('close', () => { clearTimeout(timer); socket.off('data', onData); });
  // The answer is flushed first, then the end of our side is sent; the sender's end of its body (or the bound) closes the rest.
  socket.end();
}

/**
 * Make the close of `req`'s connection a lingering one: when its answer (which says `Connection: close`) is flushed, the connection is
 * half-closed and the rest of the body is read and dropped within the bounds, instead of closed on the spot. Idempotent per connection.
 */
export function lingerOnClose(req: IncomingMessage): void {
  const socket = req.socket;
  if (marked.has(socket)) return;
  marked.add(socket);
  socket.destroySoon = (): void => lingerThenDestroy(socket);
}
