/**
 * The admin import: store what you are given, say what was wrong with it, and queue it for embedding.
 *
 * ## What it did before, and why none of it was a decision
 *
 * The handler lived inline in `app.ts` and did `replaceOne(…, { upsert: true })` on arbitrary documents. Zero
 * validation, zero schema references, and no embed job — so every imported record was stored and invisible to
 * meaning-ranked search until somebody thought to run a reindex they were never told they needed.
 *
 * The validation half READ as a decision, and was filed as one. The tension is real: an import is how you
 * restore a backup, and a backup taken before a schema change would be refused by its own instance, so
 * refusing the import makes backups unrestorable.
 *
 * It should not have been filed. `api/sync/_shared.ts` meets the identical problem on the identical kind of
 * payload and resolves it by RECORDING rather than refusing — the document is stored and the violations are
 * reported back to whoever pushed it. Import is the other bulk ingest path into the same collections, and one
 * rule with two answers is the defect this codebase produces most. So the question was withdrawn rather than
 * answered.
 *
 * ## Why the write goes through `ingestBrainDoc`
 *
 * That function is the only thing the sync router permits to write a brain document, and it exists for exactly
 * this: it writes AND enqueues in one call, so a new ingest site cannot be written without the queue. Import
 * grew its own `replaceOne` beside it and inherited none of that.
 *
 * ## What is deliberately NOT done here
 *
 * **No `seq` allocation.** An exported document carries the seq it had, and a restore that renumbered them
 * would make this instance disagree with every peer about which copy is newer. Sync preserves an incoming seq
 * for the same reason.
 *
 * **No tombstone check.** Sync refuses a document whose id has been tombstoned, so a peer that has not caught
 * up cannot resurrect a deleted record. A RESTORE is the one case where resurrection is the point — but it
 * does mean a record deleted after the backup comes back, and the tombstone will remove it again on the next
 * sync with a peer that still holds it. Stated rather than left to be discovered.
 *
 * **Files are not schema-validated.** A file has no `type` and therefore no type schema — the same asymmetry
 * `embeddingSuppressedFor` encodes by skipping the middle tier for files. Validating one would mean inventing
 * a rule for it to break.
 */
import { col } from '../db/mongo.js';
import { BRAIN_COLLECTIONS, KNOWLEDGE_TYPES } from '../config/types.js';
import { log } from '../util/log.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import { violationsAgainstLocalSchema, ingestBrainDoc } from './sync/_shared.js';
import type { BrainEmbedRecordType, KnowledgeType } from '../config/types.js';

/** The five collections an export carries, and what each one is called elsewhere. */
/** What an import may carry: every knowledge collection, so a new one is importable without an edit. */
const IMPORT_TYPES = BRAIN_COLLECTIONS;
export type ImportType = typeof IMPORT_TYPES[number];

/**
 * The record type each collection holds, for the embed queue and the schema lookup.
 *
 * `null` for `links` and it is not a gap: a link record says one record concerns another and carries no
 * text, so there is nothing to embed and no type schema to check it against. Spelled `null` rather than
 * left out, because this map is TOTAL over the importable collections — which is what made adding a
 * collection a compiler error here instead of a record kind the importer silently skipped.
 */
const RECORD_TYPE: Record<ImportType, BrainEmbedRecordType | null> = {
  facts: 'fact',
  entities: 'entity',
  edges: 'edge',
  chrono: 'chrono',
  files: 'file',
  links: null,
};

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
 * Import a payload of exported documents into one space.
 *
 * Extracted from `app.ts` so it can be exercised without an HTTP server: the route is now argument handling
 * and a status code, and everything that decides what is stored is here.
 */
export async function importDocuments(spaceId: string, payload: Record<string, unknown>): Promise<ImportResult> {
  const results = Object.fromEntries(
    IMPORT_TYPES.map(t => [t, { inserted: 0, updated: 0, errors: 0 } as ImportTypeResult]),
  ) as Record<ImportType, ImportTypeResult>;

  for (const t of IMPORT_TYPES) {
    const docs: unknown[] = Array.isArray(payload[t]) ? payload[t] as unknown[] : [];
    if (docs.length === 0) continue;

    const collName = `${spaceId}_${t}`;
    const result = results[t];
    const violations: ImportViolation[] = [];

    for (const doc of docs) {
      const docId = importableId(doc);
      if (docId === null) { result.errors++; continue; }

      try {
        /*
         * Re-tag the document to the TARGET space.
         *
         * The export embeds the source space's id in every document, and the read paths filter on that field
         * (listEntities, listEdges, listChrono, entity lookup-by-name, the edge-dedup lookup). Importing space
         * A's export into space B while keeping `spaceId: "A"` writes documents that are counted but INVISIBLE
         * to every list — the import looks like it worked, and the data appears to be missing. The collection
         * name is the only real scope, so a document written into `{spaceId}_*` belongs to `spaceId` by
         * definition.
         */
        const retagged = { ...(doc as Record<string, unknown>), _id: docId, spaceId };

        /*
         * Recorded, never refused — see the docblock.
         *
         * Skipped where there is no type SCHEMA to check against, and the condition is membership in
         * `KNOWLEDGE_TYPES` rather than a list of collection names. It read `t !== 'files'`, which was the
         * same thing while files were the only such collection; `M-2`'s links are the second, and a name
         * check would have validated a link against nothing while claiming it had been checked.
         *
         * **The axis matters and the first attempt got it wrong.** Guarding on "has a record type" reads as
         * the same question and is not: a file HAS one (`file`) and has no type schema, so files went into
         * `violationsAgainstLocalSchema`, whose switch has no case for them, and every file import threw
         * into the outer catch and was counted as an error. What `violationsAgainstLocalSchema` takes is a
         * `KnowledgeType` — so that is the question to ask.
         */
        const kind = RECORD_TYPE[t];
        if (kind !== null && (KNOWLEDGE_TYPES as readonly string[]).includes(kind)) {
          const found = violationsAgainstLocalSchema(spaceId, kind as KnowledgeType, retagged);
          if (found.length > 0) violations.push({ _id: docId, violations: found });
        }

        // Whether this REPLACES something has to be read before the write, because `ingestBrainDoc` upserts
        // and does not report which it did. One extra id-only read per document, on a path that is already
        // one round trip per document.
        const existed = await col(collName).countDocuments({ _id: docId } as never, { limit: 1 });

        await ingestBrainDoc(spaceId, RECORD_TYPE[t], t, retagged as { _id: string });

        if (existed > 0) result.updated++; else result.inserted++;
      } catch {
        result.errors++;
      }
    }

    if (violations.length > 0) result.schemaViolations = violations;
  }

  log.info(
    `Import into space '${spaceId}': `
    + IMPORT_TYPES.map(t => {
      const r = results[t];
      const v = r.schemaViolations?.length ?? 0;
      return `${t}: +${r.inserted} ~${r.updated} !${r.errors}${v > 0 ? ` ?${v}` : ''}`;
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
