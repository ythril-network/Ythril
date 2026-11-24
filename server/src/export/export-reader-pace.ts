/**
 * How a streamed export answer waits on its reader, and when a reader is too slow to keep its export (bundle-269 review, finding 9; the first
 * drive with real requests, finding 7; the second drive, finding A).
 *
 * ## What it prevents
 *
 * - **A reader that holds a slot for ever.** Only two exports run on an instance. A reader that takes a little at a time never meets an idle
 *   bound, so a rate is asked of it: while the export waits on the reader, the reader must take at least `minBytesPerSecond` on average over
 *   each `windowMs` of such waiting. A reader below it is told ({@link PacedWriter.deliver} answers `slow`; the door writes the incomplete
 *   ending and frees the slot).
 * - **Counting what the buffers took as what the reader took.** What a server sees of its reader is what the operating system accepted
 *   (`bytesWritten` less what still waits in the socket's own buffer). The kernel's send buffer (and on loopback the reader's receive
 *   buffer, a few MiB together, not settable from Node for TCP) runs ahead of the reader, so between two arbitrary moments the accepted
 *   bytes are the reader's bytes plus whatever the buffers' fill changed by. The second drive measured over waits that began while the
 *   buffers were still filling: a megabyte accepted in a millisecond of waiting, so a reader that took nothing was not judged slow. Here
 *   the rate is measured only between FULL MOMENTS: a write the operating system refused in part (after the event-loop turn in which Node
 *   hands it over, `socket.writableLength` is still above zero; a write taken whole is answered synchronously and leaves nothing). At two
 *   full moments every buffer to the reader is full, so the bytes accepted between them are exactly what the reader took (within one
 *   slice). The window opens at the first full moment, so the fill of the buffers is never counted; it closes at the first full moment
 *   after `windowMs` of waiting. A store that is slow to answer makes the export wait on the store, never on its reader: that time is not
 *   counted.
 * - **Cutting a reader that is reading.** The kernel wakes a full socket only once a large part of its send buffer is free again (Linux:
 *   a third of it, about 1.4 MiB at its default ceiling of 4 MiB), so a reader shows no progress at all for that long: at 20 KiB/s over a
 *   minute, which is why the second drive's idle bound of 60 s cut readers above the rate. The idle bound (`idleMs`: no drain at all)
 *   must therefore exceed what one such step takes at the rate asked; production sets it to the window, five minutes, which covers a step
 *   of 4.7 MiB at 16 KiB/s. A reader that runs out the idle bound took less than one step in it, so it is below the rate: `idle` is
 *   answered, and the stream door treats it as `slow`.
 * - **A cut that tells the reader nothing.** The text is written a slice at a time ({@link SLICE_BYTES}) and the next slice only once the
 *   last was taken, so little waits above the socket when a reader is judged: the ending the door writes follows what the buffers hold.
 *   It reaches the kernel once the reader frees one more step; the door keeps the connection that long, up to {@link closeUnlessFinished}'s
 *   bound, and never destroys a connection whose ending is still in the server's own buffer before that bound (the drive's cut did: Node
 *   drops its own buffer on `destroy`, while the kernel still delivers what it holds, so the reader got everything but the ending).
 */
import type { Response } from 'express';
import { paceWindow, type PaceMark } from '../util/pace-window.js';

/** The text is handed to the connection in slices of this many bytes: Node's own buffer then holds at most about two of them. */
export const SLICE_BYTES = 16_384;

/** The rule a streamed export applies to its reader. */
export interface ReaderPace {
  /** How much waiting on the reader one judgement covers at least, in milliseconds (it closes at the first full moment after it). */
  windowMs: number;
  /** The least the reader must take while the export waits on it, on average over each window. */
  minBytesPerSecond: number;
  /** How long a connection may take nothing at all before the reader is judged, in milliseconds. */
  idleMs: number;
}

/** How a write ended: the reader took it, it is too slow (`slow`), it took nothing for the idle bound (`idle`), or it went away (`gone`). */
export type PutOutcome = 'taken' | 'slow' | 'idle' | 'gone';

/** Writes the text of one answer to its reader at the reader's pace, and judges the pace. */
export interface PacedWriter {
  /** Write `text`, waiting on the reader where it does not take it at once. */
  deliver(text: string): Promise<PutOutcome>;
}


/** What the connection under `res` has accepted: the bytes written to the socket less those still in its buffer. */
function acceptedBytes(res: Response): number {
  const socket = res.socket;
  return socket ? socket.bytesWritten - socket.writableLength : 0;
}

/**
 * Whether `res` drained (`drained`) or closed (`closed`) before `ms` passed, or neither (`waiting`); `'turn'` waits one turn of the event
 * loop instead (`setImmediate`: Node hands the corked slice to the operating system on the tick before it). Listeners and timer are removed.
 */
function drainedWithin(res: Response, ms: number | 'turn'): Promise<'drained' | 'closed' | 'waiting'> {
  return new Promise(resolve => {
    const settle = (how: 'drained' | 'closed' | 'waiting'): void => {
      if (ms === 'turn') clearImmediate(timer as NodeJS.Immediate); else clearTimeout(timer as NodeJS.Timeout);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(how);
    };
    const onDrain = (): void => settle('drained');
    const onClose = (): void => settle('closed');
    const timer = ms === 'turn' ? setImmediate(() => settle('waiting')) : setTimeout(() => settle('waiting'), ms);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/** A writer for `res` that applies `pace()` (read at each wait, so a test may change it). */
export function pacedWriter(res: Response, pace: () => ReaderPace): PacedWriter {
  /** All the time spent waiting on the reader, in milliseconds. */
  let waitedMs = 0;
  /**
   * The window over the full moments (the one rule an upload's sender is judged by too, `util/pace-window.ts`): it opens at the first full
   * moment, so the fill of the buffers is never counted.
   */
  const window = paceWindow(pace);
  const atFullMoment = (now: PaceMark): 'slow' | undefined => window.observe(now);

  async function waitForReader(): Promise<PutOutcome> {
    const started = Date.now();
    const done = (how: PutOutcome): PutOutcome => { waitedMs += Date.now() - started; return how; };
    const first = await drainedWithin(res, 'turn');
    if (first === 'closed' || res.destroyed) return done('gone');
    if (first === 'drained') return done('taken');
    // Refused in part: every buffer to the reader is full now.
    if ((res.socket?.writableLength ?? 0) > 0) {
      const verdict = atFullMoment({ bytes: acceptedBytes(res), waitedMs: waitedMs + (Date.now() - started) });
      if (verdict) return done(verdict);
    }
    const { idleMs } = pace();
    const how = await drainedWithin(res, Math.max(1, idleMs - (Date.now() - started)));
    if (how === 'closed' || res.destroyed) return done('gone');
    return done(how === 'drained' ? 'taken' : 'idle');
  }

  return {
    async deliver(text) {
      const bytes = Buffer.from(text, 'utf8');
      for (let at = 0; at < bytes.length; at += SLICE_BYTES) {
        if (res.destroyed || res.writableEnded) return 'gone';
        if (res.write(bytes.subarray(at, at + SLICE_BYTES))) continue;
        const how = await waitForReader();
        if (how !== 'taken') return how;
      }
      return 'taken';
    },
  };
}

/**
 * After the door ended an answer it had to cut short, give the reader `ms` to take the rest: the connection is destroyed only if the answer
 * has not been handed to the operating system whole (`finish`) by then. Not sooner: progress shows only in the kernel's large steps, and a
 * destroy drops what Node still holds, the ending first of all. Once handed over, the kernel delivers it even after the socket is closed.
 */
export function closeUnlessFinished(res: Response, ms: number): void {
  const timer = setTimeout(() => { if (!res.writableFinished && !res.destroyed) res.destroy(); }, ms);
  const stop = (): void => clearTimeout(timer);
  res.once('finish', stop);
  res.once('close', stop);
}
