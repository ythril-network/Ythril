/**
 * The one place that knows what "the embedding process was lost" looks like as TEXT.
 *
 * ## Why a string has to carry this at all
 *
 * A failure from the embedder crosses a process boundary, then the queue (`failEmbedJob`), and only its message
 * survives: the queue decides whether a job's failure is the embedder's fault or the record's from text, through
 * `isTransientEmbedError`. A crashed inference process is the embedder's fault, so the queue has to be able to
 * recognise one from its message alone, and this module owns the words it recognises.
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
 * This module imports nothing, on purpose: the queue, the host and the tests all import it, and none of them should
 * drag anything in by doing so.
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

/** Both markers, each matched across any run of whitespace, each defused by hyphenating it. */
const MARKERS_ANYWHERE = [LOST_MARKER, NOT_SENT_MARKER]
  .map(marker => ({ pattern: new RegExp(marker.replace(/ /g, '\\s+'), 'gi'), defused: marker.replace(/ /g, '-') }));

/** `text` with both markers' words defused, for any string a child process supplied. */
export function withoutLostMarker(text: string): string {
  return MARKERS_ANYWHERE.reduce((out, { pattern, defused }) => out.replace(pattern, defused), text);
}
