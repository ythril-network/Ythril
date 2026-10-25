/**
 * How far a SHARED mark may advance when several independent transfers ran beneath it.
 *
 * ## The defect this exists to make impossible
 *
 * `lastPosPushed` and `lastPosReceived` are **one number per member per space** (per network row, for the exchange that records them). Each sync
 * cycle runs SEVEN independent transfers under that one number — the tombstones and the six record families — and each of them can stop
 * early on its own: a non-`ok` response from the peer, or the cycle's page cap.
 *
 * A mark set to what ONE transfer reached moves past what another has not delivered: a facts push that failed at position 300, in a cycle where the
 * entities push succeeded to 500, would put the fact at 400 behind the mark FOR EVER. Nothing errors at the cycle level, nothing is logged past
 * one warn, and every later cycle reports success while never sending that record again. That is the class of bug where a record becomes
 * invisible while every trigger reports having done its job. The same holds for a write that lands on the peer BETWEEN the reads of two families
 * (P2): a mark at the maximum over the families sits above it.
 *
 * ## Why "do not advance at all when something was truncated" is the WRONG fix
 *
 * It livelocks. A transfer that stopped at its page cap has more to give; refusing to advance means the next cycle re-fetches the same pages and
 * stops in the same place, for ever, and a space more than one cap behind can never catch up.
 *
 * ## The rule (bundle-81, design rev 8 §6)
 *
 * Every transfer reports how far it is COMPLETE (`deliveredThrough`, a position: every record at or below it is delivered or absent, and a stop
 * inside a run of equal positions reports the position BEFORE the run), a transfer that ran to the end reports the position its last read settled
 * at, and **the mark is the MINIMUM over every transfer** (and never below where it started). Each family's `through` is complete through the peer's
 * settled position at the time THAT family was read, so a write that landed after the family was read is above the mark and the next cycle reads it.
 * Brain tombstones are one of the transfers, in the same stream: a cycle that moved only tombstones moves the mark (Q-394).
 *
 * **Every transfer that ran must be passed.** An omitted one places no ceiling, which makes it exactly the transfer whose records get skipped.
 *
 * ## Why a stop is either a cap or an error
 *
 * A transfer that stopped at the cycle's page cap did nothing wrong: it is PARTIAL (`stoppedBy: 'cap'`) and the member is not failing. One that
 * stopped for any other reason (the peer answered an error, a write failed) is an ERROR, the cycle is incomplete and the member's failure is counted.
 * A transfer says which (`stopTransfer`, `stopAtPageBound`), and the engine reads that, never the comparison of the mark before and after: a page error
 * after earlier pages moved the mark is still a failure (decision 33).
 */
import { peerList, peerText } from '../util/log.js';

/** What one transfer within a cycle can vouch for. */
export interface TransferOutcome {
  /**
   * The highest POSITION this transfer is COMPLETE through: every record at or below it is delivered or absent. It starts at the mark the
   * transfer began from, and is consulted whether or not the transfer stopped.
   *
   * It is not "the last position delivered": relayed records of the legacy band share positions, so a transfer that stopped inside a run of
   * equal positions (a page or batch boundary, a refused request, a throw) has delivered that position WITHOUT finishing it, and reports the
   * position BEFORE the run. A transfer that ran to the end reports the position its last read settled at (the peer's settled cap less one).
   *
   * The position is computed by {@link completeThrough} and moved by two loops, once each: `pagePositionRuns` (`sync/position-run-pager.ts`) for a
   * pull and `pushPositionRuns` (`sync/push-position-runs.ts`) for a push. A transfer must take it from there.
   */
  deliveredThrough: number;
  /** True when it stopped before exhausting what the peer had: a non-`ok` response, a throw, or the cycle's page cap. */
  truncated: boolean;
  /** Why a truncated transfer stopped: `'cap'` (the cycle's page bound: nothing failed) or `'error'`. Absent while it has not stopped. */
  stoppedBy?: 'cap' | 'error';
}

/**
 * The position a transfer is COMPLETE through, given the highest position it has delivered and whether the run at that position may go on.
 *
 * The legacy band (every carried 5.6 seq, which a relayed record shares with its author's) has equal positions, so a position is only finished
 * when nothing more can arrive at it. When the run may continue (a full page, a cursor inside it) the transfer is complete through the position
 * BEFORE; when it cannot (a short page, the last page) it is complete through `position` itself. Never below 0, the position every mark starts from.
 *
 * It is one function because the answer was written four times and a copy that forgets the `- 1` puts the rest of a run behind a mark for good.
 */
export function completeThrough(position: number, runMayContinue: boolean): number {
  return runMayContinue ? Math.max(0, position - 1) : position;
}

/** The requests one transfer makes before it stops as capped, when its caller names no bound of its own. */
export const MAX_TRANSFER_PAGES = 200;

/** How a stop is logged: what stopped it and the position the transfer is held at. */
export type TransferStopped = (why: string, heldAt: number) => void;

/**
 * Stop a transfer: mark it truncated, say whether it was the cycle's cap or a fault, and say why, at the position it is held at.
 *
 * Marking and saying are one step because the pair is what the mark depends on: a stop that logs but leaves `truncated` false lets the mark
 * advance past what did not transfer, and one that marks without logging is a silent hold.
 */
export function stopTransfer(outcome: TransferOutcome, stopped: TransferStopped, why: string, by: 'cap' | 'error' = 'error'): void {
  outcome.truncated = true;
  outcome.stoppedBy = by;
  stopped(why, outcome.deliveredThrough);
}

/**
 * Stop at the page bound of one cycle, when it is reached; `true` when it stopped. `maxPages` undefined is no bound. The stop is a CAP, not a fault.
 *
 * Reaching the bound is easy to forget as a truncation because nothing failed — the peer simply still has more to give — and a loop that returns
 * quietly there reports the transfer finished, and the mark moves past what was never fetched. Both pagers stop through this.
 */
export function stopAtPageBound(
  outcome: TransferOutcome, stopped: TransferStopped, pages: number, maxPages: number | undefined,
): boolean {
  if (maxPages === undefined || pages < maxPages) return false;
  stopTransfer(outcome, stopped, `the ${maxPages}-request bound of one cycle was reached`, 'cap');
  return true;
}

/**
 * The furthest a shared mark may move: the minimum of what every transfer is complete through, and never below `from` — a mark must not
 * go backwards (re-sending is idempotent by version, but rewinding would re-do unbounded work; the one rewind is the `head` guard's, which
 * forgets the mark itself).
 *
 * @param transfers every transfer that ran under this mark. **Passing fewer than all of them is the defect**, not a partial fix: an omitted
 *                  transfer places no ceiling and is exactly the one that gets skipped. With none, the mark stays where it was.
 */
export function safeWatermark(from: number, transfers: readonly TransferOutcome[]): number {
  if (transfers.length === 0) return from;
  let ceiling = Infinity;
  for (const t of transfers) if (t.deliveredThrough < ceiling) ceiling = t.deliveredThrough;
  return Math.max(from, ceiling);
}

/** The labels of the transfers a stop of kind `by` ended. A truncated transfer that says nothing is read as a fault. */
export function stoppedTransfers(
  transfers: readonly (TransferOutcome & { label: string })[], by: 'cap' | 'error',
): string[] {
  return transfers.filter(t => t.truncated && (t.stoppedBy ?? 'error') === by).map(t => t.label);
}

/**
 * The one sentence a transfer logs when it stops early.
 *
 * Here rather than at each of the `break`s, so every one of them says the same thing: what stopped, how far it got, and that the mark is
 * being held rather than advanced.
 */
export function truncationWarn(
  what: string, peerLabel: string, spaceId: string, status: string | number, deliveredThrough: number,
): string {
  return `${what} ${peerLabel}: ${status} — delivered through position ${deliveredThrough}, so the mark for `
    + `space '${spaceId}' is held there rather than advanced past records that did not transfer.`;
}

/** What one direction of one cycle came to: where the mark may move to, and the transfers that stopped, by kind. */
export interface WatermarkResolution {
  /** The mark: the minimum of what every transfer is complete through, never below where the cycle started. */
  readonly at: number;
  /** The transfers that stopped for a reason that is a fault: the cycle did not complete. */
  readonly errored: string[];
  /** The transfers that stopped at the cycle's page cap: partial, nothing failed. */
  readonly capped: string[];
}

/**
 * The whole rule for one direction of one cycle: compute the mark, and say so when it was held back.
 *
 * Both call sites use this rather than `safeWatermark` plus their own reporting, for the reason this module exists at all. `safeWatermark` stays
 * exported because it is the pure part and deserves its own tests.
 *
 * **Every transfer that ran under this mark must be passed, brain tombstones included**: they are transfers of the same stream, and a cycle that
 * moved only tombstones moves the mark.
 */
export function resolveWatermark<T extends TransferOutcome>(opts: {
  /** `'receive'` or `'push'` — appears in the log so the two directions are distinguishable. */
  direction: 'receive' | 'push';
  peerLabel: string;
  spaceId: string;
  /** Where the cycle's mark stood when it began. */
  from: number;
  /** Every transfer that ran, KEYED BY ITS NAME: a record rather than a labelled array so a call site names them all on one line. */
  transfers: Readonly<Record<string, T>>;
  warn: (msg: string) => void;
}): WatermarkResolution {
  const labelled = Object.entries(opts.transfers).map(([label, t]) => ({ ...t, label }));
  const at = safeWatermark(opts.from, labelled);
  const errored = stoppedTransfers(labelled, 'error');
  const capped = stoppedTransfers(labelled, 'cap');
  const held = [...errored, ...capped];
  if (held.length > 0) {
    opts.warn(
      `Sync ${opts.direction} from/to ${peerText(opts.peerLabel)} space '${peerText(opts.spaceId)}': ${peerList(held, ', ')} stopped `
      + `early, so the ${opts.direction} mark advances only to ${at}. The rest is ${errored.length > 0 ? 'retried' : 'continued'} next cycle.`,
    );
  }
  return { at, errored, capped };
}
