/**
 * How far a SHARED watermark may advance when several independent transfers ran beneath it.
 *
 * ## The defect this exists to make impossible
 *
 * `lastSeqPushed` and `lastSeqReceived` are **one number per member per space**. Each sync cycle runs FIVE
 * independent transfers under that one number — tombstones plus facts, entities, edges and chrono — and each
 * of them can stop early on its own: a non-`ok` response from the peer, or a page cap reached.
 *
 * Both watermarks were then set to the **maximum** across those transfers. So a facts push that failed at seq
 * 300, in a cycle where the entities push succeeded to seq 500, moved the watermark to 500 — and the fact at
 * seq 400 was behind it **for ever**. Nothing errored at the cycle level, nothing was logged past one warn, and
 * every subsequent cycle reported success while never sending that record again.
 *
 * That is the class of bug where a record becomes invisible while every trigger reports having done its job.
 *
 * ## Why the author guards do not cover it
 *
 * Both watermarks are already author-guarded — the pull advances only for docs authored by the peer, the push
 * only for docs authored by us — and those guards are correct and load-bearing. But they are about **whose**
 * records may move the watermark, not about **whether a transfer finished**. A truncated transfer is invisible
 * to a watermark that summarises it, whoever wrote the records.
 *
 * ## Why "do not advance at all when something was truncated" is the WRONG fix
 *
 * It livelocks. A type that stopped because it hit its page cap has more to give; refusing to advance means the
 * next cycle re-fetches the same pages and stops in the same place, for ever, and a space more than one cap
 * behind can never catch up. The failure mode would be a space that syncs nothing rather than a space that loses
 * one record — worse, and harder to see.
 *
 * ## The rule
 *
 * A transfer that RAN TO COMPLETION vouches for everything above the old watermark, so it places no ceiling. A
 * transfer that stopped early vouches only up to the seq it is COMPLETE through (`TransferOutcome`): every record at or
 * below it is delivered, and a stop inside a run of records that share a seq reports the seq BEFORE the run. The
 * watermark may advance to the lowest such ceiling — every transfer is complete up to there, so nothing is skipped, and a
 * capped transfer still makes a full page-set of progress each cycle.
 *
 * ## What the rule does not claim: the author guard, and relayed records
 *
 * The advance is the highest seq among records AUTHORED by the sender (the pull) or by us (the push), so a record relayed
 * from a third author never raises it — but a relayed record's seq is that author's clock, and it can arrive in a later
 * cycle at a seq at or below a watermark a finished cycle already moved. The ceiling above is exact WITHIN a cycle: no
 * transfer is credited with a seq whose run it has not read to its end. It is not exact ACROSS cycles for a record that
 * arrives late at an old seq; one scalar over several clocks cannot be, and that is the owner's open decision (`D-12`,
 * `Q-278`), not a property this module has.
 */
import { peerList, peerText } from '../util/log.js';

/** What one transfer within a cycle can vouch for. */
export interface TransferOutcome {
  /**
   * The highest seq this transfer is COMPLETE through.
   *
   * Only consulted when `truncated`. It is the last seq whose RECORDS are all delivered — which is not "the last seq
   * delivered". Records relayed from several authors keep their author's seq, so several share one, and a transfer that
   * stopped inside such a run (a page or batch boundary, a refused request, a throw) has delivered that seq WITHOUT
   * finishing it: it reports the seq BEFORE it. A watermark at the run's seq would put the rest of the run behind it for
   * good. A transfer that ran to the end reports its highest seq, and is not consulted at all.
   *
   * The position is computed by {@link completeThrough} and moved by two loops, once each: `pageSeqRuns`
   * (`sync/seq-run-pager.ts`) for a pull and `pushSeqRuns` (`sync/push-seq-runs.ts`) for a push. A transfer must take it
   * from there and never from a seq it read.
   */
  deliveredThrough: number;
  /** True when it stopped before exhausting what the peer had: a non-`ok` response, a throw, or a page cap. */
  truncated: boolean;
}

/**
 * The seq a transfer is COMPLETE through, given the highest seq it has delivered and whether the run at that seq may go on.
 *
 * Records relayed from several authors keep their author's seq, so several share one: `seq` is only finished when nothing more
 * can arrive at it. When the run may continue (a full page, a cursor inside it) the transfer is complete through the seq
 * BEFORE; when it cannot (a short page, the last page) it is complete through `seq` itself. Never below 0, the seq every
 * watermark starts from.
 *
 * It is one function because the answer was written four times (the push loop, the pull's pair branch, its legacy ask and the
 * seq an ask rides beside a cursor) and a copy that forgets the `- 1` puts the rest of a run behind a watermark for good.
 */
export function completeThrough(seq: number, runMayContinue: boolean): number {
  return runMayContinue ? Math.max(0, seq - 1) : seq;
}

/** The requests one transfer makes before it stops as capped, when its caller names no bound of its own. */
export const MAX_TRANSFER_PAGES = 200;

/** How a stop is logged: what stopped it and the seq the transfer is held at. */
export type TransferStopped = (why: string, heldAt: number) => void;

/**
 * Stop a transfer: mark it truncated and say why, at the seq it is held at.
 *
 * Marking and saying are one step because the pair is what the watermark depends on: a stop that logs but leaves `truncated`
 * false lets the watermark advance past what did not transfer, and one that marks without logging is a silent hold.
 */
export function stopTransfer(outcome: TransferOutcome, stopped: TransferStopped, why: string): void {
  outcome.truncated = true;
  stopped(why, outcome.deliveredThrough);
}

/**
 * Stop at the page bound of one cycle, when it is reached; `true` when it stopped. `maxPages` undefined is no bound.
 *
 * Reaching the bound is easy to forget as a truncation because nothing failed — the peer simply still has more to give — and a
 * loop that returns quietly there reports the transfer finished, and the watermark moves past what was never fetched. Both
 * pagers (`sync/seq-run-pager.ts`, `sync/push-seq-runs.ts`) stop through this.
 */
export function stopAtPageBound(
  outcome: TransferOutcome, stopped: TransferStopped, pages: number, maxPages: number | undefined,
): boolean {
  if (maxPages === undefined || pages < maxPages) return false;
  stopTransfer(outcome, stopped, `the ${maxPages}-request bound of one cycle was reached`);
  return true;
}

/**
 * The furthest a shared watermark may move.
 *
 * @param from      the watermark's current value; the result is never below it, because a watermark must not
 *                  go backwards — re-sending is idempotent by seq, but rewinding would re-do unbounded work.
 * @param candidate what the cycle would have written with no truncation (today: the max across transfers).
 * @param transfers every transfer that ran under this watermark. **Passing fewer than all of them is the
 *                  defect**, not a partial fix: an omitted transfer places no ceiling and is exactly the one
 *                  that gets skipped.
 */
export function safeWatermark(
  from: number,
  candidate: number,
  transfers: readonly TransferOutcome[],
): number {
  let ceiling = candidate;
  for (const t of transfers) {
    if (t.truncated && t.deliveredThrough < ceiling) ceiling = t.deliveredThrough;
  }
  return Math.max(from, ceiling);
}

/**
 * Did anything stop early? Used only to decide whether the cycle SAYS so.
 *
 * A cycle that silently held its watermark back looks identical to a cycle with nothing to do, and the whole
 * argument of this module is that a caller must not have to infer a truncation.
 */
export function truncatedTransfers(
  transfers: readonly (TransferOutcome & { label: string })[],
): string[] {
  return transfers.filter(t => t.truncated).map(t => t.label);
}

/**
 * The one sentence a transfer logs when it stops early.
 *
 * Here rather than at each of the four `break`s, so every one of them says the same thing: what stopped, how far
 * it got, and that the watermark is being held rather than advanced. Four hand-written versions of this is how
 * the pull tombstone branch came to have none at all.
 */
export function truncationWarn(
  what: string, peerLabel: string, spaceId: string, status: string | number, deliveredThrough: number,
): string {
  return `${what} ${peerLabel}: ${status} — delivered through seq ${deliveredThrough}, so the watermark for `
    + `space '${spaceId}' is held there rather than advanced past records that did not transfer.`;
}

/**
 * The whole rule for one direction of one cycle: compute the watermark, and say so when it was held back.
 *
 * Both call sites use this rather than `safeWatermark` plus their own reporting, for the reason this module
 * exists at all — the previous version had the max-across-transfers rule written out twice, and the two would
 * have drifted the moment a sixth transfer arrived. `safeWatermark` stays exported because it is the pure part
 * and deserves its own tests.
 *
 * **Every transfer that ran under this watermark must be passed.** An omitted one places no limit, which makes
 * it precisely the transfer whose records get skipped.
 */
export function resolveWatermark<T extends TransferOutcome>(opts: {
  /** `'receive'` or `'push'` — appears in the log so the two directions are distinguishable. */
  direction: 'receive' | 'push';
  peerLabel: string;
  spaceId: string;
  from: number;
  /**
   * Every SEQ-BEARING transfer that ran, KEYED BY ITS NAME.
   *
   * A record rather than a labelled array so a call site names them all on one line. That is not brevity for
   * its own sake: a spread of `{ ...x, label: 'x' }` per family is one chance per family to mistype a label
   * that only ever appears in a log.
   */
  transfers: Readonly<Record<string, T>>;
  /**
   * Transfers that bound the advance but must NOT raise it — tombstones, on the pull side.
   *
   * Its own parameter rather than a name on an exclusion list, because the asymmetry is real: a tombstone
   * seq is not a position in the data stream, so it cannot raise the data watermark, while a tombstone
   * transfer that stopped early absolutely has to hold it. An exclusion list is the shape this signature
   * exists to remove.
   */
  alsoCheck?: Readonly<Record<string, TransferOutcome>>;
  /**
   * Which seq to read off a transfer. Pull reports `highSeq` and push reports `maxSeq`, and that difference
   * is real rather than incidental — so the caller names the field instead of computing the max itself.
   */
  seqOf: (t: T) => number;
  warn: (msg: string) => void;
  /**
   * Receives the label of every transfer that stopped early, so the CYCLE can say it did not complete.
   *
   * Required because the warning alone was the defect: a refused batch held the watermark and logged, and the
   * cycle above it still counted the member as synced and recorded `success` with nothing transferred (`Q-48`).
   */
  heldBack: string[];
}): number {
  /*
   * THE CANDIDATE IS DERIVED HERE, and it used to be a parameter.
   *
   * Both call sites already built the `transfers` record naming every family, and then computed `candidate`
   * as a SECOND hand-written list beside it. Pull's had six entries; push's had five, missing file metadata —
   * so a cycle whose only change was file metadata could be HELD BACK by that transfer and never advanced by
   * it, and re-pushed the same page for ever.
   *
   * The comment above the push call site read *"Same rule as the pull, same function — see
   * `sync/watermark.ts` for why it is not two implementations."* The function was shared. The list was not,
   * and that sentence is what stopped anyone looking. One list now, and a seventh family cannot reproduce it.
   */
  const seqBearing = Object.entries(opts.transfers).map(([label, t]) => ({ ...t, label }));
  const candidate = seqBearing.reduce((hi, t) => Math.max(hi, opts.seqOf(t as unknown as T)), 0);

  const labelled = [
    ...seqBearing,
    ...Object.entries(opts.alsoCheck ?? {}).map(([label, t]) => ({ ...t, label })),
  ];
  const at = safeWatermark(opts.from, candidate, labelled);
  const heldBack = truncatedTransfers(labelled);
  opts.heldBack?.push(...heldBack);
  if (heldBack.length > 0) {
    opts.warn(
      `Sync ${opts.direction} from/to ${peerText(opts.peerLabel)} space '${peerText(opts.spaceId)}': ${peerList(heldBack, ', ')} stopped `
      + `early, so the ${opts.direction} watermark advances only to ${at}. The rest is retried next cycle.`,
    );
  }
  return at;
}
