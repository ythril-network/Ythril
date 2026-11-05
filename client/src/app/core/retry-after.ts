/**
 * How many seconds did the server ask this caller to wait? — the one reading of a refused request's `Retry-After` header.
 *
 * ## What it prevents
 *
 * The header arrives as text, and two pages parsed it by hand (the file listing's owed-answer wait, the second-factor lock's sentence). A hand
 * parse that forgets `Number('')` is `0`, or that lets `NaN` or a negative number through, turns "no wait named" into a timer of zero or a lock
 * said to end "in NaN minutes". This answers a count or `null` ("the answer named none, or named nonsense"), and each caller keeps its own
 * default and its own bound, because what to do with no wait is the caller's: a poll interval, or the longest a lock runs.
 */

/** What a refused request carries of its answer: only the headers are read here. */
export interface RetryAfterSource {
  headers?: { get(name: string): string | null };
}

/** The seconds `err`'s `Retry-After` names (zero or more), or `null` when it names none or something that is not a count of seconds. */
export function retryAfterSecondsOf(err: unknown): number | null {
  const raw = (err as RetryAfterSource | null | undefined)?.headers?.get('Retry-After');
  if (raw === null || raw === undefined) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
