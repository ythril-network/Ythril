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
 * ## Why the write goes through `writeArrivals` (`Q-205`, ported to 5.6.x by `Q-218`)
 *
 * The arrival writer (`sync/arrivals.ts`) is the one thing that stores a record produced elsewhere. Import went
 * through `ingestBrainDoc` and stored whatever it was handed: retention stamps as the TEXT JSON made of them (a
 * sweep never compares them), the export's `embeddingModel` and `matchedText` (another model's), a repeated id in
 * file order, and it never moved the counter. Through the writer, as a RESTORE (`restore: true`):
 *
 *  - **What is stored is replaced whatever its seq** — an operator restoring a backup over newer data asked for
 *    exactly that — and the export's record-tier local fields are KEPT, as Dates: the retention stamps ARE the
 *    record tier, and `syncBase` keeps a self-restore from turning every divergent file into a conflict copy. A
 *    stamp that does not parse is removed rather than stored as text.
 *  - **What this instance derives is dropped**: the vector, its model and `matchedText` (re-embedded here).
 *  - **A repeated id stores its highest seq**, an equal seq keeping the first, as every other door reads a page.
 *  - **The counter is moved past the highest PLAUSIBLE restored seq**, so a restored record never sorts above the
 *    next local write. A family whose counter could not be moved is answered as a failed write — every document of
 *    it an `errors` count, 5.6.1's response keys — though its records are stored; re-running the import repairs it.
 *  - **Nothing is carried from the copy a record replaces**: no stamp, no `syncBase` the backup does not hold, and no
 *    vector (the backup is the record's state; every restored record the space embeds is queued and re-embedded from its text).
 *
 * ## What the 5.6.x restore keeps as 5.6.1 had it (the 5.6.2 cuts)
 *
 *  - **`C5`, the response**: `{ inserted, updated, errors }` per family, plus `schemaViolations` when there are
 *    some — nothing else. The counts read as 5.6.1's per-document loop counted them: a collapsed second copy of an
 *    id counts `updated` (5.6.1 replaced it), a document with no usable `_id` and one the store refused count
 *    `errors`.
 *  - **`C6`, derived file records**: a file chunk and a face record are restored by replace, as 5.6.1 did, so a
 *    face label survives a restore; a file row is replaced whole (its sizes and hashes kept), not merged. A file the
 *    backup carries WITH derived rows is then left with exactly those (`Q-251`, the writer's `replaceDerivedRows`).
 *  - **`C7`, no seq refusal**: an odd seq (a string, a negative, a fraction, one in the ceiling reserve) is stored
 *    as 5.6.1 stored it. It never moves the counter.
 *  - **`C4`, no receiver stamping**: an imported record with no stamp stays unstamped.
 *
 * ## What is deliberately NOT done here
 *
 * **No `seq` allocation.** An exported document carries the seq it had, and a restore that renumbered them would
 * make this instance disagree with every peer about which copy is newer. Sync preserves an incoming seq for the
 * same reason.
 *
 * **No tombstone check.** Sync refuses a document whose id has been tombstoned, so a peer that has not caught up
 * cannot resurrect a deleted record. A RESTORE is the one case where resurrection is the point — but it does mean
 * a record deleted after the backup comes back, and the tombstone will remove it again on the next sync with a
 * peer that still holds it. Stated rather than left to be discovered.
 *
 * **Files are not schema-validated.** A file has no `type` and therefore no type schema — the same asymmetry
 * `embeddingSuppressedFor` encodes by skipping the middle tier for files.
 */
import { BRAIN_COLLECTIONS, KNOWLEDGE_TYPES } from '../config/types.js';
import { log, logSafe } from '../util/log.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import { violationsAgainstLocalSchema } from './sync/_shared.js';
import type { KnowledgeType } from '../config/types.js';
import { writeArrivals, ArrivalWriteError, type ArrivalOutcome } from '../sync/arrivals.js';
import { RECORD_TYPE_OF } from '../sync/replicated-families.js';

/** What an import may carry: every knowledge collection, so a new one is importable without an edit. */
const IMPORT_TYPES = BRAIN_COLLECTIONS;
export type ImportType = typeof IMPORT_TYPES[number];

/** One document that was stored despite breaking the space's schema. */
export interface ImportViolation {
  _id: string;
  violations: SchemaViolation[];
}

export interface ImportTypeResult {
  inserted: number;
  updated: number;
  errors: number;
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

/** True when `v` is a document we can address — an object carrying a string `_id`. */
function importableId(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const id = (v as Record<string, unknown>)['_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The writer's outcome counted as 5.6.1's per-document loop counted the same documents (cut `C5`): each copy of an
 * id that landed is one document stored — the first as `inserted` when nothing was there before, every later one
 * (5.6.1 replaced it again) as `updated` — and each copy of an id that did not land is an error.
 */
function countAs561(out: ArrivalOutcome, copies: ReadonlyMap<string, number>, result: ImportTypeResult): void {
  const n = (id: string): number => copies.get(id) ?? 1;
  for (const id of out.inserted) { result.inserted += 1; result.updated += n(id) - 1; }
  for (const id of out.updated) result.updated += n(id);
  // A restore is unguarded, so `newerLocal` and `derived` stay empty; counted all the same, so nothing goes uncounted.
  const unstored = new Set([...out.storeRefused.map(r => r._id), ...out.duplicates, ...out.newerLocal, ...out.derived]);
  for (const id of unstored) result.errors += n(id);
  // A shape refusal is one document without a usable id — counted per document, as 5.6.1 did.
  result.errors += out.refused.length;
}

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
  /** Derived file rows the restore removed because the backup carries the file without them (`Q-251`). */
  let derivedRemoved = 0;

  for (const t of IMPORT_TYPES) {
    const docs: unknown[] = Array.isArray(payload[t]) ? payload[t] as unknown[] : [];
    if (docs.length === 0) continue;
    const result = results[t];
    const violations: ImportViolation[] = [];
    const copies = new Map<string, number>();

    /*
     * Recorded, never refused — see the docblock. Only where there is a type SCHEMA to check against, which is
     * membership in `KNOWLEDGE_TYPES`: a file HAS a record type (`file`) and has no type schema, and a link has
     * neither. Per document as 5.6.1 reported it; the retag to this space is the writer's, and the check reads the
     * record's type and properties, never its `spaceId`.
     */
    const kind = RECORD_TYPE_OF[t];
    for (const doc of docs) {
      const docId = importableId(doc);
      if (docId === null) continue;
      copies.set(docId, (copies.get(docId) ?? 0) + 1);
      if (kind !== null && (KNOWLEDGE_TYPES as readonly string[]).includes(kind)) {
        const found = violationsAgainstLocalSchema(spaceId, kind as KnowledgeType, doc as Record<string, unknown>);
        if (found.length > 0) violations.push({ _id: docId, violations: found });
      }
    }

    let out: ArrivalOutcome | undefined;
    /** What the writer reports LANDED, whether or not it then failed — what the derived-row cleanup may follow. */
    let written: ArrivalOutcome | undefined;
    let failure: unknown;
    try {
      written = await writeArrivals(spaceId, t, RECORD_TYPE_OF[t], docs, { restore: true });
      out = written;
      /*
       * `Q-218` R3: the writer's counter bump failed, so this counter may be behind what was restored and the next
       * local write could sort below a restored record every peer holds. Not a clean success: the family is answered
       * as a failed write (every document an error, below), and running the import again repairs it — a restore
       * replaces, so it is idempotent.
       */
      if (out.counterBehind) throw new Error('the seq counter could not be moved past the restored records');
    } catch (err) {
      failure = err;
      if (err instanceof ArrivalWriteError && err.partial) written = err.partial;
    }
    // `Q-251`: the writer's restore of file rows removed the derived rows the backup does not hold, for what landed.
    if (written) derivedRemoved += written.derivedReplaced;
    if (failure !== undefined) {
      const err = failure;
      log.warn(`Import into space '${spaceId}': ${t} could not be written: ${logSafe(String(err))}`);
      const partial = err instanceof ArrivalWriteError ? err.partial : undefined;
      if (!partial || partial.counterBehind) {
        /*
         * Nothing of the family is vouched for, so every document is an error — as 5.6.1 counted a failed write. That
         * includes a writer that stopped part-way with the counter still behind what its earlier chunks committed
         * (`Q-252`): reporting those chunks as restored would hide that the next local write can sort below them.
         */
        if (partial?.counterBehind) {
          log.warn(`Import into space '${spaceId}': ${t} stopped part-way with the seq counter behind the records it `
            + 'had already restored, so every document is counted as an error; re-running the import repairs it '
            + '(a restore replaces).');
        }
        result.errors = docs.length;
        if (violations.length > 0) result.schemaViolations = violations;
        continue;
      }
      // The writer stopped part-way: the chunks before the fault are COMMITTED. Report what landed, and count only
      // what did not as errors — a restore that says "nothing was written" over records it did write is the worse lie.
      const settled = new Set([...partial.inserted, ...partial.updated, ...partial.derived, ...partial.newerLocal,
        ...partial.duplicates, ...partial.storeRefused.map(r => r._id)]);
      const unwritten = [...copies.keys()].filter(id => !settled.has(id));
      out = { ...partial, storeRefused: [...partial.storeRefused, ...unwritten.map(_id => ({ _id, reason: String(err) }))] };
    }
    countAs561(out!, copies, result);
    if (violations.length > 0) result.schemaViolations = violations;
  }

  log.info(
    `Import into space '${spaceId}': `
    + IMPORT_TYPES.map(t => {
      const r = results[t];
      const v = r.schemaViolations?.length ?? 0;
      return `${t}: +${logSafe(r.inserted)} ~${logSafe(r.updated)} !${logSafe(r.errors)}${v > 0 ? ` ?${logSafe(v)}` : ''}`;
    }).join(', ')
    + (derivedRemoved > 0 ? `; removed ${logSafe(derivedRemoved)} derived file row(s) the backup does not hold` : ''),
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
