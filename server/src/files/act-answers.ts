/**
 * What a file act (a move, a directory create, a write, a delete) answers when it does not happen — one answer per
 * refusal, on every door.
 *
 * ## The question it answers
 *
 * "This file act failed or was refused: what status, what body, and what may the caller do next?" Asked by the REST
 * file routes (`api/files.ts`, `api/files-upload.ts`) and by the MCP dispatcher (`mcp/call-tool.ts`) for the same
 * thrown error, so `PATCH /api/files`, `POST /api/move_file` and MCP `move_file` cannot answer one failure three ways
 * (they did: `500 Failed to move path`, `400` with the raw filesystem message — the absolute data path included —
 * and the same `400` again).
 *
 * ## What it prevents
 *
 * A refusal that is the CALLER's (a destination a regular file blocks, a destination another file's records hold)
 * answered as a server fault, and a failure that is the SERVER's answered with the filesystem's or the driver's own
 * words. Every message here is built from the space-relative paths the act was given, never from `err.message` of a
 * lower layer.
 *
 * ## Why these statuses
 *
 * - `409` for a blocked or taken destination, not `400`/`422`: a peer's sync push reads `400` and `422` as "refused
 *   about the bytes" and stops re-sending those bytes until their hash changes (`sync/file-push.ts`), but these
 *   refusals are about the receiver's TREE, which can change, so the sender must keep retrying. Not `404` either: a
 *   `404` on a file act says the SOURCE names nothing.
 * - `503` + `Retry-After` for a move whose bytes moved and whose records did not all follow yet: the move is owed, a
 *   retry (or housekeeping) finishes it. It is not the store's "not answering" — the store may be fine.
 * - `500` for an act that could not record its own deletion: nothing was moved or deleted, and the reason is ours.
 * - `500` for a file-system failure that is not about the caller's path ({@link FileSystemFault}): the reason is the server's
 *   storage, said in words that name no path.
 */
import { fileSystemRefusalMessage } from '../util/fs-failure-words.js';

/** A destination cannot be created because a regular file stands where a directory must be (or it is the source's own subtree). */
export class PathBlockedByFile extends Error {
  override readonly name = 'PathBlockedByFile';
  /** `path` is space-relative: the blocker, or the requested path when the blocker is outside it. */
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

/** The rows a move would take are held by ANOTHER file's records (not the destination file it replaces). */
export class DestinationTakenByOther extends Error {
  override readonly name = 'DestinationTakenByOther';
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

/** A move's bytes moved and some of its records did not follow yet; the move is owed and will be finished. */
export class MoveStillOwed extends Error {
  override readonly name = 'MoveStillOwed';
  constructor(readonly from: string, readonly to: string) {
    super(`The move of '${from}' to '${to}' is not finished yet; it will be completed. Retry, or wait.`);
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
  status: 409 | 503 | 500;
  /** The REST body, and the MCP `structuredContent` — the same object on both doors. */
  body: { error: string; code: 'path_blocked' | 'destination_taken_by_other' | 'move_still_owed' | 'act_not_recorded' | 'file_system_fault'; path?: string; retryable?: true };
  /** Seconds a REST door puts in `Retry-After` (`sendRetryAfter`, the one writer of it); MCP has no place for it and says `retryable` in the body. */
  retryAfterSeconds?: number;
}

/** The one answer to a file act's refusal or failure, or `undefined` when `err` is not one of them. */
export function fileActAnswer(err: unknown): FileActAnswer | undefined {
  if (err instanceof PathBlockedByFile) {
    return { status: 409, body: { error: err.message, code: 'path_blocked', path: err.path } };
  }
  if (err instanceof DestinationTakenByOther) {
    return { status: 409, body: { error: err.message, code: 'destination_taken_by_other', path: err.path } };
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
