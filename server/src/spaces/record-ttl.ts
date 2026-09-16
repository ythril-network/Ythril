/**
 * The space retention tier: what a `recordTtlDays` write stores, given what was already there.
 *
 * ## Why this is a module and not four lines in the route
 *
 * There are three shapes on the wire (a number, an object, `null`) and two in storage (a number from before the
 * split, an object after it), so the write has six cases and every one of them can lose an operator's window
 * silently. Pure and separate means each case is one assertion instead of one HTTP round trip.
 *
 * ## The rules, and why each is the way round it is
 *
 * **A partial object MERGES.** `{"chrono":90}` sets chrono and leaves the other four alone. This is the opposite
 * of the `typeSchemas` rule one level down, where a named type is replaced wholesale — and deliberately: there
 * the value is a whole definition the caller is holding, here each bucket is one independent number. A canary
 * operator was bitten by the `typeSchemas` rule, so the difference is documented on both.
 *
 * **`0` and `null` clear.** Per bucket inside the object, and for the whole setting when sent bare. They mean
 * "no window", which is the same thing as absent — there is no tier above the space for a bucket to inherit from,
 * so a third meaning would have nothing to point at.
 *
 * **A scalar write REPLACES the whole object.** Someone sending `recordTtlDays: 90` is using the legacy shape and
 * means all five, so merging it into a stored object would be inventing an intent they did not express.
 *
 * **The result is normalised, not just stored.** An object whose every bucket ended up cleared becomes
 * `undefined`, so "no retention" has ONE representation in config.json rather than two that read differently in
 * the UI and compare unequal in a snapshot.
 */
import type { RecordTtlWindows, TtlBucket } from '../config/types.js';
import { RECORD_TYPES } from '../config/types.js';

/** The five buckets, in the order the UI shows them. `file` last: it is the odd one out (no schema tier). */
export const TTL_BUCKETS: readonly TtlBucket[] = RECORD_TYPES;

/** A positive integer day count, or undefined. `0`, `null` and nonsense all mean "no window". */
function window_(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * The stored value after applying `incoming` to `stored`.
 *
 * `incoming` is what the request sent (already validated); `stored` is what the space currently has. Returns
 * `undefined` for "no retention at all", which is what the config should hold rather than an empty object.
 */
export function normaliseRecordTtl(
  stored: number | RecordTtlWindows | undefined,
  incoming: number | RecordTtlWindows | null,
): number | RecordTtlWindows | undefined {
  // Bare null / 0 clears everything.
  if (incoming === null) return undefined;
  if (typeof incoming === 'number') return window_(incoming);

  // Object write: merge over the stored windows, widening a stored scalar first so the four buckets the caller
  // did not mention keep the number they were effectively already using.
  const base: RecordTtlWindows = typeof stored === 'number'
    ? { entity: stored, fact: stored, edge: stored, chrono: stored, file: stored }
    : { ...(stored ?? {}) };

  const out: RecordTtlWindows = {};
  for (const b of TTL_BUCKETS) {
    // `in` rather than `!== undefined`: an explicit `null` must clear, and both read as undefined afterwards.
    const v = b in incoming ? window_(incoming[b]) : window_(base[b]);
    if (v !== undefined) out[b] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The windows a space has, as a full five-bucket map — for display, where a gap and a zero must look different.
 *
 * Widens a stored scalar, so the UI never has to know which shape it is looking at.
 */
export function recordTtlWindows(stored: number | RecordTtlWindows | undefined): Record<TtlBucket, number | null> {
  const out = {} as Record<TtlBucket, number | null>;
  for (const b of TTL_BUCKETS) {
    out[b] = typeof stored === 'number' ? (window_(stored) ?? null) : (window_(stored?.[b]) ?? null);
  }
  return out;
}
