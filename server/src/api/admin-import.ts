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
 * refusing the import makes backups unrestorable. `api/sync/_shared.ts` meets the identical problem on the
 * identical kind of payload and resolves it by RECORDING rather than refusing — the document is stored and the
 * violations are reported back. So the question was withdrawn rather than answered.
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
 *    the wire — a size and a hash describe bytes this instance has not got.
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
import { KNOWLEDGE_TYPES, TOMBSTONE_TYPE_OF } from '../config/types.js';
import type { BrainCollection, KnowledgeType } from '../config/types.js';
import { log } from '../util/log.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import { violationsAgainstLocalSchema } from './sync/_shared.js';
import { writeArrivals, arrivalId, arrivalRefusal, ArrivalWriteError, type ArrivalOutcome } from '../sync/arrivals.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF } from '../sync/replicated-families.js';
import { readPageTombstones } from '../sync/push-reads.js';

/**
 * What an import may carry: every REPLICATED family, by collection name — the same list the export streams, so
 * an export always restores (`Q-206`: the export left out links, and a round trip lost every one).
 */
const IMPORT_TYPES: readonly BrainCollection[] = REPLICATED_FAMILIES.map(f => f.collection);
export type ImportType = BrainCollection;

/** One document that was stored despite breaking the space's schema. */
export interface ImportViolation {
  _id: string;
  violations: SchemaViolation[];
}

/** One document that was NOT stored, and why. */
export interface ImportRefusal {
  _id: string;
  reason: string;
}

export interface ImportTypeResult {
  inserted: number;
  updated: number;
  /** How many were not stored; `refused` names each one. */
  errors: number;
  /** Every document not stored, by id and reason — a count says something is wrong and nothing about which. */
  refused?: ImportRefusal[];
  /** File chunks and face records left out because this instance derives them from the blob. */
  derived?: number;
  /** Records restored over a tombstone this instance holds: a peer holding the same tombstone deletes them again. */
  restoredOverTombstone?: string[];
  /**
   * Documents stored WITH violations, named so an operator can find them.
   *
   * Reported rather than refused, and reported per record rather than counted: a number would tell an operator
   * that something in a 50 000-record restore is wrong and nothing about which one.
   */
  schemaViolations?: ImportViolation[];
}

export interface ImportResult {
  spaceId: string;
  results: Record<ImportType, ImportTypeResult>;
}

/** Why a family could not be written at all — every document of it is refused with this reason. */
const familyFailed = (err: unknown): string =>
  `the store could not write this family (${err instanceof Error ? err.message : String(err)}); retry the import`;

/**
 * Import a payload of exported documents into one space.
 *
 * Extracted from `app.ts` so it can be exercised without an HTTP server: the route is argument handling and a
 * status code, and everything that decides what is stored is here and in the arrival writer.
 */
export async function importDocuments(spaceId: string, payload: Record<string, unknown>): Promise<ImportResult> {
  const results = Object.fromEntries(
    IMPORT_TYPES.map(t => [t, { inserted: 0, updated: 0, errors: 0 } as ImportTypeResult]),
  ) as Record<ImportType, ImportTypeResult>;

  for (const t of IMPORT_TYPES) {
    const docs: unknown[] = Array.isArray(payload[t]) ? payload[t] as unknown[] : [];
    if (docs.length === 0) continue;
    const result = results[t];

    /*
     * Recorded, never refused — see the docblock. Only where there is a type SCHEMA to check against, which is
     * membership in `KNOWLEDGE_TYPES`: a file HAS a record type (`file`) and has no type schema, and a link has
     * neither.
     */
    const kind = RECORD_TYPE_OF[t];
    const violations: ImportViolation[] = [];
    if (kind !== null && (KNOWLEDGE_TYPES as readonly string[]).includes(kind)) {
      for (const doc of docs) {
        // What the writer will refuse is not stored, so it has no violations to report — the same shape rule.
        if (arrivalRefusal(doc, { seqOptional: false }) !== null) continue;
        const id = arrivalId(doc);
        // The document as it arrived: the schema check reads its type and properties, never its `spaceId`, and the
        // retag to this space is the writer's (`retagToLocalSpace`, in `writeArrivals`) — not a second one here.
        const found = violationsAgainstLocalSchema(spaceId, kind as KnowledgeType, doc as Record<string, unknown>);
        if (found.length > 0) violations.push({ _id: id, violations: found });
      }
    }

    let out: ArrivalOutcome;
    try {
      out = await writeArrivals(spaceId, t, RECORD_TYPE_OF[t], docs, { restore: true });
    } catch (err) {
      log.warn(`Import into space '${spaceId}': ${t} could not be written: ${String(err)}`);
      if (!(err instanceof ArrivalWriteError) || !err.partial) {
        // Nothing of the family is vouched for, so every document is named.
        result.refused = docs.map(d => ({ _id: arrivalId(d), reason: familyFailed(err) }));
        result.errors = docs.length;
        continue;
      }
      // The writer stopped part-way: the chunks before the fault are COMMITTED. Report what landed, and refuse only
      // what did not — a restore that says "nothing was written" over records it did write is the worse lie.
      out = err.partial;
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
    if (refused.length > 0) result.refused = refused;
    if (out.derived.length > 0) result.derived = out.derived.length;
    if (violations.length > 0) result.schemaViolations = violations;

    // A deletion this instance holds for a record the restore just brought back — named, never silently undone.
    const tombType = TOMBSTONE_TYPE_OF[t];
    const landed = [...out.inserted, ...out.updated];
    if (tombType !== undefined && landed.length > 0) {
      const held = (await readPageTombstones(spaceId, landed)).get(tombType);
      const over = landed.filter(id => held?.has(id));
      if (over.length > 0) result.restoredOverTombstone = over;
    }
  }

  log.info(
    `Import into space '${spaceId}': `
    + IMPORT_TYPES.map(t => {
      const r = results[t];
      const v = r.schemaViolations?.length ?? 0;
      const tomb = r.restoredOverTombstone?.length ?? 0;
      return `${t}: +${r.inserted} ~${r.updated} !${r.errors}${v > 0 ? ` ?${v}` : ''}${tomb > 0 ? ` over-tombstone ${tomb}` : ''}`;
    }).join(', '),
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
