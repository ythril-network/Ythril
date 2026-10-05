/**
 * The ONE way a maintainer script reads a response body into memory: with a cap, refusing past it.
 *
 * ## The question it answers
 *
 * "How do I read what a server I do not control sent back, without holding all of it if it is endless?" Asked by the
 * Ythril client (an answer) and by the GitHub client of the recorder (a JSON page, an artifact zip).
 *
 * ## What it prevents
 *
 * The cap is the one line a hand-written read leaves out. `await res.text()` and `await res.arrayBuffer()` hold the
 * whole body, and a script that polls a public API reads whatever the other end decides to send. Both clients wrote
 * the same loop (sum the chunk lengths, throw past a cap, `Buffer.concat`) and the third script to read a body would
 * have written it without the cap. Here the cap is not optional: a call without a positive finite one throws, so
 * "read it all" cannot be asked for by leaving an argument out.
 *
 * When the cap is crossed the loop stops and the body is cancelled (leaving a `for await` by `throw` cancels the
 * stream), so a refused answer is not still being downloaded behind the error.
 *
 * The error a caller wants differs (`YthrilApiError` carries a status and a tool, the GitHub client throws a plain
 * `Error` naming the path), so the caller states it with `refuse`; the default is {@link BodyTooLargeError}.
 *
 * ## What it is not
 *
 * Not a stream-to-file download: `benchmarks/dataset-pin.mjs` hashes a body as it writes it, with no cap and no buffer.
 * That is a verified download, and it never holds the body in memory.
 */

/** A body longer than the cap it was read under. `cap` is that cap in bytes. */
export class BodyTooLargeError extends Error {
  constructor(cap) {
    super(`answer larger than ${cap} bytes`);
    this.name = 'BodyTooLargeError';
    this.cap = cap;
  }
}

/**
 * @param {{ body?: AsyncIterable<Uint8Array> | null }} res a fetch `Response` (or anything with an async-iterable `body`)
 * @param {number} cap the most bytes to read: a positive finite number of bytes, never absent
 * @param {{ refuse?: (cap: number) => Error }} [opts] builds the error thrown past the cap
 * @returns {Promise<Buffer>} the whole body; empty when the response has none
 */
export async function readCappedBody(res, cap, { refuse = (limit) => new BodyTooLargeError(limit) } = {}) {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) throw new TypeError('readCappedBody needs a cap in bytes: a positive, finite number');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > cap) throw refuse(cap);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
