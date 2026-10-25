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
 */
import { col, asDoc, asFilter, asUpdate } from '../db/mongo.js';
import { isDuplicateKey } from '../db/write-errors.js';
import { escapeRegex } from '../util/redos.js';
import type { DupeScanStateDoc, DupeScanType } from '../config/types.js';
import { comparePositionStarts, type PositionStart } from '../util/position-keyset.js';

/** The global collection both scanners keep their cursors in (and `spaces/rename.ts` moves). */
export const SCAN_STATE = 'ythril_dupe_scan_state';

/**
 * The position a scan READS AFTER, from its stored state: the stored `(seq, id)` when it belongs to `cursorSeq`, else
 * the legacy start that re-reads the run at `cursorSeq` (position `cursorSeq - 1`; a fresh cursor at 0 stays at 0).
 */
export async function readScanStart(stateId: string): Promise<PositionStart> {
  const doc = await col<DupeScanStateDoc>(SCAN_STATE).findOne(asFilter<DupeScanStateDoc>({ _id: stateId }));
  const cursorSeq = typeof doc?.cursorSeq === 'number' ? doc.cursorSeq : 0;
  const pos = doc?.cursorPos;
  if (pos && pos.seq === cursorSeq && typeof pos.id === 'string' && pos.id !== '') return { pos: pos.seq, id: pos.id };
  return { pos: Math.max(0, cursorSeq - 1) };
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
 * A renamed space's scan cursors follow it: each is keyed `<space>:<type>`, `_id` is immutable, so it is copy then delete. Idempotent on a resumed rename. Losing a
 * cursor would only re-scan the space, but it would also leave a row behind that nothing reads.
 */
export async function moveScanCursors(oldId: string, newId: string): Promise<void> {
  const state = col<DupeScanStateDoc>(SCAN_STATE);
  const stale = await state.find(asFilter<DupeScanStateDoc>({ _id: { $regex: `^${escapeRegex(oldId)}:` } })).toArray();
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

/** `current`, moved to `rec` when `rec` is further on — a pair compared as the store orders them. A record with no position never moves it. */
export function advanceScanPosition(current: PositionStart, rec: { _id: string; pos?: number | undefined }): PositionStart {
  if (typeof rec.pos !== 'number') return current;
  const at = { pos: rec.pos, id: rec._id };
  return comparePositionStarts(at, current) > 0 ? at : current;
}
