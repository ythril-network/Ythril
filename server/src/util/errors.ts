/** Typed error classes for structured error handling across the codebase. */

/** Thrown when a requested resource does not exist. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown by a tool handler that a shared module has refused with a status of its own: a `429` from the heavy-call rail, a
 * `409` from a single flight. `callTool` answers it with that status on the REST door; a refusal the handler merely
 * returns is a `422` ("well-formed and refused"), which tells a caller nothing about whether to wait or to change the call.
 * The message is the whole answer, the same sentence the dedicated REST route sends.
 *
 * `body` is the structure the REST door answers beside that sentence — a failed parse's `{ error, issues }` — carried as the tool
 * result's `structuredContent`, so a caller that reads the structure gets it on both doors and not on one.
 */
export class ToolRefusal extends Error {
  override readonly name = 'ToolRefusal';
  constructor(readonly status: 400 | 403 | 404 | 409 | 429, message: string, readonly body?: Readonly<Record<string, unknown>>) {
    super(message);
  }
}

/** Thrown when a request is invalid (bad params, missing fields, etc.). */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * A refusal of what the CALLER sent, made by our own code: a path that leaves the space, a chunk range that does not tile the file, an
 * encoding that is not one of the two. The REST doors answer it `400` in its own sentence.
 *
 * ## Why it is not a bare `RangeError`
 *
 * Our refusals used to be `RangeError`s, and a door chose its `400` by `instanceof RangeError`. The runtime throws `RangeError` too (an
 * invalid `Buffer` length, an out-of-range offset, a stack overflow), so a fault of the server was answered `400` in the runtime's
 * words, and a sync sender reads `400` as "refused about the bytes" and never offers them again. A door that means "our refusal" asks for
 * this class, and any other `RangeError` is the fault it is. It extends `RangeError` so a caller that still asks the older question keeps
 * its answer; the tool doors, which answer every `Error` as a refusal, are unchanged.
 */
export class RequestRefusal extends RangeError {
  override name = 'RequestRefusal';
}
