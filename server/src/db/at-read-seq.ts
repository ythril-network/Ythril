/**
 * The filter of a write that may land only on the VERSION of a record it read — "the record is still at the seq I
 * read, or still has none".
 *
 * ## What it prevents
 *
 * A writer that reads a record, works on it, then writes by `_id` alone writes over whatever landed in between. The
 * embed job is the costly case (bundle-30, `R6`): it reads a record, calls the model — the slow step — and wrote the
 * vector, the model and `matchedText` onto the record by `_id`. A peer's newer copy landing inside the model call
 * then got the OLD text's vector; a newer copy this instance suppresses got a vector it must never hold; and
 * because `matchedText` doubles as the "unchanged" fingerprint, the stale vector could be taken as current.
 *
 * The rule was first written in the write plan's commit (`brain/write-plan/commit.ts` `opFor`, a converge's
 * `expectSeq`), which now builds its filter here too: a stored copy that had NO seq is matched by `$exists: false`,
 * never by `seq: undefined` (which matches a `null` field and nothing that is absent in the way a reader expects).
 * One spelling, so a second writer cannot get that half wrong.
 *
 * @param seq the seq the writer read, or `null` when the record it read carried none (file metadata from before 4.0,
 *   a chunk row)
 */
export function atReadSeq(id: string, seq: number | null): Record<string, unknown> {
  return seq === null ? { _id: id, seq: { $exists: false } } : { _id: id, seq };
}

/** The seq a read document carries, in `atReadSeq`'s terms: a number, or `null` for none. */
export function readSeqOf(doc: Record<string, unknown>): number | null {
  return typeof doc['seq'] === 'number' ? doc['seq'] : null;
}
