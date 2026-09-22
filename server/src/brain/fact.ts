/**
 * Fact records — create (`saveFact`), update, delete, list, count, bulk-delete.
 *
 * The recall engine lives in recall.ts, the filter DSL in filter.ts, and the structured query
 * surface in query.ts (A17.4). `saveFact` reaches into recall.ts for the optional insert-time
 * duplicate check; nothing here is imported back by those modules.
 */
import { applyRecordFlags } from './record-flag.js';
import { v4 as uuidv4 } from 'uuid';
import { reconcileLinks, removeLinksFrom, assertDesiredLinks } from './links.js';
import { authorRef } from '../config/author.js';
import { findInsertContradictions, type ContradictionWarning } from './insert-contradictions.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { brainWriteSeqTotal } from '../metrics/registry.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { toMongoSort, type SortSpec } from './list-sort.js';
import { embed } from './embedding.js';
import { factEmbedText } from './embed-text.js';
import { getConfig } from '../config/loader.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from './ttl.js';
import { stampSkewOnCreate } from './stamp-skew.js';
import { getSpaceMeta, applyPropertyDefaults } from '../spaces/schema-validation.js';
import { classifyFactUpsertAgainst, SchemaViolationError, type UpdateValidation } from './write-validation.js';
import { applyDeleteFields } from './delete-fields.js';
import { mergeTags, mergeProperties, mergePropertiesOrKeep } from './merge-fields.js';
import { enqueueEmbedJob, retireEmbedJob } from './embed-queue.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { FactDoc, EntityDoc, TombstoneDoc } from '../config/types.js';
import { SimilarMatch, checkDuplicates } from './recall.js';
import type { DupeCheckOpts } from './write-options.js';
import { PROPERTIES_SCAN_MAX_MS } from './tag-filter.js';
import { writeFilterFor, writeOutcome } from './write-precondition.js';
import { NEVER_RETURNED_PROJECTION, withoutVector } from './read-projection.js';
import { spaceCollection } from '../db/space-collection.js';

/** Store a new fact with semantic embedding */
export async function saveFact(
  spaceId: string,
  fact: string,
  /**
   * The entities this fact links to — a DESIRED LINK SET, never a stored field.
   *
   * It was `entityIds` and it was both: the array was written onto the record AND handed to
   * `reconcileLinks`, so the record and the link rows were two spellings of one fact. 5.0 removes the
   * array, so this is the input and the link records are the storage. The name says which it is, because a
   * parameter still called `entityIds` is one somebody stores again.
   */
  linkEntities: string[] = [],
  tags: string[] = [],
  description?: string,
  properties?: Record<string, string | number | boolean>,
  type?: string,
  /**
   * `onValidation` rides in here rather than becoming a thirteenth positional, because the docblock below
   * already says the twelfth was one too many. It hands the classification back so a door never re-derives it
   * for presentation — the second lookup per write that is how this rule came to be written six times.
   */
  opts?: DupeCheckOpts & { onValidation?: (check: UpdateValidation) => void },
  actor?: WebhookActor,
  ttlDays?: number | null,
  /**
   * A caller-supplied UUID v4, which makes this write **idempotent**.
   *
   * ## Why it exists
   *
   * An MCP agent or an integrator whose request times out will retry — and before this, a retried fact create
   * produced a **second fact**, silently. Entities already had this: a supplied `id` makes `upsertEntity` find
   * by `_id` and update. Edges get it free from their `(from, to, label)` natural key. Facts and chrono had
   * neither, and they are the two highest-volume write types.
   *
   * The owner chose this mechanism over an `Idempotency-Key` header specifically because it reuses a path already
   * shipped and tested on entities: no new storage, no TTL to expire, and an agent that generates one UUID before
   * its first attempt gets idempotency for free.
   *
   * ## What a retry actually does, stated precisely
   *
   * It is **not** a no-op. The record converges on the same content, but `updatedAt` and `seq` move, and tags and
   * properties **merge** rather than replace — matching `upsertEntity` exactly, because one mental model across
   * four record types is worth more than a marginally different rule per type. Converging on the same content is
   * what retry safety means here; claiming "no effect" would be false, and it would also be visible as a `clean`
   * write in `ythril_brain_write_seq_total`.
   *
   * The route validates the shape. An arbitrary string must never reach `_id`: it becomes the sync identity of a
   * record that replicates across networks.
   *
   * NOTE: this is the twelfth positional parameter, which is one too many. The next addition should convert the
   * tail to an options object rather than continue the pattern.
   */
  id?: string,
): Promise<FactDoc & { similar?: SimilarMatch[]; contradicts?: ContradictionWarning[] }> {
  // When an id is supplied, look for the record it names first — the same shape as `upsertEntity`.
  const existing: FactDoc | null = id
    ? (await col<FactDoc>(spaceCollection(spaceId, 'facts')).findOne(asFilter<FactDoc>({ _id: id }),
      { projection: NEVER_RETURNED_PROJECTION }) as FactDoc | null)
    : null;

  /*
   * THE SCHEMA IS ENFORCED HERE, so that no caller can reach the collection around it.
   *
   * Owner's ruling, 2026-08-29: *"all upsert/update/insert things must validate btw."* Fact was the record
   * kind with no classifier at all, so both doors validated the INCOMING payload rather than the record the
   * write would produce — the same defect the chrono classifier was written for, and it fails in both
   * directions: a required property present on the stored record and absent from a converging write reads as
   * a violation the merge would have supplied.
   *
   * Defaults on INSERT only, before validation, for the reason `upsertEdge` states: a property that is
   * `required` and has a `default` must not be a violation, and on an update an absent property may be one
   * the caller has just removed.
   */
  /*
   * THE LINKS ARE REFUSED BEFORE THE RECORD IS WRITTEN.
   *
   * `reconcileLinks` asserts them too, and it runs AFTER the insert — so a bad id there leaves the fact
   * stored without the links it asked for: a `400` and a row the caller did not want, which is the
   * silent unlinked write made noisy rather than fixed.
   */
  await assertDesiredLinks(spaceId, 'fact', { entity: linkEntities });

  const meta = getSpaceMeta(spaceId);
  const withDefaults = existing
    ? properties
    : applyPropertyDefaults(type ? meta?.typeSchemas?.fact?.[type] : undefined, properties);
  const check = classifyFactUpsertAgainst(meta, existing, { type, properties: withDefaults });
  if (check.blocked) throw new SchemaViolationError(check);
  opts?.onValidation?.(check);
  properties = withDefaults;

  // No entity names: a fact embeds its own content. See `factEmbedText` for the measurement.
  const embedText = factEmbedText(fact, tags, description, properties);

  // ── Embed now, or hand it to the queue?
  //
  // An insert-time duplicate/contradiction check needs the vector BEFORE the insert — that is the whole
  // reason it is computed here rather than after, so the new record cannot self-match. So those flags
  // IMPLY waiting. Implied rather than rejected as an invalid combination: a caller asking "is this a
  // duplicate?" is asking a question that cannot be answered later, so refusing it would be a puzzle
  // where an answer was available.
  //
  // Suppression wins over all three. `suppressEmbeddings` IS the absence of a vector — there is no read-time
  // filter — so computing one here and skipping the enqueue below stored exactly what the flag forbids, with
  // nothing to come back and remove it. `checkDuplicates` defaults to `true` on the MCP tool, so this was the
  // ORDINARY write into a suppressed space rather than an edge case.
  //
  // The duplicate and contradiction checks consequently do not run for a suppressed record. That is not a
  // loss: every record of a suppressed type lacks a vector, so a neighbour search had nothing to find them
  // with in the first place — it would have reported "no duplicates" over a space it could not see.
  // The RECORD tier is stated here, which it was not until 2026-09-02: this asked with `{ type }` alone, so
  // a caller's own flag had nowhere to be read from and the type schema answered instead. `undefined` still
  // means "not stated" and falls through, which is what makes passing it unconditionally safe.
  const suppressed = embeddingSuppressedFor(spaceId, 'fact',
    { type, suppressEmbeddings: opts?.suppressEmbeddings });
  const needsVectorNow = !suppressed
    && (opts?.waitForEmbedding === true || opts?.checkDuplicates === true || opts?.checkContradictions === true);

  let embResult: { vector: number[]; model: string } | null = null;
  if (needsVectorNow) {
    // Unguarded on purpose: the caller asked for a record that is searchable when this returns. A
    // silent fallback to "stored, not searchable" would answer a different question than the one asked.
    embResult = await embed(embedText);
  }

  // Opt-in insert-time duplicate / contradiction checks, using the freshly computed vector BEFORE insert
  // so it can never self-match. ONE neighbour search serves both flags — the second question is free once
  // the first has paid for the vector search.
  let similar: SimilarMatch[] | undefined;
  let contradicts: ContradictionWarning[] | undefined;
  if (embResult && (opts?.checkDuplicates || opts?.checkContradictions)) {
    const hits = await checkDuplicates(spaceId, 'fact', embResult.vector, opts.dupeThreshold, opts.dupeTopK);
    if (opts.checkDuplicates && hits.length > 0) similar = hits;
    if (opts.checkContradictions && hits.length > 0) {
      const found = await findInsertContradictions(spaceId, 'fact', { properties }, hits);
      if (found.length > 0) contradicts = found;
    }
  }

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  // ── The idempotent branch: a supplied id that already names a record CONVERGES rather than duplicating.
  //
  // Merge semantics match `upsertEntity` deliberately — tags union, properties shallow-merge — so a caller has one
  // rule to learn across all four record types. A retry sends the identical payload, so merge and replace are
  // indistinguishable for the case this exists for; the difference only shows when the id is reused with different
  // content, which is a deliberate update and behaves like the entity path does.
  if (existing) {
    const mergedTags = mergeTags(existing.tags, tags);
    const mergedProps = mergeProperties(existing.properties, properties);
    const $set: Record<string, unknown> = {
      fact,
      tags: mergedTags,
      matchedText: embedText,
      updatedAt: now,
      seq,
    };
    // Only when a vector was actually computed. When it was not, the PREVIOUS vector stays: it
    // describes the record as it was a moment ago, which is a better answer than none while the
    // queued job catches up. `matchedText` above is always current, so the two can be compared.
    if (embResult) {
      $set['embedding'] = embResult.vector;
      $set['embeddingModel'] = embResult.model;
    }
    if (type !== undefined) $set['type'] = type;
    if (description !== undefined) $set['description'] = description;
    if (properties !== undefined) $set['properties'] = mergedProps;
    const $unset: Record<string, unknown> = {};
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'fact', existing: existing as unknown as Record<string, unknown> });
    const updateOp: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
    await col<FactDoc>(spaceCollection(spaceId, 'facts')).updateOne(
      asFilter<FactDoc>({ _id: existing._id }), asUpdate<FactDoc>(updateOp),
    );
    const converged = { ...existing, ...($set as Partial<FactDoc>) } as FactDoc;
    if ('_expireAt' in $unset) delete (converged as { _expireAt?: unknown })._expireAt;
    // After the write, never before: a job for a record that failed to store would be a job for
    // nothing. Enqueued even when the vector is already current — the content just changed, so the
    // stored vector is now stale, and the queue is what makes it catch up.
    // Not queued when suppressed: skipping the inline embed and queueing anyway stores the vector the flag
    // forbids a few seconds later, with nothing to come back and remove it.
    if (!embResult && !suppressed) await enqueueEmbedJob(spaceId, 'fact', converged._id);
    /*
     * The link records, after the write and before the event.
     *
     * This branch writes the link set UNCONDITIONALLY, from a parameter that defaults to `[]` — so a
     * retried `saveFact` carrying the id and no entities WIPES the stored links. Whether that is right is not this
     * change's question; what matters is that the link records follow it either way, because a link left
     * behind describes a connection the fact itself no longer claims. `createChrono`'s equivalent branch
     * is guarded and does not clear, and that asymmetry is recorded on the `M-2` row rather than smoothed
     * over here.
     */
    await reconcileLinks(spaceId, converged._id, 'fact', { entity: linkEntities }, converged.author);
    // `fact.updated`, not `created` — a subscriber must be able to tell a converged retry from a new record.
    if (actor) emitWebhookEvent({ event: 'fact.updated', spaceId, entry: { ...converged, embedding: undefined }, ...actor });
    return withoutVector((similar || contradicts)
      ? { ...converged, ...(similar ? { similar } : {}), ...(contradicts ? { contradicts } : {}) }
      : converged);
  }

  const doc: FactDoc = {
    // A supplied id that named nothing becomes the record's identity, so the caller's retry finds it next time.
    // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always. A supplied id may
    // ADDRESS an existing record — the update path above — but it never becomes a new record's identity.
    // It used to: a supplied id that named nothing was adopted, which made the caller a co-author of our
    // primary key and, across a sync, let two instances deriving ids from the same key collide by design.
    // A caller wanting to carry their own reference puts it in `name` or `description`, which are for that.
    _id: uuidv4(),
    spaceId,
    fact,
    tags,
    matchedText: embedText,
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    ...(embResult ? { embedding: embResult.vector, embeddingModel: embResult.model } : {}),
  };
  /*
   * The flag is STORED, not merely consulted.
   *
   * Everything that revisits a record later resolves the tiers from the DOCUMENT — the embed queue, a reindex,
   * a retry. A create that skipped the embedding without recording WHY would be re-embedded by the first of
   * those to come past, and the caller would never learn that their flag lasted one write.
   *
   * `false` is stored too, and means the same as it does anywhere else: this record does not suppress, which
   * still does not override a type or a space that does. Only `undefined` — not stated — is left off.
   */
  applyRecordFlags(doc, opts);
  if (type !== undefined) doc.type = type;
  if (description !== undefined) doc.description = description;
  if (properties !== undefined) doc.properties = properties;
  // See entities.ts: without `typed` the schema tier is unreachable and the space default applies instead.
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'fact', type: doc.type });
  // Warn-not-refuse: a caller's own stamp checked against ours. Stored only when it disagrees beyond the space's
  // threshold, so presence is the signal. The write proceeds either way -- a backdated import is legitimate.
  stampSkewOnCreate(doc, getSpaceMeta(spaceId));
  await col<FactDoc>(spaceCollection(spaceId, 'facts')).insertOne(asDoc<FactDoc>(doc));
  if (!embResult && !suppressed) await enqueueEmbedJob(spaceId, 'fact', doc._id);
  // The link records for a new fact. One call whether the array is empty or not: `reconcileLinks` is a
  // reconcile, so "nothing to do" is a cheap answer rather than a decision this site has to make.
  await reconcileLinks(spaceId, doc._id, 'fact', { entity: linkEntities }, doc.author);
  // Real-time duplicate-rule evaluation (opt-in per space). Fire-and-forget; the
  // dynamic import avoids a static cycle with dupe-scanner.js.
  if (getConfig().spaces.find(s => s.id === spaceId)?.dupeRulesOnInsert) {
    import('./dupe-scanner.js').then(m => m.evaluateRecordForDuplicates(spaceId, 'fact', doc._id)).catch(() => { /* best-effort */ });
  }
  if (actor) emitWebhookEvent({ event: 'fact.created', spaceId, entry: { ...doc, embedding: undefined }, ...actor });
  // Advisory only — the record is stored either way.
  return withoutVector((similar || contradicts) ? { ...doc, ...(similar ? { similar } : {}), ...(contradicts ? { contradicts } : {}) } : doc);
}

/** Update an existing fact's text, tags, links, description, or properties. Re-embeds when content fields change. */
export async function updateFact(
  spaceId: string,
  memoryId: string,
  updates: { fact?: string; tags?: string[]; linkEntities?: string[]; description?: string; properties?: Record<string, string | number | boolean>; type?: string; suppressEmbeddings?: boolean; superseded?: boolean },
  deleteFieldsPaths?: string[],
  actor?: WebhookActor,
  ttlDays?: number | null,
  ifMatchSeq?: number,
  /** See `saveFact`'s: the classification, so a door never re-derives it for presentation. */
  onValidation?: (check: UpdateValidation) => void,
): Promise<FactDoc | null> {
  const existing = await col<FactDoc>(spaceCollection(spaceId, 'facts'))
    .findOne(asFilter<FactDoc>({ _id: memoryId, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as FactDoc | null;
  if (!existing) return null;

  // Refused BEFORE the update lands, or a bad link id leaves every other field already changed.
  if (updates.linkEntities !== undefined) {
    await assertDesiredLinks(spaceId, 'fact', { entity: updates.linkEntities });
  }

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };
  const $unset: Record<string, unknown> = {};

  // `properties` MERGES into the stored map. It used to replace it, which contradicted this tool's own
  // schema ("Key-value properties to merge"), the `deleteFields` contract ("applied AFTER the normal
  // merge"), the entity and edge update paths, and `saveFact`'s own converge branch above. An agent
  // patching one key silently destroyed every other property on the record, with no error anywhere.
  // Removing a key is `deleteFields`' job — an absence never means "delete".
  //
  // `tags` deliberately still REPLACE here, and that is not an oversight: `update_fact` documents them
  // as "New tags (replaces existing)" while `update_entity`/`update_edge` document a union. Both halves
  // are stated, so both are kept and pinned by a test rather than silently unified.
  const mergedUpdateProps = mergePropertiesOrKeep(existing.properties, updates.properties);
  if (updates.fact !== undefined) $set['fact'] = updates.fact;
  if (updates.tags !== undefined) $set['tags'] = updates.tags;
  if (updates.description !== undefined) $set['description'] = updates.description;
  if (updates.properties !== undefined) $set['properties'] = mergedUpdateProps;
  if (updates.type !== undefined) $set['type'] = updates.type;
  // Toggling exclusion always ends in an embed job, and the job handles BOTH directions — it unsets the
  // vector when the flag is on and computes one when it is off. So this path never needs to know which
  // way the toggle went.
  if (updates.suppressEmbeddings !== undefined) $set['suppressEmbeddings'] = updates.suppressEmbeddings;
  if (updates.superseded !== undefined) $set['superseded'] = updates.superseded;

  // Apply deleteFields after merge
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    // Build a merged view for deleteFields application
    const merged: Record<string, unknown> = {
      fact: updates.fact ?? existing.fact,
      tags: updates.tags ?? existing.tags,
      description: updates.description !== undefined ? updates.description : existing.description,
      properties: mergedUpdateProps ?? {},
    };
    applyDeleteFields(merged, deleteFieldsPaths);

    // Reflect deletions into $set/$unset
    for (const field of ['description', 'tags', 'properties']) {
      if (!(field in merged)) {
        $unset[field] = '';
        delete $set[field];
      } else if (deleteFieldsPaths.some(p => p === field || p.startsWith(field + '.'))) {
        $set[field] = merged[field];
      }
    }
  }

  /*
   * Validated HERE, after `deleteFields` has been folded into `$set`/`$unset`, so the document checked is the
   * document written. A patch that REMOVES a required property has only broken the record once the deletion is
   * applied, so validating earlier would check something the caller is not about to store.
   *
   * The values come from `$set` where the patch touched a field and from `existing` where it did not — which
   * is what "validate the merged record" means, and what neither door was doing for a fact before there was
   * a classifier for one.
   */
  {
    const finalType = ('type' in $set ? $set['type'] : existing.type) as string | undefined;
    const finalProps = ('properties' in $unset ? {}
      : ('properties' in $set ? $set['properties'] : existing.properties)) as Record<string, string | number | boolean> | undefined;
    const check = classifyFactUpsertAgainst(getSpaceMeta(spaceId), existing,
      { type: finalType, properties: finalProps });
    if (check.blocked) throw new SchemaViolationError(check);
    onValidation?.(check);
  }

  // Re-embed whenever any content field changes
  // There is no longer a "did the content change?" branch here. It existed to decide whether to pay for an
  // inline embed; the re-embed is now ENQUEUED unconditionally after the write, and `embedStoredRecord`
  // reads the record as STORED. Deciding here would mean deciding from this function's stale read — the
  // exact reasoning that made the old inline embedding wrong.

  applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
    { collection: 'fact', existing: existing as unknown as Record<string, unknown> }); // F10
  const updateOp: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
  // findOneAndUpdate, not updateOne, so the PRE-image comes back in the same round trip.
  //
  // The update itself is unchanged — same filter, same operators, same result — but the returned document is
  // the record as it was at WRITE time. Comparing its seq with the one read at the top of this function is
  // exactly the lost-update test: if it moved, another writer landed in the window between our read and our
  // write, and whatever they changed in a field we also set has just been overwritten with no trace.
  //
  // Observation for a caller that sent no `If-Match`: it must not reject a write that would previously have
  // succeeded, so the counter records and the write lands. With an `If-Match` the same operation ALSO
  // enforces it, because `seq` goes in this filter — see `write-precondition.ts` for why the check has to
  // live here rather than in a comparison made before the embed call above.
  const before = await col<FactDoc>(spaceCollection(spaceId, 'facts')).findOneAndUpdate(
    asFilter<FactDoc>(writeFilterFor(memoryId, ifMatchSeq)),
    asUpdate<FactDoc>(updateOp),
    { returnDocument: 'before' },
  ) as FactDoc | null;
  brainWriteSeqTotal
    .labels({
      collection: 'facts',
      outcome: writeOutcome(!!before, ifMatchSeq !== undefined, !!before && before.seq !== existing.seq),
    })
    .inc();
  // Nothing matched, so nothing was written; the response below is built from `existing` and would describe
  // a write that did not happen.
  if (!before) return null;

  const result = { ...existing, ...($set as Partial<FactDoc>) } as FactDoc;
  if ('_expireAt' in $unset) delete (result as { _expireAt?: unknown })._expireAt;

  // Apply deleteFields to the returned doc for consistency
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    applyDeleteFields(result as unknown as Record<string, unknown>, deleteFieldsPaths);
  }

  // Toggling exclusion always ends in an embed job, and the job handles BOTH directions — it unsets
  // the vector when the flag is on and computes one when it is off. So this path never has to know
  // which way the toggle went, which is what keeps the rule in one place.
  // ONE enqueue, unconditionally, for every successful update: recompute the text from the record as
  // STORED, and honour excludeFromVectorSearch in whichever direction it moved. See the entity update and
  // `embedStoredRecord` for why this replaced an inline embed built from a stale read.
  await enqueueEmbedJob(spaceId, 'fact', result._id);
  // Only when the caller NAMED it. Omitting `linkEntities` on a patch means "leave the links alone", and
  // passing `{ entity: undefined }` would read as "remove them all" — the same absent-versus-empty
  // distinction `deleteFields` exists for, one level down.
  //
  // `deleteFields` no longer reaches the links: it names RECORD fields, and the links are not one any more.
  if (updates.linkEntities !== undefined) {
    await reconcileLinks(spaceId, result._id, 'fact', { entity: updates.linkEntities }, result.author);
  }
  if (actor) emitWebhookEvent({ event: 'fact.updated', spaceId, entry: { ...result, embedding: undefined }, ...actor });
  return result;
}

/** Delete a fact and record a tombstone */
export async function deleteFact(
  spaceId: string,
  memoryId: string,
  actor?: WebhookActor,
): Promise<boolean> {
  const existing = await col<FactDoc>(spaceCollection(spaceId, 'facts'))
    .findOne(asFilter<FactDoc>({ _id: memoryId, spaceId }), { projection: { seq: 1 } }) as { seq?: number } | null;
  const seq = await nextSeq(spaceId);
  const result = await col<FactDoc>(spaceCollection(spaceId, 'facts')).deleteOne({
    _id: memoryId,
    spaceId,
  });
  if (result.deletedCount === 0) return false;
  // The record is gone, so its embed job has nothing left to embed. Eager rather than left to the worker: the
  // worker only claims `pending` jobs, so a job that had already gone terminal `failed` would never be claimed
  // again and would outlive the record for ever — visible since #861 as a permanent failure naming a recordId
  // that 404s.
  await retireEmbedJob(spaceId, 'fact', memoryId);

  const tombstone: TombstoneDoc = {
    _id: memoryId,
    type: 'fact',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
    ...(existing?.seq !== undefined ? { originalSeq: existing.seq } : {}),
  };
  await col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones')).replaceOne(
    asFilter<TombstoneDoc>({ _id: memoryId }),
    asDoc<TombstoneDoc>(tombstone),
    { upsert: true },
  );
  // The cascade. A deleted fact's links describe a connection whose SUBJECT no longer exists, and nothing
  // else would ever remove them — the reconcile hook only runs on a write to the record that is now gone.
  // Links pointing AT this fact are a different question and belong to the readers' slice: removing them
  // here would delete another record's data.
  await removeLinksFrom(spaceId, memoryId, 'fact');
  if (actor) emitWebhookEvent({ event: 'fact.deleted', spaceId, entry: { _id: memoryId }, ...actor });
  return true;
}

/** List facts (no embedding, paginated) */
export async function listFacts(
  spaceId: string,
  filter: Record<string, unknown> = {},
  limit = 20,
  skip = 0,
  sort?: SortSpec,
) {
  return col<FactDoc>(spaceCollection(spaceId, 'facts'))
    .find(asFilter<FactDoc>(filter))
    .maxTimeMS(filter['$expr'] ? PROPERTIES_SCAN_MAX_MS : 60_000)
    .project({ embedding: 0 })
    .sort(sort ? toMongoSort(sort) : { createdAt: -1 })
    .skip(parseSkip(skip))
    .limit(parseLimit(limit, 20, 1000))
    .toArray();
}

/** Count facts in a space */
export async function countFacts(spaceId: string): Promise<number> {
  return col<FactDoc>(spaceCollection(spaceId, 'facts')).countDocuments();
}
