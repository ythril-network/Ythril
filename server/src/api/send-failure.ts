/**
 * How a REST door puts a failure on the wire — the one place a store failure's HTTP answer is written.
 *
 * ## Why one module (bundle-30 I12, verify-drive-2 findings 2 and 3)
 *
 * What a store failure SAYS was already one function's (`storeFailureAnswer`). How it was SENT was not: the read
 * routes, the error handler and the sync push doors went through `sendStoreFailure` and carried `Retry-After`; the
 * REST doors that hand their body to a tool (`/api/<tool>`, `/api/brain/recall`, `/similar`, `/traverse`) wrote
 * `res.status(outcome.status)` themselves and carried no header; and forty-odd route `catch`es answered a hand-written
 * `500 Internal error` without asking whether the failure was the store's at all — `POST …/entities` among them, which
 * is what the UI's create form showed an operator for a condition that clears on a retry. Every door had been written
 * by hand, and the one that forgot was whichever its author was not testing.
 *
 * So each of the three ways a door meets a failure has one sender here, and each puts the store's answer through
 * {@link sendStoreFailure}:
 *
 * - a route's own `catch` → {@link sendCaughtFailure};
 * - a door that delegates to `callTool` → {@link sendToolAnswer};
 * - a throw that reaches the app's error handler, or a read route's helper → {@link sendStoreFailure} directly.
 *
 * `a-store-failure-answers-alike-on-every-door-db` reads the doors from the mounted routers, not from these call
 * sites, so a door that answers on its own is found the day it is mounted.
 */
import type express from 'express';
import { storeFailureAnswer, type StoreFailureAnswer } from '../brain/store-failure.js';
import type { ToolCallOutcome } from '../mcp/call-tool.js';
import { reportServerFailure } from '../util/report-failure.js';

/**
 * Put a store failure's answer on the wire: status, `Retry-After` when the answer is retryable, and the body —
 * the answer's own, or a door's envelope around it (`/api/<tool>` answers `{ok, error, data}`). What the answer SAYS
 * is `storeFailureAnswer`'s; this decides only that no door can drop the header or the status.
 */
export function sendStoreFailure(res: express.Response, answer: StoreFailureAnswer, envelope?: Record<string, unknown>): void {
  if (answer.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(answer.retryAfterSeconds));
  res.status(answer.status).json(envelope ?? answer.body);
}

/**
 * Answer a failure a route caught: the store's answer when it is the store's, otherwise a `500` in words of ours —
 * reported to the operator with its stack either way (`reportServerFailure`, or the store answer's own log line, so
 * the driver's text is logged once and not twice).
 *
 * `where` names the operation for the operator's search, as `reportServerFailure` asks. The body of a non-store `500`
 * is flat and generic by default: `public-probes-leak-nothing.test.js` pins that, and a route is the last place to
 * start echoing an exception back. `fallback` is that body when the route has a sentence of its own for it (`Failed
 * to delete file`), or — on an admin route whose operator acts on it — the exception's own message; it is never used
 * for a failure on the store's side, which `storeFailureAnswer` answers first, in our words.
 *
 * **A response already under way is not answered again.** A route that streams (an export) can fail after its
 * status line is out; writing a second one throws inside the `catch`, which is the one place nothing recovers it.
 * The failure is reported and the response is left as the stream left it — the guard each such route used to
 * write by hand, kept here so the next streaming route cannot forget it.
 */
export function sendCaughtFailure(res: express.Response, where: string, err: unknown,
  fallback: Record<string, unknown> = { error: 'Internal server error' }): void {
  if (res.headersSent) { reportServerFailure(where, err); return; }
  const store = storeFailureAnswer(err);
  if (store) { sendStoreFailure(res, store); return; }
  reportServerFailure(where, err);
  res.status(500).json(fallback);
}

/**
 * Answer a REST door that delegated to `callTool`: the door's own body, sent with the status the tool decided — or,
 * for a store failure, through {@link sendStoreFailure}, so the header the tool's transport cannot carry is put on
 * the HTTP one.
 */
export function sendToolAnswer(res: express.Response, outcome: Pick<ToolCallOutcome, 'status' | 'storeFailure'>, body: Record<string, unknown>): void {
  if (outcome.storeFailure) { sendStoreFailure(res, outcome.storeFailure, body); return; }
  res.status(outcome.status).json(body);
}
