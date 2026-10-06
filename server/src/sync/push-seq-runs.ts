/**
 * "Send what this instance holds after a position, a page at a time, and say how far the peer is COMPLETE" — the
 * push half of the seq-run rule, for the record push and the tombstone push alike (bundle-52, `Q-277`).
 *
 * ## What it prevents
 *
 * Both pushes read `seq > cursor` in pages and moved the cursor to the last seq of a page. Records relayed from several
 * authors share seqs, so a page that ends inside a run left the rest of the run behind the cursor, never offered; and the
 * same cursor was reported as `deliveredThrough`, so a stop (a 5xx on the next page) inside a run claimed the whole run was
 * delivered, and `lastSeqPushed` then moved past records the peer never received. The two loops were written separately and
 * agreed on neither.
 *
 * ## The rule
 *
 * The position is a PAIR, `(seq, _id)`, read through `readAfterSeq` (`util/seq-keyset.ts`), so the next page continues the
 * run a full page ended inside and re-sends nothing — a record the peer refuses is offered, and counted, once.
 *
 * `outcome.deliveredThrough` is the last seq the peer is COMPLETE through: after a FULL page the run at its last seq may
 * continue, so that seq MINUS ONE; after a short page nothing more exists below the horizon, so that seq itself. It moves
 * only after the peer took the page, and a stop leaves it where it was — which is what a stop inside a run needs to report.
 */
import type { SeqPosition } from '../util/seq-keyset.js';
import { completeThrough, stopAtPageBound, stopTransfer, type TransferOutcome, type TransferStopped } from './watermark.js';

/**
 * @param o.outcome `deliveredThrough` is the position to start after (the member's watermark); updated as pages land.
 * @param o.read the rows after a position, at most `limit`, in `(seq, _id)` order — `readAfterSeq`, with the caller's filter.
 * @param o.send hand a page to the peer: `null` when it took it, or why the push must stop.
 * @param o.maxPages pages one call may send before it stops as capped (default: none), so the next cycle resumes.
 * @param o.stopped how a stop is logged: what stopped it and the seq the push is held at.
 */
export async function pushSeqRuns<T extends { _id: string; seq: number }>(o: {
  outcome: TransferOutcome;
  pageSize: number;
  maxPages?: number;
  read: (after: SeqPosition, limit: number) => Promise<T[]>;
  send: (rows: T[]) => Promise<string | null>;
  stopped: TransferStopped;
}): Promise<void> {
  const { outcome } = o;
  let after: SeqPosition = { seq: outcome.deliveredThrough };
  for (let pages = 0; ; pages++) {
    if (stopAtPageBound(outcome, o.stopped, pages, o.maxPages)) return;
    const rows = await o.read(after, o.pageSize);
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    const refusal = await o.send(rows);
    if (refusal !== null) {
      stopTransfer(outcome, o.stopped, refusal);
      return;
    }
    const full = rows.length >= o.pageSize;
    outcome.deliveredThrough = Math.max(outcome.deliveredThrough, completeThrough(last.seq, full));
    if (!full) return;
    after = { seq: last.seq, id: last._id };
  }
}
