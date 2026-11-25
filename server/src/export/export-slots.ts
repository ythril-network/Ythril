/**
 * The slots every export of a space's records runs in: the `export` family of `util/slots.ts`, at most {@link EXPORT_SLOTS_INSTANCE} at once
 * on the instance and {@link EXPORT_SLOTS_PER_CALLER} per caller (Q-750, design r4 §5.4 [B5]). The first of an `export_*` family (owner,
 * 2026-11-19): a later export format takes its slot here, so the formats share one budget.
 *
 * ## What it prevents
 *
 * An export reads a space page by page and holds what it read until the reader has taken it. Without a bound, a few callers that start
 * exports and stop reading hold the store and the memory of every page they asked for. A slot is taken before the first record is read and
 * released exactly once ({@link ExportSlot.release} is idempotent), so a door that releases on every ending (finish, close, error, idle
 * cut) cannot release twice and free another caller's slot. The count and the idempotent release are `takeSlot`'s, shared with the SPARQL
 * family (bundle-271, Q-756), which counts apart.
 */
import { SLOT_FAMILIES, takeSlot, type Slot } from '../util/slots.js';

/** Exports running at once on the instance. */
export const EXPORT_SLOTS_INSTANCE = SLOT_FAMILIES.export.instance;
/** Exports running at once per caller (a token, or the address of a caller with none). */
export const EXPORT_SLOTS_PER_CALLER = SLOT_FAMILIES.export.perCaller;
/** The wait a refused export is told to keep before trying again (`Retry-After`), in seconds. */
export const EXPORT_RETRY_AFTER_SECONDS = SLOT_FAMILIES.export.retryAfterSeconds;

/** A held slot. */
export type ExportSlot = Slot;

/** A slot for `callerKey`, or `null` when the instance or the caller holds all it may. */
export function takeExportSlot(callerKey: string): ExportSlot | null {
  return takeSlot('export', callerKey);
}
