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
import { answerForCaught } from '../util/answer-for-caught.js';
import { ConnectionsNotWritten, connectionsNotWrittenAnswer } from '../brain/connections-not-written.js';
import type { FileActAnswer } from '../files/act-answers.js';
import { answerFileActFailure } from '../files/act-failure-answer.js';
import { spaceActAnswer } from '../spaces/space-act-answer.js';
import { writeRefusalAnswer } from '../brain/write-validation.js';
import { RecordVersionAtCeiling } from '../brain/write-precondition.js';
import { PositionClockUnusable, PositionsSeedUnavailable, PositionsBuilding, EdgeIdentityBuilding } from '../util/errors.js';

/**
 * Put a store failure's answer on the wire: status, `Retry-After` when the answer is retryable, and the body —
 * the answer's own, or a door's envelope around it (`/api/<tool>` answers `{ok, error, data}`). What the answer SAYS
 * is `storeFailureAnswer`'s; this decides only that no door can drop the header or the status.
 */
export function sendStoreFailure(res: express.Response, answer: StoreFailureAnswer, envelope?: Record<string, unknown>): void {
  sendRetryAfter(res, answer.retryAfterSeconds);
  res.status(answer.status).json(envelope ?? answer.body);
}

/**
 * The one writer of `Retry-After`: every answer that says when to retry carries its wait as `retryAfterSeconds` (the store's, a file
 * act's, a tool outcome's), and this is the only place it becomes a header — so the header's spelling and unit cannot differ by door.
 */
function sendRetryAfter(res: express.Response, retryAfterSeconds: number | undefined): void {
  if (retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(retryAfterSeconds));
}

/**
 * The `503` a sender reads as the EDGES FAMILY held (`edge_identity_building`, Q-624): a page of fork edges met a space whose identity index is still the full one.
 * One sender for the push doors (`sendCaughtFailure`) and for the app's error handler, which answers the import route's.
 */
export function sendEdgeIdentityBuilding(res: express.Response, err: EdgeIdentityBuilding): void {
  res.status(503).json({ error: err.message, code: err.code, retryable: true });
}

/**
 * Put the answer for a write whose record landed and whose connections did not on the wire (`Q-170`): the cause's status,
 * `written`, no `Retry-After` and `retryable: false` — and the write audited as a write of the record it stored, which a
 * create's path cannot name (`req.auditEntryId`, read by `audit/middleware.ts`).
 *
 * One sender for the app's error handler and for `sendCaughtFailure`, so a route that catches its own failures cannot
 * answer a stored record as a `500` that reads "nothing happened".
 */
export function sendConnectionsNotWritten(res: express.Response, err: ConnectionsNotWritten, where: string): void {
  const answer = connectionsNotWrittenAnswer(err, where);
  res.req.auditEntryId = err.written.id;
  res.status(answer.status).json(answer.body);
}

/**
 * Put a file act's refusal on the wire (`fileActAnswer`): its status, its `Retry-After` (a move still owed) and its body, the
 * same object MCP carries as `structuredContent`. The answer is the one `answerFileActFailure` gave, which has already reported the
 * server's own (`500`, `503`) to the operator and counted it; this only sends it.
 */
function sendFileActAnswer(res: express.Response, answer: FileActAnswer): void {
  sendRetryAfter(res, answer.retryAfterSeconds);
  res.status(answer.status).json(answer.body);
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
  // First, for the reason `sendConnectionsNotWritten` gives: the record is stored, and the store's answer to its cause is a retry.
  if (err instanceof ConnectionsNotWritten) { sendConnectionsNotWritten(res, err, where); return; }
  // A file act's refusal (a destination a file blocks, a move still owed) is its own answer, whatever route met it: none of them is a
  // `RangeError`, so a route's own `RangeError` branch above this call cannot take one for a malformed path.
  const fileAct = answerFileActFailure(err, where);
  if (fileAct) { sendFileActAnswer(res, fileAct); return; }
  // A write a space's standing act refused (409, the act's code), and an act refused because shutdown closed the runner (503): the
  // same answer `callTool` and the app's final handler give, from the one function all three ask (`spaceActAnswer`, Q-560).
  const closed = spaceActAnswer(err);
  if (closed) { res.status(closed.status).json(closed.body); return; }
  // A local write's stamp refused it: the version is at the ceiling (409, a code), or the clock or the position seed will not let it be taken (503).
  // A space that owes its positions answers the 503 a sender reads as HELD (`positions_building`), whatever door asked.
  if (err instanceof PositionsBuilding) { res.status(503).json({ error: err.message, code: err.code, retryable: true }); return; }
  // A page of fork edges for a space still rebuilding its edge identity index: the 503 a sender reads as the EDGES FAMILY held (`edge_identity_building`).
  if (err instanceof EdgeIdentityBuilding) { sendEdgeIdentityBuilding(res, err); return; }
  const stamp = writeRefusalAnswer(err, 'update');
  if (stamp && (err instanceof RecordVersionAtCeiling || err instanceof PositionClockUnusable || err instanceof PositionsSeedUnavailable)) {
    res.status(stamp.status).json(stamp.body);
    return;
  }
  const store = storeFailureAnswer(err, where);
  if (store) { sendStoreFailure(res, store); return; }
  // Whatever is left is a fault, whatever it is: this is a catch-all and every route answered its own refusals before it (`refusals: false`).
  // A file-system error, a socket failure and an unreadable stored file are answered by what they are, in our words; the rest is the
  // route's own sentence (`fallback`), and says `retryable: false` and its code itself, so a route that stamps `retryable` from the status
  // cannot call it retryable. Reported inside `answerForCaught`, once per operation and class per window.
  const caught = answerForCaught(err, where, { refusals: false });
  const ownWords = caught.kind === 'internal' || caught.kind === 'refusal' || caught.kind === 'driver_refusal';
  res.status(caught.status).json(ownWords ? { code: 'internal', retryable: false, ...fallback } : caught.body);
}

/**
 * Answer a REST door that delegated to `callTool`: the door's own body, sent with the status the tool decided — or,
 * for a store failure, through {@link sendStoreFailure}, so the header the tool's transport cannot carry is put on
 * the HTTP one.
 */
export function sendToolAnswer(res: express.Response, outcome: Pick<ToolCallOutcome, 'status' | 'storeFailure' | 'retryAfterSeconds'>, body: Record<string, unknown>): void {
  if (outcome.storeFailure) { sendStoreFailure(res, outcome.storeFailure, body); return; }
  sendRetryAfter(res, outcome.retryAfterSeconds);
  res.status(outcome.status).json(body);
}
