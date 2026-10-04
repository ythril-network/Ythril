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

/**
 * Record the cause of a 5xx the route is about to send.
 *
 * `where` is what the operator will search for: name the operation, not the file — `'revoke token'`, not
 * `'tokens.ts:683'`. A line number is stale the next commit; the operation is what appears in their ticket.
 */
export function reportServerFailure(where: string, cause: unknown): void {
  // The cause goes as the meta argument: `fmt` keeps an Error's stack (this server's frames) and bounds its message,
  // which a driver may have built from a peer's `_id` (bundle-30 `B4`) — and bounds any other cause like any value.
  log.error(`${peerText(where)} failed with a 5xx:`, cause);
}
