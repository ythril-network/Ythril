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
import { factEmbedText, entityEmbedText, edgeEmbedText, chronoEmbedText, fileEmbedText, chunkEmbedText } from './embed-text.js';
import { resolveEdgeEndpointNames } from './edge-endpoint-names.js';
import { embeddingSuppressedFor, recordSuppression, RECORD_SUPPRESS_FIELD } from './suppress-embeddings.js';
import { isTransientEmbedError } from './embed-queue.js';
import { atReadSeq, readSeqOf } from './write-precondition.js';
import { getEmbeddingConfig } from '../config/loader.js';
import { spaceCollection } from '../db/space-collection.js';
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

/** A file record a conversion or a media job DERIVED from another file, rather than one somebody stored. */
export function isDerived(doc: Record<string, unknown>): boolean {
  return typeof doc['parentFileId'] === 'string';
}

/** A derived record's text, or `null` when it has none: a face chunk, a converted or extracted copy. */
function derivedText(doc: Record<string, unknown>): string | null {
  const content = doc['content'];
  if (typeof content !== 'string' || content === '') return null;
  return chunkEmbedText(doc['headingText'] as string | null | undefined, content);
}

/**
 * The derived records that HAVE text, as a Mongo fragment — the same rule as `derivedText` above, for a sweep.
 *
 * Beside the function it mirrors so the two are read together: a sweep that queued textless derived records would
 * queue them on every call for ever, because nothing ever gives them a vector to stop matching "has no vector".
 */
export const derivedHasText: Readonly<Record<string, unknown>> = {
  parentFileId: { $exists: true },
  content: { $type: 'string', $ne: '' },
};

/** How far up `parentFileId` a derived record looks for its owner. A caption chunk of an image extracted from a
 *  document is two levels down; nothing is deeper. */
export const MAX_ANCESTRY = 3;

/**
 * Whether a derived record's TOP-LEVEL file says its embeddings are suppressed.
 *
 * A chunk carries no flag of its own: its owner set one on the file. Read only one level up, the caption chunk of an
 * image extracted from a suppressed document would still embed, because the extracted image is the parent and the
 * document is the grandparent. A missing ancestor counts as suppressed — fail closed, because the alternative sends
 * the passage to an embedder that may be external, against a choice nobody can see any more.
 */
async function ancestorSuppressed(spaceId: string, doc: Record<string, unknown>): Promise<boolean> {
  let parentId = doc['parentFileId'];
  for (let depth = 0; depth < MAX_ANCESTRY && typeof parentId === 'string'; depth++) {
    const parent = await col(spaceCollection(spaceId, 'files')).findOne(
      asFilter({ _id: parentId }),
      { projection: { parentFileId: 1, [RECORD_SUPPRESS_FIELD]: 1 } },
    ) as Record<string, unknown> | null;
    if (!parent) return true;
    if (recordSuppression(parent) === true) return true;
    parentId = parent['parentFileId'];
  }
  return false;
}

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
): Promise<string | null> {
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
      // A DERIVED record (a chunk, a media chunk, a face chunk, a converted or extracted copy) carries no path text
      // of its own: its producer embedded its `content`, or nothing at all. Building it from `_id` gave every chunk
      // the vector of `docs/a.pdf#chunk0`, which is how a backfill used to "repair" one.
      if (isDerived(doc)) return derivedText(doc);
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
 *
 * `superseded` is a third: a newer copy of the record arrived while this job was embedding the one it read, so its
 * write — which lands only on that version (`atReadSeq`) — touched nothing. The newer copy's own arrival queued the
 * embedding it is owed, so this attempt is finished, never retried, and a reindex counts it as done.
 */
export type EmbedOutcome = 'embedded' | 'gone' | 'excluded' | 'unchanged' | 'textless' | 'superseded';

/**
 * `rebuild`: make the vector again even when its text and model name are unchanged. A reindex is exactly that case —
 * a prefix scheme, a dimension or the weights behind a model name changed, and "the same text with the same name" is
 * no longer the same vector. Only a reindex asks for it.
 */
export interface EmbedStoredRecordOptions {
  rebuild?: boolean;
}

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
  opts: EmbedStoredRecordOptions = {},
): Promise<EmbedOutcome> {
  const collName = `${spaceId}_${COLLECTION[recordType]}`;
  const doc = await col(collName).findOne(asFilter({ _id: recordId })) as Record<string, unknown> | null;
  if (!doc) return 'gone';

  // EVERY write below lands only on the version just read (`atReadSeq`): the model call is the slow step, and a peer's
  // newer copy can arrive inside it. A write by `_id` alone would put the OLD text's vector and `matchedText` on the
  // newer copy — or a vector on a copy this instance suppresses — and `matchedText` doubles as the "unchanged"
  // fingerprint, so the stale vector could be taken as current. False: nothing matched, a newer copy is there.
  const readSeq = readSeqOf(doc);
  const writeIfUnchanged = async (update: Record<string, unknown>): Promise<boolean> =>
    (await col(collName).updateOne(asFilter(atReadSeq(recordId, readSeq)), update)).matchedCount > 0;

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
  const text = await buildEmbedText(spaceId, recordType, doc);

  // A derived record with no text is owed nothing, and whatever vector it holds came from a backfill that embedded
  // its path. Decided BEFORE suppression, whose branch writes `matchedText` and would give the record a text it does
  // not have. `faceEmbedding` is a different index of a different model and is not touched.
  if (text === null) {
    if (('embedding' in doc || 'embeddingModel' in doc || 'matchedText' in doc)
      && !await writeIfUnchanged({ $unset: { embedding: '', embeddingModel: '', matchedText: '' } })) return 'superseded';
    return 'textless';
  }

  // `matchedText` is what the lexical channel searches, so it is rewritten on EVERY outcome, not only when a vector is
  // stored (`Q-94`). Left as it was, a suppressed record kept matching the text it held when suppression began — a
  // deleted property went on being found, and shown as the record's matched text.
  if (embeddingSuppressedFor(spaceId, recordType, doc) || (isDerived(doc) && await ancestorSuppressed(spaceId, doc))) {
    return await writeIfUnchanged({ $set: { matchedText: text }, $unset: { embedding: '', embeddingModel: '' } })
      ? 'excluded' : 'superseded';
  }

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
  if (!opts.rebuild && vectorPresent && doc['matchedText'] === text && doc['embeddingModel'] === configuredModel) {
    return 'unchanged';
  }

  let result: Awaited<ReturnType<typeof embed>>;
  try {
    result = await embed(text);
  } catch (err) {
    // A rebuild that fails because the EMBEDDER is away changes nothing. The record's text did not change, so its
    // vector still describes it — under the old model, perhaps, but a model-change reindex keeps recall refused for
    // the space until it is done. Unsetting here would strip a whole space's vectors at claim rate for as long as
    // an outage lasts, and the job retries under the rebuild either way. Any other failure is the record's own,
    // and takes the path below.
    if (opts.rebuild && isTransientEmbedError(err instanceof Error ? err.message : String(err))) throw err;
    // The failed path, and the one retries and a dead letter end on (`Q-94`). The current text is written so the
    // lexical channel stops matching what the record no longer says, and the vector is DROPPED with it: that vector
    // is of text that is gone, and `matchedText` doubles as the "unchanged" fingerprint above — written beside a
    // stale vector, the next attempt would take the vector as current and never call the model again.
    // On a newer copy it writes nothing, and the failure still reaches the caller, which retries.
    await writeIfUnchanged({ $set: { matchedText: text }, $unset: { embedding: '', embeddingModel: '' } });
    throw err;
  }

  // `seq` is deliberately NOT advanced. An embedding is a DERIVED field — `merkle.ts` excludes it from
  // replication precisely because each peer computes its own — so bumping `seq` here would broadcast a
  // no-op change to every peer in every network the space belongs to, on every embedding, forever.
  return await writeIfUnchanged({ $set: { embedding: result.vector, embeddingModel: result.model, matchedText: text } })
    ? 'embedded' : 'superseded';
}
