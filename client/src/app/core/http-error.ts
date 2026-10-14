/**
 * Extract a short, human-readable reason from an HttpErrorResponse (or any
 * thrown error) for display in an error state or toast. Prefers the server's
 * own `{ error: string }` body, then the HTTP status text, then the JS message.
 * Returns '' when nothing useful is available (the UI then shows a generic line).
 *
 * ## The request id (observability audit, lens 9)
 *
 * Every response carries `X-Request-Id`, and the server logs that id with every unhandled error:
 *
 *     [ERROR] Unhandled error [ba355eee-3829-4d0e-859e-bc6b4947364d]: Config not loaded
 *
 * So the link between a failure and its log line existed at the protocol level and stopped at the only
 * place a person meets it: the UI showed *"Internal server error"* with nothing to quote. An API consumer
 * could read the header; an operator looking at the screen could not, and neither could anyone filing a
 * report about it. One instance of "diagnosable in principle, undiagnosable in practice".
 *
 * The id is appended to a SERVER-side failure only. A 4xx the caller caused is self-explanatory and the id
 * would be noise on every validation message; a 5xx (or a transport failure, status 0) is the case where
 * the answer is in the server log and the reader needs the key to find it.
 */

/** Response header carrying the per-request correlation id, set for every response by `app.ts`. */
const REQUEST_ID_HEADER = 'X-Request-Id';

/** Errors worth correlating: a server fault, or a request that never got an answer at all. */
function worthCorrelating(status: number | undefined): boolean {
  return status === 0 || status === undefined || status >= 500;
}

/** What an HTTP failure looks like to the two readers below: its status and, narrowed to the one method used, its headers. */
interface CorrelatableFailure {
  status?: number;
  // HttpHeaders, narrowed to the one method used — `headers` is absent on a plain thrown Error.
  headers?: { get(name: string): string | null };
}

/**
 * `text` with the failure's request id appended when it is one worth quoting (see the section above): a server fault or a
 * request that got no answer, and only when the response carried the header. Any sentence about a failure goes through this,
 * so a refusal worded by the client names the log line the way `httpErrorReason` does, rather than by a second copy of the rule.
 */
export function withRequestId(text: string, err: unknown): string {
  const e = err as CorrelatableFailure | null;
  if (!e || !worthCorrelating(e.status)) return text;
  let id: string | null = null;
  // Defensive: `headers.get` throws on nothing real, but this runs inside every error path in the app and
  // must never be the reason an error message fails to render.
  try { id = e.headers?.get(REQUEST_ID_HEADER) ?? null; } catch { id = null; }
  if (!id) return text;
  return text ? `${text} (request ${id})` : `request ${id}`;
}

export function httpErrorReason(err: unknown): string {
  const e = err as (CorrelatableFailure & {
    error?: { error?: unknown };
    statusText?: string;
    message?: string;
  }) | null;
  if (!e) return '';

  const base = (() => {
    const serverMsg = e.error?.error;
    if (typeof serverMsg === 'string' && serverMsg.trim()) return serverMsg;
    if (typeof e.statusText === 'string' && e.statusText && e.statusText !== 'OK') {
      return e.status ? `${e.status} ${e.statusText}` : e.statusText;
    }
    if (typeof e.status === 'number' && e.status > 0) return `HTTP ${e.status}`;
    if (typeof e.message === 'string' && e.message.trim()) return e.message;
    return '';
  })();

  return withRequestId(base, e);
}
