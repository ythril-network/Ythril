/**
 * An upload read under the bounds a sender can break: its silence, its pace and its size (bundle-270, lens finding L7 and Q-953). The RDF
 * import, the schema-from-RDF door and the admin import read their bodies through it.
 *
 * ## What it prevents
 *
 * - **A slow or silent sender holding an import door for everyone.** Each of the three doors reads one upload at a time for the whole instance,
 *   so a sender that stops, or sends a byte now and then, kept every other caller out until Node's own request timeout (five minutes). A body
 *   that gives nothing for the idle bound is refused ({@link UploadStalled}); one that moves less than the rate over a window of the reader's
 *   waiting is refused ({@link UploadTooSlow}). The rule and the rate are the export's (`pace-window.ts`): only time spent waiting on the
 *   sender counts, so a slow consumer (the sort, the spool) never counts against it. The guard is inside, so no door reads an upload without it.
 * - **A refusal that cannot be answered.** The reader never destroys its source: it reads by `read()` and its own listeners, removed on every
 *   exit, so a door can still answer a client that is still sending (its own 413, 400 and 507 too), close the connection and drain the rest
 *   (`req.resume()`, which a `readable` listener left behind would block). The connection header and the drain are the door's.
 * - **A timer that outlives the upload, or a refusal that comes late.** One timer per wait, at whichever deadline comes first (the idle bound or
 *   the window's close; a tie is a stall), cleared on every exit; a consumer that fails while the reader waits aborts the wait through `signal`,
 *   so the failure is answered at once ({@link uploadReadable} wires it for a stream stage).
 * - **A blocked event loop judged as the sender's silence.** When a deadline fires, the reader gives the loop one turn (`setImmediate`, after
 *   the I/O that waited) and reads what arrived before judging.
 *
 * Each pace refusal writes one warn line naming the door, the refusal, the bytes received and the time waited, never the body.
 */
import { Readable } from 'node:stream';
import { MIN_TRANSFER_BYTES_PER_SECOND, paceWindow } from './pace-window.js';
import { log, peerText } from './log.js';

/**
 * How long an upload may send nothing before it is refused, in milliseconds. A minute is long past any pause a client that has the file in
 * hand makes between two chunks (a chunk is what its socket buffer holds: milliseconds), and short enough that a stalled sender is turned away
 * before callers give up.
 */
export const UPLOAD_IDLE_MS = 60_000;
/**
 * How much of the reader's waiting one judgement of the rate covers at least, in milliseconds. A minute: well under Node's request timeout
 * (five minutes), equal to the idle bound, and long enough for TCP's retransmission back-off on a lossy link. Unlike the export's reader, a
 * sender is not seen through a kernel send buffer that shows progress only in large steps, so the export's five minutes are not needed.
 */
export const UPLOAD_RATE_WINDOW_MS = 60_000;

/** The pace an upload is held to. */
export interface UploadPace {
  /** How long the sender may send nothing, in milliseconds. */
  idleMs: number;
  /** How much of the reader's waiting one judgement of the rate covers at least, in milliseconds. */
  windowMs: number;
  /** The least the sender must send while the reader waits on it, on average over each window. */
  minBytesPerSecond: number;
}

const PRODUCTION_PACE: Readonly<UploadPace> = Object.freeze({
  idleMs: UPLOAD_IDLE_MS, windowMs: UPLOAD_RATE_WINDOW_MS, minBytesPerSecond: MIN_TRANSFER_BYTES_PER_SECOND,
});
let pace: Readonly<UploadPace> = PRODUCTION_PACE;
/** The pace every upload is held to now (read at each wait, so a test's change reaches an upload already being read). */
export const uploadPace = (): Readonly<UploadPace> => pace;
/** Replace parts of the pace (a test that needs it to bind in milliseconds); `null` restores production's. */
export function setUploadPaceForTest(p: Partial<UploadPace> | null): void {
  pace = p ? Object.freeze({ ...PRODUCTION_PACE, ...p }) : PRODUCTION_PACE;
}

/** The upload sent nothing for the idle bound. */
export class UploadStalled extends Error {
  override readonly name = 'UploadStalled';
  constructor(readonly idleMs: number, readonly bytes: number, readonly waitedMs: number) { super('the upload sent nothing for the idle bound'); }
}

/** The upload sent less than the rate over a window of the reader's waiting. */
export class UploadTooSlow extends Error {
  override readonly name = 'UploadTooSlow';
  constructor(readonly minBytesPerSecond: number, readonly windowMs: number, readonly bytes: number, readonly waitedMs: number) {
    super('the upload sent less than the least rate over a window');
  }
}

/** The body is over the byte bound the door gave. */
export class UploadOverBound extends Error {
  override readonly name = 'UploadOverBound';
  constructor(readonly limit: number) { super('the body is over its byte bound'); }
}

/** The sender went away before the body ended (the connection closed). */
export class UploadGone extends Error {
  override readonly name = 'UploadGone';
  constructor() { super('the sender went away before the body ended'); }
}

/** How a door reads its upload. */
export interface UploadReadOptions {
  /** The door's name, for the warn line of a refusal. */
  door: string;
  /** The most bytes the body may hold; none when the door counts them itself. */
  max?: number;
  /** An idle bound of the door's own (a test's per-door knob); the pace's otherwise. */
  idleMs?: number;
  /** Aborted by the consumer when it fails: a pending wait settles at once. */
  signal?: AbortSignal;
}

type Chunk = Buffer | string;
type Waited = { kind: 'chunk'; chunk: Chunk } | { kind: 'end' } | { kind: 'idle' } | { kind: 'window' };

/**
 * The next chunk of `stream`, its end, or which deadline came first: `idleAt` or `windowAt` (epoch milliseconds; a tie is `idle`). Every
 * listener, the timer and the turn are removed before it settles. A failure of the stream rejects with it; a close before the end with
 * {@link UploadGone}; an abort with the signal's reason.
 */
function nextOf(stream: Readable, idleAt: number, windowAt: number | undefined, signal: AbortSignal | undefined): Promise<Waited> {
  return new Promise<Waited>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let turn: NodeJS.Immediate | undefined;
    const settle = (then: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (turn !== undefined) clearImmediate(turn);
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      then();
    };
    /** Settles with what the stream holds, if anything; answers whether it did. */
    const tryRead = (): boolean => {
      const chunk = stream.read() as Chunk | null;
      if (chunk !== null) { settle(() => resolve({ kind: 'chunk', chunk })); return true; }
      if (stream.readableEnded) { settle(() => resolve({ kind: 'end' })); return true; }
      return false;
    };
    const onReadable = (): void => { tryRead(); };
    const onEnd = (): void => settle(() => resolve({ kind: 'end' }));
    const onError = (err: Error): void => settle(() => reject(err));
    const onClose = (): void => {
      if (tryRead()) return;
      settle(() => reject(stream.errored ?? new UploadGone()));
    };
    const onAbort = (): void => settle(() => reject(signal?.reason ?? new Error('the upload\'s consumer gave up')));
    if (signal?.aborted) { reject(signal.reason ?? new Error('the upload\'s consumer gave up')); return; }
    if (stream.errored) { reject(stream.errored); return; }
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (tryRead()) return;
    if (stream.destroyed) { onClose(); return; }
    const idleFirst = windowAt === undefined || idleAt <= windowAt;
    const at = windowAt === undefined || idleFirst ? idleAt : windowAt;
    timer = setTimeout(() => {
      timer = undefined;
      // One turn of the loop before judging: data that waited behind a blocked loop is read in the poll phase before it.
      turn = setImmediate(() => {
        turn = undefined;
        if (settled || tryRead()) return;
        settle(() => resolve({ kind: idleFirst ? 'idle' : 'window' }));
      });
    }, Math.max(0, at - Date.now()));
  });
}

const bytesOf = (chunk: Chunk): number => (typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength);

/**
 * `body` as it arrives, refused when it stalls ({@link UploadStalled}), trickles ({@link UploadTooSlow}) or passes `max`
 * ({@link UploadOverBound}). A stream is read as it is and never destroyed; any other iterable is read through a stream of its own, which is.
 */
export async function* readUpload(body: Readable | AsyncIterable<Chunk>, options: UploadReadOptions): AsyncGenerator<Chunk, void, undefined> {
  const stream = body instanceof Readable ? body : Readable.from(body, { objectMode: true });
  const owned = stream !== body;
  const window = paceWindow(uploadPace);
  let bytes = 0;
  let waitedMs = 0;
  /** When the current silence began: the start, then each chunk's arrival. */
  let silentSince = Date.now();
  const refuse = (err: UploadStalled | UploadTooSlow): never => {
    const what = err instanceof UploadStalled ? 'stalled' : 'too slow';
    log.warn(`An upload to ${peerText(options.door)} was refused (${what}): ${bytes} bytes in ${Math.round(waitedMs)} ms of waiting`);
    throw err;
  };
  const tooSlow = (): never => refuse(new UploadTooSlow(uploadPace().minBytesPerSecond, uploadPace().windowMs, bytes, waitedMs));
  try {
    for (;;) {
      const idleMs = options.idleMs ?? uploadPace().idleMs;
      const started = Date.now();
      const left = window.remainingMs(waitedMs);
      const next = await nextOf(stream, silentSince + idleMs, left === undefined ? undefined : started + left, options.signal);
      waitedMs += Date.now() - started;
      if (next.kind === 'end') return;
      if (next.kind === 'idle') refuse(new UploadStalled(idleMs, bytes, waitedMs));
      if (next.kind === 'window') {
        if (window.observe({ bytes, waitedMs }) === 'slow') tooSlow();
        continue;
      }
      if (next.kind !== 'chunk') continue;
      silentSince = Date.now();
      bytes += bytesOf(next.chunk);
      if (options.max !== undefined && bytes > options.max) throw new UploadOverBound(options.max);
      if (window.observe({ bytes, waitedMs }) === 'slow') tooSlow();
      yield next.chunk;
    }
  } finally {
    if (owned) stream.destroy();
  }
}

/**
 * {@link readUpload} as a stream stage, for a door that pipes its upload (the admin import's spool). A later stage's failure destroys this one,
 * which aborts a pending wait at once, so the failure is answered then and not when the idle bound or the window runs out. The request under
 * it is never destroyed.
 */
export function uploadReadable(body: Readable, options: Omit<UploadReadOptions, 'signal'>): Readable {
  const consumer = new AbortController();
  const chunks = readUpload(body, { ...options, signal: consumer.signal });
  let pulling = false;
  return new Readable({
    read() {
      if (pulling) return;
      pulling = true;
      void (async () => {
        try {
          for (;;) {
            const r = await chunks.next();
            if (r.done) { this.push(null); return; }
            if (!this.push(r.value)) return;
          }
        } catch (err) {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        } finally {
          pulling = false;
        }
      })();
    },
    destroy(err, done) {
      consumer.abort(err ?? new Error('the stage was destroyed'));
      chunks.return(undefined).then(() => done(err), () => done(err));
    },
  });
}
