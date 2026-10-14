/**
 * What a file act (a move, a directory create, a write, a delete) answers when it does not happen — one answer per
 * refusal, on every door.
 *
 * ## The question it answers
 *
 * "This file act failed or was refused: what status, what body, and what may the caller do next?" Asked by the REST
 * file routes (`api/files.ts`, `api/files-upload.ts`, each through `sendCaughtFailure` in `api/send-failure.ts`, which asks
 * {@link fileActAnswer} before any other classification) and by the MCP dispatcher (`mcp/call-tool.ts`) for the same
 * thrown error, so `PATCH /api/files`, `POST /api/move_file` and MCP `move_file` cannot answer one failure three ways
 * (they did: `500 Failed to move path`, `400` with the raw filesystem message — the absolute data path included —
 * and the same `400` again).
 *
 * ## What it prevents
 *
 * A refusal that is the CALLER's (a destination a regular file blocks, a destination something already stands at)
 * answered as a server fault, and a failure that is the SERVER's answered with the filesystem's or the driver's own
 * words. Every message here is built from the space-relative paths the act was given, never from `err.message` of a
 * lower layer.
 *
 * ## Counted where it is answered
 *
 * {@link fileActAnswer} is what a door calls and it counts the answer by its `code` (`ythril_file_act_answers_total`);
 * {@link fileActAnswerOf} classifies and counts nothing, for a caller that asks "is this refusal that kind?" and does not
 * answer (`isPathBlocked`). A classification that counted would report an answer no door gave. Counting inside the answer
 * is what a door cannot forget. The tally lives here and the metrics registry reads it at scrape time
 * ({@link fileActAnswerCounts}), because this module is imported below the registry and importing the registry back would be
 * a runtime import cycle.
 *
 * ## Why these statuses
 *
 * - `409` for a blocked destination or one something already stands at (`destination_exists`), not `400`/`422`: a
 *   peer's sync push reads `400` and `422` as "refused about the bytes" and stops re-sending those bytes until their hash
 *   changes (`sync/file-push.ts`), but these refusals are about the receiver's TREE, which can change, so the sender must
 *   keep retrying. Not `404` either: a `404` on a file act says the SOURCE names nothing.
 * - `422` for a directory delete that did not say `confirm: true`, and `400` for the space root: refusals about the
 *   request itself, which no retry of the same request changes.
 * - `503` + `Retry-After` for a move whose bytes moved and whose records did not all follow yet: the move is owed, a
 *   retry (or housekeeping) finishes it. It is not the store's "not answering" — the store may be fine.
 * - `500` for an act that could not record its own deletion: nothing was moved or deleted, and the reason is ours.
 * - `500` for a file-system failure that is not about the caller's path ({@link FileSystemFault}): the reason is the server's
 *   storage, said in words that name no path.
 */
import { fileSystemRefusalMessage } from '../util/fs-failure-words.js';
/** The caller's path cannot be used: a regular file stands where a directory must be, it is the source itself or inside it, or the file system refuses it. Answered `path_blocked`. */
export class PathBlocked extends Error {
  override readonly name = 'PathBlocked';
  /** `path` is space-relative: the blocker, or the requested path when the blocker is outside it. */
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

/** What stands at a move's destination: bytes, a live record without bytes, the records of another file, or a sidecar's destination. */
export type DestinationStanding = 'bytes' | 'record' | 'rows' | 'sidecar';

/** The act whose destination something stands at: a move, or the resolution of a sync conflict that places the incoming copy (`api/conflicts.ts`). */
export type DestinationAct = 'move' | 'resolution';

/**
 * Something already stands at an act's destination, and neither a move nor a conflict resolution replaces anything there.
 *
 * `path` is the destination as requested; `standing` says what stands there, and `detail` (a `'sidecar'` standing only) the
 * sidecar path that is taken. The sentence names the remedy: delete what stands there (that is replicated), or choose another name.
 *
 * `act` is whose sentence it is. A resolution's remedy is not a move's: the copy is not a file being moved, the caller chooses a name or a
 * space for it, and `delete_file` of the occupant is one way out and not the way. The default is a move's, so a move cannot say it wrong.
 */
export class DestinationExists extends Error {
  override readonly name = 'DestinationExists';
  /** `detail` is the second path a `sidecar` standing names; `act` is whose sentence the refusal speaks (a move's, by default). */
  readonly detail?: string;
  constructor(readonly path: string, readonly standing: DestinationStanding, { detail, act = 'move' }: { detail?: string; act?: DestinationAct } = {}) {
    super(act === 'resolution' ? resolutionExistsSentence(path, standing) : destinationExistsSentence(path, standing, detail));
    if (detail !== undefined) this.detail = detail;
  }
}

/** The sentence of {@link DestinationExists} for a conflict resolution: built only from space-relative paths, and naming no move. */
function resolutionExistsSentence(path: string, standing: DestinationStanding): string {
  const remedy = 'Choose another name or space for the copy, or delete what stands there first (that deletes it on every instance it is replicated to).';
  return standing === 'record'
    ? `'${path}' has a file record but no bytes here (its content may still be arriving from a peer, or an earlier delete was interrupted), and resolving a conflict never replaces it; nothing was moved. ${remedy}`
    : `'${path}' already exists where the copy would be placed, and resolving a conflict never replaces it; nothing was moved. ${remedy}`;
}

/** The sentence of {@link DestinationExists}: built only from space-relative paths. */
function destinationExistsSentence(path: string, standing: DestinationStanding, detail?: string): string {
  switch (standing) {
    case 'bytes':
      return `'${path}' already exists, and a move never replaces anything. Delete it first (that deletes the file on every instance it is replicated to), or choose another name.`;
    case 'record':
      return `'${path}' has a file record but no bytes here (its content may still be arriving from a peer, or an earlier delete was interrupted), and a move never replaces anything. Delete it first with delete_file on '${path}' (that deletes it on every instance it is replicated to; a file whose content is still arriving from a peer appears once it has), or choose another name.`;
    case 'rows':
      return `'${path}' already has the records of another file, and a move never replaces anything. Delete that file first, or choose another name.`;
    case 'sidecar':
      return `'${path}' cannot be taken: '${detail ?? path}' already exists. Delete what stands there first, or choose another name.`;
  }
}

/**
 * A move's bytes already moved, but a record of another file holds an id the moved records need, so they have not followed. The move
 * stays owed. Housekeeping retries it, for a bounded number of attempts (the sentence says only that the server keeps retrying: how
 * long is not a promise); deleting the foreign file and repeating the move finishes it.
 *
 * `path` is the held id; `heldBy` is the foreign file whose records hold it (the top of the held row's chain: the file's own path, so a
 * caller can name it and delete it), ALWAYS given and always in the body; `from` and `to` are the move's own roots. All space-relative.
 */
export class DestinationHeldAfterMove extends Error {
  override readonly name = 'DestinationHeldAfterMove';
  constructor(readonly path: string, readonly from: string, readonly to: string, readonly heldBy: string) {
    super(`The bytes of '${from}' already moved to '${to}', but '${path}' is held by the records of '${heldBy}', another file, so the records of '${from}' have not followed. `
      + `The server keeps retrying the move. Delete '${heldBy}' and repeat the move to finish it.`);
  }
}

/** A directory delete that did not say `confirm: true`. Answered `confirm_required`. */
export class ConfirmRequired extends Error {
  override readonly name = 'ConfirmRequired';
  constructor(readonly path: string) {
    super('Deleting a directory requires confirm: true.');
  }
}

/** A delete of the space's root directory, which is never deleted. Answered `space_root_refused`. */
export class SpaceRootRefused extends Error {
  override readonly name = 'SpaceRootRefused';
  constructor(readonly path: string) {
    super('Cannot delete the space root directory.');
  }
}

/**
 * A move's bytes moved and some of its records did not follow yet; the move is owed and will be finished.
 *
 * `cause` is the failure that stopped it, and it is not optional in spirit: a walk (housekeeping finishing the move) and the log read
 * the chain under this wrapper, and a wrapper that hides a store failure makes the store being down look like one space failing.
 */
export class MoveStillOwed extends Error {
  override readonly name = 'MoveStillOwed';
  constructor(readonly from: string, readonly to: string, cause?: unknown) {
    super(`The move of '${from}' to '${to}' is not finished yet; it will be completed. Retry, or wait.`, cause === undefined ? undefined : { cause });
  }
}

/** An act that removes bytes from a path could not record the removal (its tombstone), so it did not act. */
export class ActNotRecorded extends Error {
  override readonly name = 'ActNotRecorded';
  constructor(readonly act: 'move' | 'delete', readonly path: string) {
    super(`Nothing was ${act === 'move' ? 'moved' : 'deleted'}: the ${act === 'move' ? 'move' : 'deletion'} of '${path}' could not be recorded.`);
  }
}

/**
 * A file-system failure that is the SERVER's, in words that name no path: the operator reads the cause in the log, the caller reads the
 * sentence (`fileSystemRefusalMessage`, the one place that sentence is built). The original is the `cause`.
 */
export class FileSystemFault extends Error {
  override readonly name = 'FileSystemFault';
  constructor(cause: unknown) {
    super(fileSystemRefusalMessage((cause as NodeJS.ErrnoException | null)?.code), { cause });
  }
}

/** How long a caller is told to wait before retrying an owed move, in seconds. */
const OWED_MOVE_RETRY_AFTER_S = 5;

export interface FileActAnswer {
  status: 400 | 409 | 422 | 500 | 503;
  /** The REST body, and the MCP `structuredContent` — the same object on both doors. */
  body: {
    error: string;
    code: 'path_blocked' | 'destination_exists' | 'destination_held_after_move' | 'confirm_required' | 'space_root_refused'
      | 'move_still_owed' | 'act_not_recorded' | 'file_system_fault';
    path?: string;
    /** The foreign file whose records hold an id a finished move needs: `destination_held_after_move` only. */
    heldBy?: string;
    retryable?: true;
  };
  /** Seconds a REST door puts in `Retry-After` (`sendRetryAfter`, the one writer of it); MCP has no place for it and says `retryable` in the body. */
  retryAfterSeconds?: number;
}

/**
 * The one answer to a file act's refusal or failure, counted: what a door calls when it ANSWERS. `undefined` when `err` is not one of
 * them, and then nothing is counted. The count is inside, so a door cannot answer without it; a caller that only classifies calls
 * {@link fileActAnswerOf}.
 */
export function fileActAnswer(err: unknown): FileActAnswer | undefined {
  const answer = fileActAnswerOf(err);
  if (answer !== undefined) answered[answer.body.code] += 1;
  return answer;
}

/**
 * Answers given since the process started, per code, every code present (0 before its first answer): the registry's
 * `ythril_file_act_answers_total` is read from it at scrape time. The keys are typed against the answer's own code union, so a code
 * added to {@link FileActAnswer} without a tally here does not compile.
 */
const answered: Record<FileActAnswer['body']['code'], number> = {
  path_blocked: 0,
  destination_exists: 0,
  destination_held_after_move: 0,
  confirm_required: 0,
  space_root_refused: 0,
  move_still_owed: 0,
  act_not_recorded: 0,
  file_system_fault: 0,
};

/** A snapshot of the tally {@link fileActAnswer} keeps: how many answers each code has been given. */
export function fileActAnswerCounts(): Readonly<Record<FileActAnswer['body']['code'], number>> {
  return { ...answered };
}

/**
 * What `err` would be answered, or `undefined` when it is not a file act's refusal or failure: a pure classification with no side
 * effect. A caller that does not put the answer on a door (it decides what to do with a refusal) asks this, so it does not count an
 * answer no door gave.
 */
export function fileActAnswerOf(err: unknown): FileActAnswer | undefined {
  if (err instanceof PathBlocked) {
    return { status: 409, body: { error: err.message, code: 'path_blocked', path: err.path } };
  }
  if (err instanceof DestinationExists) {
    return { status: 409, body: { error: err.message, code: 'destination_exists', path: err.path } };
  }
  if (err instanceof DestinationHeldAfterMove) {
    return { status: 409, body: { error: err.message, code: 'destination_held_after_move', path: err.path, heldBy: err.heldBy } };
  }
  if (err instanceof ConfirmRequired) {
    return { status: 422, body: { error: err.message, code: 'confirm_required', path: err.path } };
  }
  if (err instanceof SpaceRootRefused) {
    return { status: 400, body: { error: err.message, code: 'space_root_refused', path: err.path } };
  }
  if (err instanceof MoveStillOwed) {
    return {
      status: 503, body: { error: err.message, code: 'move_still_owed', path: err.to, retryable: true },
      retryAfterSeconds: OWED_MOVE_RETRY_AFTER_S,
    };
  }
  if (err instanceof ActNotRecorded) {
    return { status: 500, body: { error: err.message, code: 'act_not_recorded', path: err.path } };
  }
  if (err instanceof FileSystemFault) {
    // No `path` and no `Retry-After`: it is not about a path the caller gave, and nobody knows a retry will help.
    return { status: 500, body: { error: err.message, code: 'file_system_fault' } };
  }
  return undefined;
}
