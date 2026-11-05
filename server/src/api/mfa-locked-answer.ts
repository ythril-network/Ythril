/**
 * The one answer a locked second factor gets, at every door that asks for a code (Q-694).
 *
 * ## What it prevents
 *
 * Three doors verify a code (`enforceMfa`, the exemption grant, `POST /api/mfa/verify`) and each had its own refusal shape. A lock answered
 * three ways would be three contracts for a client to learn, and a door that forgot `Retry-After` or `retryable: false` would tell an
 * automation to retry a lock that cannot lift. One sender, so the status, the body and the header cannot differ by door.
 *
 * The answer is `429 { error: 'MFA_LOCKED', code: 'MFA_LOCKED', key, retryAfterSeconds, retryable: false, message }` with `Retry-After`
 * equal to `retryAfterSeconds` (through `sendRetryAfter`, the one writer of that header). `key` says what is locked, `token` or `address`;
 * `retryable: false` says the same request cannot succeed before the wait is spent: a client waits and does not prompt for another code.
 *
 * It lives with the doors (`api/`), beside `send-failure.ts` whose `sendRetryAfter` it uses; the auth guard that answers the lock imports it
 * from there, as it does the other answer shapes the doors share.
 */
import type { Response } from 'express';
import { sendRetryAfter } from './send-failure.js';
import { MFA_FAILURES_MAX, MFA_LOCKOUT_WINDOW_MS, type MfaLock } from '../auth/code-attempts.js';

/** Write the lock's `429` on `res`. */
export function sendMfaLocked(res: Response, lock: MfaLock): void {
  const minutes = Math.max(1, Math.ceil(lock.retryAfterSeconds / 60));
  const what = lock.key === 'token' ? 'This token' : 'This address';
  sendRetryAfter(res, lock.retryAfterSeconds);
  res.status(429).json({
    error: 'MFA_LOCKED',
    code: 'MFA_LOCKED',
    key: lock.key,
    retryAfterSeconds: lock.retryAfterSeconds,
    retryable: false,
    message: `${what} is locked for the second factor: ${MFA_FAILURES_MAX} wrong codes in ${MFA_LOCKOUT_WINDOW_MS / 60_000} minutes. `
      + `Do not send another code; try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  });
}
