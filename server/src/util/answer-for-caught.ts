/**
 * What a door says about a failure it caught and did not recognise: decided by what the failure IS, never by its message.
 *
 * ## What it prevents
 *
 * Four doors met a caught failure that no typed branch claimed, and each decided by its own rule. The tool dispatcher
 * (`answerThrown`) and the read routes (`sendReadFailure`) answered it `400` in the thrower's words: a `TypeError` of ours, a file-system
 * error carrying the server's absolute data path, a socket failure naming an internal host were all "your request was wrong", and a client
 * that treats `4xx` as final (a sync sender, an agent with `onError: continueRegularOutput`) dropped the work silently. The REST catch-all
 * (`sendCaughtFailure`) answered a bare `500`, so one failure was a `400` on one door and a `500` on the next. A bulk resolution's per-id
 * item counted an unclassified `TypeError` as a `file_system_fault`.
 *
 * Here the rule is one function and the words are ours. The caller's own message is echoed only for a door that answers OUR refusals
 * (`refusals: true`: the tool doors and a read, which have always answered a plain `Error` as the caller's), and never for anything a
 * runtime, a driver or a socket wrote.
 *
 * ## The table (one unit row per line, on every answerer: `a-caught-failure-is-answered-by-what-it-is-db.test.js`)
 *
 * - the store's condition is the DOOR's first question (`storeFailureAnswer`), asked before this and never here;
 * - a stored file that cannot be read: `500`, its base name and "cannot be read";
 * - a socket-shaped failure (`ECONN*`, `EPIPE`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_*`, also through `cause`): `502`, "an upstream service did
 *   not answer";
 * - a file-system error, also through `cause`: `500` `file_system_fault`, by the one function that counts and reports a file act's failure;
 * - something the DRIVER raised that is not the store's condition (a server refusal): the driver's words never reach the answer;
 * - a `TypeError`, `ReferenceError`, `SyntaxError` or a thrown non-Error: `500`, "Internal server error", `code: 'internal'`;
 * - any other `Error` (our refusal convention): `400` with its message where the door answers refusals, else `500` as a fault.
 *
 * Every fault body says `retryable: false` ITSELF: `statesRetryability` stamps `true` on a `5xx` body that does not say, and a fault is not
 * a condition that clears. Every fault is reported (the cause and stack to the operator) once per operation and class per window, however
 * often a caller repeats it, and the class is the metric's label (`CAUGHT_KINDS`, a fixed vocabulary).
 *
 * ## The question it answers
 *
 * "What do we say about this failure?" It builds on `isFileSystemError` (`fs-failure-words.ts`), `errorChain` (`db/error-chain.ts`) and
 * `refusalText` (`brain/store-failure.ts`), and does not re-ask any of them. What each door does with the answer (a status line, an
 * envelope, `structuredContent`, one item of a bulk answer) stays the door's.
 */
import path from 'node:path';
import { MongoError } from 'mongodb';
import { errorChain } from '../db/error-chain.js';
import { refusalText } from '../brain/store-failure.js';
import { StoredFileUnreadable } from '../files/stored-bytes.js';
import { FileSystemFault } from '../files/act-answers.js';
import { answerFileActFailure } from '../files/act-failure-answer.js';
import { isFileSystemError } from './fs-failure-words.js';
import { log, peerText } from './log.js';
import { warnOnce } from './warn-once.js';

/** The classes a caught failure is answered as: the metric's `class` label, so a fixed set and never a message. */
export const CAUGHT_KINDS = ['unreadable_file', 'upstream', 'file_system', 'driver_refusal', 'internal', 'refusal'] as const;
export type CaughtKind = (typeof CAUGHT_KINDS)[number];

export interface CaughtAnswer {
  status: 400 | 500 | 502;
  /** `retryable` is always stated; `code` is the stable word a client can branch on (`file_system_fault`, `internal`). */
  body: { error: string; retryable: boolean; code?: string };
  kind: CaughtKind;
}

/** The words of a fault of ours that has nothing a caller can act on. */
export const INTERNAL_ERROR_TEXT = 'Internal server error';
const UPSTREAM_TEXT = 'an upstream service did not answer';

/** Socket-shaped codes: the connection to something else failed, which is not a file act and not the caller's request. */
const SOCKET_CODE = /^(ECONN[A-Z]*|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_[A-Z_]+)$/;

const saidFault = warnOnce<string>({ max: 256, every: 60_000 });

/** Report a fault's cause to the operator once per operation and class per window; the answer is given every time. */
function reportCaught(where: string, kind: CaughtKind, err: unknown): void {
  saidFault(`${where}|${kind}`, () => log.error(`${peerText(where)} failed (${kind}):`, err));
}

/**
 * The answer for a failure no typed branch claimed. `where` names the operation for the operator's search (as `reportServerFailure` asks).
 * `refusals` says whether this door answers a plain `Error` as the caller's refusal (`400`, its message) or, being a catch-all for faults,
 * as a fault of ours.
 */
export function answerForCaught(err: unknown, where: string, { refusals }: { refusals: boolean }): CaughtAnswer {
  if (err instanceof StoredFileUnreadable) {
    reportCaught(where, 'unreadable_file', err);
    return { status: 500, body: { error: `${path.basename(err.filePath)} cannot be read.`, retryable: false }, kind: 'unreadable_file' };
  }
  const chain = errorChain(err);
  if (chain.some(e => SOCKET_CODE.test(String((e as { code?: unknown }).code ?? '')))) {
    reportCaught(where, 'upstream', err);
    return { status: 502, body: { error: UPSTREAM_TEXT, retryable: false }, kind: 'upstream' };
  }
  const fsError = chain.find(isFileSystemError);
  if (fsError) {
    // Counted and reported by the one function every door asks of a file act's failure, so it is neither dropped nor said twice.
    const act = answerFileActFailure(new FileSystemFault(fsError), where)!;
    return { status: 500, body: { ...act.body, retryable: false }, kind: 'file_system' };
  }
  if (chain.some(e => e instanceof MongoError)) {
    // Not the store's condition (the door asked first): what the server refused. The sentence is ours; the driver's text is logged inside.
    if (refusals) return { status: 400, body: { error: refusalText(err), retryable: false }, kind: 'driver_refusal' };
    reportCaught(where, 'driver_refusal', err);
    return { status: 500, body: { error: INTERNAL_ERROR_TEXT, retryable: false }, kind: 'driver_refusal' };
  }
  if (err instanceof Error && !(err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError)) {
    if (refusals) return { status: 400, body: { error: err.message, retryable: false }, kind: 'refusal' };
    reportCaught(where, 'refusal', err);
    return { status: 500, body: { error: INTERNAL_ERROR_TEXT, code: 'internal', retryable: false }, kind: 'refusal' };
  }
  reportCaught(where, 'internal', err);
  return { status: 500, body: { error: INTERNAL_ERROR_TEXT, code: 'internal', retryable: false }, kind: 'internal' };
}
