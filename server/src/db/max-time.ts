/**
 * Did MongoDB abort this operation because its `maxTimeMS` expired?
 *
 * Keyed on **error code 50** (`MaxTimeMSExpired`) first, because a code is stable where a message is not.
 * The message check is a fallback for drivers or proxies that wrap the error and lose the code — without it,
 * a wrapped timeout falls through to whatever the caller does with an unknown error, and a deliberate deadline
 * surfaces as a 500 or, worse, as an empty answer.
 *
 * Moved out of `brain/recall.ts` when the filtered-recall completion and the face gallery needed the same
 * question answered: a second copy of this regex is how one caller comes to call a timeout "no match".
 *
 * **The fallback matches what the store SAYS when a deadline passed, never the word `maxTimeMS`.** An error that
 * names the option is usually the store refusing it where it does not belong — `cannot set maxTimeMS on getMore
 * command for a non-awaitData cursor` is a BadValue (code 2) — and read as a deadline it is retried for ever and
 * reported as "ran out of time" when the code is wrong (bundle-30 I6, D1). A code other than 50 is never overridden
 * by the message: the fallback is only for an error that lost its code on the way here.
 */
export function isMaxTimeExpired(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  // 50 MaxTimeMSExpired; 262 ExceededTimeLimit, which the store words the same way and the message match took before.
  if (code === 50 || code === 262) return true;
  if (typeof code === 'number') return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /exceeded time limit/i.test(msg);
}
