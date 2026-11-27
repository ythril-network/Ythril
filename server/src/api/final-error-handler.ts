/**
 * The app's final error handler: what a request answers when a route throws and no catch of its own took it (bundle-378, Q-976).
 *
 * ## The question it answers
 *
 * "What does a caller get from an error nothing above caught?" One function, mounted last by `createApp`, so a route written without a catch
 * still answers a typed refusal as every route that catches does.
 *
 * ## What it prevents
 *
 * The handler took any error with a numeric `status` first and sent `{ error }` alone, so a typed 409 refusal a route did not catch
 * (`fork_row_read_only`, `fork_cap`, `endpoint_removed`, `write_race_lost`, `link_target_removed`) lost the `code` a client translates and acts on,
 * and the shared mappers below that branch (a standing act, a refusal, a store failure) were never reached by a class that carries a `status`. Now the
 * shared mappers come first, and a 4xx that no mapper owns keeps the `code` and the `id` it carries beside its `error`.
 *
 * A 5xx never echoes an internal message: only a refusal that carries a `code` of its own is answered in its own sentence; any other is the
 * store's answer (`storeFailureAnswer`) or the flat `500 Internal server error`, logged with its stack.
 */
import type express from 'express';
import { writeRefusalAnswer } from '../brain/write-validation.js';
import { ConnectionsNotWritten } from '../brain/connections-not-written.js';
import { storeFailureAnswer } from '../brain/store-failure.js';
import { spaceActAnswer } from '../spaces/space-act-answer.js';
import { sendStoreFailure, sendConnectionsNotWritten, sendEdgeIdentityBuilding } from './send-failure.js';
import { EdgeIdentityBuilding, PositionsBuilding, schemaReadUnavailableAnswer } from '../util/errors.js';
import { log } from '../util/log.js';
import { routeLabel } from '../http/route-map.js';

/** The first status of a refusal the caller caused, the first of a fault, and the first past both. */
const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;
const PAST_ERRORS = 600;
/** A space that is not ready: the status a sender reads as HELD. */
const UNAVAILABLE = 503;

/** The `code` and the `id` an error carries, as the body fields they travel in: a field only when the error holds it as a string. */
function typedFields(err: object): { code?: string; id?: string } {
  const { code, id } = err as { code?: unknown; id?: unknown };
  return { ...(typeof code === 'string' ? { code } : {}), ...(typeof id === 'string' ? { id } : {}) };
}

/** The numeric HTTP status an error carries, or `undefined` when it carries none. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('status' in err)) return undefined;
  const s = (err as { status: unknown }).status;
  return typeof s === 'number' ? s : undefined;
}

export function finalErrorHandler(err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction): void {
  /*
   * THE RECORD LANDED and its connections did not (`Q-170`) — matched before everything below, because the cause it
   * wraps is a conflict, a refusal or a store failure, and each of those answered as itself tells the caller the
   * write did not happen. It answers what happened: the cause's status, `written`, and not retryable.
   */
  if (err instanceof ConnectionsNotWritten) {
    // Audited as a write of the record too, which a create's path cannot name (`sendConnectionsNotWritten`).
    sendConnectionsNotWritten(res, err, `${req.method} ${routeLabel(req)}`);
    return;
  }
  // A restore page of fork edges into a space still rebuilding its edge identity index (`sync/space-import.ts`): the same `503 edge_identity_building` the push doors answer.
  if (err instanceof EdgeIdentityBuilding) {
    sendEdgeIdentityBuilding(res, err);
    return;
  }
  // A space that owes its positions: the 503 a sender reads as HELD.
  if (err instanceof PositionsBuilding) {
    res.status(UNAVAILABLE).json({ error: err.message, code: err.code, retryable: true });
    return;
  }
  // A read of schema versions over a collection that lists no stamp index yet, or a pass past its deadline (`schema_index_building`, `schema_versions_busy`).
  const schemaRead = schemaReadUnavailableAnswer(err);
  if (schemaRead) {
    res.status(schemaRead.status).json(schemaRead.body);
    return;
  }
  /*
   * A write a space's standing act refused (`409` with the act's code: a restore, a deletion, a wipe, a rename, a migration), or an
   * act refused because shutdown closed the runner (`503`). The writers raise it from the write gate, and a route that does not catch
   * reaches here: without this branch sixteen REST record routes answered `500` for a documented `409` while the MCP door and the
   * routes that catch answered it right (Q-560). The same function `sendCaughtFailure` and `callTool` ask.
   */
  const actAnswer = spaceActAnswer(err);
  if (actAnswer) {
    res.status(actAnswer.status).json(actAnswer.body);
    return;
  }
  /*
   * A REFERENCE REFUSAL IS THE CALLER'S FAULT, and it reaches here rather than a route.
   *
   * The existence check for a link moved from the seven write doors into the writers — which is what
   * made it true of `linkEntities` as well as of the 4.x arrays it guarded. Express 5 forwards a
   * rejected handler here, so a caller naming a record that does not exist got **500 Internal server
   * error** where they used to get a `400` naming the id. A refusal that reads as a server fault is
   * worse than the silent write it replaced: there is nothing in it to act on.
   *
   * Answered HERE and not per door on purpose. Seven branches are seven chances for the next door to
   * be written without one, and the symptom is a 500 on the path nobody exercised.
   *
   * A refusal (a reference that names nothing, a schema refusal, a fork row, an edge or a link whose entity was removed) or a conflict (another
   * write kept moving the record: nothing was written and a retry is the remedy) — the status and body, code and id included, every shared mapper
   * gives them. It comes BEFORE the status branch below: these classes carry a `status`, and that branch would have answered them `{ error }` alone.
   */
  const refused = writeRefusalAnswer(err, 'update');
  if (refused) {
    res.status(refused.status).json(refused.body);
    return;
  }
  // An error of the request itself (body-parser's 413 and 400, a refusal with a 4xx of its own): its status and its sentence, and the `code` and
  // `id` it carries, which a client reads and acts on. A 5xx is answered below and never in an internal error's own words.
  const status = statusOf(err);
  if (status !== undefined && status >= CLIENT_ERROR && status < SERVER_ERROR) {
    res.status(status).json({ error: (err as { message?: string }).message ?? 'Request error', ...typedFields(err as object) });
    return;
  }
  /*
   * The STORE's condition is the store's on every door (bundle-30, `R1`). A write the bound ended, a step-down, a
   * dropped socket: retryable, `503` — the classification the MCP door and the read routes already answer from,
   * so a REST write and the same write through a tool no longer disagree (this answered `500` while the tool
   * door answered `503`). An unrecognised driver error is answered there too, as a `500` in our words and logged
   * with its stack; everything else stays the `500` below.
   */
  // Named by method and path (never the query, which can carry a file path), as a route's own catch names itself.
  const store = storeFailureAnswer(err, `${req.method} ${routeLabel(req)}`);
  if (store) {
    sendStoreFailure(res, store);
    return;
  }
  // A 5xx refusal that names its own code (a SPARQL read's bound) says its sentence and its code; a 5xx that names none is a fault and says nothing of itself.
  const coded = err && typeof err === 'object' ? typedFields(err) : {};
  if (status !== undefined && status >= SERVER_ERROR && status < PAST_ERRORS && coded.code !== undefined) {
    res.status(status).json({ error: (err as { message?: string }).message ?? 'Request error', ...coded });
    return;
  }
  /*
   * The id is no longer spelled out here: every line emitted during a request carries it now, so writing it
   * again produced it twice on the one line that already had it. The error is the META argument, so the line
   * keeps its stack and bounds its message (`fmt`) — interpolated, the stack was dropped (bundle-30 I6, C16).
   */
  log.error('Unhandled error:', err);
  res.status(SERVER_ERROR).json({ error: 'Internal server error' });
}
