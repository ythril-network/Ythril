/**
 * Page a peer's stream by POSITION, follow the peer's own cursor, and say how far the transfer is COMPLETE (bundle-81, design rev 8 §6; the
 * successor of `sync/seq-run-pager.ts`).
 *
 * ## The question it answers
 *
 * "Given a way to ask a 6.0 peer for the page after a position, read everything it will give this cycle, hand each page on once, and report where
 * the transfer is complete through." It is the one pager of every position-paged pull: the six record families, the brain tombstones, the one-time
 * tombstone re-read and the file-stamp report's feed. A caller supplies how to ask (`fetch`) and what to do with what came (`deliver`).
 *
 * ## What it owns so no caller can drop it
 *
 *  - **Both parsers' refusal.** Every answer goes through `parsePageAnswer` (`sync/wire-answer.ts`), which THROWS `PeerPagesBySeq` on a page without
 *    `positions: 1`, `through` and `head`: the throw passes this loop and ends the member's turn, writing no mark. A caller cannot read a 5.x page.
 *  - **`through` is the peer's, and it is trusted for nothing else than what it says.** A page's `through` is "complete through" (the peer's own
 *    position before an unfinished tie, or its settled cap less one when nothing follows), so this loop never derives a position from a record: a
 *    record carries none on the wire. A `through` above the peer's own `head` is a lie about the peer's own stream and ends the transfer.
 *  - **The cursor is followed, never trusted to move.** It must be a cursor this client can read (`p1.`, opaque to a caller), and strictly past the
 *    position the request was made from, or the transfer would loop on a peer that echoes one back; a page that says more follows and brings nothing
 *    is the same fault.
 *  - **The `head` guard** (rev 8 §4): a first request from a mark ABOVE the peer's `head` (the peer's settled cap less one) means the peer's numbers
 *    went backwards (a database restore with the wall clock set back). The transfer restarts from 0 once, tells the caller (`onBehind`) so the mark is
 *    forgotten and counted, and the re-read sorts it out by id and version.
 *  - **The cycle's page bound is a CAP, not a fault** (`stopAtPageBound`): the transfer reports `stoppedBy: 'cap'` and the engine counts the cycle partial.
 *  - **Shutdown stops it at a page boundary** (`shouldStop`, bundle-39 D5): `stoppedBy: 'closing'`, the page in flight landed and nothing failed; a fetch
 *    the shutdown signal aborted is the same stop.
 *
 * `deliveredThrough` rides on `outcome`, updated as the loop goes, so a throw leaves it at the last page delivered.
 */
import { decodePositionCursor, comparePositionStarts, type PositionStart } from '../util/position-keyset.js';
import { MAX_TRANSFER_PAGES, stopAtPageBound, stopTransfer, type TransferOutcome, type TransferStopped } from './watermark.js';
import { parsePageAnswer } from './wire-answer.js';
import { stopAtClosing, stopIfClosingThrew } from './arrival-stop.js';

/** What one request asks: the position to read after, or the peer's own cursor (which wins). */
export interface PositionRunAsk {
  afterPos: number;
  cursor: string | null;
}

/** What `fetch` hands back: a status the peer answered (a stop), or the body of a 2xx page, which this loop parses. */
export type PositionRunPage = { status: number } | { body: unknown };

/**
 * A cursor a transfer may follow, or `null`: the cursor field of an answer that is a string is a cursor, anything else is none.
 * (The file-tombstone stream, which is an ISO stream, reads its own cursor through this too.)
 */
export function serverCursorOf(next: unknown): string | null | undefined {
  return typeof next === 'string' ? next : next === null ? null : undefined;
}

export async function pagePositionRuns(o: {
  /** In: `deliveredThrough` is the mark the transfer starts from. Out: what it is complete through, and whether and why it stopped. */
  outcome: TransferOutcome;
  /** What a request asks for per page. */
  limit: number;
  /** Requests this transfer makes before it stops as capped; default {@link MAX_TRANSFER_PAGES}. */
  maxPages?: number;
  /** Ask the peer. A transport failure THROWS (the member's failure); a status the peer answered is returned. */
  fetch: (ask: PositionRunAsk, limit: number) => Promise<PositionRunPage>;
  /** Take a page's items. `null`: taken; a string: the reason the transfer must stop (a write this instance could not make). */
  deliver: (items: unknown[]) => Promise<string | null>;
  stopped: TransferStopped;
  /** The peer's `head` is below the mark this transfer started from: the peer's positions went backwards. Called once; the transfer then restarts from 0. */
  onBehind?: (peerHead: number, startedFrom: number) => void;
  /**
   * Asked at each page boundary: true stops the transfer as `'closing'` where the last page landed (bundle-39 D5). Defaults to shutdown having begun
   * (`isShuttingDown`), so no caller can leave a transfer paging through the drain; a test passes its own.
   */
  shouldStop?: () => boolean;
}): Promise<void> {
  const { outcome } = o;
  const maxPages = o.maxPages ?? MAX_TRANSFER_PAGES;
  let ask: PositionRunAsk = { afterPos: outcome.deliveredThrough, cursor: null };
  /** The position the current ask reads AFTER: the mark, or the pair cursor last followed. */
  let floor: PositionStart = { pos: ask.afterPos };
  let checkedHead = false;
  const stop = (why: string): void => stopTransfer(outcome, o.stopped, why);

  for (let pages = 0; ; pages++) {
    if (stopAtClosing(outcome, o.stopped, o.shouldStop)) return;
    if (stopAtPageBound(outcome, o.stopped, pages, maxPages)) return;
    let got: PositionRunPage;
    try { got = await o.fetch(ask, o.limit); } catch (err) {
      // A fetch the shutdown signal aborted is a stop for shutdown, not the peer's failure; any other throw is the caller's to read, as always.
      if (stopIfClosingThrew(outcome, o.stopped)) return;
      throw err;
    }
    if ('status' in got) { stop(`the peer answered ${got.status}`); return; }
    const page = parsePageAnswer(got.body);

    if (!checkedHead && ask.cursor === null) {
      checkedHead = true;
      if (outcome.deliveredThrough > page.head) {
        o.onBehind?.(page.head, outcome.deliveredThrough);
        outcome.deliveredThrough = 0;
        ask = { afterPos: 0, cursor: null };
        floor = { pos: 0 };
        continue;
      }
    }
    if (page.through > page.head) { stop('the peer\'s page is complete through a position above its own head'); return; }

    let next: PositionStart | undefined;
    if (page.nextCursor !== null) {
      next = decodePositionCursor(page.nextCursor);
      if (next === undefined) { stop('the peer handed back a cursor that cannot be read'); return; }
      if (comparePositionStarts(next, floor) <= 0) { stop('the peer\'s cursor does not move past the position it was asked from'); return; }
      if (page.items.length === 0) { stop('the peer says more follows and served nothing'); return; }
    }

    if (page.items.length > 0) {
      const refusal = await o.deliver(page.items);
      if (refusal !== null) { stop(refusal); return; }
    }
    outcome.deliveredThrough = Math.max(outcome.deliveredThrough, page.through);
    if (next === undefined) return;
    ask = { afterPos: floor.pos, cursor: page.nextCursor };
    floor = next;
  }
}
