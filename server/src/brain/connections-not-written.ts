/**
 * A write whose RECORD landed and whose connections did not — answered as what it is (`Q-170`, design 8).
 *
 * ## What this prevents
 *
 * A single-record door writes the record first and its `link*` fields and inline `edges` after (a relationship needs
 * both ends), so there is a window in which the record is stored and its connections are not. Whatever fails in that
 * window used to reach the caller as it would have before the write: the store's `503` with `Retry-After` and
 * `retryable: true` (true of a write that did not land), a `500`, or an edge's refusal as if nothing had been stored.
 * A caller who retries sends the record again, and a create without an id stores a second one.
 *
 * So `applyConnections` wraps ANY throw out of its two halves as {@link ConnectionsNotWritten}, which says what WAS
 * written (`written`) and why the rest was not (`cause`). The two shared mappers — the app's error handler and
 * `callTool`'s catch — answer it through {@link connectionsNotWrittenAnswer}, the one place the status, the body and
 * the "not retryable" are decided, so the REST door, the MCP door and `/api/<tool>` cannot answer it three ways.
 *
 * ## What the answer is
 *
 * The cause's STATUS CLASS, with the retry taken out of it: a refusal keeps its record-refusal status (`422` for a
 * schema refusal, `400` for a reference), a conflict keeps `409`, a store failure keeps its `5xx`. Every one carries
 * `retryable: false`, never a `Retry-After`, and `written: { kind, id, edges }` — the record's id and the ids of the
 * edges that DID land before the failure, so the caller can send the rest as an update to that id.
 *
 * The message is the class's own, never the cause's: the cause may be the driver's, whose text names internal hosts
 * and collections (`storeFailureAnswer` keeps those in the log for the same reason).
 */
import type { RefKind } from '../config/types-knowledge.js';
import { storeFailureAnswer } from './store-failure.js';
import { writeRefusalAnswer } from './write-validation.js';
import { WriteConflict } from './write-plan/types.js';
import { reportServerFailure } from '../util/report-failure.js';

/** What a write stored before its connections failed: the record, and the ids of the edges that landed. */
export interface WrittenRecord {
  kind: RefKind;
  id: string;
  /** The ids of the edges that were written before the failure, in the order they landed. */
  edges: string[];
}

/**
 * The one way a {@link WrittenRecord} is built: `applyConnections` (a single-record write) and the batch's
 * `nameWhatLanded` both name what landed, and a third spelling of the `{ kind, id, edges }` literal is a third chance to
 * hand over the caller's live array (which the next edge to land would grow under a caller already holding the answer).
 */
export function writtenRecord(kind: RefKind, id: string, landedEdges: readonly string[]): WrittenRecord {
  return { kind, id, edges: [...landedEdges] };
}

/**
 * The record is stored; its connections are not all written. See the module docblock: this is what stops a caller
 * being told "retry" about a write that landed.
 */
export class ConnectionsNotWritten extends Error {
  constructor(readonly written: WrittenRecord, readonly cause: unknown) {
    super(`The ${written.kind} was stored as '${written.id}', but its connections were not all written. `
      + `Do not send the write again — send the connections as an update to '${written.id}'.`);
    this.name = 'ConnectionsNotWritten';
  }
}

/** What a door puts on the wire for a {@link ConnectionsNotWritten}: one status, one body, and no `Retry-After`. */
export interface ConnectionsNotWrittenAnswer {
  status: number;
  body: {
    error: string;
    retryable: false;
    written: WrittenRecord;
    /** The cause's own refusal words, present only when the cause is OUR refusal (never a driver's text). */
    refusal?: string;
    code?: number;
    codeName?: string;
  };
}

/**
 * The answer for a write whose record landed and whose connections did not.
 *
 * `where` names the operation for the log line a store failure writes (`storeFailureAnswer` requires it), so the
 * driver's text is logged once, here, and never answered.
 */
export function connectionsNotWrittenAnswer(err: ConnectionsNotWritten, where: string): ConnectionsNotWrittenAnswer {
  const base = { error: err.message, retryable: false as const, written: err.written };
  // An update's status for a schema refusal: the record exists, so what was refused is an edit of it. A conflict keeps
  // the status the other doors give it, and carries no refusal words (its own message says "retry", which this is not).
  const refused = writeRefusalAnswer(err.cause, 'update');
  if (refused) {
    return {
      status: refused.status,
      body: err.cause instanceof WriteConflict ? base : { ...base, refusal: err.cause instanceof Error ? err.cause.message : String(err.cause) },
    };
  }
  const store = storeFailureAnswer(err.cause, where);
  if (store) {
    return {
      status: store.status,
      body: { ...base, ...(store.body.code !== undefined ? { code: store.body.code } : {}), ...(store.body.codeName ? { codeName: store.body.codeName } : {}) },
    };
  }
  reportServerFailure(`${where}: the connections of a stored ${err.written.kind}`, err.cause);
  return { status: 500, body: base };
}
