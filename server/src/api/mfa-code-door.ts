/**
 * Does this request carry a live second-factor code? — the one sequence a door that demands a code runs (Q-694).
 *
 * ## What it prevents
 *
 * Two doors asked for a code with the same four steps written twice (`enforceMfa` in `auth/middleware.ts`, the exemption grant in
 * `api/tokens.ts`): the token's lock first, then the code from `X-TOTP-Code`, then the attempt counter, then the answer. The order is the
 * contract. A lock asked AFTER the code prompts a client for a code that cannot succeed; a missing code sent to the counter would count a request
 * that guessed nothing; a verifier asked before the lock spends a step on a locked token. A third copy that got one of them wrong would be a door
 * with a hole no behaviour test of the other two sees, so the sequence is here once and each door passes only what is its own: the bodies of its
 * two refusals.
 *
 * `POST /api/mfa/verify` is not a caller: it answers `{ valid }` and never refuses a missing code, so it asks `tryMfaCode` itself.
 *
 * It lives with the doors (`api/`), beside `mfa-locked-answer.ts` whose lock answer it sends; it writes the response, so it is not part of
 * `auth/code-attempts.ts`, which writes none.
 */
import type { Request, Response } from 'express';
import { tryMfaCode, mfaLockOfToken } from '../auth/code-attempts.js';
import { sendMfaLocked } from './mfa-locked-answer.js';

/** The two bodies a door answers `403` with when the code is not there or is not good. A lock is answered by `sendMfaLocked`, the same at every door. */
export interface MfaDoorRefusals {
  /** No code was sent. Never a guess, so never counted. */
  missing: object;
  /** A code was sent and was refused: wrong, replayed, stale, or with no secret to judge it against. */
  invalid: object;
}

/**
 * Whether the request carries a code the token may use. On a refusal the answer is already written on `res` (`429 MFA_LOCKED`, or `403` with the
 * door's own body) and this returns false; on true nothing was written.
 *
 * @param tokenId the id the attempts are counted under (`callerKeyOf`)
 */
export function mfaCodeHolds(req: Request, res: Response, tokenId: string, refusals: MfaDoorRefusals): boolean {
  // A locked token is answered before it is asked for a code (the lock is the answer; no code can succeed). Reads only: it counts nothing.
  const lock = mfaLockOfToken(tokenId);
  if (lock) {
    sendMfaLocked(res, lock);
    return false;
  }
  const code = (req.headers['x-totp-code'] as string | undefined ?? '').trim();
  // A request with no code is never a guess: it is refused here and not counted.
  if (!code) {
    res.status(403).json(refusals.missing);
    return false;
  }
  // A code goes through the attempt counter, which answers an object: `.ok`, and `.reason` for a lock the address key began.
  const attempt = tryMfaCode(code, { tokenId, req });
  if (!attempt.ok) {
    if (attempt.reason === 'locked') sendMfaLocked(res, attempt);
    else res.status(403).json(refusals.invalid);
    return false;
  }
  return true;
}
