/**
 * Who is still writing link ARRAYS to a space, so an operator converts with their eyes open.
 *
 * ## The gap this closes
 *
 * `completeLinkage` makes a space refuse `entityIds` / `memoryIds` / `chronoIds`, and that refusal is
 * correct and opt-in. The canary operator's point (4.0.0 report, 2026-09-06 §5) is WHEN it arrives: on the
 * caller's next write, not at conversion time. An operator converts, and learns which of their writers still
 * use the old surface when one of them breaks. Their words: *"N writers used `entityIds` on this space in
 * the last 30 days"*. They would have had five, and knew none of them without grepping their own repos.
 *
 * ## Why not the audit log, which looks like exactly the right source
 *
 * It already records these field names per entry with a token, a label, a space and a time. Two things kill
 * it, and both UNDER-REPORT IN SILENCE, which is worse than not answering at all:
 *
 *  - `AUDIT_CHANGE_FIELDS` covers `fact.update`, `chrono.update` and `file.meta.update`. **A create
 *    carrying `entityIds` records nothing** — and a freshly written caller is the one an operator most needs
 *    to hear about.
 *  - `changes` expire on a deliberately short clock (`DEFAULT_RECORD_CHANGE_RETENTION_DAYS`, 14) because
 *    they carry user content. The ask is 30 days, and lengthening that clock is not a trade worth making
 *    for a pre-flight.
 *
 * Built on it, this would answer *"2 writers"* where the truth is five, with nothing saying it had looked at
 * half the window and none of the creates. A lower number reads exactly like a cleaner space.
 *
 * ## So it is observed where the fact exists
 *
 * `arrayWriteError` already inspects every write body for these fields, at all seven doors, and returns
 * early when the space is not converted — which is precisely the window this question is about. One
 * inspection, two outcomes: refuse on a converted space, note on an unconverted one.
 *
 * **The note is fired and never awaited, and its failure is swallowed here.** An advisory observation that
 * can make a write fail, or make it slow, is worse than no observation. `a-door-that-refuses-arrays-also-
 * records-them.test.js` holds this file to that.
 *
 * ## One document per space, token and field
 *
 * Upserted rather than appended: the question is *"who, and when did they last"*, so a log would grow
 * without bound to answer something a single row answers. `count` is a running total and is the one thing a
 * log would have given for free — it is incremented rather than reconstructed.
 */
import { col, asFilter } from '../db/mongo.js';
import { log } from '../util/log.js';

/** How far back the pre-flight looks unless asked otherwise — the window the canary asked for. */
export const DEFAULT_WRITER_WINDOW_DAYS = 30;

/**
 * How long a note is kept.
 *
 * Longer than the default window so that asking for the default never silently truncates, and bounded so the
 * collection cannot grow for ever on a space nobody converts. A note holds a token id and a field name and
 * no user content, which is why this clock can be long where the audit log's `changes` clock cannot.
 */
export const WRITER_NOTE_RETENTION_DAYS = 90;

const COLLECTION = '_legacy_array_writers';

/** One warning per process when the note write is failing — see the catch in `noteLegacyArrayWrite`. */
let warnedOnce = false;

interface WriterNote {
  _id: string;
  spaceId: string;
  tokenId: string | null;
  tokenLabel: string | null;
  field: string;
  firstAt: Date;
  lastAt: Date;
  count: number;
}

/** Who made a write, as both surfaces already hold it: REST from `req.authToken`, MCP from its tool context. */
export interface WriteActor {
  tokenId?: string | null;
  tokenLabel?: string | null;
}

/**
 * One row per token per field, so a repeat write updates rather than accumulates.
 *
 * A token id is the identity, and a missing one still gets a row: an OIDC session or an unauthenticated path
 * is a writer too, and dropping it would make the count lower than the truth in exactly the way this module
 * exists to avoid. `unknown` is a legible answer; a silently smaller number is not.
 *
 * NUL is the separator, written as an ESCAPE and never as a literal byte -- a raw control byte makes git
 * treat the whole file as binary, with no diff and no blame. A space id and a field name cannot contain one,
 * so no two different triples can collide on a single key, which a slash or a space could not promise.
 */
const noteId = (spaceId: string, tokenId: string | null, field: string): string =>
  `${spaceId}\u0000${tokenId ?? 'unknown'}\u0000${field}`;

/**
 * Record that `fields` were written to `spaceId` by `actor`. Never throws, never awaited by a caller.
 *
 * Returns nothing on purpose: a caller that could inspect the outcome would eventually be written to branch
 * on it, and this must stay a write that cannot affect the write it observes.
 */
export function noteLegacyArrayWrite(input: {
  spaceId: string;
  fields: readonly string[];
  actor: WriteActor | undefined;
}): void {
  const { spaceId, fields, actor } = input;
  if (fields.length === 0) return;
  const tokenId = actor?.tokenId ?? null;
  const tokenLabel = actor?.tokenLabel ?? null;
  const now = new Date();
  void (async () => {
    for (const field of fields) {
      await col<WriterNote>(COLLECTION).updateOne(
        asFilter<WriterNote>({ _id: noteId(spaceId, tokenId, field) }),
        {
          /*
           * NO FIELD APPEARS IN BOTH OPERATORS, and that is a hard Mongo rule rather than a preference.
           *
           * `tokenLabel` was in `$setOnInsert` AND `$set`, and Mongo refuses the whole update with
           * "Updating the path 'tokenLabel' would create a conflict at 'tokenLabel'". Every note failed,
           * the failure was swallowed here, and the pre-flight answered "no writers" for a space being
           * written to — the inert control this whole feature exists to prevent, in the feature itself.
           * It compiled, it type-checked, and no source gate could see it; the integration test
           * `links-convert-preflight.test.js` drives a real write against a real Mongo and does.
           *
           * `firstAt` is insert-only, so "since when" survives every later write by the same token.
           */
          $setOnInsert: { spaceId, tokenId, field, firstAt: now },
          // The label is refreshed rather than pinned: a token that was renamed should be reported under the
          // name an operator will recognise today, and the id is what identifies it either way.
          $set: { lastAt: now, tokenLabel },
          $inc: { count: 1 },
        },
        { upsert: true },
      );
    }
  })().catch(err => {
    /*
     * Swallowed, because an advisory observation must never fail the write it observes — but LOUD ONCE.
     *
     * This was `log.debug`, and that is how a total failure stayed invisible: every note was being refused
     * and the only symptom was a pre-flight that answered "nobody" — which is exactly what a healthy space
     * answers. A warning per write would train an operator to ignore the log; a warning ONCE per process
     * says "this is broken" without becoming noise, and a transient blip stays quiet after it.
     */
    if (!warnedOnce) {
      warnedOnce = true;
      log.warn(`Legacy array-write notes are not being recorded (${err instanceof Error ? err.message : String(err)}). `
        + 'The links conversion pre-flight will under-report until this is fixed; this is logged once per process.');
    }
    log.debug(`legacy array-write note failed for '${spaceId}': ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** One writer of the legacy arrays, as the pre-flight reports them. */
export interface LegacyArrayWriter {
  tokenId: string | null;
  tokenLabel: string | null;
  fields: string[];
  lastAt: string;
  count: number;
}

/** What the pre-flight answers. */
export interface ConvertPreflight {
  spaceId: string;
  /**
   * The window the answer covers, as an ISO instant, and it is not decoration.
   *
   * A count with no window on it cannot be told apart from a count over a shorter one, and an operator is
   * about to decide something on it. This is the field that stops the pre-flight repeating the audit log's
   * failure — under-reporting with nothing to say it had.
   */
  since: string;
  /** How far back a note can exist at all, whatever `since` was asked for. */
  retentionDays: number;
  /** Empty means nobody wrote an array in the window — which is what an operator is hoping to see. */
  writers: LegacyArrayWriter[];
  /** Already converted? Then the arrays are refused and this answers about the window before that. */
  converted: boolean;
}

/**
 * Who wrote a link array to this space within `windowDays`, newest last-write first.
 *
 * Grouped in memory rather than by an aggregation: the rows are one per token per field, so a space with a
 * hundred distinct writers is three hundred small documents — smaller than the pipeline that would avoid
 * reading them.
 */
export async function legacyArrayWriters(input: {
  spaceId: string;
  windowDays?: number;
  converted: boolean;
}): Promise<ConvertPreflight> {
  const { spaceId, converted } = input;
  const windowDays = Number.isFinite(input.windowDays) && (input.windowDays ?? 0) > 0
    ? Math.min(input.windowDays as number, WRITER_NOTE_RETENTION_DAYS)
    : DEFAULT_WRITER_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const rows = await col<WriterNote>(COLLECTION)
    .find(asFilter<WriterNote>({ spaceId, lastAt: { $gte: since } }))
    .toArray();

  const byToken = new Map<string, LegacyArrayWriter>();
  for (const r of rows) {
    const key = r.tokenId ?? 'unknown';
    const w = byToken.get(key) ?? { tokenId: r.tokenId, tokenLabel: r.tokenLabel, fields: [], lastAt: '', count: 0 };
    if (!w.fields.includes(r.field)) w.fields.push(r.field);
    w.count += r.count;
    const at = r.lastAt.toISOString();
    if (at > w.lastAt) w.lastAt = at;
    // The freshest label wins, for the same reason the note refreshes it.
    if (at === w.lastAt) w.tokenLabel = r.tokenLabel;
    byToken.set(key, w);
  }

  const writers = [...byToken.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  for (const w of writers) w.fields.sort();
  return { spaceId, since: since.toISOString(), retentionDays: WRITER_NOTE_RETENTION_DAYS, writers, converted };
}

/**
 * The three obligations of an INSTANCE-WIDE collection keyed by space, and this is the whole list.
 *
 * `space_activity` is the same shape and had to remember all three; this module was written with one of
 * them and the other two were found by sweeping the guidelines over it before it shipped. They are together
 * here so a fourth collection of this shape has something to copy that is complete:
 *
 *  1. **Indexes**, because every read filters on `spaceId` and every sweep on `lastAt`.
 *  2. **A per-space purge**, because `dropSpaceData` clears collections by NAME PREFIX and an instance-wide
 *     collection has no prefix to match. Left behind, notes outlive the space for the whole retention
 *     window -- and a space recreated with the same id would inherit writers it never had.
 *  3. **Retention**, so an unconverted space cannot grow the collection for ever.
 */
export async function ensureLegacyArrayWriterIndexes(): Promise<void> {
  const c = col<WriterNote>(COLLECTION);
  await c.createIndex({ spaceId: 1, lastAt: -1 });
  await c.createIndex({ lastAt: 1 });
}

/**
 * Forget one space's notes. Called by `dropSpaceData`, which cannot reach this collection by prefix.
 *
 * See obligation 2 above: a space recreated with the same id would otherwise be told about writers that
 * wrote to its predecessor, which is worse than no answer -- it is a wrong answer that looks like a right
 * one, and the operator is about to decide something on it.
 */
export async function purgeLegacyArrayWriters(spaceId: string): Promise<number> {
  const r = await col<WriterNote>(COLLECTION).deleteMany(asFilter<WriterNote>({ spaceId }));
  return r.deletedCount ?? 0;
}

/** Drop notes past retention. Called from the same sweep that ages the audit log's changes. */
export async function sweepLegacyArrayWriterNotes(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - WRITER_NOTE_RETENTION_DAYS * 86_400_000);
  const r = await col<WriterNote>(COLLECTION)
    .deleteMany(asFilter<WriterNote>({ lastAt: { $lt: cutoff } }));
  return r.deletedCount ?? 0;
}
