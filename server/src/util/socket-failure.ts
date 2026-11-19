/**
 * Did a connection to something else fail? Two questions over one walk of an error's chain, the door's and the outbound call's.
 *
 * ## What it prevents
 *
 * The rule "this failure is a socket's, not ours" was a private constant of `answerForCaught`, so the one other place that needed it (the embed call
 * deciding whether the embedder could be reached) either copied the pattern or read the words of a message, and an outage of the embedder on
 * 18 Nov 2026 ended every queued job `failed` because the queue read words. The pattern is here once; a caller asks a question and never holds a
 * list of codes.
 *
 * ## The two questions, and why they differ
 *
 * - {@link isSocketFailure} is the DOORS' rule, moved here unchanged from `answerForCaught`: `ECONN*`, `EPIPE`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_*` anywhere in the
 *   chain (`cause`, `underlying`, a driver wrapper's thrown error, an aggregate's members). A door answers it `502`; what it answers did not change
 *   when the outbound call learned more, so a caught failure is answered as it was.
 * - {@link isConnectionFailure} is the OUTBOUND call's: that rule, plus the codes of a host that cannot be routed to (`EHOSTUNREACH`, `ENETUNREACH`), the
 *   fetch library's own connection failures (`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`), and an
 *   error NAMED `TimeoutError` anywhere in the chain. What the runtime's `fetch` throws for a closed port is a `TypeError` "fetch failed" whose `cause` carries
 *   `ECONNREFUSED`; for an `AbortSignal.timeout` that fired it is a `DOMException` named `TimeoutError` with no `cause` and the numeric `code` 23, which is why the
 *   name is read and the code is not.
 * - {@link isTimeoutFailure} narrows the second to the ones that are a timeout, so a caller that says which kind it met does not hold the list either.
 *
 * What neither reads is a message: a string that says "timeout" or "connection refused" is text, and text is not the proof (`embed-errors.ts` says why).
 */
import { errorChain } from '../db/error-chain.js';

/** Socket-shaped codes: the connection to something else failed, which is not a file act and not the caller's request. */
const SOCKET_CODE = /^(ECONN[A-Z]*|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_[A-Z_]+)$/;

/** What an outbound call meets beyond {@link SOCKET_CODE}: no route to the host, and the fetch library's own connection failures. */
const OUTBOUND_CODE = /^(EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/;

/** The codes that say a connection or an answer did not arrive in time. */
const TIMEOUT_CODE = /^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/;

/** The name `AbortSignal.timeout` gives the error it aborts with. */
const TIMEOUT_NAME = 'TimeoutError';

const codeOf = (e: object): string => String((e as { code?: unknown }).code ?? '');
const hasTimeoutName = (e: object): boolean => (e as { name?: unknown }).name === TIMEOUT_NAME;

/** The doors' rule: a socket-shaped code anywhere in the chain. */
export function isSocketFailure(err: unknown): boolean {
  return errorChain(err).some(e => SOCKET_CODE.test(codeOf(e)));
}

/** The outbound call's rule: the connection to the far end failed, or the call's own timeout ended it. */
export function isConnectionFailure(err: unknown): boolean {
  return errorChain(err).some(e => SOCKET_CODE.test(codeOf(e)) || OUTBOUND_CODE.test(codeOf(e)) || hasTimeoutName(e));
}

/** Of a connection failure, the ones that are a timeout: the call's own (`TimeoutError`) or a timeout code. */
export function isTimeoutFailure(err: unknown): boolean {
  return errorChain(err).some(e => TIMEOUT_CODE.test(codeOf(e)) || hasTimeoutName(e));
}
