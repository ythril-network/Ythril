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
import { notFlaggedIfFile } from '../files/live-file-row.js';
import { writeDerivedFields, type FileRowTier } from '../files/derived-fields.js';
import type { SpacePart } from '../db/space-collection.js';
import { embed } from './embedding.js';
import { factEmbedText, entityEmbedText, edgeEmbedText, chronoEmbedText, fileEmbedText, chunkEmbedText } from './embed-text.js';
import { resolveEdgeEndpointNames, resolveEndpointNames } from './edge-endpoint-names.js';
import { edgeEndpointKind } from './entity-refs.js';
import { embeddingSuppressedFor, fileEmbeddingSuppressed } from './suppress-embeddings.js';
import { isTransientEmbedError } from './embed-queue.js';
import { getEmbeddingConfig } from '../config/loader.js';
import { atReadSeq, readSeqOf } from '../db/at-read-seq.js';
import { UNSET_DERIVED, UNSET_VECTOR } from '../sync/local-only-fields.js';
import { log, logSafe, peerList } from '../util/log.js';
import { holdsVector } from './holds-vector.js';
import { holdsDerived } from './holds-derived.js';
import { textIsStale } from './derived-text-on-write.js';
import type {
  BrainEmbedRecordType, FactDoc, EntityDoc, EdgeDoc, ChronoEntry, FileMetaDoc,
} from '../config/types.js';

/** Collection suffix per record type — the same mapping recall uses. */
/** Exported so the re-embed backfill scans the same collections this function writes. A second copy of this
 *  map is how a backfill quietly misses a record kind. */
export const COLLECTION: Record<BrainEmbedRecordType, SpacePart> = {
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
      return edgeTextOf(e, fromName, toName);
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

/** An edge's text from its endpoints' names: the one composition, so the one-document and the batched builder cannot differ. */
function edgeTextOf(e: EdgeDoc, fromName: string, toName: string): string {
  return edgeEmbedText(fromName, e.label, toName, e.tags ?? [], e.type, e.description, e.properties);
}

/**
 * The answer for a record whose text CANNOT be built: a field of its own has the wrong type (`tags: 'x'`, which a pull can store,
 * since an arrival is not validated against the schema). Neither a string (so nothing stores it as text) nor `null` (a derived row
 * with no text BY DESIGN, which is owed nothing): such a record is owed its job, whose failure is then visible in `list_embed_jobs`.
 * Every caller tests `typeof text === 'string'` before using a text.
 */
export const UNBUILDABLE: unique symbol = Symbol('embed text cannot be built');

/** What the guarded builders answer for one record: its text, `null` when it has none, or {@link UNBUILDABLE}. */
export type EmbedText = string | null | typeof UNBUILDABLE;

/**
 * One record's text, or {@link UNBUILDABLE} when the record's own field has the wrong type. Only that is caught: the builders
 * throw a `TypeError` on it (`tags.join is not a function`), while a store error (an edge's endpoint read) is not the record's and
 * is rethrown, so an outage never reads as a page of broken records.
 */
async function textOrMarker(build: () => string | null | Promise<string | null>): Promise<EmbedText> {
  try {
    return await build();
  } catch (err) {
    if (err instanceof TypeError) return UNBUILDABLE;
    throw err;
  }
}

/**
 * {@link buildEmbedText}, guarded the way {@link buildEmbedTexts} guards each record of a page: the one-record builder for a caller
 * that must not fail on one broken record (the dupe scanner's hold on a dismissed pair).
 */
export function buildEmbedTextOrMarker(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  doc: Record<string, unknown>,
): Promise<EmbedText> {
  return textOrMarker(() => buildEmbedText(spaceId, recordType, doc));
}

/**
 * `buildEmbedText` for a page of documents of one kind: the same string for each, in order (`null` where a document has no
 * text, {@link UNBUILDABLE} where its own field has the wrong type).
 *
 * ## Why it is its own function
 *
 * `buildEmbedText` resolves an edge's two endpoint names with a read each, which is right for one record and a read per
 * endpoint over a page. The backfill's walk compares every record's `matchedText` with its text, and the arrival writer builds
 * the text of the suppressed arrivals of a chunk, so both read names once per endpoint KIND (`resolveEndpointNames`). The
 * answer is the same by construction: the name's normalisation is `endpointDisplayName` for both readers, an endpoint of a kind
 * no collection holds is its raw id for both, and the text is composed by `edgeTextOf` for both. Every other kind has no read, so
 * it is `buildEmbedText` itself.
 *
 * ## One broken record does not fail the page
 *
 * Both callers build a whole page at once, so a record whose text threw failed the arrival writer's page on every cycle and the
 * backfill for the whole space on every call, after jobs had already been queued (Q-656). Each record is guarded on its own
 * ({@link textOrMarker}) and the page's broken records are named in ONE warning.
 */
export async function buildEmbedTexts(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  docs: ReadonlyArray<Record<string, unknown>>,
): Promise<EmbedText[]> {
  let texts: EmbedText[];
  if (recordType !== 'edge') {
    texts = await Promise.all(docs.map(d => buildEmbedTextOrMarker(spaceId, recordType, d)));
  } else {
    const edges = docs as unknown as EdgeDoc[];
    if (edges.length === 0) return [];
    // Outside the per-record guard: a failed read is the store's, not a record's.
    const nameOf = await resolveEndpointNames(spaceId, edges);
    texts = await Promise.all(edges.map(e => textOrMarker(
      () => edgeTextOf(e, nameOf(edgeEndpointKind(e.fromKind), e.from), nameOf(edgeEndpointKind(e.toKind), e.to)))));
  }
  const unbuildable = docs.filter((_, i) => texts[i] === UNBUILDABLE).map(d => d['_id']);
  if (unbuildable.length > 0) {
    log.warn(`${unbuildable.length} record(s) of ${recordType} in '${logSafe(spaceId)}' have text that cannot be built (a field of the `
      + `wrong type): e.g. ${peerList(unbuildable, ', ', { count: UNBUILDABLE_NAMED })}. Their embed jobs fail and are listed by `
      + 'list_embed_jobs; correct the record.');
  }
  return texts;
}

/** How many of a page's unbuildable records its warning names. */
const UNBUILDABLE_NAMED = 5;

/** Why a record is owed a job, in precedence order where two could apply (`stale` before a model change). */
export type EmbedOwedReason = 'stale' | 'vectorless' | 'suppressed-vector' | 'clear-derived' | 'model' | 'rebuild';

/**
 * What the worker would do with a stored record, decided from the record alone:
 *
 * - `unbuildable`: its own field has the wrong type; the worker's job fails on it (and is visible in `list_embed_jobs`);
 * - `textless`: a derived row with no text; with `reason: 'clear-derived'` it still holds a derived field the worker unsets;
 * - `settled`: suppressed, its text current and no vector; the worker's write changes nothing;
 * - `writeLexical`: suppressed, and its text is stale (`stale`) or it still holds a vector (`suppressed-vector`): the worker writes
 *   the text and removes the vector, with no model call;
 * - `unchanged`: a vector beside its current text, made by the configured model; the model call would reproduce it;
 * - `embed`: the model is called, because the record holds no vector (`vectorless`), its vector is of text it no longer has
 *   (`stale`), another model made it (`model`), or a reindex asks for it again (`rebuild`).
 */
export type EmbedOwed =
  | { outcome: 'unbuildable' }
  | { outcome: 'textless'; reason?: 'clear-derived' }
  | { outcome: 'settled' }
  | { outcome: 'writeLexical'; reason: 'stale' | 'suppressed-vector' }
  | { outcome: 'unchanged' }
  | { outcome: 'embed'; reason: 'stale' | 'vectorless' | 'model' | 'rebuild' };

/** What {@link embedOwed} reads of a record. The vector itself is not needed, only whether it holds one (`holdsVector`). */
export interface EmbedOwedInput {
  text: EmbedText;
  suppressed: boolean;
  vectorPresent: boolean;
  /** Whether the record holds any derived field (`UNSET_DERIVED`'s keys), present even as `null`. */
  holdsDerived: boolean;
  matchedText: unknown;
  embeddingModel: unknown;
  /** The configured model's name. Lazy: asked only when the answer depends on it (a vector beside its current text). */
  configuredModel: () => string;
  rebuild?: boolean;
}

/**
 * The worker's classifier: what `embedStoredRecord` does with a record, as a value. The worker switches on it, and the backfill's
 * walk (`queue-embed-sweep.ts`) counts from it, so a record the walk owes is exactly a record the worker settles and a drained
 * space owes nothing on the next call by construction (Q-656). A second copy of this table in the walk is how `embedding: null`
 * came to be queued by neither of the backfill's two walks.
 *
 * A vectorless record that is not suppressed is `vectorless`, never `stale`: `stale` names a record that holds a vector, or is
 * suppressed, whose stored text is not its current text (the backfill's `stale` count). Whether the text is stale is
 * `textIsStale`'s question, asked here and nowhere else in this module.
 */
export function embedOwed(i: EmbedOwedInput): EmbedOwed {
  if (i.text === UNBUILDABLE) return { outcome: 'unbuildable' };
  if (i.text === null) return i.holdsDerived ? { outcome: 'textless', reason: 'clear-derived' } : { outcome: 'textless' };
  const stale = textIsStale({ matchedText: i.matchedText }, i.text);
  if (i.suppressed) {
    if (stale) return { outcome: 'writeLexical', reason: 'stale' };
    if (i.vectorPresent) return { outcome: 'writeLexical', reason: 'suppressed-vector' };
    return { outcome: 'settled' };
  }
  if (!i.vectorPresent) return { outcome: 'embed', reason: 'vectorless' };
  if (stale) return { outcome: 'embed', reason: 'stale' };
  if (i.embeddingModel !== i.configuredModel()) return { outcome: 'embed', reason: 'model' };
  if (i.rebuild) return { outcome: 'embed', reason: 'rebuild' };
  return { outcome: 'unchanged' };
}

/**
 * What became of an embedding attempt.
 *
 * `gone` and `excluded` are both successes — the record was deleted, or its owner asked for it not to be
 * findable. Neither is owed a vector, so neither may be retried: a retry would keep a job alive forever for
 * work that must never happen.
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
 *
 * ## Every write lands only on the version this read (`atReadSeq`)
 *
 * The model call is the slow step, and a peer's newer copy can land inside it. Written by `_id` alone, the job put
 * the OLD text's vector and `matchedText` on the newer copy — and on a newer copy this instance suppresses, a vector
 * it must never hold. So all four writes below are filtered on the seq the read saw; a copy written since is not
 * touched (`superseded`), and that copy's own arrival queued its own job.
 */
export async function embedStoredRecord(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
  opts: EmbedStoredRecordOptions = {},
): Promise<EmbedOutcome> {
  const collName = `${spaceId}_${COLLECTION[recordType]}`;
  // A flagged file row reads as 'gone': the flag strips the vector, its model and `matchedText`, and a job that ran
  // against the row anyway would write all three back onto the audit record of a deleted file. Per kind, because the
  // collection is the kind's, and the any-tier predicate because a chunk or caption row is a legitimate subject here.
  const doc = await col(collName).findOne(
    asFilter({ _id: recordId, ...notFlaggedIfFile(recordType) })) as Record<string, unknown> | null;
  if (!doc) return 'gone';
  /** The version this job read: every write below lands on it or on nothing. */
  const asRead = asFilter(atReadSeq(recordId, readSeqOf(doc)));

  /**
   * This job's write of what it derived, through the one writer of a derived field (`files/derived-fields.ts`).
   *
   * **A FLAG STAMPS NO SEQ, so `atReadSeq` cannot see a delete.** A file deleted while the model was running leaves the
   * version this job read still stored — so the success write below used to put a vector, its model and the text it was
   * made from onto the audit record of a deleted file, and the suppressed and failure paths wrote its text. The writer
   * asks the liveness question per TIER: a file's own row answers for itself, a chunk, caption or face row answers for
   * its PARENT (it carries no flag of its own), and a record of another kind has no flag to ask about — a delete removes
   * it, which `atReadSeq` does see.
   *
   * `gone` is not a failure. The file was deleted, which is the outcome the delete decided; the job reports nothing and
   * ends as though it had nothing to do.
   */
  const parentFileId = typeof doc['parentFileId'] === 'string' ? doc['parentFileId'] : undefined;
  const tier: FileRowTier = recordType !== 'file' ? 'not-a-file' : parentFileId !== undefined ? 'derived' : 'top-level';
  const write = (update: { set?: Record<string, unknown>; unset?: Record<string, unknown> }) =>
    writeDerivedFields({ spaceId, collectionSuffix: COLLECTION[recordType], tier, filter: asRead as Record<string, unknown>, parentFileId, ...update });

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
  // Throws on a record whose own field has the wrong type: the job fails where `list_embed_jobs` shows it, which is how an
  // operator learns of the record (the backfill owes it on every call for that reason).
  const text = await buildEmbedText(spaceId, recordType, doc);

  // `matchedText` is what the lexical channel searches, so it is rewritten on EVERY outcome, not only when a vector is
  // stored (`Q-94`). Left as it was, a suppressed record kept matching the text it held when suppression began — a
  // deleted property went on being found, and shown as the record's matched text.
  // A FILE row asks the file question (its two tiers, then its ancestors); every other kind has no ancestors. A textless
  // row is not asked: its answer does not depend on it, and the file question costs an ancestor read.
  const suppressed = text === null ? false : recordType === 'file'
    ? await fileEmbeddingSuppressed(spaceId, doc)
    : embeddingSuppressedFor(spaceId, recordType, doc);

  // Every successful update enqueues an embed job, unconditionally and for good reasons — the enqueue is also
  // how the `suppressEmbeddings` toggle takes effect, and how a stale inline embed was eliminated. But most
  // updates change something the vector does not depend on: a tag, a property, a link, a status. Those paid for a
  // model call that could only reproduce the vector already stored.
  //
  // **The fingerprint already exists.** Every embed writes `matchedText` — the exact text it embedded — beside the
  // vector. So an identical text, with a vector present and the SAME model configured, means the model call is a
  // no-op by construction (`unchanged`): a vector is a pure function of (text, model), and both are unchanged.
  //
  // This is not a heuristic and it does not trade quality: the record keeps a vector the system itself produced
  // from this text with this model. Any of the three conditions failing re-embeds. The table is `embedOwed`'s, which
  // the backfill's walk asks too.
  const owed = embedOwed({
    text, suppressed, vectorPresent: holdsVector(doc), holdsDerived: holdsDerived(doc),
    matchedText: doc['matchedText'], embeddingModel: doc['embeddingModel'], configuredModel: () => getEmbeddingConfig().model, rebuild: opts.rebuild,
  });
  switch (owed.outcome) {
    case 'unbuildable':
      // `buildEmbedText` throws instead of answering the marker; only the guarded builders give it.
      throw new Error(`embedStoredRecord: the text of ${recordType} '${logSafe(recordId)}' cannot be built`);
    case 'textless': {
      // A derived record with no text is owed nothing, and whatever vector it holds came from a backfill that embedded
      // its path. Decided BEFORE suppression, whose branch writes `matchedText` and would give the record a text it does
      // not have. `faceEmbedding` is a different index of a different model and is not touched.
      if (owed.reason === 'clear-derived') {
        const outcome = await write({ unset: UNSET_DERIVED });
        if (outcome === 'superseded') return 'superseded';
        if (outcome === 'gone') return 'gone';
      }
      return 'textless';
    }
    case 'settled':
    case 'writeLexical': {
      // The text, and the vector UNSET: see the suppression comment above. Written for a settled record too, which changes
      // nothing and keeps the job's answer `excluded`.
      const outcome = await write({ set: { matchedText: text }, unset: UNSET_VECTOR });
      return outcome === 'written' ? 'excluded' : outcome === 'gone' ? 'gone' : 'superseded';
    }
    case 'unchanged':
      return 'unchanged';
    case 'embed':
      break;
  }
  // `embedOwed` answers `embed` only for a record with a text.
  const toEmbed = text as string;

  let result: Awaited<ReturnType<typeof embed>>;
  try {
    result = await embed(toEmbed);
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
    // On the version read only: a newer copy's text is not this job's to write.
    await write({ set: { matchedText: toEmbed }, unset: UNSET_VECTOR });
    throw err;
  }

  // `seq` is deliberately NOT advanced. An embedding is a DERIVED field — `merkle.ts` excludes it from
  // replication precisely because each peer computes its own — so bumping `seq` here would broadcast a
  // no-op change to every peer in every network the space belongs to, on every embedding, forever.
  const outcome = await write({ set: { embedding: result.vector, embeddingModel: result.model, matchedText: toEmbed } });
  return outcome === 'written' ? 'embedded' : outcome === 'gone' ? 'gone' : 'superseded';
}
