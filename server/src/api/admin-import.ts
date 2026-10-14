/**
 * The admin import: restore what an export wrote, say what was wrong with it, and queue it for embedding.
 *
 * ## What it did before, and why none of it was a decision
 *
 * The handler lived inline in `app.ts` and did `replaceOne(…, { upsert: true })` on arbitrary documents. Zero
 * validation, zero schema references, and no embed job — so every imported record was stored and invisible to
 * meaning-ranked search until somebody thought to run a reindex they were never told they needed.
 *
 * The validation half READ as a decision, and was filed as one. The tension is real: an import is how you
 * restore a backup, and a backup taken before a schema change would be refused by its own instance, so
 * refusing the import makes backups unrestorable. Sync meets the identical problem on the identical kind of
 * payload and resolves it by RECORDING rather than refusing — the document is stored and what it carries is
 * reported back — through one module, `sync/arrival-recording.ts`, which the page accept and this restore both
 * ask. So the question was withdrawn rather than answered.
 *
 * ## Why the write goes through `writeArrivals` (`Q-205`)
 *
 * The arrival writer (`sync/arrivals.ts`) is the one thing that stores a record produced elsewhere, and it owns
 * every precondition a door used to hold a subset of. Import used it through `ingestBrainDoc` and still stored
 * whatever it was handed: a string seq (invisible to every seq-paged pull), a seq inside the protocol's ceiling
 * reserve (a stranded counter), retention stamps as the TEXT JSON made of them (a sweep never compares them), the
 * export's vectors (another model's), file chunks as files, and a repeated id in file order. Through the writer:
 *
 *  - **A seq is a non-negative integer the counter can carry**, or the record is refused, NAMED with the reason
 *    (`refused`). Absent is allowed for file metadata only, which predates seqs.
 *  - **It is a RESTORE, not a peer arrival** (`restore: true`): what is stored is replaced whatever its seq — an
 *    operator restoring a backup over newer data asked for exactly that — and the export's record-tier local
 *    fields are KEPT, as Dates: the retention stamps ARE the record tier (a per-record `ttlDays` is never
 *    stored), and `syncBase` keeps a self-restore from turning every divergent file into a conflict copy.
 *  - **What this instance derives is dropped**: the vector, its model and `matchedText` (re-embedded here),
 *    every file chunk and face record (re-derived from the blob), and every file-metadata key that is not on
 *    the wire — a size and a hash describe bytes this instance has not got. An edge's write guard (`_functionalGuard`,
 *    `Q-439`) is dropped too: it is a lock on a subject in THIS instance's index, never a backup's to bring, so a restored
 *    edge arrives unmarked.
 *  - **A soft-deleted file stays flagged** (`Q-257`): the export holds this instance's own audit rows, and a row with
 *    `deletedAt` is restored with it (`flagsKept` counts them) — never as a live row with no bytes, which every peer
 *    would be offered. A flag is not a wire key, so only a restore brings one.
 *  - **A restore removes what its backup lacks, and says how much** (`Q-256`): every authored key a backup row does not carry is
 *    taken off the row it replaces, and `keysRemoved` counts the ones that row held.
 *  - **A repeated id stores its highest seq**; **D-9**: a record with no stamp is stamped from its own
 *    `createdAt` by this instance's `schema > space` windows.
 *  - **The counter is bumped per landed chunk**, so a restored record never sorts above the next local write.
 *
 * ## What is deliberately NOT done here
 *
 * **No `seq` allocation.** An exported document carries the seq it had, and a restore that renumbered them would
 * make this instance disagree with every peer about which copy is newer. Sync preserves an incoming seq for the
 * same reason.
 *
 * **No tombstone refusal.** Sync refuses a document whose id has been tombstoned, so a peer that has not caught
 * up cannot resurrect a deleted record. A RESTORE is the one case where resurrection is the point — but it means
 * a record deleted after the backup comes back, and a peer still holding the tombstone deletes it again on the
 * next sync, which reads as data loss. So every record restored over a tombstone is NAMED in the result
 * (`restoredOverTombstone`) rather than left to be discovered.
 *
 * **Files are not schema-validated.** A file has no `type` and therefore no type schema — the same asymmetry
 * `embeddingSuppressedFor` encodes by skipping the middle tier for files.
 */
import { TOMBSTONE_TYPE_OF } from '../config/types.js';
import type { BrainCollection } from '../config/types.js';
import { log, logSafe, peerList, peerText } from '../util/log.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import { MAX_ROWS } from '../brain/write-validation.js';
import { watchArrivals, recordedOf, sayRecorded, type RecordedFamilies } from '../sync/arrival-recording.js';
import { isNewerCopy } from '../sync/upsert-plan.js';
import { writeArrivals, arrivalId, arrivalRefusal, NAMED_IN_SUMMARY, type ArrivalOutcome } from '../sync/arrivals.js';
import { PageStoppedError } from '../sync/page-stopped.js';
import { CounterBehindError } from '../sync/counter-after-page.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF } from '../sync/replicated-families.js';
import { readPageTombstones } from '../sync/push-reads.js';
import { restartLeakedRowScans } from '../files/leaked-rows-repair.js';

/**
 * What an import may carry: every REPLICATED family, by collection name — the same list the export streams, so
 * an export always restores (`Q-206`: the export left out links, and a round trip lost every one).
 */
const IMPORT_TYPES: readonly BrainCollection[] = REPLICATED_FAMILIES.map(f => f.collection);
export type ImportType = BrainCollection;

/**
 * One document that was stored carrying something the schema does not accept and the copy it replaced lacked. A row is the field and the
 * reason, NEVER the value: the restore's answer is not where a backup's data goes (`R6-9`, names and counts only).
 */
export interface ImportViolation {
  _id: string;
  violations: Array<Pick<SchemaViolation, 'field' | 'reason'>>;
}

/** How many documents a restore's answer names; `schemaViolationsTotal` says how many there were. */
export const IMPORT_VIOLATIONS_NAMED = 50;

/** One document that was NOT stored, and why. */
export interface ImportRefusal {
  _id: string;
  reason: string;
}

export interface ImportTypeResult {
  inserted: number;
  updated: number;
  /** How many were not stored — the total; `refused` names the first of them. */
  errors: number;
  /**
   * The documents not stored, by id and reason — the first `NAMED_IN_SUMMARY` of them, so a 50 000-record restore
   * that fails answers a bounded body; `errors` is how many there were in all.
   */
  refused?: ImportRefusal[];
  /** File chunks and face records left out because this instance derives them from the blob. */
  derived?: number;
  /**
   * Files only: how many restored rows kept the `deletedAt` flag their backup carried (`Q-257`) — files this instance had
   * soft-deleted, brought back as the audit records they were rather than as live rows with no bytes. Present only when any did.
   */
  flagsKept?: number;
  /**
   * Files only: how many authored keys (a description, its source, the properties, the tags, a suppression mark) the restored rows
   * LOST because their backup row lacks them — an export is a full record, so a restore of an older backup over newer edits removes
   * what the backup does not say. Counts the keys the replaced rows held, not the keys the backup lacks. Present only when any were.
   */
  keysRemoved?: number;
  /**
   * The family's records were stored, and this instance's seq counter could not be moved past them (`Q-224`): the
   * next local write may sort below a restored record. Present only when it happened; run the import again (a
   * restore replaces, so it is idempotent) and it moves the counter.
   */
  counterBehind?: true;
  /**
   * Records restored over a tombstone this instance holds — a peer holding the same tombstone deletes them again.
   * The first `NAMED_IN_SUMMARY` ids; `restoredOverTombstoneTotal` is how many there were.
   */
  restoredOverTombstone?: string[];
  restoredOverTombstoneTotal?: number;
  /**
   * Documents stored carrying something the schema does not accept that the copy they replaced lacked, named so an operator can find them: the
   * first {@link IMPORT_VIOLATIONS_NAMED} of them, each with its fields and reasons and no value. An `off` space reports none.
   *
   * Reported rather than refused, and reported per record rather than counted: a number would tell an operator
   * that something in a 50 000-record restore is wrong and nothing about which one — and bounded, because a number of names is not.
   */
  schemaViolations?: ImportViolation[];
  /** How many documents there were in all, when `schemaViolations` names fewer. Present with `schemaViolations`. */
  schemaViolationsTotal?: number;
  /** `schemaViolations` stopped at {@link IMPORT_VIOLATIONS_NAMED} of {@link schemaViolationsTotal}. Present only then. */
  schemaViolationsTruncated?: true;
}

export interface ImportResult {
  spaceId: string;
  results: Record<ImportType, ImportTypeResult>;
}

/** Why a family could not be written at all — every document of it is refused with this reason. */
const familyFailed = (err: unknown): string =>
  `the store could not write this family (${peerText(err)}); retry the import`;

/**
 * Import a payload of exported documents into one space.
 *
 * Extracted from `app.ts` so it can be exercised without an HTTP server: the route is argument handling and a
 * status code, and everything that decides what is stored is here and in the arrival writer.
 *
 * **It restarts the space's leaked-rows scan before it answers** (`files/leaked-rows-repair.ts`), whatever the payload carried and
 * however far it got: the records it brought were never read, and a scan that had completed would sit out its day over them. The scan
 * is not run here; the next tick of the sweep does it.
 */
export async function importDocuments(spaceId: string, payload: Record<string, unknown>): Promise<ImportResult> {
  try { return await importInto(spaceId, payload); }
  finally { restartLeakedRowScans([spaceId]); }
}

async function importInto(spaceId: string, payload: Record<string, unknown>): Promise<ImportResult> {
  const results = Object.fromEntries(
    IMPORT_TYPES.map(t => [t, { inserted: 0, updated: 0, errors: 0 } as ImportTypeResult]),
  ) as Record<ImportType, ImportTypeResult>;
  /** What each family recorded, for the one line, counter and summary a restore says (`sayRecorded`). */
  const recordedByFamily = new Map<string, Map<string, readonly SchemaViolation[]>>();

  for (const t of IMPORT_TYPES) {
    const docs: unknown[] = Array.isArray(payload[t]) ? payload[t] as unknown[] : [];
    if (docs.length === 0) continue;
    const result = results[t];

    /*
     * Recorded, never refused — see the docblock, and `sync/arrival-recording.ts` for what recording is: only a document that was STORED,
     * only what the copy it replaced lacked, nothing in an `off` space, names and counts and never a value. Looked at BEFORE the write —
     * the copy a restore replaces is gone afterwards — and only where there is a type SCHEMA to check against (a file has none, a link
     * neither: `watchArrivals` answers nothing for them).
     *
     * A repeated id stores its highest seq (the writer's rule), so that is the version judged; what the writer will refuse (`arrivalRefusal`)
     * is not stored and has nothing to report.
     */
    const winners = new Map<string, Record<string, unknown> & { _id: string }>();
    for (const doc of docs) {
      if (arrivalRefusal(doc, { seqOptional: false }) !== null) continue;
      const held = winners.get(arrivalId(doc));
      if (held === undefined || isNewerCopy((doc as { seq: number }).seq, held['seq'] as number)) winners.set(arrivalId(doc), doc as Record<string, unknown> & { _id: string });
    }
    const watch = await watchArrivals(spaceId, t, [...winners.values()], 'import');

    let out: ArrivalOutcome;
    try {
      out = await writeArrivals(spaceId, t, RECORD_TYPE_OF[t], docs, { restore: true });
    } catch (err) {
      log.warn(`Import into space '${peerText(spaceId)}': ${t} could not be written: ${logSafe(String(err))}`);
      // `Q-224`: the writer always says what it had done when it stopped — a record write that failed part-way, or
      // a counter it could not move past what it restored. What it vouches for is reported as landed.
      const partial = err instanceof PageStoppedError ? err.partial : undefined;
      if (err instanceof CounterBehindError) result.counterBehind = true;
      if (!partial) {
        // Nothing of the family is vouched for, so every document is named.
        result.refused = docs.slice(0, NAMED_IN_SUMMARY).map(d => ({ _id: peerText(arrivalId(d)), reason: familyFailed(err) }));
        result.errors = docs.length;
        continue;
      }
      // The writer stopped part-way: the chunks before the fault are COMMITTED. Report what landed, and refuse only
      // what did not — a restore that says "nothing was written" over records it did write is the worse lie.
      out = partial;
      const settled = new Set([...out.inserted, ...out.updated, ...out.derived, ...out.newerLocal,
        ...out.duplicates, ...out.refused.map(r => r._id)]);
      const unwritten = [...new Set(docs.map(arrivalId))].filter(id => !settled.has(id));
      out = { ...out, refused: [...out.refused, ...unwritten.map(_id => ({ _id, reason: familyFailed(err) }))] };
    }
    result.inserted = out.inserted.length;
    result.updated = out.updated.length;
    const refused: ImportRefusal[] = [
      ...out.refused,
      ...out.duplicates.map(_id => ({ _id, reason: 'a uniquely-indexed duplicate of a record held here under another id' })),
    ];
    result.errors = refused.length;
    // Named in the answer bounded (`Q-270`): a megabyte `_id` or seq is cut where it is SHOWN, never where it is a
    // key — `settled` above and the writer match refusals to documents by the id as it arrived.
    if (refused.length > 0) {
      result.refused = refused.slice(0, NAMED_IN_SUMMARY).map(r => ({ ...r, _id: peerText(r._id), reason: peerText(r.reason) }));
    }
    if (out.derived.length > 0) result.derived = out.derived.length;
    if (out.flagKept.length > 0) result.flagsKept = out.flagKept.length;
    if (out.keysRemoved > 0) result.keysRemoved = out.keysRemoved;
    // What the documents that LANDED carry that the copies they replaced did not. The answer names the first `IMPORT_VIOLATIONS_NAMED`
    // of them, by id and by field and reason — never a value — and says how many there were in all and that it stopped short.
    const stored = new Set([...out.inserted, ...out.updated]);
    const recorded = recordedOf(watch, [...winners.values()].filter(d => stored.has(d._id)), 'import');
    if (recorded.size > 0) {
      const rows = [...recorded];
      result.schemaViolations = rows.slice(0, IMPORT_VIOLATIONS_NAMED).map(([doc, found]) => ({
        _id: peerText(doc._id),
        violations: found.slice(0, MAX_ROWS).map(({ field, reason }) => ({ field, reason })),
      }));
      result.schemaViolationsTotal = rows.length;
      if (rows.length > IMPORT_VIOLATIONS_NAMED) result.schemaViolationsTruncated = true;
      recordedByFamily.set(t, new Map(rows.map(([doc, found]) => [doc._id, found])));
    }

    // A deletion this instance holds for a record the restore just brought back — named, never silently undone.
    const tombType = TOMBSTONE_TYPE_OF[t];
    const landed = [...out.inserted, ...out.updated];
    if (tombType !== undefined && landed.length > 0) {
      const held = (await readPageTombstones(spaceId, landed)).get(tombType);
      const over = landed.filter(id => held?.has(id));
      if (over.length > 0) {
        result.restoredOverTombstone = over.slice(0, NAMED_IN_SUMMARY).map(id => peerText(id));
        result.restoredOverTombstoneTotal = over.length;
      }
    }
  }

  // Said once for the restore, names and counts only. Never throws, so it cannot turn a restore that landed into one that failed.
  sayRecorded({ spaceId, source: 'import', peer: 'import', families: recordedByFamily as RecordedFamilies });

  log.info(
    `Import into space '${peerText(spaceId)}': `
    + peerList(IMPORT_TYPES.map(t => {
      const r = results[t];
      const v = r.schemaViolationsTotal ?? 0;
      const tomb = r.restoredOverTombstoneTotal ?? 0;
      return `${t}: +${r.inserted} ~${r.updated} !${r.errors}${v > 0 ? ` ?${v}` : ''}${tomb > 0 ? ` over-tombstone ${tomb}` : ''}${r.flagsKept ? ` flagged ${r.flagsKept}` : ''}${r.keysRemoved ? ` keys-removed ${r.keysRemoved}` : ''}`;
    }), ', '),
  );

  return { spaceId, results };
}

/** The array-shape check the route answers 400 for, kept beside the importer that defines the shape. */
export function importPayloadError(payload: Record<string, unknown>): string | null {
  for (const t of IMPORT_TYPES) {
    if (payload[t] !== undefined && !Array.isArray(payload[t])) return `'${t}' must be an array`;
  }
  return null;
}
