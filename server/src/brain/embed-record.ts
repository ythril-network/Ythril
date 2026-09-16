/**
 * Embed one stored brain record, given only its type and id.
 *
 * ## Why this is a module rather than a branch inside the worker
 *
 * "Rebuild this record's embedding text and store the vector" already existed once, inline in the
 * `POST /reindex` route — four near-identical blocks, one per type, each re-deriving what the creator
 * fed the model. The embedding queue needs exactly the same operation, and a second copy would put the
 * codebase back where `merge-fields.ts` found it: one rule, several implementations, and a promise that
 * they agree.
 *
 * The text MUST match what the creator embedded. If a reindex or a queued job builds it differently, a
 * record's vector silently stops corresponding to its own content, and the only symptom is worse recall
 * — no error, nothing to grep for. So the `*EmbedText` builders in `embed-text.ts` are the single
 * source, and this module's job is only to gather their inputs from the stored document.
 */

import { col, asFilter } from '../db/mongo.js';
import { embed } from './embedding.js';
import { factEmbedText, entityEmbedText, edgeEmbedText, chronoEmbedText, fileEmbedText } from './embed-text.js';
import { resolveEdgeEndpointNames } from './edge-endpoint-names.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import type { KnowledgeType } from '../config/types-knowledge.js';
import { getEmbeddingConfig } from '../config/loader.js';
import type {
  BrainEmbedRecordType, FactDoc, EntityDoc, EdgeDoc, ChronoEntry, FileMetaDoc,
} from '../config/types.js';

/** Collection suffix per record type — the same mapping recall uses. */
/** Exported so the re-embed backfill scans the same collections this function writes. A second copy of this
 *  map is how a backfill quietly misses a record kind. */
export const COLLECTION: Record<BrainEmbedRecordType, string> = {
  fact: 'facts', entity: 'entities', edge: 'edges', chrono: 'chrono', file: 'files',
};

// `entityNames` was here: it resolved a record's linked entity ids to names for the fact and file builders,
// which is the round-trip A-3 removed along with the prepend. Both of its consumers are gone, so it goes rather
// than sitting unused — and with it one Mongo query per embedded fact and per embedded file.

/**
 * The exact string this record's vector is built from.
 *
 * Exported so a test can assert that a queued job and the creator produce the SAME text for the same
 * record — the property that makes async embedding invisible to the searcher.
 */
export async function buildEmbedText(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  doc: Record<string, unknown>,
): Promise<string> {
  switch (recordType) {
    case 'fact': {
      const m = doc as unknown as FactDoc;
      return factEmbedText(m.fact, m.tags ?? [], m.description, m.properties);
    }
    case 'entity': {
      const e = doc as unknown as EntityDoc;
      return entityEmbedText(e.name, e.type, e.tags ?? [], e.description, e.properties ?? {});
    }
    case 'edge': {
      const e = doc as unknown as EdgeDoc;
      const [fromName, toName] = await resolveEdgeEndpointNames(spaceId, e.from, e.to, e.fromKind, e.toKind);
      return edgeEmbedText(fromName, e.label, toName, e.tags ?? [], e.type, e.description, e.properties);
    }
    case 'chrono': {
      const c = doc as unknown as ChronoEntry;
      return chronoEmbedText(c.title, c.type, c.status, c.description, c.tags ?? [], c.properties);
    }
    case 'file': {
      // `_id` IS the normalised path — `toDocId(filePath)` — so the path the vector is built from is the
      // stored one, not one the caller passed in and that may since have been renamed.
      const f = doc as unknown as FileMetaDoc & { _id: string };
      return fileEmbedText(f._id, f.tags ?? [], f.description, f.properties, f.excerpt);
    }
  }
}

/**
 * What became of an embedding attempt.
 *
 * `gone` and `excluded` are both successes — the record was deleted, or its owner asked for it not to be
 * findable. Neither is owed a vector, so neither may be retried: a retry would keep a job alive forever for
 * work that must never happen.
 */
export type EmbedOutcome = 'embedded' | 'gone' | 'excluded' | 'unchanged';

/**
 * ## Why an UPDATE enqueues this instead of embedding inline
 *
 * Until 2026-08-07 all four update functions computed the vector themselves, from the record as they had
 * READ it plus the caller's patch, and wrote it in the same `$set`. Every content field in that `$set` was
 * guarded by `updates.X !== undefined`, but the embedding never was — it went in unconditionally.
 *
 * So two concurrent patches touching DIFFERENT fields both landed and lost no field, exactly as documented,
 * while each wrote a whole embedding describing only its own view of the record. The later write won, and
 * the stored vector then described a record that no longer existed anywhere: not a lost field, a permanent
 * disagreement between a record and its own index. Nothing could detect it, because every field was
 * correct — no counter fires, and no `If-Match` precondition would have been violated.
 *
 * `embedStoredRecord` cannot have that bug. It re-reads the document AFTER the write, so the text it embeds
 * is by construction the text of the record as it actually stands, whoever else wrote to it in between.
 *
 * Two things fall out of the change that are worth knowing before "simplifying" it back:
 *
 *  - **It is the contract creates already have.** `upsertEntity` and `saveFact` have queued by default since
 *    the embed queue shipped, and `waitForEmbedding` is the documented opt-out. Updates were the odd one out.
 *  - **It deletes four copies of the embed-text builder.** Each update function had its own inline call to
 *    `entityEmbedText` / `factEmbedText` / …; `buildEmbedText` above is the one the queue uses, and one
 *    copy cannot drift from itself.
 *
 * ## Load the record, build its text, embed it, store the vector.
 *
 * Throws if the model is unavailable — the caller decides whether that is a retry (the worker) or a
 * failed request (`waitForEmbedding: true`). Returns `gone` when the record no longer exists, which is
 * the ordinary outcome for a record deleted between the enqueue and the claim, and must NOT be a retry:
 * retrying would keep a job alive for a document that will never come back.
 */
export async function embedStoredRecord(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
): Promise<EmbedOutcome> {
  const collName = `${spaceId}_${COLLECTION[recordType]}`;
  const doc = await col(collName).findOne(asFilter({ _id: recordId })) as Record<string, unknown> | null;
  if (!doc) return 'gone';

  // `suppressEmbeddings` is implemented AS the absence of a vector — there is no query-time filter to honour,
  // so a stored vector IS the feature failing. This is the LAST place it can take effect, not the only one:
  // the four creators consult `embeddingSuppressedFor` before computing a vector inline, because a creator
  // that already has one never reaches this function. See that helper for what that cost.
  //
  // The stale vector is UNSET rather than left behind. Leaving it would keep the record findable by the
  // exact mechanism the flag exists to switch off, which is the whole bug. That also makes this the path that
  // cleans up after a suppression toggled ON: the next write of an existing record removes its vector here.
  //
  // The per-record flag is the TOP tier of three, and all three are spelled `suppressEmbeddings`. A type
  // schema may suppress the whole type, and the space may suppress everything; `embeddingSuppressed` resolves
  // record > schema > space, the same order `retention` uses. Two tiered settings that resolved differently is
  // the kind of thing nobody discovers until it is wrong, and "wrong" here means recall silently stops
  // covering something.
  //
  // Absent at a tier means NOT STATED and falls through — it is not `false`. Reading it as `false` would make
  // the space-wide switch do nothing for any type that had a schema at all, which is every type worth
  // suppressing.
  if (embeddingSuppressedFor(spaceId, recordType, doc)) {
    await col(collName).updateOne(
      asFilter({ _id: recordId }),
      { $unset: { embedding: '', embeddingModel: '' } },
    );
    return 'excluded';
  }

  const text = await buildEmbedText(spaceId, recordType, doc);

  // Every successful update enqueues an embed job, unconditionally and for good reasons — the enqueue is also
  // how the `suppressEmbeddings` toggle takes effect, and how a stale inline embed was eliminated. But most
  // updates change something the vector does not depend on: a tag, a property, a link, a status. Those paid for a
  // model call that could only reproduce the vector already stored.
  //
  // **The fingerprint already exists.** Every embed writes `matchedText` — the exact text it embedded — beside the
  // vector. So an identical text, with a vector present and the SAME model configured, means the model call is a
  // no-op by construction: a vector is a pure function of (text, model), and both are unchanged.
  //
  // This is not a heuristic and it does not trade quality: the record keeps a vector the system itself produced
  // from this text with this model. Any of the three conditions failing falls through and re-embeds.
  const configuredModel = getEmbeddingConfig().model;
  const vectorPresent = Array.isArray(doc['embedding']) && (doc['embedding'] as unknown[]).length > 0;
  if (vectorPresent && doc['matchedText'] === text && doc['embeddingModel'] === configuredModel) {
    return 'unchanged';
  }

  const result = await embed(text);

  // `seq` is deliberately NOT advanced. An embedding is a DERIVED field — `merkle.ts` excludes it from
  // replication precisely because each peer computes its own — so bumping `seq` here would broadcast a
  // no-op change to every peer in every network the space belongs to, on every embedding, forever.
  await col(collName).updateOne(
    asFilter({ _id: recordId }),
    { $set: { embedding: result.vector, embeddingModel: result.model, matchedText: text } },
  );
  return 'embedded';
}
