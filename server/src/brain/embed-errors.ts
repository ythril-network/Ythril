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

/** The words the queue recognises. Lower case, because the queue matches on a lower-cased message. */
export const LOST_MARKER = 'embedding process lost';

/**
 * The inference process ended without answering — it exited, crashed, was killed, or stopped answering — and what
 * it held was rejected. Only the host constructs this.
 *
 * `detail` says how it ended (`code=139 signal=null`), because the queue ends a record on the third one and an
 * operator reading `lastError` needs to see the crash, not just that there was one.
 */
export class LostChildError extends Error {
  constructor(detail: string) {
    super(`${LOST_MARKER} (${detail})`);
    this.name = 'LostChildError';
  }
}

/** Did the HOST raise this? True only for a `LostChildError`; never for something that reads like one. */
export function isLostChildError(err: unknown): err is LostChildError {
  return err instanceof LostChildError;
}

const MARKER_ANYWHERE = new RegExp(LOST_MARKER.replace(/ /g, '\\s+'), 'gi');

/** `text` with the marker words defused, for any string a child process supplied. */
export function withoutLostMarker(text: string): string {
  return text.replace(MARKER_ANYWHERE, LOST_MARKER.replace(/ /g, '-'));
}
