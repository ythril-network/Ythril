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
 */
export class ToolRefusal extends Error {
  override readonly name = 'ToolRefusal';
  constructor(readonly status: 400 | 404 | 409 | 429, message: string) {
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
