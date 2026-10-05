/**
 * A 5xx a route decides to send must leave evidence behind.
 *
 * ## What went wrong
 *
 * The canary operator hit `DELETE /api/tokens/:id` and got `HTTP 500` in 6 ms. They asked us for the cause
 * twice over ten days. When they finally captured the pod log for that exact second, it contained **three
 * unrelated OIDC warnings and nothing else** — no line for the DELETE at all. So they reasoned from the only
 * evidence present, and built a hypothesis on it: that an expired session answers 500 where 401 belongs.
 *
 * The hypothesis was wrong (`resolveBearer` returning null writes `401 Invalid or expired token`, and a throw
 * reaches `app.ts`'s handler which logs `Unhandled error:`). But **it was the only hypothesis their evidence
 * could support**, and that is the defect this file exists to remove. Reasoning from an empty log is not their
 * mistake to stop making; it is ours to stop causing.
 *
 * ## The class, not the one site
 *
 * Sweeping every deliberate `res.status(5xx)` under `server/src/api` found **twenty-four** with no report of
 * any kind nearby. Seven of those are the sharp shape:
 *
 * ```ts
 * } catch (err) {
 *   res.status(500).json({ error: 'Internal error' });   // `err` bound, and thrown away
 * }
 * ```
 *
 * The exception is caught, named, and discarded. **The caller is told nothing and the operator is told
 * nothing**, so the failure exists only as a status code — which is precisely as much as the canary had.
 * `brain/entities.ts` was the worst of them: an entity write could fail and leave no trace anywhere.
 *
 * ## Why the response body is deliberately not this function's business
 *
 * A generic body is a security property here, not an oversight — `public-probes-leak-nothing.test.js` pins
 * that public routers answer a flat `Internal server error` and never echo `err.message`. So this reports to
 * the OPERATOR only, and every call site keeps writing its own response. One helper that also sent the body
 * would have to know which routers are public, which is a second copy of a rule that already has a home.
 *
 * ## What a report contains
 *
 * The `where` and the stack. The stack, not just the message, because the message alone ("Cannot read
 * properties of undefined") sends the reader back to grep for which of eleven `undefined`s it was — and the
 * whole point is that the next person reading this line is an operator on another team who cannot grep our
 * source at all.
 */
import { log, peerText } from './log.js';
import { warnOnce } from './warn-once.js';

/**
 * Record the cause of a 5xx the route is about to send.
 *
 * `where` is what the operator will search for: name the operation, not the file — `'revoke token'`, not
 * `'tokens.ts:683'`. A line number is stale the next commit; the operation is what appears in their ticket.
 */
export function reportServerFailure(where: string, cause: unknown): void {
  // An Error goes in as the log line's META argument: `fmt` renders it with its frames kept and its message bounded to
  // half the budget (`errorWithStack`), so a long message — a driver's text quoting a caller's filter — cannot push the
  // frames, the one thing this report exists to keep, out of the cut. Anything else is a value like any other.
  if (cause instanceof Error) log.error(`${peerText(where)} failed with a 5xx:`, cause);
  else log.error(`${peerText(where)} failed with a 5xx: ${peerText(cause)}`);
}

/**
 * Record, once, the driver's text an answer WITHHELD (`caughtFailureText` in `brain/store-failure.ts`, `sendReadFailure`).
 *
 * A driver error's message names the host, the port and the namespace it failed on, so no answer carries it (`Q-361`) —
 * and the operator who needs it reads it here, at the level they watch, under the operation the caller named. The
 * counterpart of `reportServerFailure` for a failure the door answers in OUR words: that one is for a 5xx a route
 * decides to send and logs the stack; this one is for the text an answer replaced, and logs the driver's account.
 *
 * `detail` is the driver's own text (`storeFailureDetail`), rendered through `peerText` like any value that did not
 * originate here: a driver's message can carry a caller's input, and it is bounded and escaped.
 */
export function reportDriverFailure(operation: string, detail: string): void {
  log.warn(`${peerText(operation)} failed: ${peerText(detail)}`);
}

/** How long a driver failure already reported for an operation and a kind is not reported again (`reportRecurringDriverFailure`). */
const RECURRING_REPORT_WINDOW_MS = 10 * 60_000;
/** The most of an operation or a kind a window key holds; both are ours or a class name, and the key stays small. */
const RECURRING_KEY_PART_MAX = 128;
const recurringReported = warnOnce<string>({ every: RECURRING_REPORT_WINDOW_MS });

/**
 * `reportDriverFailure` for a failure that arrives at the rate of the work that meets it — a read route under load, a
 * queued job per record — reported once per window for each (operation, `kind`) and not once per occurrence.
 *
 * The incident that motivated withholding the driver's text was 6 of 36 calls failing for hours after a search process
 * restarted; one warning per failed call would put that into the 1 000-line ring the log viewer reads and the container
 * log, a thousand lines saying what the first one did. `kind` is what makes two failures one condition — the error's
 * code or class, never its text — so a different condition on the same operation is still news. A failure that is a
 * one-off act (`reportDriverFailure`) is reported every time.
 */
export function reportRecurringDriverFailure(operation: string, kind: string, detail: string): void {
  const key = `${peerText(operation, { max: RECURRING_KEY_PART_MAX })}\u0000${peerText(kind, { max: RECURRING_KEY_PART_MAX })}`;
  recurringReported(key, () => reportDriverFailure(operation, detail));
}
