/**
 * Does a record's own timestamp agree with the server's?
 *
 * ## The report this exists for
 *
 * The canary operator, 2026-08-09T0942Z: they corrected three of their own board posts whose `postedAt` was **eight hours**
 * early. Not clock drift — their host's clock was right the whole time. They measured the clock once and then
 * **extrapolated** the next three stamps by estimating how long their own work had taken, and it had taken eight hours
 * longer than it felt.
 *
 * Their sentence is the whole problem: *"an estimated timestamp looks exactly like a measured one once it is written
 * down."* And their suggestion is why this is ours to build rather than theirs:
 *
 * > *"comparing a post's `stampedAt` against the record's own server-side `createdAt` would have caught this
 * > immediately, and that comparison is available to the store rather than to the author."*
 *
 * An author cannot check their own stamp against their own belief. The store can, because it holds a number the author
 * did not supply.
 *
 * ## A WARNING, never a refusal
 *
 * A legitimately backdated record exists — a historical import, a backfilled letter, and they have both. Refusing the
 * write would break exactly those, and what is being reported is a **wrong number, not a corrupt record**. So the skew
 * is recorded and surfaced; the write always proceeds.
 *
 * ## Why the parsing is the substance of this module
 *
 * Their stamps are written `2026-08-11T1200Z` — no colon, no seconds. `new Date('2026-08-11T1200Z')` is **Invalid
 * Date**. A check built on `Date.parse` alone would therefore find nothing to compare on precisely the records that
 * motivated the ask, and would report "no skew detected" for a stamp eight hours wrong. It would not be a weak feature;
 * it would be a feature that confidently says the opposite of the truth on its own motivating example.
 *
 * So `parseStamp` accepts the compact form as well, and `stamp-skew.test.js` asserts it against the literal strings from
 * their messages rather than against a form I invented while writing this.
 */
import type { SpaceMeta, StampSkew } from '../config/types-knowledge.js';

export type { StampSkew };

/**
 * The board protocol's own tolerance. Its documented assumption is that two parties' clocks differ *by up to forty
 * minutes*, so anything inside that is the case the protocol already accepts and warning about it would be noise.
 * Theirs differed by eight hours.
 */
export const DEFAULT_STAMP_SKEW_WARN_MINUTES = 40;

/**
 * The property names checked when a space does not name its own.
 *
 * Both are the canary operator's, because a convention that no caller uses is a check that never fires. `stampedAt` is the
 * one their suggestion named; `postedAt` is the one that was actually wrong in all three corrected posts.
 */
export const DEFAULT_STAMP_PROPERTIES: readonly string[] = ['stampedAt', 'postedAt'];

/** ISO-ish with the time compressed: `2026-08-11T1200Z`, `2026-08-11T1200+02:00`, optionally with seconds. */
const COMPACT = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse a caller-supplied stamp to epoch ms, or `null` when it is not a timestamp at all.
 *
 * `null` is a deliberate outcome and not a failure: a property named `postedAt` holding `"soon"` is a caller's business,
 * and inventing a skew for it would produce a warning about the wrong thing. Unparseable means **not checked**, and the
 * caller is told which so that "no warning" cannot be read as "the stamp is fine".
 */
export function parseStamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds vs milliseconds, decided by magnitude: 1e12 ms is 2001, and 1e12 seconds is the year 33658. Any
    // plausible seconds value is below it and any plausible ms value is above it.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const m = COMPACT.exec(raw);
  if (m) {
    // Rebuilt into a form Date can parse rather than computed by hand, so leap years, month lengths and offsets stay
    // the platform's problem. A missing zone is treated as UTC, matching how the board writes it.
    const zone = m[5] ? (m[5] === 'Z' ? 'Z' : m[5]) : 'Z';
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}${zone}`);
    return Number.isNaN(t) ? null : t;
  }

  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** What a space's meta says about this check, with the defaults resolved. */
export function stampSkewSettings(meta: SpaceMeta | undefined): { warnMs: number; properties: readonly string[] } {
  const cfg = meta?.stampSkew;
  const minutes = cfg?.warnMinutes ?? DEFAULT_STAMP_SKEW_WARN_MINUTES;
  return {
    // 0 (or a negative) DISABLES rather than warning on everything. A threshold of zero read as "warn on any
    // difference" would fire on every record in the space, since a caller's stamp and the server's clock never agree to
    // the millisecond — the check would be unusable in exactly the configuration someone picks to make it strictest.
    warnMs: minutes > 0 ? minutes * 60_000 : 0,
    properties: cfg?.properties?.length ? cfg.properties : DEFAULT_STAMP_PROPERTIES,
  };
}

/**
 * Compare a record's caller-supplied stamp against the server's `createdAt`.
 *
 * Returns `null` when there is nothing to report: no stamp property, an unparseable value, the check disabled, or a skew
 * inside the threshold. The FIRST property that parses wins — checking several and reporting the worst would let a
 * caller's second, sloppier field speak for a record whose real stamp was fine.
 */
export function detectStampSkew(
  properties: Record<string, unknown> | undefined,
  createdAt: string,
  meta: SpaceMeta | undefined,
): StampSkew | null {
  if (!properties) return null;
  const { warnMs, properties: names } = stampSkewSettings(meta);
  if (warnMs <= 0) return null;

  const serverMs = Date.parse(createdAt);
  if (Number.isNaN(serverMs)) return null;

  for (const name of names) {
    if (!(name in properties)) continue;
    const parsed = parseStamp(properties[name]);
    if (parsed === null) continue;
    const skewMs = parsed - serverMs;
    if (Math.abs(skewMs) <= warnMs) return null;
    return {
      property: name,
      stamp: String(properties[name]),
      skewMs,
      thresholdMs: warnMs,
    };
  }
  return null;
}

/**
 * Stamp the skew onto a create doc, so the wrong number is findable LATER.
 *
 * Shaped as a doc mutator called beside `stampExpiryOnCreate`, because all four brain creates already call that and a
 * fifth create written next year will be written next to it.
 *
 * **Stored only when it exceeds the threshold.** Storing it always would put a `0` on every record in every space —
 * megabytes to say nothing — and would make the useful query (`{stampSkew: {$exists: true}}`) match everything. Presence
 * IS the signal, which is what makes this the cheap integrity check they described rather than a new report to run.
 *
 * Returns the skew when there was one, so the caller can also put it in the response: the writer is the one who can
 * still fix their clock, and they only find out if something says so at the time.
 */
export function stampSkewOnCreate(
  doc: { properties?: Record<string, unknown>; createdAt: string; stampSkew?: StampSkew },
  meta: SpaceMeta | undefined,
): StampSkew | null {
  const skew = detectStampSkew(doc.properties, doc.createdAt, meta);
  if (skew) doc.stampSkew = skew;
  return skew;
}

/**
 * The sentence a caller reads. Hours, because the unit the reporter used to describe their own failure was hours, and a
 * skew in milliseconds is a number nobody converts in their head.
 */
export function stampSkewWarning(skew: StampSkew): string {
  const hours = skew.skewMs / 3_600_000;
  const magnitude = Math.abs(hours) >= 1
    ? `${Math.abs(hours).toFixed(1)} hours`
    : `${Math.round(Math.abs(skew.skewMs) / 60_000)} minutes`;
  const direction = skew.skewMs < 0 ? 'BEFORE' : 'AFTER';
  return `${skew.property} '${skew.stamp}' is ${magnitude} ${direction} the server's write time. `
    + `The record was stored as sent — this is a warning about the timestamp, not a rejection. `
    + `If it was estimated rather than measured, it is probably wrong.`;
}
