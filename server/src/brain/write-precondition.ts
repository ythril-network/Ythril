/**
 * Optimistic concurrency for brain-record updates, enforced where it is actually atomic.
 *
 * ── Why the filter and not a comparison ─────────────────────────────────────────────────────────
 *
 * The obvious shape is: read the record, compare its `seq` with the client's `If-Match`, then write.
 * That is a race with a longer window than the one it claims to close — every update function reads,
 * then validates and resolves (a network call, on the slow paths), and only then writes. A
 * comparison made at the top has been stale for the whole of that.
 *
 * Putting `seq` in the update's own filter makes the check part of the write. MongoDB matches the
 * document and applies the operators in one operation, so either the record was still at that `seq`
 * and the write landed, or it was not and nothing happened. There is no window to lose an update in,
 * and it costs nothing: every update function already issues exactly this `findOneAndUpdate`.
 *
 * ── Why `seq` is the right validator, and how to talk about it ──────────────────────────────────
 *
 * `seq` comes from `withSeq(spaceId, …)` — a per-SPACE monotonic counter, not a per-record version. It
 * still answers the only question a precondition asks ("has this record been written since I read
 * it?"), because a record's `seq` changes on every write to that record and on no other event. What
 * it is NOT is a small counter that goes 1, 2, 3 for a given record, so nothing user-facing should
 * describe it as a version number: it is an opaque validator that clients echo back.
 *
 * ── The one thing the caller must get right ─────────────────────────────────────────────────────
 *
 * A `null` from `findOneAndUpdate` means the filter matched nothing. Under a precondition that means
 * "the record moved or is gone"; with no precondition it means "gone". The update functions return
 * `null` in both cases and the ROUTE decides between 404 and 412, because only the route knows
 * whether it read the record a moment earlier.
 */

/**
 * The filter for an update's own write. `ifMatchSeq === undefined` gives the unconditional filter
 * this code has always used, byte for byte.
 */
export function writeFilterFor(id: string, ifMatchSeq?: number): Record<string, unknown> {
  return ifMatchSeq === undefined ? { _id: id } : { _id: id, seq: ifMatchSeq };
}

/**
 * The metric outcome for a write that has just been attempted.
 *
 * Three values, and the third is new: `refused` is a write a precondition STOPPED. It is deliberately
 * not folded into `collision`, because the two mean opposite things to anyone reading the graph — a
 * collision is a lost update that happened, a refusal is one that did not. Folding them would also
 * corrupt the measurement the 412 work was prioritised on: the collision rate has been accumulating
 * since #674, and a series whose meaning changes halfway through cannot be compared with itself.
 */
export function writeOutcome(
  wrote: boolean,
  hadPrecondition: boolean,
  seqMoved: boolean,
): 'clean' | 'collision' | 'refused' {
  if (!wrote) return hadPrecondition ? 'refused' : 'collision';
  return seqMoved ? 'collision' : 'clean';
}
