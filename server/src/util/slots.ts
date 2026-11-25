/**
 * The slots the long reads of a space run in, per family: at most `instance` at once on the instance and `perCaller` per caller (bundle-271,
 * Q-756, r2 R4.6; extracted from the export's own slots, Q-750). The families are the export (`export_*`, every export format shares one
 * budget) and SPARQL (the query endpoint and the Linked Data reads, which run the same quad source).
 *
 * ## What it prevents
 *
 * - **A few callers holding the store.** A read that walks a space holds a cursor and what it read until its reader has taken it; without a
 *   bound, a few callers that start reads and stop reading hold the store and the memory of every page they asked for.
 * - **One door starving another.** Each family counts apart: two exports running never refuse a query, nor two queries an export.
 * - **A release that frees another caller's slot.** A slot is released exactly once ({@link Slot.release} is idempotent), so a door that
 *   releases on every ending (finish, close, error, idle cut) cannot release twice.
 * - **A family nobody declared.** {@link takeSlot} throws for a name {@link SLOT_FAMILIES} does not hold, never a budget of its own.
 *
 * Module state, so every door of a family meets one count.
 */

/** A family's budget, and the wait a refused caller is told to keep before trying again (`Retry-After`), in seconds. */
export interface SlotFamily { readonly instance: number; readonly perCaller: number; readonly retryAfterSeconds: number }

/** Every family and its budget. */
export const SLOT_FAMILIES = Object.freeze({
  export: Object.freeze({ instance: 2, perCaller: 1, retryAfterSeconds: 5 }),
  sparql: Object.freeze({ instance: 2, perCaller: 1, retryAfterSeconds: 5 }),
} satisfies Record<string, SlotFamily>);

export type SlotFamilyName = keyof typeof SLOT_FAMILIES;

/** A held slot. */
export interface Slot { release(): void }

interface Count { total: number; byCaller: Map<string, number> }
const counts = new Map<SlotFamilyName, Count>();

/** A slot of `family` for `callerKey` (a token's id, or the address of a caller with none), or `null` when the family's budget is spent. */
export function takeSlot(family: SlotFamilyName, callerKey: string): Slot | null {
  if (!Object.hasOwn(SLOT_FAMILIES, family)) throw new Error(`takeSlot: no slot family '${String(family)}' is declared`);
  const budget: SlotFamily = SLOT_FAMILIES[family];
  let count = counts.get(family);
  if (!count) { count = { total: 0, byCaller: new Map() }; counts.set(family, count); }
  const mine = count.byCaller.get(callerKey) ?? 0;
  if (count.total >= budget.instance || mine >= budget.perCaller) return null;
  count.byCaller.set(callerKey, mine + 1);
  count.total++;
  const held = count;
  let holding = true;
  return {
    release() {
      if (!holding) return;
      holding = false;
      held.total--;
      const left = (held.byCaller.get(callerKey) ?? 1) - 1;
      if (left <= 0) held.byCaller.delete(callerKey); else held.byCaller.set(callerKey, left);
    },
  };
}
