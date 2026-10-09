/**
 * Did a PEER deliver this record? The one spelling of that question as a database predicate.
 *
 * `deliveredBy` names the member a record arrived from, and it has two values that are NOT a peer, which is the whole
 * reason this is a module rather than a line:
 *
 *  - `''` is "nobody's delivery". The back-fill (`delivered-by-backfill.ts`) stamps it on every row it cannot prove a
 *    route for, a move re-keys a row with it (`rekeyedRow`, `local-only-fields.ts`), and a local write or an admin push
 *    stores it. So an author-less row that was always this instance's own carries `''` after the back-fill, not an
 *    absent field — and a check written as `{ deliveredBy: { $exists: false } }` declines every one of those.
 *  - this instance's own id, which a relayed copy of its own record can carry. Its own delivery is not a peer's.
 *
 * A hand-written copy drops one of those two, and both failures are silent: drop `''` and every pre-authorship local row
 * reads as a peer's; drop `self` and a record this instance wrote reads as somebody else's.
 *
 * ## What it is for, and what it is NOT
 *
 * It answers who supplied the record, which is not the same question as who AUTHORED it. A caller that wants "is this
 * row mine to write authored content onto" combines it with the author check itself; a caller that wants "may this
 * be removed as a peer's sidecar" combines it the other way. `fill-file-meta.ts`'s `receiverMade` is NOT a caller and
 * must not become one: it asks whether the RECEIVER created the row, and a row the bytes pull created carries a peer's
 * `deliveredBy` and is exactly what it exists to fill.
 */

/** A predicate matching the records a peer delivered: `deliveredBy` set, and neither `''` nor this instance. */
export function deliveredByAPeer(self: string | null | undefined): Record<string, unknown> {
  return { deliveredBy: { $exists: true, $nin: ['', self ?? null] } };
}

/**
 * A predicate matching the records NO peer delivered: absent, `''`, or this instance's own id.
 *
 * Derived from {@link deliveredByAPeer} with `$nor` rather than written again, so the two cannot disagree about a value
 * — which is the defect a second spelling of the positive form would be.
 */
export function notDeliveredByAPeer(self: string | null | undefined): Record<string, unknown> {
  return { $nor: [deliveredByAPeer(self)] };
}
