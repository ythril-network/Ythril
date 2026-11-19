/**
 * How a streamed export answer waits on its reader, and when a reader is too slow to keep its export (bundle-269 review, finding 9; the first
 * drive with real requests, finding 7).
 *
 * ## What it prevents
 *
 * - **A reader that holds a slot for ever.** Only two exports run on an instance. A reader that takes a little at a time never meets the idle
 *   bound, so a rate is asked of it: while the export WAITS on the reader (a write its connection did not take at once), the connection must
 *   accept at least `minBytesPerSecond` on average, judged over each `windowMs` of such waiting. A reader below it is told
 *   ({@link PacedWriter.put} answers `slow`, and the door writes the incomplete ending) and its slot is freed.
 * - **A rate that measures the wrong thing.** What a server can see of its reader is what the operating system accepted from the socket
 *   (`bytesWritten` less what still waits in the socket's own buffer); what the reader has actually received is not visible above the kernel,
 *   whose send buffer (a few MiB, sized by the kernel and not settable from Node for TCP) runs ahead of it. The drive measured an average of
 *   the bytes `write` had taken since the start: the first few MiB went into that buffer at once, so the bound saw nothing of a slow reader
 *   for minutes. Here the export is measured only while it waits, and it waits only once every buffer between it and the reader is full, so
 *   what the connection accepts during a wait is what the reader takes. A store that is slow to answer makes the export wait on the store,
 *   never on its reader, and is not counted against it.
 * - **A cut that tells the reader nothing.** The text is written a slice at a time ({@link SLICE_BYTES}) and the next slice only once the
 *   last was taken, so little waits above the socket when a reader is judged too slow: the incomplete ending the door then writes reaches
 *   it behind what its connection already holds, instead of the drive's cut by the idle bound with the final chunk missing.
 * - **A reader that takes nothing.** No drain for `idleMs` answers `idle`: no ending can be written to a socket that takes nothing, so the
 *   door cuts the connection (a chunked answer without its final chunk, which every HTTP client reports as broken).
 */
import type { Response } from 'express';

/** The text is handed to the connection in slices of this many bytes: Node's own buffer then holds at most about two of them. */
export const SLICE_BYTES = 16_384;

/** The rule a streamed export applies to its reader. */
export interface ReaderPace {
  /** How much waiting on the reader one judgement covers, in milliseconds. */
  windowMs: number;
  /** The least the connection must accept while the export waits on it, on average over each `windowMs` of waiting. */
  minBytesPerSecond: number;
  /** How long a connection may take nothing at all before it is cut, in milliseconds. */
  idleMs: number;
}

/** How a write ended: the reader took it, it is too slow (`slow`), it took nothing for the idle bound (`idle`), or it went away (`gone`). */
export type PutOutcome = 'taken' | 'slow' | 'idle' | 'gone';

/** Writes the text of one answer to its reader at the reader's pace, and judges the pace. */
export interface PacedWriter {
  /** Write `text`, waiting on the reader where it does not take it at once. */
  put(text: string): Promise<PutOutcome>;
}

const MS_PER_SECOND = 1_000;

/** What the connection under `res` has accepted: the bytes written to the socket less those still in its buffer. */
function acceptedBytes(res: Response): number {
  const socket = res.socket;
  return socket ? socket.bytesWritten - socket.writableLength : 0;
}

/** Whether `res` drained before `ms` passed (`drained`), closed first (`closed`), or neither (`waiting`); listeners and timer are removed. */
function drainedWithin(res: Response, ms: number): Promise<'drained' | 'closed' | 'waiting'> {
  return new Promise(resolve => {
    const settle = (how: 'drained' | 'closed' | 'waiting'): void => {
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(how);
    };
    const onDrain = (): void => settle('drained');
    const onClose = (): void => settle('closed');
    const timer = setTimeout(() => settle('waiting'), ms);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/** A writer for `res` that applies `pace()` (read at each wait, so a test may change it). */
export function pacedWriter(res: Response, pace: () => ReaderPace): PacedWriter {
  let waitedMs = 0;
  let waitedBytes = 0;

  async function waitForReader(): Promise<PutOutcome> {
    const started = Date.now();
    for (;;) {
      const { windowMs, minBytesPerSecond, idleMs } = pace();
      const before = { at: Date.now(), bytes: acceptedBytes(res) };
      const until = Math.min(windowMs - waitedMs, idleMs - (before.at - started));
      const how = await drainedWithin(res, Math.max(until, 1));
      const now = Date.now();
      waitedMs += now - before.at;
      waitedBytes += Math.max(0, acceptedBytes(res) - before.bytes);
      if (how === 'closed' || res.destroyed) return 'gone';
      if (waitedMs >= windowMs) {
        const slow = waitedBytes * MS_PER_SECOND < minBytesPerSecond * waitedMs;
        waitedMs = 0;
        waitedBytes = 0;
        if (slow) return 'slow';
      }
      if (how === 'drained') return 'taken';
      if (now - started >= idleMs) return 'idle';
    }
  }

  return {
    async put(text) {
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
 * After the door ended an answer it had to cut short, keep the connection only while the reader still takes something: no progress for
 * `idleMs` closes it. Stops when the answer is handed to the operating system whole (`finish`) or the connection closes.
 */
export function closeIfStalled(res: Response, idleMs: number): void {
  let last = acceptedBytes(res);
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => { if (timer) clearTimeout(timer); };
  const check = (): void => {
    if (res.writableFinished || res.destroyed) return;
    const now = acceptedBytes(res);
    if (now === last) { res.destroy(); return; }
    last = now;
    timer = setTimeout(check, idleMs);
  };
  res.once('finish', stop);
  res.once('close', stop);
  timer = setTimeout(check, idleMs);
}
