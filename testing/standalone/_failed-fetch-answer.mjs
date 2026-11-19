/**
 * What a probe records of a fetch that threw: "no answer" only for the abort its own timeout raised, a connection failure for anything else.
 *
 * ## The question it answers
 *
 * *"Did this door give no answer in time, or did the connection fail?"* A gate that asks a door with `AbortSignal.timeout(ms)` gets a
 * `TimeoutError` when the door never answered, and some other error (`fetch failed` with `ECONNRESET` as its cause, `AbortError`) when the
 * request never got an answer for another reason. Reading both as "no answer within N ms" sent a reader of a reset connection to the
 * door instead of to the harness (bundle-348, the store-failure gate's about door). Both are failures of the case; they are named by
 * what they were.
 *
 * @param {unknown} err what the fetch (or the read of its body) threw
 * @param {{ status?: number }} [seen] the status of a response that had already arrived, when one had
 * @returns {{ status: number, raw: string, error: string, timedOut?: true, connectionFailed?: true, causeCode?: string }}
 */
export function answerOfFailedFetch(err, { status = 0 } = {}) {
  const text = String(err);
  if (err?.name === 'TimeoutError') return { status, raw: text, error: text, timedOut: true };
  // A DOMException's `code` is a number (20 for an abort); the name is what says it.
  const causeCode = [err?.cause?.code, err?.code, err?.cause?.name, err?.name].find(c => typeof c === 'string' && c !== '') ?? 'unknown';
  const said = `${text}${err?.cause ? ` (${err.cause.code ?? ''} ${err.cause.message ?? err.cause})` : ''}`;
  return { status, raw: said, error: said, connectionFailed: true, causeCode };
}
