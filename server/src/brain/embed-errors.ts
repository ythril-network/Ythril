/**
 * The embed failures the server itself builds, the ONE verdict every caller asks of a caught failure (`classifyEmbedFailure`), and the
 * one place that knows what "the embedding process was lost" looks like as TEXT.
 *
 * ## One verdict, by class and status, never by an endpoint's words
 *
 * An embed failure the server built is an object whose class and fields say who produced it: `EmbeddingHttpError` (an HTTP answer, with its
 * status), `EmbedUnreachableError` (the connection never landed), `LostChildError` (the inference process was lost), `OverCeilingError`
 * (a stored passage is over the ceiling). `classifyEmbedFailure` decides a failure's fate from those alone. The message of an
 * `EmbeddingHttpError` holds the endpoint's own body, text a third party writes, so it is never asked for words: a 400 whose body says
 * `timeout` or `embedding process lost` is the record's own failure, as any 400 is.
 *
 * ## Why a string still has to carry this at all
 *
 * A failure from the bundled embedder crosses a process boundary, then the queue (`failEmbedJob`), and only its message
 * survives it when the child supplied the text: for a failure whose producer cannot be known (a child's text in a plain `Error`, a
 * string), the verdict is decided by words, through `isTransientEmbedError`, and only as a wait: a string can never end a job or count
 * a crash. This module owns the words it recognises. A failure whose producer IS known keeps its class all the way to the queue, and
 * the class is the proof.
 *
 * ## Why the marker is written once
 *
 * The text is read by the queue (a needle), written by the host (`LostChildError`) and shown to an operator in
 * `lastError`. Three places, one literal: rename the message in one of them and the queue silently stops retrying
 * crashes. `embed-failures-are-classified-by-who-produced-them.test.js` holds that this file is the only source
 * containing the words.
 *
 * ## Why only the HOST can make one
 *
 * The child supplies error strings too (a tokenizer failure, an input it refuses), and a string is a string: one
 * that happened to contain the marker would make a record look like it had crashed the runtime, and one
 * containing a needle such as `timeout` would make an input look transient. So two rules, both in this file so a
 * caller cannot keep one without the other:
 *
 *  - `isLostChildError` answers for an error OBJECT the host constructed (`LostChildError`). A message that merely
 *    reads like one is not one.
 *  - `withoutLostMarker` is applied to every string that comes FROM the child before it becomes part of an error,
 *    so the marker text cannot survive into a message the queue will read.
 *
 * This module imports nothing, on purpose: the queue, the embed call, the host and the tests all import it, and none of them should
 * drag anything in by doing so (which is also why the words rule and the status sets live here and not in the queue).
 */

/**
 * The words the queue recognises AND COUNTS against a record. Lower case, because the queue matches on a lower-cased
 * message. Carried only by the request the process was holding when it was lost: that is the one input that can have
 * killed it.
 */
export const LOST_MARKER = 'embedding process lost';

/**
 * The words for a request the lost process had NOT been sent: queued behind the one in flight, arriving during the
 * respawn backoff, or waiting while the model loaded. Transient, like `LOST_MARKER`, and never counted.
 *
 * ## Why this is a second marker and not a flag
 *
 * The queue sees only the message, so the difference has to be in the words. One marker for both was the bystander
 * defect: with `embedConcurrency` above one, a record queued behind a poison record was rejected with the same text
 * on every crash, charged the same crash, and ended `failed` beside it after three. It must not CONTAIN
 * `LOST_MARKER`, or the queue would count it anyway; `embed-failures-are-classified-by-who-produced-them.test.js`
 * holds that.
 */
export const NOT_SENT_MARKER = 'embedding process unavailable';

/**
 * The inference process ended without answering — it exited, crashed, was killed, or stopped answering — and what
 * it held was rejected. Only the host constructs this, and only the host knows `inFlight`, so neither can be spoofed
 * by text a child supplies.
 *
 * `detail` says how it ended (`code=139 signal=null`), because the queue ends a record on the third one and an
 * operator reading `lastError` needs to see the crash, not just that there was one. `inFlight: false` (the request
 * was never sent to the process that was lost) gives the message `NOT_SENT_MARKER` instead of `LOST_MARKER`.
 */
export class LostChildError extends Error {
  readonly inFlight: boolean;
  constructor(detail: string, opts: { inFlight?: boolean } = {}) {
    const inFlight = opts.inFlight ?? true;
    super(inFlight
      ? `${LOST_MARKER} (${detail})`
      : `${NOT_SENT_MARKER}: it was lost before this request was sent (${detail})`);
    this.name = 'LostChildError';
    this.inFlight = inFlight;
  }
}

/** Did the HOST raise this? True only for a `LostChildError`; never for something that reads like one. */
export function isLostChildError(err: unknown): err is LostChildError {
  return err instanceof LostChildError;
}

/**
 * The embed call could not REACH its HTTP endpoint: the connection was refused or reset, there was no route, the name did not resolve, or the connection or the
 * call timed out (`isConnectionFailure` in `util/socket-failure.ts`, asked where the fetch's failure is caught, `brain/embedding.ts`). That is the embedder's
 * failure and never the record's, so a job that meets it keeps its attempts and waits (an `outage` of `classifyEmbedFailure`).
 *
 * ## Why an object and not words
 *
 * The message is the sentence an operator has always been shown, word for word, and it holds none of the needles `isTransientEmbedError` reads, which is how an
 * outage once spent five attempts on every queued job. The fact that it was an outage is carried by the CLASS: `isEmbedUnreachableError` is by `instanceof` alone,
 * as `isLostChildError` is, so a plain `Error` or a string with the same sentence (an endpoint's body, a child's text, a refused address) is not one.
 *
 * It carries no `code` and no `cause` on purpose: a door that catches it answers a write that needs the vector as it always did (`400`, this sentence), and a
 * socket code on the chain would make `answerForCaught` answer `502`.
 */
export class EmbedUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedUnreachableError';
  }
}

/** Did the embed call raise this? True only for an `EmbedUnreachableError`; never for something that reads like one. */
export function isEmbedUnreachableError(err: unknown): err is EmbedUnreachableError {
  return err instanceof EmbedUnreachableError;
}

/** Both markers, each matched across any run of whitespace, each defused by hyphenating it. */
const MARKERS_ANYWHERE = [LOST_MARKER, NOT_SENT_MARKER]
  .map(marker => ({ pattern: new RegExp(marker.replace(/ /g, '\\s+'), 'gi'), defused: marker.replace(/ /g, '-') }));

/** `text` with both markers' words defused, for any string a child process supplied. */
export function withoutLostMarker(text: string): string {
  return MARKERS_ANYWHERE.reduce((out, { pattern, defused }) => out.replace(pattern, defused), text);
}

/**
 * A refusal from the embedding endpoint, carrying enough to decide whether trying again is sensible: the HTTP `status` is what the
 * verdict reads, and `body` is the endpoint's own text, which nothing decides by.
 *
 * The message is unchanged from what it was — `Embedding request failed (HTTP 429): …` — because operators
 * have that string in their runbooks and their logs, and it is what a caller shows a requester.
 *
 * It lives here and not in `embedding.ts` (which re-exports it, so `instanceof` holds across both import paths) because the verdict
 * reads it and this module imports nothing.
 */
export class EmbeddingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** From `Retry-After`, when the server sent one and it was a number we can act on. */
    readonly retryAfterMs: number | null,
  ) {
    super(`Embedding request failed (HTTP ${status}): ${body}`);
    this.name = 'EmbeddingHttpError';
  }
}

/** The HTTP status for a payload the endpoint refuses as too large. */
const PAYLOAD_TOO_LARGE_STATUS = 413;

/**
 * Statuses where trying again INSIDE one embed call is the right move, and nothing else (`embedViaHttpWithRetry`).
 *
 * A 400 or a 413 means the REQUEST is wrong and will be wrong every time — retrying it burns the caller's
 * deadline to arrive at the same answer more slowly. A 401 retried is a lockout waiting to happen. Smaller than
 * {@link WAIT_EMBED_STATUSES} on purpose: a call inside a recall has a deadline, a queued job does not.
 */
export const BUSY_EMBED_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Statuses of an endpoint that is not available NOW, for which a queued job waits instead of spending its attempts: the busy ones, a
 * request timeout (408), an endpoint that is overloaded (529), and a proxy that could not reach or was not answered by its origin (520 to
 * 524, and 530). Every other status spends the budget, a 500 among them; 525 to 527 are certificate and handshake faults of a
 * configuration, which waiting does not cure.
 */
export const WAIT_EMBED_STATUSES: ReadonlySet<number> = new Set([...BUSY_EMBED_STATUSES, 408, 520, 521, 522, 523, 524, 529, 530]);

/**
 * Why a stored passage is not embedded: its text (the heading and the body) is `bytes` long and the embedder takes `ceiling`.
 * It was stored before the ceiling existed (or by a conversion at a higher one); cutting it would leave the passage `complete` with
 * most of its text unfindable by meaning, so it is refused with the act that cures it: re-converting its file splits it into parts.
 *
 * Thrown where the passage is found over the ceiling (`embedStoredRecord`), and known by its CLASS: the verdict ends the job at once
 * and never reads the message, so a child's text that began with these words is not this.
 */
export class OverCeilingError extends Error {
  constructor(bytes: number, ceiling: number) {
    super(`This passage is larger than the embedder accepts (${bytes} bytes, ceiling ${ceiling}). Re-convert its file to split it: retry_embed_file, or POST /api/files/<space>/retry_embedding?path=<file>.`);
    this.name = 'OverCeilingError';
  }
}

/**
 * Is this failure, of no class the server built, the embedder's to be waited out? Asked only by {@link classifyEmbedFailure}, for a failure
 * whose producer cannot be known: an inference child process's text, a string. Reachability and availability: the connection never
 * landed, or the far end said "not now".
 *
 * A `400` or `422` is NOT here, and that is the whole point of keeping a budget at all — a malformed input is exactly the per-record
 * failure `attempts` exists to bound. Retrying it for ever would replace one silent failure mode with another: a job that never completes
 * and never gives up. An HTTP answer is not asked this at all: its class and status say it (`WAIT_EMBED_STATUSES`).
 */
export function isTransientEmbedError(message: string): boolean {
  const m = message.toLowerCase();
  return [
    // A crashed inference process, raised by the host. Words can only make it a wait: counting a crash is by class.
    LOST_MARKER,
    // A request queued behind that crash, never sent to the process that died: a wait too.
    NOT_SENT_MARKER,
    'econnrefused', 'econnreset', 'etimedout', 'ehostunreach', 'enetunreach', 'eai_again', 'enotfound',
    'socket hang up', 'fetch failed', 'network error', 'timeout', 'timed out',
    'too many requests', 'service unavailable', 'bad gateway', 'gateway timeout', 'temporarily unavailable',
    ' 429', ' 502', ' 503', ' 504', 'status 429', 'status 502', 'status 503', 'status 504',
  ].some(needle => m.includes(needle));
}

/**
 * The text of a caught embed failure: an `Error`'s message, or the string it is. The one derivation, so `lastError` and the words rule see
 * the same text. It is never `peerText(err)` of the object, which would prefix the class name.
 */
export function embedFailureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** Why a job ended at once: the embedder refused the request as too large, or the stored passage is over the ceiling. */
export type EmbedEndReason = 'refused_413' | 'over_ceiling';

/**
 * What a caught embed failure MEANS for the job it ended.
 *
 *  - `lost`: the request the inference process was holding when it was lost: counted per record, and ends a job on the third;
 *  - `ends`: nothing a retry changes: the job ends at once, with its reason;
 *  - `outage`: the embedder is not available: the job waits and keeps its attempts. `proven` says the class or the status told it, and
 *    not words;
 *  - `record`: the record's (or the settings') own failure: it spends the attempt budget.
 */
export type EmbedVerdict =
  | { kind: 'lost' }
  | { kind: 'ends'; reason: EmbedEndReason }
  | { kind: 'outage'; proven: boolean }
  | { kind: 'record' };

/**
 * THE one answer to "whose failure is this, and what does it cost the job?", asked by the embed queue (`failEmbedJob`), by the rebuild rule
 * (`embedStoredRecord`) and by the media queue (`isEmbedderUnavailable`), so they cannot disagree.
 *
 * Decided by the object and its status, in this order, and never by words an endpoint wrote:
 *
 *  1. a `LostChildError`: `lost` when it was in flight, a proven outage when the request was never sent to the lost process;
 *  2. an `EmbeddingHttpError`: 413 `ends` (`refused_413`); a status of {@link WAIT_EMBED_STATUSES} is a proven outage; any other status
 *     is the record's, whatever its body says;
 *  3. an `OverCeilingError` `ends` (`over_ceiling`); an `EmbedUnreachableError` is a proven outage;
 *  4. anything else (a child's text in a plain `Error`, a string) is judged by {@link isTransientEmbedError}: an outage by words, which
 *     is never `proven`, or the record's. A string or a plain `Error` can never be `ends` or `lost`, whatever it says.
 */
export function classifyEmbedFailure(failure: unknown): EmbedVerdict {
  if (failure instanceof LostChildError) return failure.inFlight ? { kind: 'lost' } : { kind: 'outage', proven: true };
  if (failure instanceof EmbeddingHttpError) {
    if (failure.status === PAYLOAD_TOO_LARGE_STATUS) return { kind: 'ends', reason: 'refused_413' };
    return WAIT_EMBED_STATUSES.has(failure.status) ? { kind: 'outage', proven: true } : { kind: 'record' };
  }
  if (failure instanceof OverCeilingError) return { kind: 'ends', reason: 'over_ceiling' };
  if (failure instanceof EmbedUnreachableError) return { kind: 'outage', proven: true };
  return isTransientEmbedError(embedFailureMessage(failure)) ? { kind: 'outage', proven: false } : { kind: 'record' };
}

/**
 * Was the embedder UNAVAILABLE, so that trying the same record again later is what cures it? True for a proven outage only: the class or
 * the status said so. The words of a child's text do not make it true, which is what a caller that waits without any cap (the media queue)
 * must be able to rely on.
 */
export function isEmbedderUnavailable(failure: unknown): boolean {
  const verdict = classifyEmbedFailure(failure);
  return verdict.kind === 'outage' && verdict.proven;
}
