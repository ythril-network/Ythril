/**
 * Is a value an ISO8601 instant that sorts as TEXT — the one spelling of "comparable" for every position and
 * acknowledgement that is compared with `<`, `>` or stored in an index?
 *
 * ISO8601 UTC timestamps sort lexically, which is what lets a position be compared with `<` instead of parsing dates.
 * That only holds for the fixed-width `Z` form the codebase writes (`new Date().toISOString()`), so anything else is
 * treated as unknown rather than compared — a `+02:00` offset would sort wrongly and silently move a floor or a cursor
 * forward. It lives here, below both users (the file-tombstone acknowledgement in `sync/`, the file-tombstone cursor in
 * `util/seq-keyset.ts`), so neither has to import the other's layer to ask.
 */
export function isComparableIso(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v);
}

/** The width of a comparable instant, in characters — what lets a cursor split `<instant><separator><id>` without parsing. */
export const COMPARABLE_ISO_LENGTH = 24;
