/**
 * The slots every export of a space's records runs in: at most {@link EXPORT_SLOTS_INSTANCE} at once on the instance and
 * {@link EXPORT_SLOTS_PER_CALLER} per caller (Q-750, design r4 §5.4 [B5]). The first of an `export_*` family (owner, 2026-11-19): a later
 * export format takes its slot here, so the formats share one budget.
 *
 * ## What it prevents
 *
 * An export reads a space page by page and holds what it read until the reader has taken it. Without a bound, a few callers that start
 * exports and stop reading hold the store and the memory of every page they asked for. A slot is taken before the first record is read and
 * released exactly once ({@link ExportSlot.release} is idempotent), so a door that releases on every ending (finish, close, error, idle
 * cut) cannot release twice and free another caller's slot.
 *
 * Module state, so both doors meet one count.
 */

/** Exports running at once on the instance. */
export const EXPORT_SLOTS_INSTANCE = 2;
/** Exports running at once per caller (a token, or the address of a caller with none). */
export const EXPORT_SLOTS_PER_CALLER = 1;
/** The wait a refused export is told to keep before trying again (`Retry-After`), in seconds. */
export const EXPORT_RETRY_AFTER_SECONDS = 5;

/** A held slot. */
export interface ExportSlot { release(): void }

const running = new Map<string, number>();
let total = 0;

/** A slot for `callerKey`, or `null` when the instance or the caller holds all it may. */
export function takeExportSlot(callerKey: string): ExportSlot | null {
  const mine = running.get(callerKey) ?? 0;
  if (total >= EXPORT_SLOTS_INSTANCE || mine >= EXPORT_SLOTS_PER_CALLER) return null;
  running.set(callerKey, mine + 1);
  total++;
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      total--;
      const left = (running.get(callerKey) ?? 1) - 1;
      if (left <= 0) running.delete(callerKey); else running.set(callerKey, left);
    },
  };
}
