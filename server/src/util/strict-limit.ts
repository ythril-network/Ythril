/**
 * What a `limit` may be where a caller who asks for a page must be TOLD it asked for too much, not given less — once.
 *
 * ## Why this exists
 *
 * `parseLimit` (`util/pagination.ts`) clamps: a garbage or oversized `limit` becomes the default or the cap, and the caller
 * never learns. That is right for a list a person pages through and wrong for a caller that writes a loop around the answer
 * (`Q-109`: a cap applied quietly is a count nobody can trust). Three acts refuse instead — the sync history, the vote
 * outcomes and the embed-job list — and each wrote the bound check and the sentence for itself, so two said "must be an
 * integer from 1 to N" and one said it with backticks. The check and the sentence are here, and the sentence is the one a
 * caller reads whichever door and whatever the wrong value was.
 *
 * ## What it takes, and the shape it keeps
 *
 * REST reaches an act with a query string's TEXT and MCP with a JSON value, so {@link parseStrictLimit} takes either: an
 * integer, or the text of one. Anything else — a fraction, `NaN`, `null`, an object, an array, text that is not digits — is
 * the one refusal. Absent (and the empty string a bare `?limit=` sends) is the default. A door that already holds a number
 * asks {@link limitRefusal} directly.
 */

/** The sentence a caller reads when its `limit` is outside `1`..`max`. */
export function limitRefusal(limit: number, max: number): string | null {
  return Number.isInteger(limit) && limit >= 1 && limit <= max ? null : `limit must be an integer from 1 to ${max}`;
}

export type StrictLimit = { ok: true; limit: number } | { ok: false; error: string };

/** `raw` as a limit in `1`..`max`, `fallback` when it is absent or empty, the one refusal otherwise. */
export function parseStrictLimit(raw: unknown, fallback: number, max: number): StrictLimit {
  if (raw === undefined || raw === '') return { ok: true, limit: fallback };
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : NaN;
  const error = limitRefusal(n, max);
  return error ? { ok: false, error } : { ok: true, limit: n };
}
