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
