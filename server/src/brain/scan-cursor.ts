/**
 * Where a background scan (the duplicate scanner, the contradiction scanner) resumes — one question, answered once.
 *
 * ## What it prevents
 *
 * Both scanners kept `cursorSeq` and moved it to the seq of each record they scanned, then read `seq > cursorSeq`. Records
 * from several authors share seqs, so a batch that ended inside a run, or a run that `maxPerRun` cut in two, left the rest of
 * the run behind the cursor: those records were never scanned until each was next edited, and the scan reported a clean
 * pass (bundle-52, `Q-277`). The position is a pair, `(seq, _id)`, read through `util/seq-keyset.ts` like every other
 * seq-paged reader.
 *
 * ## The stored state, which two builds can both read
 *
 * `{ cursorSeq: number, cursorPos?: { seq, id } }` in `ythril_dupe_scan_state`. `cursorSeq` stays a NUMBER, because an
 * older build reads it as one and moves it. `cursorPos` is where in the run at `cursorSeq` the last stop was, and it is
 * trusted ONLY when `cursorPos.seq === cursorSeq`: otherwise an older build moved `cursorSeq` since (a rollback) and the
 * position describes a place the cursor is no longer at. The read is then the legacy one — INCLUSIVE of `cursorSeq`,
 * because the old cursor says the run at that seq was read and it may have been read only in part. Scanning it once more
 * is idempotent (a pair already recorded is recorded again as itself), so the cost of doubt is one run, never a skip.
 * A reset clears both.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import type { DupeScanStateDoc, DupeScanType } from '../config/types.js';
import { compareSeqPositions, type SeqPosition } from '../util/seq-keyset.js';

/** The global collection both scanners keep their cursors in (and `spaces/rename.ts` moves). */
export const SCAN_STATE = 'ythril_dupe_scan_state';

/**
 * The position a scan READS AFTER, from its stored state: the stored `(seq, id)` when it belongs to `cursorSeq`, else
 * the legacy start that re-reads the run at `cursorSeq` (position `cursorSeq - 1`; a fresh cursor at 0 stays at 0).
 */
export async function readScanStart(stateId: string): Promise<SeqPosition> {
  const doc = await col<DupeScanStateDoc>(SCAN_STATE).findOne(asFilter<DupeScanStateDoc>({ _id: stateId }));
  const cursorSeq = typeof doc?.cursorSeq === 'number' ? doc.cursorSeq : 0;
  const pos = doc?.cursorPos;
  if (pos && pos.seq === cursorSeq && typeof pos.id === 'string' && pos.id !== '') return { seq: pos.seq, id: pos.id };
  return { seq: Math.max(0, cursorSeq - 1) };
}

/** Store where a scan stopped. `null` is a reset: `cursorSeq` 0 and no position. A position without an id stores nothing. */
export async function writeScanPosition(
  stateId: string, ctx: { spaceId: string; type: DupeScanType }, pos: SeqPosition | null,
): Promise<void> {
  if (pos !== null && pos.id === undefined) return;   // nothing was scanned past the start: there is nothing to claim
  const now = new Date().toISOString();
  await col<DupeScanStateDoc>(SCAN_STATE).updateOne(
    asFilter<DupeScanStateDoc>({ _id: stateId }),
    asUpdate<DupeScanStateDoc>(pos === null
      ? { $set: { ...ctx, cursorSeq: 0, updatedAt: now }, $unset: { cursorPos: '' } }
      : { $set: { ...ctx, cursorSeq: pos.seq, cursorPos: { seq: pos.seq, id: pos.id as string }, updatedAt: now } }),
    { upsert: true },
  );
}

/** `current`, moved to `rec` when `rec` is further on — a pair compared as the store orders them. A record with no seq never moves it. */
export function advanceScanPosition(current: SeqPosition, rec: { _id: string; seq?: number | undefined }): SeqPosition {
  if (typeof rec.seq !== 'number') return current;
  const at = { seq: rec.seq, id: rec._id };
  return compareSeqPositions(at, current) > 0 ? at : current;
}
