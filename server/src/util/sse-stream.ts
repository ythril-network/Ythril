/**
 * One Server-Sent Events stream, opened with its bounds inside it (`Q-108`).
 *
 * ## Why a module
 *
 * Two handlers stream SSE — the brain change feed and the admin log tail — and both were written the same way: write
 * headers, subscribe, `res.write` every event, heartbeat every 30 s. Neither capped how many were open (the change
 * bus lifted its listener warning with `setMaxListeners(0)`) and neither read `res.write`'s back-pressure, so a
 * reader that stopped reading had every later event queued for it in this process's memory, indefinitely.
 *
 * ## The two guards a hand-written copy drops
 *
 * - **A count per stream kind** (`MAX_SSE_CONNECTIONS`). The 201st open is refused `503` with `Retry-After` before a
 *   header is written; a closed stream frees its slot.
 * - **A byte bound per reader** (`SSE_MAX_BUFFERED_BYTES`). A send that finds more than that already queued CLOSES
 *   the stream instead of adding to it. The client reconnects with a fresh ticket (the Brain page does it on its own;
 *   the log tab stops and the operator restarts it), and both feeds are "something changed, re-read" signals, so a
 *   reconnect loses nothing a re-read does not restore — where buffering for a reader that never drains loses the
 *   process.
 *
 * The heartbeat and the unsubscribe-on-close live here too, so a third stream cannot forget either.
 */
import type { Request, Response } from 'express';
import { MAX_SSE_CONNECTIONS, SSE_MAX_BUFFERED_BYTES } from './request-bounds.js';

const open = new Map<string, number>();

export interface EventStream {
  /** Write one already-framed SSE chunk (`data: …\n\n`). Closes the stream when the reader is too far behind. */
  send(chunk: string): void;
  /** Register what to undo when the stream ends (an unsubscribe). Runs once, whichever side closes. */
  onClose(fn: () => void): void;
}

export interface EventStreamOptions {
  /** The stream kind the connection count is kept for — one pool per feed. */
  pool: string;
  maxConnections?: number;
  maxBufferedBytes?: number;
  heartbeatMs?: number;
}

/** How many streams of `pool` are open — for tests and for a status readout. */
export function openStreams(pool: string): number {
  return open.get(pool) ?? 0;
}

/**
 * Open a stream on `res`, or refuse it with `503` and return null when `pool` is full.
 */
export function openEventStream(req: Request, res: Response, opts: EventStreamOptions): EventStream | null {
  const max = opts.maxConnections ?? MAX_SSE_CONNECTIONS;
  const maxBuffered = opts.maxBufferedBytes ?? SSE_MAX_BUFFERED_BYTES;
  const count = open.get(opts.pool) ?? 0;
  if (count >= max) {
    res.setHeader?.('Retry-After', '30');
    res.status(503).json({ error: `at most ${max} live event streams of this kind may be open at once; try again shortly` });
    return null;
  }
  open.set(opts.pool, count + 1);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n'); // open the stream

  const cleanups: (() => void)[] = [];
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      open.set(opts.pool, Math.max(0, (open.get(opts.pool) ?? 1) - 1));
      for (const fn of cleanups) { try { fn(); } catch { /* one cleanup failing must not strand the others */ } }
    } finally {
      // Whatever the way out of the body above, the keepalive does not outlive the stream.
      clearInterval(heartbeat);
    }
  };

  const send = (chunk: string): void => {
    if (closed) return;
    if (res.destroyed) { close(); return; }
    if (res.writableLength > maxBuffered) {
      // The reader is not reading. Closing is the bound; the client's reconnect is the recovery.
      close();
      res.end();
      return;
    }
    res.write(chunk);
  };

  // A plain `setInterval`, and the ONE exemption from `util/interval-job.ts` (`Q-317`): this timer is the lifetime of ONE connection
  // (created here, cleared in `close`'s `finally`), its tick is a synchronous write and so cannot overlap itself, and it touches no
  // database. An interval job's single-flight, housekeeping bound, throttled lines and registry label would each answer a question
  // nobody asked of a keepalive, once per open stream.
  const heartbeat = setInterval(() => send(':\n\n'), opts.heartbeatMs ?? 30_000);
  heartbeat.unref?.();
  req.on('close', close);

  return { send, onClose: fn => { if (closed) fn(); else cleanups.push(fn); } };
}
