/**
 * Is a value a POSITION a request or a stored document may name? A leaf module (no imports), so a module the position reader itself depends on (the
 * change feed's floor, which the records stream seeds from) can ask it without an import cycle (bundle-255). `util/position-keyset.ts` re-exports it.
 */

/**
 * Is `value` a position a request may name: a safe integer of 0 or more, up to `Number.MAX_SAFE_INTEGER`?
 *
 * Its own bound, deliberately not `isPositionSeq`'s (`MAX_SYNC_SEQ`): a clock-band position is above it and would be refused. What bounds the
 * damage of a huge one is not this parse but the cap every read applies and `ownPositionMark`'s cut of every mark recorded from it.
 */
export function isPositionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
