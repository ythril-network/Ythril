/**
 * Push this instance's stream to a peer in pages by POSITION, and say how far the peer is COMPLETE (bundle-81, design rev 8 §6; the successor of
 * `sync/push-seq-runs.ts`).
 *
 * ## The question it answers
 *
 * "Given a way to read the rows after a position and a way to send them, send everything this cycle will carry and report where the peer is complete
 * through." It is the one loop of every position-paged push: the six record families and the brain tombstones.
 *
 * ## What it owns so no caller can drop it
 *
 *  - **The page boundary may fall inside a run of equal positions** (the legacy band has them), so a FULL page is complete through the position BEFORE
 *    its last row (`completeThrough`), and the next read continues the run with the pair `(pos, _id)`. The loop passes that pair; no caller builds one.
 *  - **An EMPTY or SHORT read is complete through the settled cap less one**, not through the last row sent and not through nothing: every position
 *    below the cap is delivered or does not exist (a write in flight holds the cap below it), so a cycle whose only content was a tombstone, or whose
 *    selection found nothing, still moves the mark (Q-394). Without that the same rows were offered again every cycle for ever.
 *  - **A refusal stops the transfer** (`stopTransfer`) at the position it is complete through; the cycle's page bound stops it as a CAP.
 *
 * The rows come back without their position (a position is local and never on the wire), and `read` is the position reader (`readAfterPosition`),
 * which asks the readiness of the space inside, so a space that owes its positions throws `PositionsBuilding` here and sends nothing.
 */
import { completeThrough, stopAtPageBound, stopTransfer, type TransferOutcome, type TransferStopped } from './watermark.js';
import type { PositionRead, PositionStart } from '../util/position-keyset.js';

export async function pushPositionRuns<T extends { _id: string }>(o: {
  /** In: `deliveredThrough` is the mark the push starts from. Out: what the peer is complete through, and whether and why the push stopped. */
  outcome: TransferOutcome;
  pageSize: number;
  maxPages?: number;
  /** The rows after `after`, at most `limit`, below the settled cap (`readAfterPosition`). */
  read: (after: PositionStart, limit: number) => Promise<PositionRead<T>>;
  /** Send a page. `null`: the peer took it; a string: why the push must stop (the peer refused it). */
  send: (rows: T[]) => Promise<string | null>;
  stopped: TransferStopped;
}): Promise<void> {
  const { outcome } = o;
  let after: PositionStart = { pos: outcome.deliveredThrough };
  for (let pages = 0; ; pages++) {
    if (stopAtPageBound(outcome, o.stopped, pages, o.maxPages)) return;
    const read = await o.read(after, o.pageSize);
    const rows = read.rows.map(r => r.row);
    const last = read.rows[read.rows.length - 1];
    if (last !== undefined) {
      const refusal = await o.send(rows);
      if (refusal !== null) { stopTransfer(outcome, o.stopped, refusal); return; }
    }
    const full = read.rows.length >= o.pageSize;
    // A full page may end inside a run, so it is complete only below its last position; anything shorter has read to the end of what the cap lets
    // through, and everything below the cap is delivered or absent.
    const through = full && last ? completeThrough(last.pos, true) : Math.max(0, read.cap - 1);
    outcome.deliveredThrough = Math.max(outcome.deliveredThrough, through);
    if (!full || last === undefined) return;
    after = { pos: last.pos, id: last.row._id };
  }
}
