/**
 * The one rule by which a transfer's pace is judged, on either side of the wire: the RDF export judging its reader, an import door judging its
 * sender (bundle-269 review, finding 9; bundle-270, Q-953).
 *
 * ## What it prevents
 *
 * - **Two rules that drift.** The export judged its reader by a rate over a tumbling window of the time it spent waiting on it; the upload
 *   readers had an idle bound alone, and a sender of a byte now and then held an instance-wide door for good. The window's verdict is this one
 *   pure function, which the export's `pacedWriter` and the upload reader both call, so a fix to the rule reaches both.
 * - **Two rates that drift.** {@link MIN_TRANSFER_BYTES_PER_SECOND} is the one figure both ask, so the guides state one rate.
 * - **Counting the other side's slowness.** Only time spent waiting on the party judged is counted (`waitedMs`): the export's time waiting on
 *   its store, and an import's time spent sorting or spooling, never count against the reader or the sender.
 *
 * ## The rule
 *
 * The first mark opens the window. A later mark whose waiting is at least `windowMs` past the open one closes it: below `minBytesPerSecond`
 * on average over that span it is `slow`; otherwise the next window opens at that mark. A shorter span is not judged.
 */

/** The least a transfer must move while the other side waits on it, in bytes a second: the export's reader and an import's sender alike. */
export const MIN_TRANSFER_BYTES_PER_SECOND = 16_384;

/** How a window is judged: its least span of waiting, and the least rate over it. */
export interface PaceRule {
  windowMs: number;
  minBytesPerSecond: number;
}

/** A moment of a transfer: the bytes moved so far and the waiting done so far. */
export interface PaceMark {
  bytes: number;
  waitedMs: number;
}

/** The tumbling window over one transfer. */
export interface PaceWindow {
  /** Judge at `now`: `slow`, or nothing (the window goes on, or a new one opens here). */
  observe(now: PaceMark): 'slow' | undefined;
  /** How much more waiting from `waitedMs` closes the current window, or undefined while none is open. */
  remainingMs(waitedMs: number): number | undefined;
}

const MS_PER_SECOND = 1_000;

/** A window over one transfer that judges by `rule()` (read at each judgement, so a test may change it). */
export function paceWindow(rule: () => PaceRule): PaceWindow {
  let opened: PaceMark | null = null;
  return {
    observe(now) {
      if (!opened) { opened = now; return undefined; }
      const { windowMs, minBytesPerSecond } = rule();
      const span = now.waitedMs - opened.waitedMs;
      if (span < windowMs) return undefined;
      if ((now.bytes - opened.bytes) * MS_PER_SECOND < minBytesPerSecond * span) return 'slow';
      opened = now;
      return undefined;
    },
    remainingMs(waitedMs) {
      if (!opened) return undefined;
      return Math.max(0, rule().windowMs - (waitedMs - opened.waitedMs));
    },
  };
}
