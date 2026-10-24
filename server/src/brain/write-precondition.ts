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
 * `seq` is the record's VERSION: a local write stamps `max(V + 1, the stored version + 1, …)` (`util/version-stamp.ts`), so it
 * is above every version this instance has held for the record, and it changes on every write to that record and on no other
 * event. It still answers the only question a precondition asks ("has this record been written since I read it?"). What it is
 * NOT is a small counter that goes 1, 2, 3 for a given record, so nothing user-facing should describe it as a count: it is an
 * opaque validator that clients echo back.
 *
 * ── The write is the version's own (bundle-81, decision 14) ─────────────────────────────────────
 *
 * A local write is stamped against the version it READ (`readSeq`), and its filter names that version whether or not the
 * caller sent an `If-Match`. Without it an arrival landing between the read and the write was overwritten by a stamp BELOW
 * it, and since an arrival no longer lifts the counter nothing corrected that afterwards: a peer holding the arrival never
 * took this copy as newer. So `readSeq` is REQUIRED — a caller cannot ask for the unconditional filter, and there is none.
 * A miss without `If-Match` is retried by the writer (re-read, re-stamp, at most three attempts); with one, it is the
 * precondition refusal at once.
 *
 * ── The one thing the caller must get right ─────────────────────────────────────────────────────
 *
 * A `null` from `findOneAndUpdate` means the filter matched nothing. Under a precondition that means
 * "the record moved or is gone"; with no precondition it means "gone" or "moved again after every retry". The update
 * functions return `null` in both cases and the ROUTE decides between 404 and 412, because only the route knows
 * whether it read the record a moment earlier.
 */

import { atReadSeq } from '../db/at-read-seq.js';

/**
 * The code a write answers when the version it would stamp is above the highest one sync accepts (`MAX_INGEST_SEQ`): the record's
 * own version is at that ceiling, so this instance can no longer change or delete it — the instance that wrote it can. A constant,
 * spelled here once because this module owns a write's version outcome; the clients' words are keyed by it
 * (`networks.refusal.record_version_at_ceiling`).
 */
export const RECORD_VERSION_AT_CEILING = 'record_version_at_ceiling';

/**
 * A local write was refused because its version would be above `MAX_INGEST_SEQ`, which every receiver refuses: written, it would
 * reach nobody. Thrown by `versionsFor` (`util/version-stamp.ts`) before anything is written, so a refused edit changes nothing, a
 * refused delete leaves no tombstone and a refused merge is refused whole. One sentence for both doors: REST answers `409` with
 * `{ error, code, id }`, MCP a refusal carrying the same code and sentence (`writeRefusalAnswer`).
 */
export class RecordVersionAtCeiling extends Error {
  override readonly name = 'RecordVersionAtCeiling';
  readonly code = RECORD_VERSION_AT_CEILING;
  constructor(readonly id: string) {
    super('This record\'s version is already at the highest number that sync accepts, so this instance can no longer change or delete it. '
      + 'The instance that wrote it can.');
  }
}

/**
 * The filter for an update's own write: still at the version the stamp read (`readSeq`: a number, or `null` when the stored row carries
 * none) — `atReadSeq`'s, the one spelling of that (which the write plan's converge uses too, bundle-30 I6, C3) — and, when the caller sent an
 * `If-Match`, still at that version as well, so an `If-Match` of any other version never matches. `readSeq` is required on purpose (see above).
 */
export function writeFilterFor(
  id: string, { readSeq, ifMatchSeq }: { readSeq: number | null; ifMatchSeq?: number | null | undefined },
): Record<string, unknown> {
  const read = atReadSeq(id, readSeq);
  return ifMatchSeq === undefined || ifMatchSeq === readSeq ? read : { $and: [read, atReadSeq(id, ifMatchSeq)] };
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
