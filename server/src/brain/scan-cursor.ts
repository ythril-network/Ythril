/**
 * Where a background scan (the duplicate scanner, the contradiction scanner) resumes — one question, answered once.
 *
 * ## What it prevents
 *
 * Both scanners kept a cursor and moved it to the position of each record they scanned, then read after it. Records from several authors share
 * positions in the legacy band (every carried 5.6 seq, which a relayed record shares with its author's), so a batch that ended inside a run, or a run
 * that `maxPerRun` cut in two, left the rest of the run behind the cursor: those records were never scanned until each was next edited, and the scan
 * reported a clean pass (bundle-52, `Q-277`). The position is a pair, `(pos, _id)`, read through `util/position-keyset.ts` like every other
 * position-paged reader (bundle-81: a scanner pages by where a record LANDED here, so a record a peer delivered, an import or a repair gives a fresh
 * position is judged once, and nothing is re-scanned across the upgrade).
 *
 * ## The stored state, which two builds can both read
 *
 * `{ cursorSeq: number, cursorPos?: { seq, id } }` in `ythril_dupe_scan_state`, **under the names 5.6 gave them**: the numbers are POSITIONS now, and a
 * legacy row's position IS its seq (the identity band), so a cursor stored before 6.0 is valid as it stands, a carry copies it by identity, and a 5.6
 * started after a rollback finds its own state. `cursorSeq` stays a NUMBER, because an older build reads it as one and moves it. `cursorPos` is where
 * in the run at `cursorSeq` the last stop was, and it is trusted ONLY when `cursorPos.seq === cursorSeq`: otherwise an older build moved `cursorSeq`
 * since (a rollback) and the pair describes a place the cursor is no longer at. The read is then the legacy one — INCLUSIVE of `cursorSeq`, because the old
 * cursor says the run at that position was read and it may have been read only in part. Scanning it once more is idempotent (a pair already recorded is
 * recorded again as itself), so the cost of doubt is one run, never a skip. A reset clears both.
 *
 * ## The hold clock (`Q-697`)
 *
 * A scan that held a type because its index was not ready keeps the type's position, and the next run reads the same records again. When the index
 * stays unready that repeats every run, and a hold that lasts a week must not look like one that has just begun. So the cursor's own row carries
 * `heldSince`, the time of the FIRST hold ({@link noteScanHold}: `$min`, so a later hold never moves it), and a hold at least {@link HOLD_WARN_AFTER_MS}
 * old is warned. Only a PASS that ended without a hold clears it ({@link clearScanHold}); a position write never does, and neither does a reset, because
 * a hold is about the index and not the position: the held pass's own write of the seeds before the held one, and an operator's manual rescan, must not
 * hide it.
 */
import { col, asDoc, asFilter, asUpdate } from '../db/mongo.js';
import { isDuplicateKey } from '../db/write-errors.js';
import { escapeRegex } from '../util/redos.js';
import type { DupeScanStateDoc, DupeScanType } from '../config/types.js';
import { comparePositionStarts, type PositionStart } from '../util/position-keyset.js';
import { log, peerText } from '../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../util/warn-once.js';
import { scanHoldsTotal, type ScanHoldScanner } from '../metrics/scan-hold-count.js';

/** The global collection both scanners keep their cursors in (and `spaces/rename.ts` moves). */
export const SCAN_STATE = 'ythril_dupe_scan_state';

/**
 * How old a hold must be before it is WARNED: 20 hours, below the daily period of both scanners, so the second daily run in a row warns despite the jitter
 * of a schedule. A hold of one run is the ordinary case of an index that is being built after an upgrade or a database container recreate, and says nothing
 * above info. It is a time and not a count of runs: a manual scan (`POST /api/duplicates/scan`) is a run too, and a count that every rescan raises would
 * warn about an index that has been unready for minutes (`docs/decisions`, "a hold warns by age"). Written as one number for `doc-cited-constants`.
 */
export const HOLD_WARN_AFTER_MS = 72_000_000;

/** A hold that has lasted is said once per window, per cursor: the window is the threshold, so a daily run that holds again says it again. */
const holdWarned = warnOnce<string>({ every: HOLD_WARN_AFTER_MS });
/** A hold whose own bookkeeping failed is said once per say-once window: it never stops the scan and never hides under it. */
const holdNoteFailed = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });

/**
 * What a cursor's stored state says to a scan that is about to read it: where to read after ({@link readScanStart}) and whether the row carries a hold
 * clock, so the pass that ends without a hold clears it with one write and a healthy instance writes nothing.
 */
export async function readScanCursor(stateId: string): Promise<{ start: PositionStart; carriesHold: boolean }> {
  const doc = await col<DupeScanStateDoc>(SCAN_STATE).findOne(asFilter<DupeScanStateDoc>({ _id: stateId }));
  const cursorSeq = typeof doc?.cursorSeq === 'number' ? doc.cursorSeq : 0;
  const pos = doc?.cursorPos;
  const carriesHold = doc?.heldSince !== undefined;
  if (pos && pos.seq === cursorSeq && typeof pos.id === 'string' && pos.id !== '') return { start: { pos: pos.seq, id: pos.id }, carriesHold };
  return { start: { pos: Math.max(0, cursorSeq - 1) }, carriesHold };
}

/**
 * The position a scan READS AFTER, from its stored state: the stored `(seq, id)` when it belongs to `cursorSeq`, else
 * the legacy start that re-reads the run at `cursorSeq` (position `cursorSeq - 1`; a fresh cursor at 0 stays at 0).
 */
export async function readScanStart(stateId: string): Promise<PositionStart> {
  return (await readScanCursor(stateId)).start;
}

/** One type's hold, as {@link noteScanHold} is told of it: who held, where, and when (`now`, epoch milliseconds, injected so the 20 h boundary is testable). */
export interface ScanHold {
  scanner: ScanHoldScanner;
  spaceId: string;
  type: DupeScanType;
  /** The contradiction scanner's cursor that held (`structured` or `nli`); the duplicate scanner has one cursor per type. */
  pass?: string;
  now: number;
}

/**
 * Record that a scan HELD this cursor's type because its index was not ready: the clock, the count and the line, in one place so no scanner can keep
 * one and drop another.
 *
 *  - `heldSince` on the cursor's own row, the first time it held (`$min` of ISO strings, which order as times, so a later hold never moves it and a stored
 *    value that is no time is replaced by the first real one). An UPSERT: a type held before any position was written has no row yet, and the row it
 *    creates carries the fields the row type requires (`$setOnInsert`) so `readScanStart`, `carryScanCursors` and `moveScanCursors` read it like any other;
 *  - `ythril_scan_holds_total{scanner}`, one per hold;
 *  - a line at info per hold (the space through `peerText`), and a WARN once the hold is {@link HOLD_WARN_AFTER_MS} old, said once per window.
 *
 * It runs in its own `try`: a store that refuses the bookkeeping is said once and never throws into the scan, so the scan's stop (set before this is
 * called) cannot be undone by a failed write.
 */
export async function noteScanHold(cursorId: string, hold: ScanHold): Promise<void> {
  scanHoldsTotal.note(hold.scanner);
  try {
    const at = new Date(hold.now).toISOString();
    const state = col<DupeScanStateDoc>(SCAN_STATE);
    const row = await state.findOneAndUpdate(
      asFilter<DupeScanStateDoc>({ _id: cursorId }),
      asUpdate<DupeScanStateDoc>({
        $min: { heldSince: at },
        $setOnInsert: { spaceId: hold.spaceId, type: hold.type, cursorSeq: 0, updatedAt: at },
      }),
      { upsert: true, returnDocument: 'after', projection: { heldSince: 1 } },
    );
    let since = Date.parse(String(row?.heldSince));
    if (!Number.isFinite(since)) {
      // A stored value that is no time (`$min` keeps one that sorts below an ISO string): replaced by this hold, so the clock runs from here.
      await state.updateOne(asFilter<DupeScanStateDoc>({ _id: cursorId }), asUpdate<DupeScanStateDoc>({ $set: { heldSince: at } }));
      since = hold.now;
    }
    const where = `space ${peerText(hold.spaceId)}, ${hold.type}${hold.pass ? ` (${hold.pass} pass)` : ''}`;
    const sinceAt = new Date(since).toISOString();
    log.info(`Scan hold (${hold.scanner}): the index is not ready over records it should serve — ${where} keeps its position for the next run (held since ${sinceAt})`);
    if (hold.now - since >= HOLD_WARN_AFTER_MS) {
      holdWarned(cursorId, () => log.warn(`Scan hold (${hold.scanner}): ${where} has been held for ${Math.floor((hold.now - since) / 3_600_000)} hours `
        + `(since ${sinceAt}) because its vector index is not ready over records it should serve — those records are not being scanned until it is. `
        + 'Check the space\'s vector index (ythril_scan_holds_total counts each hold)'));
    }
  } catch (err) {
    holdNoteFailed(cursorId, () => log.warn(`Scan hold (${hold.scanner}): could not record the hold of ${peerText(hold.spaceId)} ${hold.type} — ${peerText(err)}`));
  }
}

/**
 * Take the hold clock off a cursor: a pass over it ended WITHOUT a hold (an empty batch included, so a type whose records were all deleted has nothing to
 * hold). Never creates a row. Called once per pass, and only when {@link readScanCursor} said the row carried the clock, so no seed writes and a healthy
 * instance writes nothing at all. A failed write is said once and never fails the scan: the clock then runs on and the next clean pass clears it.
 */
export async function clearScanHold(cursorId: string): Promise<void> {
  try {
    await col<DupeScanStateDoc>(SCAN_STATE).updateOne(
      asFilter<DupeScanStateDoc>({ _id: cursorId }), asUpdate<DupeScanStateDoc>({ $unset: { heldSince: '' } }));
  } catch (err) {
    holdNoteFailed(cursorId, () => log.warn(`Scan hold: could not clear the hold clock of ${peerText(cursorId)} — ${peerText(err)}`));
  }
}

/** Store where a scan stopped. `null` is a reset: `cursorSeq` 0 and no position. A position without an id stores nothing. */
export async function writeScanPosition(
  stateId: string, ctx: { spaceId: string; type: DupeScanType }, at: PositionStart | null,
): Promise<void> {
  if (at !== null && at.id === undefined) return;   // nothing was scanned past the start: there is nothing to claim
  const now = new Date().toISOString();
  await col<DupeScanStateDoc>(SCAN_STATE).updateOne(
    asFilter<DupeScanStateDoc>({ _id: stateId }),
    asUpdate<DupeScanStateDoc>(at === null
      ? { $set: { ...ctx, cursorSeq: 0, updatedAt: now }, $unset: { cursorPos: '' } }
      : { $set: { ...ctx, cursorSeq: at.pos, cursorPos: { seq: at.pos, id: at.id as string }, updatedAt: now } }),
    { upsert: true },
  );
}

/**
 * The first carry's scanner cursors (bundle-81, design rev 8 §3a): a cursor stored by 5.6 holds only `cursorSeq`, and a legacy row's position IS its seq, so it
 * is carried by identity into the new field: `cursorPos = { seq: cursorSeq, id: '' }`. The empty id says "the place in the run at `cursorSeq` is not known",
 * which {@link readScanStart} reads as the legacy start (the run at `cursorSeq` is read again, never skipped), exactly what a 5.6 cursor always meant. A
 * cursor that already has its pair, or none to carry (`cursorSeq` 0), is left alone. Answers how many it carried.
 */
export async function carryScanCursors(): Promise<number> {
  const r = await col<DupeScanStateDoc>(SCAN_STATE).updateMany(
    asFilter<DupeScanStateDoc>({ cursorSeq: { $type: 'number', $gt: 0 }, cursorPos: { $exists: false } }),
    [{ $set: { cursorPos: { seq: '$cursorSeq', id: '' } } }] as unknown as ReturnType<typeof asUpdate<DupeScanStateDoc>>,
  );
  return r.modifiedCount;
}

/**
 * The filter that names one space's cursor rows: every `_id` that starts `<spaceId>:`. The colon is the boundary, so a sibling space whose id merely starts with
 * this one's (`victim-archive` beside `victim`) is never named, and the id is escaped so it matches as text. The one spelling for the rename (which moves the rows)
 * and the delete (which drops them), so neither can reach a neighbour's cursor by dropping the colon or the escape.
 */
function cursorsOfSpace(spaceId: string): ReturnType<typeof asFilter<DupeScanStateDoc>> {
  return asFilter<DupeScanStateDoc>({ _id: { $regex: `^${escapeRegex(spaceId)}:` } });
}

/**
 * A renamed space's scan cursors follow it: each is keyed `<space>:<type>`, `_id` is immutable, so it is copy then delete. Idempotent on a resumed rename. Losing a
 * cursor would only re-scan the space, but it would also leave a row behind that nothing reads.
 */
export async function moveScanCursors(oldId: string, newId: string): Promise<void> {
  const state = col<DupeScanStateDoc>(SCAN_STATE);
  const stale = await state.find(cursorsOfSpace(oldId)).toArray();
  for (const doc of stale) {
    const moved = { ...doc, _id: `${newId}:${doc._id.slice(oldId.length + 1)}` };
    await state.insertOne(asDoc(moved)).catch(async (err: unknown) => {
      if (!isDuplicateKey(err)) throw err;
      await state.deleteOne(asFilter<DupeScanStateDoc>({ _id: moved._id }));   // a re-run: the moved copy of the earlier attempt is replaced by this one
      await state.insertOne(asDoc(moved));
    });
    await state.deleteOne(asFilter<DupeScanStateDoc>({ _id: doc._id }));
  }
}

/**
 * A deleted space's scan cursors go with it: every row whose `_id` starts `<spaceId>:` (the colon is the boundary, so a sibling `victim-archive` keeps its
 * rows when `victim` is deleted). The prefix drop of the space's own collections cannot reach them, because this collection is instance-wide: a space created
 * again under the same id would otherwise start its first scan from the old position (records below it never scanned) and inherit the old `heldSince`, so its
 * first ordinary hold would be warned as one that has lasted weeks (`Q-697`). Answers how many rows it removed.
 */
export async function dropScanCursorsOfSpace(spaceId: string): Promise<number> {
  const r = await col<DupeScanStateDoc>(SCAN_STATE).deleteMany(cursorsOfSpace(spaceId));
  return r.deletedCount;
}

/** `current`, moved to `rec` when `rec` is further on — a pair compared as the store orders them. A record with no position never moves it. */
export function advanceScanPosition(current: PositionStart, rec: { _id: string; pos?: number | undefined }): PositionStart {
  if (typeof rec.pos !== 'number') return current;
  const at = { pos: rec.pos, id: rec._id };
  return comparePositionStarts(at, current) > 0 ? at : current;
}
