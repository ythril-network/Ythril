/**
 * Whether an export answer carries HTTP trailers, decided once, and the only place a `Trailer` header is declared or trailers are added.
 *
 * ## What it prevents
 *
 * **A request that ends the server.** Node refuses a `Trailer` header on an answer that is not chunked: it throws
 * `ERR_HTTP_TRAILER_INVALID` while writing the headers, the error handler's own answer meets the same header and throws again in an event
 * callback, and the process handler ends the process on that uncaught exception (bundle-269 drive, findings 1 and 2: a `HEAD` and an
 * HTTP/1.0 `GET` of the records export each did). An answer is chunked only when the request is HTTP/1.1 or later (HTTP/1.0 has no chunked
 * coding, RFC 9112 §7.1) and it carries content (a `HEAD` answer has none, RFC 9110 §9.3.2). {@link trailersFor} asks both before the
 * headers are sent and declares nothing otherwise; its `send` adds the trailers only when they were declared, so no caller can declare or
 * send one on an answer that cannot carry it. A reader whose answer carries none reads the same facts in the document's own ending.
 *
 * `a-trailer-is-declared-only-on-a-chunked-answer.test.js` refuses `addTrailers` or a `Trailer` header anywhere else in `server/src`.
 */

/** What decides whether an answer is chunked: the request's method and HTTP version. */
export interface TrailerRequest { method: string; httpVersionMajor: number; httpVersionMinor: number }
/** The response calls this module makes. */
export interface TrailerResponse { headersSent: boolean; setHeader(name: string, value: string): unknown; addTrailers(trailers: Record<string, string>): void }

/** The trailers of one answer: whether they are carried, and how to send their values at the end. */
export interface AnswerTrailers {
  /** The answer is chunked and declared `Trailer:`; when false, nothing is declared and `send` does nothing. */
  readonly carried: boolean;
  /** Add the trailers' values (call once, just before `end`); nothing when they are not carried. */
  send(values: Record<string, string>): void;
}

/** The first HTTP version with the chunked coding (RFC 9112 §7.1). */
const CHUNKED_SINCE = { major: 1, minor: 1 };

/** Whether `req`'s answer is chunked: HTTP/1.1 or later, and a method whose answer carries content. */
function answerIsChunked(req: TrailerRequest): boolean {
  const version = req.httpVersionMajor > CHUNKED_SINCE.major
    || (req.httpVersionMajor === CHUNKED_SINCE.major && req.httpVersionMinor >= CHUNKED_SINCE.minor);
  return version && req.method.toUpperCase() !== 'HEAD';
}

/**
 * Declare the trailers `names` on `res` when its answer can carry them (call before the first write), and hand back how to send them.
 * An answer whose headers are already sent declares nothing.
 */
export function trailersFor(req: TrailerRequest, res: TrailerResponse, names: readonly string[]): AnswerTrailers {
  const carried = names.length > 0 && !res.headersSent && answerIsChunked(req);
  if (carried) res.setHeader('Trailer', names.join(', '));
  return {
    carried,
    send(values) {
      if (carried) res.addTrailers(values);
    },
  };
}
