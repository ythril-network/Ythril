/**
 * An RDF door's upload, read through the one upload reader (`util/upload-reader.ts`: its size, its silence and its pace) with the reader's
 * refusals as RDF reader errors (bundle-270, lens finding L7 and Q-953).
 *
 * ## What it prevents
 *
 * - **A bound's refusal worded as a failed upload.** The RDF reader's source catch words any error of its source that is not one of its own
 *   ({@link RdfParseError}) as `rdf_source_failed`: the body bound's 413 was answered as a 400 failed upload until it passed through as it is.
 *   Each refusal of the upload reader is therefore rethrown here as an `RdfParseError` of its own class, which `rdf/rdf-document.ts` answers
 *   with its own status and code. Every RDF door reads its upload through {@link counted}, so none can drop the mapping.
 * - **Everything else** (the stall, the trickle, the timer, a request that must not be destroyed so the door can answer it) is the upload
 *   reader's, and its docblock says what it prevents. The MCP tools take their documents inline, as one chunk, so nothing of the pace reaches them.
 */
import { RdfParseError } from './parse.js';
import { readUpload, UploadOverBound, UploadStalled, UploadTooSlow } from '../util/upload-reader.js';

/** The body is over the door's byte bound: answered 413 naming it. */
export class BodyTooLarge extends RdfParseError {
  constructor(readonly limit: number) { super('rdf_bound_exceeded', 'the body is over the import body bound'); }
}

/** The upload gave nothing for the idle bound: answered 408 with its own code, and the door is freed. */
export class RdfUploadStalled extends RdfParseError {
  constructor(readonly idleMs: number) { super('rdf_source_failed', 'the upload sent nothing for the idle bound'); }
}

/** The upload sent less than the least rate over a window of the reader's waiting: answered 408 with its own code, and the door is freed. */
export class RdfUploadTooSlow extends RdfParseError {
  constructor(readonly minBytesPerSecond: number, readonly windowMs: number) { super('rdf_source_failed', 'the upload sent too slowly'); }
}

/**
 * `body` read by the upload reader for the door named `door`, counted against `max` bytes; `idleMs` is a test's own idle bound for the door
 * (left out, the upload pace's applies, and its test knob with it).
 */
export async function* counted(
  body: AsyncIterable<Uint8Array | string>, max: number, door: string, idleMs?: number,
): AsyncGenerator<Uint8Array | string, void, undefined> {
  try {
    yield* readUpload(body as AsyncIterable<Buffer | string>, { door, max, ...(idleMs === undefined ? {} : { idleMs }) });
  } catch (err) {
    if (err instanceof UploadStalled) throw new RdfUploadStalled(err.idleMs);
    if (err instanceof UploadTooSlow) throw new RdfUploadTooSlow(err.minBytesPerSecond, err.windowMs);
    if (err instanceof UploadOverBound) throw new BodyTooLarge(err.limit);
    throw err;
  }
}
