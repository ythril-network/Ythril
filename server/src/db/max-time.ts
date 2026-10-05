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
 * command for a non-awaitData cursor` is a BadValue (code 2) — and read as a deadline it is reported as "the search
 * ran out of time" and retried as one, when the defect is in the bound (bundle-30 I6, D1).
 */
export function isMaxTimeExpired(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 50) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /operation exceeded time limit|exceeded time limit/i.test(msg);
}
