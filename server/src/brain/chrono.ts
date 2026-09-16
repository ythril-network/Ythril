import { v4 as uuidv4 } from 'uuid';
import { reconcileLinks, removeLinksFrom } from './links.js';
import { LINK_CLASSES } from './link-adjacency.js';
import { brainWriteSeqTotal } from '../metrics/registry.js';
import { authorRef } from '../config/author.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { tagContains, textContains, propertiesValueContains, PROPERTIES_SCAN_MAX_MS } from './tag-filter.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { toMongoSort, type SortSpec } from './list-sort.js';
import { NEVER_RETURNED_PROJECTION, withoutVector } from './read-projection.js';
import { textSearchOr, SEARCHABLE_FIELDS } from './text-search.js';
import { embed } from './embedding.js';
import { chronoEmbedText } from './embed-text.js';
import { SimilarMatch, checkDuplicates } from './recall.js';
import type { DupeCheckOpts } from './write-options.js';
import { findInsertContradictions, type ContradictionWarning } from './insert-contradictions.js';
import { deriveChronoStatus } from './chrono-status.js';
import { datePassedPolicy, typesWhereDatePassedMeansNothing } from './chrono-date-policy.js';
import { getConfig } from '../config/loader.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from './ttl.js';
import { stampSkewOnCreate } from './stamp-skew.js';
import { getSpaceMeta, applyPropertyDefaults } from '../spaces/schema-validation.js';
import { classifyChronoUpsertAgainst, SchemaViolationError, type UpdateValidation } from './write-validation.js';
import { mergeTags, mergeProperties, mergePropertiesOrKeep } from './merge-fields.js';
import { applyDeleteFields } from './delete-fields.js';
import { enqueueEmbedJob, retireEmbedJob } from './embed-queue.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { ChronoEntry, ChronoType, ChronoStatus, TombstoneDoc } from '../config/types.js';
import { writeFilterFor, writeOutcome } from './write-precondition.js';
import { wipeSpaceCollection } from './bulk-wipe.js';

// Re-exported so existing importers (and the C5 tests) keep reaching it here; it lives in its own leaf
// module only to keep chrono.ts ↔ recall.ts from importing each other. See chrono-status.ts.
export { deriveChronoStatus } from './chrono-status.js';


/**
 * The recurrence frequencies a chrono entry may repeat on. EXPORTED so a test can exercise all of them
 * rather than naming four -- a fifth would otherwise be accepted by this validator and tried by nothing.
 */
export const RECURRENCE_FREQ = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/**
 * Every optional field a `deleteFields` path may clear on a chrono entry.
 *
 * A field that is settable and missing here is accepted at the door and then does nothing — the silent
 * no-op this whole mechanism exists to remove, reintroduced one field at a time. The REQUIRED fields
 * (`title`, `startsAt`, `status`) are refused by `validateDeleteFields` instead, so between the two lists
 * every path a caller can send is either performed or reported.
 *
 * **The link arrays are DERIVED**, because they are not a fixed set: a chrono entry points at whatever
 * `LINK_CLASSES` says it does, and `memoryIds` arrived after this mechanism shipped. The rest are this
 * record's own optional fields and have no list to derive from.
 */
const DELETABLE_CHRONO_FIELDS: readonly string[] = [
  'description', 'tags', 'properties', 'recurrence', 'endsAt', 'confidence', 'suppressEmbeddings',
  ...LINK_CLASSES.filter(c => c.kind === 'chrono').map(c => c.field),
];

/**
 * Validate and normalise a `recurrence` block.
 *
 * Shared by REST and MCP. REST previously destructured `recurrence` straight out of the
 * request body and handed it to createChrono with NO shape check — unlike every sibling
 * field — so an arbitrary object could be persisted and later fed to date logic. MCP did
 * not expose it at all, so recurring entries were unreachable for agents.
 *
 * Returns `{ ok: true, value }` (value `undefined` when absent), or `{ ok: false, error }`.
 */
export function parseRecurrence(
  raw: unknown,
): { ok: true; value: ChronoEntry['recurrence'] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'recurrence must be an object' };
  }
  const r = raw as Record<string, unknown>;

  const freq = r['freq'];
  if (typeof freq !== 'string' || !(RECURRENCE_FREQ as readonly string[]).includes(freq)) {
    return { ok: false, error: `recurrence.freq must be one of: ${RECURRENCE_FREQ.join(', ')}` };
  }

  // `interval` is required by the type. Default it rather than persisting a half-formed
  // block that would later read as NaN.
  let interval = 1;
  if (r['interval'] !== undefined) {
    if (typeof r['interval'] !== 'number' || !Number.isInteger(r['interval']) || r['interval'] < 1) {
      return { ok: false, error: 'recurrence.interval must be a positive integer' };
    }
    interval = r['interval'];
  }

  let until: string | undefined;
  if (r['until'] !== undefined) {
    if (typeof r['until'] !== 'string' || Number.isNaN(Date.parse(r['until']))) {
      return { ok: false, error: 'recurrence.until must be an ISO 8601 date string' };
    }
    until = r['until'];
  }

  return {
    ok: true,
    value: { freq: freq as 'daily' | 'weekly' | 'monthly' | 'yearly', interval, ...(until ? { until } : {}) },
  };
}

/**
 * Store a new chrono entry.
 *
 * `opts` is last rather than alongside `actor`/`ttlDays` (where `saveFact` and `upsertEntity` put it) purely
 * so the three existing positional call sites are untouched; it is the same `DupeCheckOpts` and behaves
 * identically.
 */
export async function createChrono(
  spaceId: string,
  fields: {
    title: string;
    type: ChronoType;
    startsAt: string;
    description?: string;
    endsAt?: string;
    status?: ChronoStatus;
    confidence?: number;
    tags?: string[];
    entityIds?: string[];
    memoryIds?: string[];
    properties?: Record<string, string | number | boolean>;
    recurrence?: ChronoEntry['recurrence'];
    /**
     * A caller-supplied UUID v4, which makes this write idempotent — see `saveFact()` for the full reasoning.
     *
     * A retried create that names an existing entry CONVERGES on the same content instead of producing a
     * second calendar entry. Chrono is the type where the same thing most often gets logged twice even
     * without a retry, which is why the opt-in duplicate check below exists; this closes the mechanical case.
     */
    id?: string;
  },
  actor?: WebhookActor,
  ttlDays?: number | null,
  /** `onValidation` rides in `opts` rather than becoming another positional. See `upsertEdge`'s. */
  opts?: DupeCheckOpts & { onValidation?: (check: UpdateValidation) => void },
): Promise<ChronoEntry & { similar?: SimilarMatch[]; contradicts?: ContradictionWarning[] }> {
  // When an id is supplied, look for the entry it names first — the same shape as `upsertEntity` and
  // `saveFact`.
  const existing: ChronoEntry | null = fields.id
    ? (await col<ChronoEntry>(`${spaceId}_chrono`).findOne(
      asFilter<ChronoEntry>({ _id: fields.id, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as ChronoEntry | null)
    : null;

  /*
   * THE SCHEMA IS ENFORCED HERE, so that no caller can reach the collection around it.
   *
   * Owner's ruling, 2026-08-29. The classifier already existed (#1067) and was called by the doors alone —
   * three copies for create and two for update, each reachable only if remembered.
   */
  const meta = getSpaceMeta(spaceId);
  const withDefaults = existing
    ? fields.properties
    : applyPropertyDefaults(meta?.typeSchemas?.chrono?.[fields.type], fields.properties);
  {
    const check = classifyChronoUpsertAgainst(meta, existing, { type: fields.type, properties: withDefaults });
    if (check.blocked) throw new SchemaViolationError(check);
    opts?.onValidation?.(check);
  }
  fields = { ...fields, properties: withDefaults };

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const status = fields.status ?? 'upcoming';
  const tags = fields.tags ?? [];

  // Embed kind + status + title + description + tags + properties (best-effort)
  // Queued by default — see the note in `upsertEntity`. `matchedText` is stored either way.
  const embedText = chronoEmbedText(fields.title, fields.type, status, fields.description, tags, fields.properties);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText?: string } = { matchedText: embedText };
  // Suppression wins over `waitForEmbedding` — see `embeddingSuppressedFor`. `matchedText` is stored either
  // way, which is the point: a suppressed record stays findable lexically and stops competing on meaning.
  //
  // Hoisted, because the enqueue below consults the same answer. The RECORD tier is stated here, which it was
  // not until 2026-09-02 — see `DupeCheckOpts`.
  const suppressed = embeddingSuppressedFor(spaceId, 'chrono',
    { type: fields.type, suppressEmbeddings: opts?.suppressEmbeddings });
  if (opts?.waitForEmbedding === true && !suppressed) {
    const embResult = await embed(embedText);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model, matchedText: embedText };
  }

  // Opt-in insert-time duplicate / contradiction checks, using the freshly computed vector BEFORE insert so
  // it can never self-match. ONE neighbour search serves both flags. A calendar is where the same thing most
  // often gets logged twice, and where two entries most often disagree about what became of it — the
  // structured judge compares the stored `status`, not the dates (see structured-claims.ts for why).
  let similar: SimilarMatch[] | undefined;
  let contradicts: ContradictionWarning[] | undefined;
  if ((opts?.checkDuplicates || opts?.checkContradictions) && embeddingFields.embedding) {
    const hits = await checkDuplicates(spaceId, 'chrono', embeddingFields.embedding, opts.dupeThreshold, opts.dupeTopK);
    if (opts.checkDuplicates && hits.length > 0) similar = hits;
    if (opts.checkContradictions && hits.length > 0) {
      const found = await findInsertContradictions(spaceId, 'chrono', { properties: fields.properties, status }, hits);
      if (found.length > 0) contradicts = found;
    }
  }

  // ── The idempotent branch: a supplied id that already names an entry converges rather than duplicating.
  if (existing) {
    const mergedTags = mergeTags(existing.tags, tags);
    const mergedProps = mergeProperties(existing.properties, fields.properties);
    const $set: Record<string, unknown> = {
      title: fields.title,
      type: fields.type,
      startsAt: fields.startsAt,
      status,
      tags: mergedTags,
      updatedAt: now,
      seq,
      ...embeddingFields,
    };
    if (fields.endsAt !== undefined) $set['endsAt'] = fields.endsAt;
    if (fields.description !== undefined) $set['description'] = fields.description;
    if (fields.confidence !== undefined) $set['confidence'] = fields.confidence;
    if (fields.entityIds !== undefined) $set['entityIds'] = fields.entityIds;
    if (fields.memoryIds !== undefined) $set['memoryIds'] = fields.memoryIds;
    if (fields.properties !== undefined) $set['properties'] = mergedProps;
    if (fields.recurrence !== undefined) $set['recurrence'] = fields.recurrence;
    const $unset: Record<string, unknown> = {};
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'chrono', existing: existing as unknown as Record<string, unknown> });
    const updateOp: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
    await col<ChronoEntry>(`${spaceId}_chrono`).updateOne(
      asFilter<ChronoEntry>({ _id: existing._id }), asUpdate<ChronoEntry>(updateOp),
    );
    const converged = { ...existing, ...($set as Partial<ChronoEntry>) } as ChronoEntry;
    if ('_expireAt' in $unset) delete (converged as { _expireAt?: unknown })._expireAt;
    // Both classes, from the CONVERGED document rather than the parameters: this branch merges, so what
    // the entry now says is the only correct input to a reconcile.
    await reconcileLinks(spaceId, converged._id, 'chrono',
      { entity: converged.entityIds ?? [], fact: converged.memoryIds ?? [] }, converged.author);
    // `chrono.updated`, not `created` — a subscriber must be able to tell a converged retry from a new entry.
    if (actor) emitWebhookEvent({ event: 'chrono.updated', spaceId, entry: { ...converged, embedding: undefined }, ...actor });
    return withoutVector((similar || contradicts)
      ? { ...converged, ...(similar ? { similar } : {}), ...(contradicts ? { contradicts } : {}) }
      : converged);
  }

  const doc: ChronoEntry = {
    // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always. A supplied id may
    // ADDRESS an existing record — the update path above — but it never becomes a new record's identity.
    // It used to: a supplied id that named nothing was adopted, which made the caller a co-author of our
    // primary key and, across a sync, let two instances deriving ids from the same key collide by design.
    // A caller wanting to carry their own reference puts it in `name` or `description`, which are for that.
    _id: uuidv4(),
    spaceId,
    title: fields.title,
    type: fields.type,
    startsAt: fields.startsAt,
    status,
    tags,
    entityIds: fields.entityIds ?? [],
    memoryIds: fields.memoryIds ?? [],
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    ...embeddingFields,
  };
  // Stored, not merely consulted — see the note in `saveFact`.
  if (opts?.suppressEmbeddings !== undefined) doc.suppressEmbeddings = opts.suppressEmbeddings;
  if (fields.description !== undefined) doc.description = fields.description;
  if (fields.endsAt !== undefined) doc.endsAt = fields.endsAt;
  if (fields.confidence !== undefined) doc.confidence = fields.confidence;
  if (fields.properties !== undefined) doc.properties = fields.properties;
  if (fields.recurrence !== undefined) doc.recurrence = fields.recurrence;

  // The collection+type is passed so the SCHEMA tier applies (record > schema > space): a telemetry space
  // prunes deploy `event`s while keeping `health-snapshot`/`metrics-snapshot` for trending, which one
  // space-wide TTL cannot express.
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'chrono', type: doc.type });
  // Warn-not-refuse: a caller's own stamp checked against ours. Stored only when it disagrees beyond the space's
  // threshold, so presence is the signal. The write proceeds either way -- a backdated import is legitimate.
  stampSkewOnCreate(doc, getSpaceMeta(spaceId));
  await col<ChronoEntry>(`${spaceId}_chrono`).insertOne(asDoc<ChronoEntry>(doc));
  if (!embeddingFields.embedding && !suppressed) await enqueueEmbedJob(spaceId, 'chrono', doc._id);
  // A chrono entry is the only record kind that holds TWO classes, and they are told apart by the to-kind
  // rather than by a field name — which is why one reconcile call takes both.
  await reconcileLinks(spaceId, doc._id, 'chrono',
    { entity: doc.entityIds ?? [], fact: doc.memoryIds ?? [] }, doc.author);
  if (actor) emitWebhookEvent({ event: 'chrono.created', spaceId, entry: { ...doc, embedding: undefined }, ...actor });
  // Advisory only — the entry is stored either way.
  return withoutVector((similar || contradicts) ? { ...doc, ...(similar ? { similar } : {}), ...(contradicts ? { contradicts } : {}) } : doc);
}

export async function updateChrono(
  spaceId: string,
  id: string,
  updates: Partial<Pick<ChronoEntry, 'title' | 'description' | 'type' | 'startsAt' | 'endsAt' | 'status' | 'confidence' | 'tags' | 'entityIds' | 'memoryIds' | 'properties' | 'recurrence' | 'suppressEmbeddings'>>,
  deleteFieldsPaths?: string[],
  actor?: WebhookActor,
  ttlDays?: number | null,
  ifMatchSeq?: number,
  /** See `createChrono`'s: the classification, so a door never re-derives it for presentation. */
  onValidation?: (check: UpdateValidation) => void,
): Promise<ChronoEntry | null> {
  const existing = await col<ChronoEntry>(`${spaceId}_chrono`)
    .findOne(asFilter<ChronoEntry>({ _id: id, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as ChronoEntry | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };
  const $unset: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) $set[k] = v;
  }
  // `properties` MERGES, like every other write path: `createChrono`'s converge branch above, the entity
  // and edge updates, and the retry-safety guarantee the integration guide states for all four record
  // types. The generic loop overhead has been REPLACING it — patch one key, lose the rest, no error.
  // Removing a key is `deleteFields`' job on the surfaces that offer it, never an absence here.
  const mergedUpdateProps = mergePropertiesOrKeep(existing.properties, updates.properties);
  if (updates.properties !== undefined) $set['properties'] = mergedUpdateProps;

  /**
   * `deleteFields`, applied AFTER the merge — the same shape and the same order as `updateFact`.
   *
   * Chrono was the one record type without it (X-4). Combined with merging `properties`, that meant a key
   * written once could never be removed: an absence never means "delete" here, deliberately, and there was
   * no path that unset. So the entry is not "chrono should have a parameter the others have" — it is that
   * chrono had no expression for removal at all.
   *
   * The merged view is built from `updates ?? existing` so a path can address a field this call is also
   * setting, and the result is reflected back into `$set`/`$unset`: a whole field that disappeared becomes
   * an `$unset`, and a field that merely lost a sub-key is re-`$set` to its pruned value.
   */
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    const merged: Record<string, unknown> = {
      title: updates.title ?? existing.title,
      description: updates.description !== undefined ? updates.description : existing.description,
      tags: updates.tags ?? existing.tags,
      entityIds: updates.entityIds ?? existing.entityIds,
      memoryIds: updates.memoryIds ?? existing.memoryIds,
      properties: mergedUpdateProps ?? {},
      recurrence: updates.recurrence !== undefined ? updates.recurrence : existing.recurrence,
      endsAt: updates.endsAt !== undefined ? updates.endsAt : existing.endsAt,
      confidence: updates.confidence !== undefined ? updates.confidence : existing.confidence,
      // The STORED value, not the resolved tier: `false` is a real stored value here and
      // `recordSuppression` deliberately reports it as "not stated", which would turn a delete into a
      // no-op. One spelling since `D-6`.
      suppressEmbeddings: updates.suppressEmbeddings !== undefined
        ? updates.suppressEmbeddings
        : existing.suppressEmbeddings,
    };
    applyDeleteFields(merged, deleteFieldsPaths);

    // EVERY optional field, not a convenient subset. A field the writer forgets is accepted at the edge and
    // then does nothing, which is the silent no-op this feature exists to remove — chrono's whole problem was
    // that a property could not be removed and nothing said so. The REQUIRED fields (`title`, `startsAt`,
    // `status`) are refused by `validateDeleteFields` instead, so between the two lists every path a caller
    // can send is either performed or reported.
    for (const field of DELETABLE_CHRONO_FIELDS) {
      if (!(field in merged)) {
        $unset[field] = '';
        delete $set[field];
      } else if (deleteFieldsPaths.some(p => p === field || p.startsWith(field + '.'))) {
        $set[field] = merged[field];
      }
    }
  }

  // There is no longer a "did an embedding-relevant field change?" branch here. It existed to decide whether
  // to pay for an inline embed; the re-embed is now ENQUEUED unconditionally after the write, and
  // `embedStoredRecord` reads the record as STORED. Deciding here would mean deciding from this function's
  // stale read — the exact reasoning that made the old inline embedding wrong.

  /*
   * Validated after `deleteFields` has been folded in, so the document checked is the document written — the
   * same ordering `updateEntityById` and `updateFact` need, and for the same reason: a patch that REMOVES a
   * required property has only broken the record once the deletion is applied.
   */
  {
    const finalType = ('type' in $set ? $set['type'] : existing.type) as ChronoEntry['type'];
    const finalProps = ('properties' in $unset ? {}
      : ('properties' in $set ? $set['properties'] : existing.properties)) as Record<string, string | number | boolean> | undefined;
    const check = classifyChronoUpsertAgainst(getSpaceMeta(spaceId), existing,
      { type: finalType, properties: finalProps });
    if (check.blocked) throw new SchemaViolationError(check);
    onValidation?.(check);
  }

  applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
    { collection: 'chrono', existing: existing as unknown as Record<string, unknown> }); // F10
  const updateOp: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
  // Lost-update detection, identical to `updateFact` and for the same reason: `returnDocument: "before"`
  // hands back the record as it was at WRITE time, so comparing its seq with the one read at the top of this
  // function is exactly the test for another writer landing in the window. Observation only — no write that
  // previously succeeded is now rejected.
  const beforeWrite = await col<ChronoEntry>(`${spaceId}_chrono`).findOneAndUpdate(
    asFilter<ChronoEntry>(writeFilterFor(id, ifMatchSeq)),
    asUpdate<ChronoEntry>(updateOp),
    { returnDocument: 'before' },
  ) as ChronoEntry | null;
  brainWriteSeqTotal.labels({
    collection: 'chrono',
    outcome: writeOutcome(!!beforeWrite, ifMatchSeq !== undefined, !!beforeWrite && beforeWrite.seq !== existing.seq),
  }).inc();
  // Nothing matched, so nothing was written; the response below is built from `existing`.
  if (!beforeWrite) return null;
  const updatedChrono = { ...existing, ...($set as Partial<ChronoEntry>) } as ChronoEntry;
  if ('_expireAt' in $unset) delete (updatedChrono as { _expireAt?: unknown })._expireAt;
  // Toggling exclusion always ends in an embed job, and the job handles BOTH directions — it unsets
  // the vector when the flag is on and computes one when it is off. So this path never has to know
  // which way the toggle went, which is what keeps the rule in one place.
  // ONE enqueue, unconditionally, for every successful update: recompute the text from the record as
  // STORED, and honour `suppressEmbeddings` in whichever direction it moved. See the entity update and
  // `embedStoredRecord` for why this replaced an inline embed built from a stale read.
  await enqueueEmbedJob(spaceId, 'chrono', updatedChrono._id);
  /*
   * The writer whose `$set` key is COMPUTED — `$set[k] = v` over `Object.entries(updates)` — so no grep for
   * the field name finds this path at all. Reconciled from the STORED document for that reason: reading the
   * updates object would mean re-deriving which class the loop happened to touch, and getting that wrong is
   * invisible.
   *
   * Both classes are passed only when the caller named one of them. Omitting `memoryIds` on a patch means
   * "leave the fact links", not "remove them".
   */
  if (updates.entityIds !== undefined || updates.memoryIds !== undefined
      || deleteFieldsPaths?.some(p => p.startsWith('entityIds') || p.startsWith('memoryIds'))) {
    await reconcileLinks(spaceId, updatedChrono._id, 'chrono',
      { entity: updatedChrono.entityIds ?? [], fact: updatedChrono.memoryIds ?? [] }, updatedChrono.author);
  }
  if (actor) emitWebhookEvent({ event: 'chrono.updated', spaceId, entry: { ...updatedChrono, embedding: undefined }, ...actor });
  return withoutVector(updatedChrono);
}

/**
 * Return the entry with its derived status applied (a shallow copy only when the status changes).
 *
 * `F-26`: what a passed due moment MEANS is the type's decision now, so the policy is resolved per entry —
 * from the one resolver, never re-derived here. `getSpaceMeta` is the existing answer to "what is this
 * space's meta", refs resolved, so a `$ref`-ed library schema states this like any other field.
 */
function withDerivedStatus(entry: ChronoEntry, now: Date = new Date()): ChronoEntry {
  const status = deriveChronoStatus(entry, now, datePassedPolicy(getSpaceMeta(entry.spaceId), entry.type));
  return status === entry.status ? entry : { ...entry, status };
}

export async function getChronoById(spaceId: string, id: string): Promise<ChronoEntry | null> {
  const entry = await col<ChronoEntry>(`${spaceId}_chrono`)
    .findOne(asFilter<ChronoEntry>({ _id: id, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as ChronoEntry | null;
  return entry ? withDerivedStatus(entry) : null;
}

export interface ChronoFilter {
  status?: string;
  type?: string;
  /** ALL of these tags must be present (AND semantics). */
  tags?: string[];
  /** ANY of these tags must be present (OR semantics). */
  tagsAny?: string[];
  /**
   * Single-tag SUBSTRING search, case-insensitive — what the UI's `?tag=` box sends.
   *
   * Deliberately separate from `tags`/`tagsAny`, which keep their documented exact AND/OR semantics:
   * integrations use those to select an exact set, and widening them would silently over-match.
   */
  tagLike?: string;
  /** Per-column description filter: case-insensitive substring on `description` alone. */
  descriptionLike?: string;
  /** Per-column properties filter: substring over any VALUE in the bag. Scans; see the helper. */
  propertiesLike?: string;
  /** ISO 8601 — return entries with createdAt > after */
  after?: string;
  /** ISO 8601 — return entries with createdAt < before */
  before?: string;
  /** Case-insensitive substring match on title and description. */
  search?: string;
}

/**
 * The Mongo filter behind `listChrono`, and whether it compares a stored date against the clock.
 *
 * Exported and pure so it can be asserted without a database. That matters here specifically: what this
 * builder gets wrong is never an exception, it is a clause that silently stops applying — and a suite that
 * needs Docker to see that is a suite nobody runs before pushing.
 */
export function buildChronoQuery(
  spaceId: string,
  filter: ChronoFilter,
  now: Date,
  /**
   * The chrono types whose passed dates mean NOTHING (`F-26`), or `null` when the SPACE tier says nothing
   * and the set is therefore not enumerable.
   *
   * PASSED IN, and that is the whole reason this parameter exists rather than a `getSpaceMeta` call in the
   * body. This function is exported and PURE so it can be asserted without a database — the docblock above
   * says so, and `chrono-list-filter-composes.test.js` is built on it. Reading config here made every case
   * in that suite throw `Config not loaded`, which is the gate doing exactly what its own note promises:
   * what this builder gets wrong is never an exception at runtime, it is a clause that silently stops
   * applying, so a suite that needs Docker to see it is a suite nobody runs before pushing.
   *
   * Defaulted to "no type is exempt", which is the behaviour every caller had before this existed.
   */
  datePassedExempt: readonly string[] | null = [],
): { query: Record<string, unknown>; comparesAgainstTheClock: boolean } {
  const query: Record<string, unknown> = { spaceId };
  // Whether the status filter compares a stored date against the clock, which is a per-document evaluation
  // rather than an index lookup and therefore wants the shorter scan budget. Tracked as a DECISION rather
  // than re-derived from `query['$expr']` at the cursor: `overdue` moved its comparison inside an `$or`, so
  // the top-level key vanished while the scan did not, and the budget would have silently gone back to 60 s.
  let comparesAgainstTheClock = false;
  /**
   * Compound clauses ACCUMULATE here instead of being assigned to `query.$or` / `query.$and` directly.
   *
   * Three separate filters wanted one of those two keys and each wrote it with `=`: the tag pair took `$and`,
   * the substring search took `$or`, and the `overdue` fix below needs an `$or` of its own. Two of those in
   * one call and the later assignment ERASES the earlier constraint — silently, and in the widening
   * direction, which is the failure this repo produces most. Accumulating cannot express that mistake.
   */
  const and: Record<string, unknown>[] = [];

  // Status filter is `overdue`-aware (C5): `overdue` is normally DERIVED from the due moment, not stored.
  if (filter.status !== undefined) {
    // The due moment: endsAt, or startsAt when there is no end. `$toDate` so mixed-offset ISO strings
    // compare chronologically, not lexically.
    const refDate = { $toDate: { $ifNull: ['$endsAt', '$startsAt'] } };
    /*
     * `F-26`: the types whose passed dates mean NOTHING must be excluded from every clock comparison here,
     * or this door disagrees with every other one about the same record.
     *
     * `null` means the SPACE tier says nothing, so no type derives at all and the set is not enumerable —
     * an empty array would say the opposite while looking identical, which is the absent-versus-empty
     * conflation this codebase has paid for more than once. `derivesForSomeType` is the branch that reads.
     */
    const exempt = datePassedExempt;
    const derivesForSomeType = exempt !== null;
    // A clause restricting the comparison to types that DO derive. Empty when none are exempt, so the
    // shipped query shape is unchanged on every space that has not set this.
    const derivingOnly: Record<string, unknown> = exempt && exempt.length > 0
      ? { type: { $nin: exempt } } : {};
    if (filter.status === 'overdue') {
      // BOTH kinds, and the second half is the fix. `overdue` is a legal value on every write door — the
      // enum accepts it on `save_chrono`, `update_chrono`, `save_bulk`, both REST routes and the Brain
      // UI's own status dropdown — so a caller can store it, and `deriveChronoStatus` passes a stored one
      // straight through. Matching only the derivable ones therefore hid exactly the entries somebody had
      // taken the trouble to mark, from the filter that names them.
      and.push({
        $or: [
          { status: 'overdue' },
          // Only for types that still derive: a `nothing` type reads as its stored status everywhere else,
          // so matching it here would make `overdue` mean one thing in a filter and another in the answer.
          ...(derivesForSomeType
            ? [{ status: { $in: ['upcoming', 'active'] }, $expr: { $lt: [refDate, now] }, ...derivingOnly }]
            : []),
        ],
      });
      comparesAgainstTheClock = derivesForSomeType;
    } else if (filter.status === 'upcoming' || filter.status === 'active') {
      // Exclude entries that are now derived-overdue so they don't surface under their stored status --
      // but ONLY where the type derives. On a `nothing` type the stored status is the answer, so excluding
      // it here would hide exactly the records the filter names.
      query['status'] = filter.status;
      if (exempt === null) {
        // Nothing derives anywhere in this space, so there is no clock comparison to make at all.
      } else if (exempt.length === 0) {
        // The shipped shape, BYTE FOR BYTE, on every space that has not set `whenDuePasses` -- which is the
        // ruling's "an instance that changes nothing sees nothing change", carried down to the query. The
        // accumulator below is only reached when a type is actually exempt.
        query['$expr'] = { $gte: [refDate, now] };
      } else {
        and.push({ $or: [{ type: { $in: exempt } }, { $expr: { $gte: [refDate, now] } }] });
      }
      comparesAgainstTheClock = derivesForSomeType;
    } else {
      query['status'] = filter.status; // completed / cancelled — no derivation
    }
  }
  if (filter.type !== undefined) query['type'] = filter.type;

  // Single-tag substring search (the UI box). Exclusive with the exact tags/tagsAny set below.
  if (filter.tagLike) query['tags'] = tagContains(filter.tagLike);
  if (filter.descriptionLike) query['description'] = textContains(filter.descriptionLike);
  if (filter.propertiesLike) Object.assign(query, propertiesValueContains(filter.propertiesLike));

  // tags ALL (AND): every tag in the array must be present
  if (filter.tags && filter.tags.length > 0) {
    query['tags'] = { $all: filter.tags };
  }

  // tagsAny (OR): at least one tag in the array must be present
  // If both tags and tagsAny are provided, combine with $and
  if (filter.tagsAny && filter.tagsAny.length > 0) {
    if (filter.tags && filter.tags.length > 0) {
      // Already have an $all constraint on tags — both go through the accumulator
      and.push({ tags: { $all: filter.tags } }, { tags: { $in: filter.tagsAny } });
      delete query['tags'];
    } else {
      query['tags'] = { $in: filter.tagsAny };
    }
  }

  // Date range on createdAt
  if (filter.after !== undefined || filter.before !== undefined) {
    const range: Record<string, string> = {};
    if (filter.after !== undefined) range['$gt'] = filter.after;
    if (filter.before !== undefined) range['$lt'] = filter.before;
    query['createdAt'] = range;
  }

  // Full-text substring search on title and/or description. Escaped (2b-iii-a): the raw value used to
  // reach `$regex` un-escaped, so a value like `(a+)+$` was a ReDoS / regex-injection vector.
  const search = textSearchOr(filter.search, SEARCHABLE_FIELDS.chrono);
  if (search) and.push({ $or: search.$or });

  if (and.length > 0) query['$and'] = and;

  return { query, comparesAgainstTheClock };
}

export async function listChrono(
  spaceId: string,
  filter: ChronoFilter = {},
  limit = 50,
  skip = 0,
  sort?: SortSpec,
): Promise<ChronoEntry[]> {
  const now = new Date();
  // `F-26`: resolved HERE, where reading config is already the norm, and handed to the pure builder.
  const { query, comparesAgainstTheClock } = buildChronoQuery(
    spaceId, filter, now, typesWhereDatePassedMeansNothing(getSpaceMeta(spaceId)));

  const entries = await col<ChronoEntry>(`${spaceId}_chrono`)
    .find(asFilter<ChronoEntry>(query), { projection: NEVER_RETURNED_PROJECTION })
    .maxTimeMS(comparesAgainstTheClock ? PROPERTIES_SCAN_MAX_MS : 60_000)
    .sort(sort ? toMongoSort(sort) : { createdAt: -1 })
    .skip(parseSkip(skip))
    .limit(parseLimit(limit, 20, 1000))
    .toArray() as ChronoEntry[];
  // Present the derived status (same `now` as the filter, so the returned status agrees with it).
  return entries.map(e => withDerivedStatus(e, now));
}

export async function deleteChrono(
  spaceId: string,
  chronoId: string,
  actor?: WebhookActor,
): Promise<boolean> {
  const existing = await col<ChronoEntry>(`${spaceId}_chrono`)
    .findOne(asFilter<ChronoEntry>({ _id: chronoId, spaceId }), { projection: { seq: 1 } }) as { seq?: number } | null;
  const seq = await nextSeq(spaceId);
  const result = await col<ChronoEntry>(`${spaceId}_chrono`).deleteOne({
    _id: chronoId,
    spaceId,
  });
  if (result.deletedCount === 0) return false;
  // The record is gone, so its embed job has nothing left to embed. Eager rather than left to the worker: the
  // worker only claims `pending` jobs, so a job that had already gone terminal `failed` would never be claimed
  // again and would outlive the record for ever — visible since #861 as a permanent failure naming a recordId
  // that 404s.
  await retireEmbedJob(spaceId, 'chrono', chronoId);

  const tombstone: TombstoneDoc = {
    _id: chronoId,
    type: 'chrono',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
    ...(existing?.seq !== undefined ? { originalSeq: existing.seq } : {}),
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    asFilter<TombstoneDoc>({ _id: chronoId }),
    asDoc<TombstoneDoc>(tombstone),
    { upsert: true },
  );
  // The cascade — see `removeLinksFrom`. Links pointing AT this entry belong to the readers' slice.
  await removeLinksFrom(spaceId, chronoId, 'chrono');
  if (actor) emitWebhookEvent({ event: 'chrono.deleted', spaceId, entry: { _id: chronoId }, ...actor });
  return true;
}

/** Bulk-delete every chrono entry in a space, writing a tombstone per deleted doc. */
export async function bulkDeleteChrono(spaceId: string): Promise<number> {
  return await wipeSpaceCollection(spaceId, 'chrono', 'chrono');
}
