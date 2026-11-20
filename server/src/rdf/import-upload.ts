/**
 * An RDF import's upload, read under the two bounds a sender can break: its size and its silence (bundle-270, lens finding L7).
 *
 * ## What it prevents
 *
 * - **A stalled sender holding the door for everyone.** The import door reads one file at a time for the whole instance and answers every other import 409
 *   `rdf_import_busy` while it does, so a sender that stops holds the import for everyone; only Node's own request timeout (five minutes) ended it.
 *   {@link counted} refuses ({@link UploadStalled}) a body that gives nothing for {@link RDF_IMPORT_UPLOAD_IDLE_MS}, and the guard is inside, so no caller can read
 *   an upload without it. The MCP tool takes its document inline, as one chunk, so it has no upload to stall; both doors answer the refusal alike because it is
 *   the act's.
 * - **A refusal that cannot be answered.** Closing a request destroys its socket, so a stalled source is not closed (the door answers on its socket and ends the
 *   connection), while every other exit (the end, a failure, a body over its bound, the consumer giving up) closes it as `for await` would.
 * - **A bound's refusal worded as a failed upload.** Both refusals are reader errors ({@link RdfParseError}), because the reader's source catch words any other
 *   error of the source as `rdf_source_failed`: the body bound's 413 was answered as a 400 failed upload until it passed through as it is.
 */
import { RdfParseError } from './parse.js';

/**
 * How long an upload may send nothing before it is refused (`rdf_import_upload_stalled`), in milliseconds. A minute is long past any pause a client that has the
 * file in hand makes between two chunks (a chunk is what its socket buffer holds: milliseconds), and short enough that a stalled sender is turned away before
 * callers give up. It bounds a silence, not a slow upload: the export's counterpart bounds a slow reader by a rate as well, which a writer of a file does not need
 * (the file is bounded by `importBodyMaxBytes` and the sort's bounds, and a slow sender holds only the door, not the store).
 */
export const RDF_IMPORT_UPLOAD_IDLE_MS = 60_000;

/** The body is over the import body bound (`importBodyMaxBytes`): answered 413 naming it. */
export class BodyTooLarge extends RdfParseError {
  constructor(readonly limit: number) { super('rdf_bound_exceeded', 'the body is over the import body bound'); }
}

/** The upload gave nothing for the idle bound: answered 400 with its own code, and the door is freed. */
export class UploadStalled extends RdfParseError {
  constructor(readonly idleMs: number) { super('rdf_source_failed', 'the upload sent nothing for the idle bound'); }
}

const IDLE = Symbol('idle');

/** The next chunk of `it`, or `IDLE` when it does not come within `ms` (its late answer is dropped, a late failure with it). */
function nextWithin<T>(it: AsyncIterator<T>, ms: number): Promise<IteratorResult<T> | typeof IDLE> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(IDLE), ms);
    timer.unref();
    it.next().then(r => { clearTimeout(timer); resolve(r); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

/** `body` counted against `max` bytes as it arrives, and refused ({@link UploadStalled}) when it gives nothing for `idleMs`. */
export async function* counted(
  body: AsyncIterable<Uint8Array | string>, max: number, idleMs: number = RDF_IMPORT_UPLOAD_IDLE_MS,
): AsyncGenerator<Uint8Array | string, void, undefined> {
  const it = body[Symbol.asyncIterator]();
  let n = 0;
  let sourceEnded = false;
  try {
    for (;;) {
      let next: IteratorResult<Uint8Array | string> | typeof IDLE;
      try { next = await nextWithin(it, idleMs); } catch (err) { sourceEnded = true; throw err; }
      if (next === IDLE) { sourceEnded = true; throw new UploadStalled(idleMs); }
      if (next.done) { sourceEnded = true; return; }
      const chunk = next.value;
      n += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (n > max) throw new BodyTooLarge(max);
      yield chunk;
    }
  } finally {
    if (!sourceEnded) await it.return?.();
  }
}
