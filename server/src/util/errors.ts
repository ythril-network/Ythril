/** Typed error classes for structured error handling across the codebase. */

/** Thrown when a requested resource does not exist. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  constructor(message: string) {
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
 * Thrown when the connected store cannot do what a capability needs — today, `$vectorSearch` on a MongoDB older than
 * 8.2. It is OUR sentence about the STORE: it tells an operator what to do and a caller that retrying later may work
 * (the store can be upgraded under it), so `classifyReadFailure` answers it as a store-side failure (`503`, retryable)
 * in its own words. It is a class of its own so that recognition does not depend on what its message says: the
 * classifier reads message patterns only from errors the DRIVER raised, and an own refusal that merely names `mongot`
 * is a `400` (`Q-361`).
 */
export class StoreCapabilityError extends Error {
  override readonly name = 'StoreCapabilityError';
  /** @param what the capability that is unavailable, as the sentence begins: `Semantic recall`, `Vector search`. */
  constructor(what: string) {
    super(
      `${what} is unavailable: $vectorSearch is not supported by the connected MongoDB. ` +
      'Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas.',
    );
  }
}

/** What `messageOf` says for a value whose text cannot be read (a hostile getter, a throwing `toString`). */
const UNREADABLE_ERROR = '[unreadable error]';

/**
 * The text of whatever was thrown: an `Error`'s message, anything else as `String` says it.
 *
 * The one place a `catch` turns a caught value into text, so the rule is not rewritten as
 * `err instanceof Error ? err.message : String(err)` at every site that needs it — each copy is a place a thrown
 * non-Error could be handled differently. It never throws: it runs inside
 * `catch` blocks, where a throw replaces the failure being handled with one nobody reads, and a Proxy whose
 * `message` getter throws, or an object whose `toString` does, answers `UNREADABLE_ERROR` instead.
 *
 * This is the RAW text. Text that reaches a log line goes through `peerText`, and text that reaches a caller
 * through `caughtFailureText` (`brain/store-failure.ts`); neither is this function's business.
 */
export function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return UNREADABLE_ERROR;
  }
}
