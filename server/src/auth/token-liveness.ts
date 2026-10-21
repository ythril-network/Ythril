/**
 * Is this stored token still live: not past its expiry?
 *
 * ## Why a module
 *
 * "Not expired" was written out three times in `auth/tokens.ts` (the cache hit, the prefix path and the legacy-prefix path of
 * `findMatchingToken`), and the personal-views sweep (`config/views.ts`, Q-531) needs the same answer about an OWNER's tokens. A
 * sweep that judged liveness its own way would delete the views of an owner the authenticator still lets in, or keep the views of
 * one it has refused for a month. The cut-off is the instant `expiresAt` passes: a token is live at its expiry instant and not after.
 *
 * Takes the milliseconds as an argument so the sweep can be asked about a day that has not come (`sweepOwnerlessViews({ now })`).
 */
export function tokenIsLive(token: { expiresAt: string | null }, nowMs: number = Date.now()): boolean {
  if (!token.expiresAt) return true;
  return !(new Date(token.expiresAt).getTime() < nowMs);
}
