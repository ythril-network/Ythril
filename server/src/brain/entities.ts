import { v4 as uuidv4 } from 'uuid';
import { brainWriteSeqTotal } from '../metrics/registry.js';
import { authorRef } from '../config/author.js';
import { findInsertContradictions, type ContradictionWarning } from './insert-contradictions.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { toMongoSort, type SortSpec } from './list-sort.js';
import { NEVER_RETURNED_PROJECTION, withoutVector } from './read-projection.js';
import { embed } from './embedding.js';
import { entityEmbedText } from './embed-text.js';
import { getConfig } from '../config/loader.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from './ttl.js';
import { stampSkewOnCreate } from './stamp-skew.js';
import { getSpaceMeta, applyPropertyDefaults } from '../spaces/schema-validation.js';
import { classifyEntityUpsertAgainst, SchemaViolationError, type UpdateValidation } from './write-validation.js';
import { writeFilterFor, writeOutcome } from './write-precondition.js';
import { applyDeleteFields, setUnlessDeleted } from './delete-fields.js';
import { mergeTagsAndProperties, mergePropertiesOrKeep, mergeTagsOrKeep } from './merge-fields.js';
import { enqueueEmbedJob, retireEmbedJob } from './embed-queue.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { linksToAny, LINK_CLASSES, usesLinkRecords, linksPointingAt, docsFromCollection, type LinkClass }
  from './link-adjacency.js';
import type { RefKind } from '../config/types-knowledge.js';
import { checkDuplicates, type SimilarMatch } from './recall.js';
import type { DupeCheckOpts } from './write-options.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { log } from '../util/log.js';
import type { EntityDoc, EdgeDoc, FactDoc, ChronoEntry, TombstoneDoc, FileMetaDoc } from '../config/types.js';
import { PROPERTIES_SCAN_MAX_MS, textContains } from './tag-filter.js';
import { wipeSpaceCollection } from './bulk-wipe.js';

/** An item that references a given entity, and — for an edge — which of its ends does. */
export interface BacklinkEntry {
  type: 'edge' | 'fact' | 'chrono' | 'file' | 'face';
  _id: string;
  /**
   * Which end of the EDGE names the entity, and absent on every other type.
   *
   * Absent rather than guessed: a fact, chrono entry or file HOLDS a reference in a list, so it has no
   * ends, and labelling one `to` would send a caller looking for an edge that does not exist. Set by
   * `entityDeleteBlockers`, which is what the refusal is built from.
   */
  end?: 'from' | 'to' | 'both';
}

/**
 * Strip a deleted person's label from every face record that pointed at them.
 *
 * Face descriptors are not stored in a face collection — they are filemeta records
 * (`{fileId}#face-chunk{N}`) carrying `faceEmbedding` and, once labelled, `faceEntityId`. So deleting
 * the entity used to leave the biometric descriptor on disk still tagged with the identifier that was
 * just erased, and `gallerySearch` kept matching new uploads against it — the dangling label
 * propagated forward instead of decaying.
 *
 * **Unlabel, never delete.** The face record belongs to the *file*, which the operator did not
 * delete; removing it would destroy someone's image metadata as a side effect of deleting a contact.
 * "Delete this person" means we stop claiming to know whose face it is, not that the photo loses its
 * face. An operator who wants the descriptors gone deletes the file — that path already cascades
 * correctly, because `deleteConversionArtifacts` matches on `parentFileId`.
 *
 * Shared by every delete path (single, bulk, TTL sweep) on purpose: this being fixed in one caller
 * only is the exact shape of the original bug.
 *
 * @returns how many face records were unlabelled.
 */
export async function unlabelFacesForEntities(spaceId: string, entityIds: string[]): Promise<number> {
  if (entityIds.length === 0) return 0;
  return unlabelFacesWhere(spaceId, { faceEntityId: { $in: entityIds } });
}

/** Clear every face label in a space — for the bulk wipe, where all entities are gone by definition. */
export async function unlabelAllFaces(spaceId: string): Promise<number> {
  return unlabelFacesWhere(spaceId, { faceEntityId: { $exists: true } });
}

async function unlabelFacesWhere(spaceId: string, match: Record<string, unknown>): Promise<number> {
  const res = await col<FileMetaDoc>(`${spaceId}_files`).updateMany(
    asFilter<FileMetaDoc>(match),
    asUpdate<FileMetaDoc>({ $unset: { faceEntityId: '', faceScore: '' } }),
  );
  const n = res.modifiedCount ?? 0;
  if (n > 0) log.info(`Unlabelled ${n} face record(s) in '${spaceId}' after entity deletion`);
  return n;
}

export interface UpsertResult {
  entity: EntityDoc;
  warning?: string;
  /** Near-duplicate entities surfaced by an opt-in insert-time similarity check. */
  similar?: SimilarMatch[];
  /** Near-neighbours that structurally CONTRADICT this entity (same single-valued property, different
   *  value). Advisory — the entity is stored regardless. */
  contradicts?: ContradictionWarning[];
}


/** Derive the text to embed for an entity (name + type + tags + description + properties). */

/**
 * Create or update an entity.
 *
 * Identity semantics (Defect 2 fix):
 *  - If `id` is supplied → look up by `_id`; update the document if found, or insert
 *    a new document with that exact `_id` if not found (upsert by ID).
 *  - If `id` is not supplied → always insert a new document with a freshly generated
 *    UUID v4 as `_id`.  Name is a non-unique searchable label, not a primary key.
 *
 * Callers that need name-based lookup should use `findEntitiesByName`.
 */
export async function upsertEntity(
  spaceId: string,
  name: string,
  type: string,
  tags: string[] = [],
  properties: Record<string, string | number | boolean> = {},
  description?: string,
  id?: string,
  opts?: DupeCheckOpts,
  actor?: WebhookActor,
  ttlDays?: number | null,
  /**
   * Hands the classification back to the caller — the warnings a `warn` space reports in its 201, and the
   * `preExisting`/`introduced` split. It exists so a door never has to run `classifyEntityUpsert` a second
   * time purely for presentation: that would be a second lookup per write, and it is how the rule ended up
   * written in six places to begin with.
   */
  onValidation?: (check: UpdateValidation) => void,
): Promise<UpsertResult> {
  const collection = col<EntityDoc>(`${spaceId}_entities`);

  // When an id is provided, attempt to find the existing record by primary key.
  const existing: EntityDoc | null = id
    ? (await collection.findOne(asFilter<EntityDoc>({ _id: id, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as EntityDoc | null)
    : null;

  /*
   * THE SCHEMA IS ENFORCED HERE, so that no caller can reach the collection around it.
   *
   * Owner's ruling, 2026-08-29: *"all upsert/update/insert things must validate btw — i thought that was
   * already fact."* It was fact for `upsertEdge` alone (#1046), and for the same reason it is now fact here:
   * the rule lived in the two API routes, the MCP tool and `bulk.ts`, and `bulk.ts` enforced a DIFFERENT one —
   * blocking on any violation with no `preExisting`/`introduced` split, so the same upsert was refused through
   * `/bulk` and accepted through `/entities`.
   *
   * Declared defaults fill in what the caller omitted BEFORE validation and only on an INSERT: a property that
   * is `required` and has a `default` must not be a violation, because the default is what satisfies the
   * requirement — and on an update an absent property may be one the caller has just removed, so resurrecting
   * it would undo a deliberate deletion.
   */
  const meta = getSpaceMeta(spaceId);
  const withDefaults = existing
    ? properties
    : applyPropertyDefaults(meta?.typeSchemas?.entity?.[type], properties);
  const check = classifyEntityUpsertAgainst(meta, existing, { name, type, properties: withDefaults, tags });
  if (check.blocked) throw new SchemaViolationError(check);
  onValidation?.(check);
  properties = withDefaults ?? properties;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  // Embed the entity text (best-effort — if embedding fails we still store the entity)
  //
  // Queued by default, so the write does not pay the model's latency. `matchedText` is stored either
  // way: it is a pure string, it is exactly what the queued job will embed, and recording it now is what
  // lets the stored vector be checked against the text it came from.
  const forEmbed = mergeTagsAndProperties(existing, { tags, properties });
  const embedText = entityEmbedText(name, type, forEmbed.tags, description ?? existing?.description, forEmbed.properties);
  //
  // The duplicate/contradiction checks below compare THIS record's vector against its neighbours, so they
  // cannot run without one — and unlike the embedding itself, that question cannot be deferred and
  // answered later in a response that has already been sent. So they imply the wait, exactly as they do
  // in `saveFact`. Implied rather than rejected as an invalid combination: a caller asking "is this a
  // duplicate?" would otherwise get a silent "no".
  // Suppression wins over all three — see `embeddingSuppressedFor`. Computing a vector here and skipping the
  // enqueue stored exactly what the flag forbids, with nothing to come back and remove it.
  // The RECORD tier is stated here, which it was not until 2026-09-02 — see `DupeCheckOpts`.
  const suppressed = embeddingSuppressedFor(spaceId, 'entity',
    { type, suppressEmbeddings: opts?.suppressEmbeddings });
  const needsVectorNow = !suppressed
    && (opts?.waitForEmbedding === true
      || opts?.checkDuplicates === true || opts?.checkContradictions === true);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText?: string } = { matchedText: embedText };
  if (needsVectorNow) {
    // Unguarded on purpose: the caller asked for a record searchable when this returns, so falling back
    // to "stored, not searchable" would answer a different question than the one asked.
    const embResult = await embed(embedText);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model, matchedText: embedText };
  }

  if (existing) {
    const { tags: updatedTags, properties: mergedProps } = mergeTagsAndProperties(existing, { tags, properties });
    const $set: Record<string, unknown> = { name, type, tags: updatedTags, properties: mergedProps, updatedAt: now, seq, ...embeddingFields };
    if (description !== undefined) $set['description'] = description;
    const $unset: Record<string, unknown> = {};
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'entity', existing: existing as unknown as Record<string, unknown> }); // F10
    const updateOp: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
    await collection.updateOne(
      asFilter<EntityDoc>({ _id: existing._id }),
      asUpdate<EntityDoc>(updateOp),
    );
    const entity: EntityDoc = { ...existing, name, type, tags: updatedTags, properties: mergedProps, updatedAt: now, seq, ...embeddingFields, ...(description !== undefined ? { description } : {}) };
    if ('_expireAt' in $set) entity._expireAt = $set['_expireAt'] as Date;
    else if ('_expireAt' in $unset) delete (entity as { _expireAt?: unknown })._expireAt;
    // After the write, never before: a job for a record that failed to store would be a job for nothing.
    if (!embeddingFields.embedding && !suppressed) await enqueueEmbedJob(spaceId, 'entity', entity._id);
    if (actor) emitWebhookEvent({ event: 'entity.updated', spaceId, entry: { ...entity, embedding: undefined }, ...actor });
    return { entity: withoutVector(entity) };
  }

  // Warn when inserting without an explicit id and duplicates already exist
  let warning: string | undefined;
  if (!id) {
    const existingCount = await collection.countDocuments(asFilter<EntityDoc>({ spaceId, name, type }));
    if (existingCount > 0) {
      warning = `${existingCount} existing entit${existingCount === 1 ? 'y' : 'ies'} with name '${name}' and type '${type}' already exist in this space. A new entity was created because no id was supplied. To update an existing entity, provide its id.`;
    }
  }

  // Opt-in insert-time duplicate / contradiction checks, using the freshly computed vector BEFORE insert
  // so it can never self-match. ONE neighbour search serves both flags.
  let similar: SimilarMatch[] | undefined;
  let contradicts: ContradictionWarning[] | undefined;
  if ((opts?.checkDuplicates || opts?.checkContradictions) && embeddingFields.embedding) {
    const hits = await checkDuplicates(spaceId, 'entity', embeddingFields.embedding, opts.dupeThreshold, opts.dupeTopK);
    if (opts.checkDuplicates && hits.length > 0) similar = hits;
    if (opts.checkContradictions && hits.length > 0) {
      const found = await findInsertContradictions(spaceId, 'entity', { properties }, hits);
      if (found.length > 0) contradicts = found;
    }
  }

  const doc: EntityDoc = {
    // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always. A supplied id may
    // ADDRESS an existing record — the update path above — but it never becomes a new record's identity.
    // It used to: a supplied id that named nothing was adopted, which made the caller a co-author of our
    // primary key and, across a sync, let two instances deriving ids from the same key collide by design.
    // A caller wanting to carry their own reference puts it in `name` or `description`, which are for that.
    _id: uuidv4(),
    spaceId,
    name,
    type,
    tags,
    properties,
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    ...embeddingFields,
  };
  // Stored, not merely consulted — see the note in `saveFact`: everything that revisits a record later reads
  // the tiers off the document.
  if (opts?.suppressEmbeddings !== undefined) doc.suppressEmbeddings = opts.suppressEmbeddings;
  if (description !== undefined) doc.description = description;
  // `typed` is what makes the SCHEMA tier reachable. Omit it and the resolver silently falls through to the
  // space default, so a window set on `typeSchemas.entity.<type>.retention` does nothing at all.
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'entity', type: doc.type });
  // Warn-not-refuse: a caller's own stamp checked against ours. Stored only when it disagrees beyond the space's
  // threshold, so presence is the signal. The write proceeds either way -- a backdated import is legitimate.
  stampSkewOnCreate(doc, getSpaceMeta(spaceId));
  await collection.insertOne(asDoc<EntityDoc>(doc));
  // Not queued when suppressed, for the reason `saveFact` states: a queued job stores the vector the flag
  // forbids moments later, and nothing revisits it.
  if (!embeddingFields.embedding && !suppressed) await enqueueEmbedJob(spaceId, 'entity', doc._id);
  // Real-time duplicate-rule evaluation (opt-in per space). Fire-and-forget; the
  // dynamic import avoids a static cycle with dupe-scanner.js.
  //
  // Behind the embedding, not beside it. This evaluates the STORED record against its neighbours, and a
  // stored record has no vector until the queue gets to it — firing here would compare nothing and find
  // nothing, silently. Nothing is lost by the wait: this path is fire-and-forget and writes candidates to
  // the Review surface rather than returning them, so no caller is holding a response open for it.
  // Only when we embedded INLINE — otherwise the embed worker runs it once the vector exists, so this
  // guard is what stops it running twice rather than what stops it running at all.
  if (embeddingFields.embedding && getConfig().spaces.find(s => s.id === spaceId)?.dupeRulesOnInsert) {
    import('./dupe-scanner.js').then(m => m.evaluateRecordForDuplicates(spaceId, 'entity', doc._id)).catch(() => { /* best-effort */ });
  }
  if (actor) emitWebhookEvent({ event: 'entity.created', spaceId, entry: { ...doc, embedding: undefined }, ...actor });
  // Advisory only — the entity is stored either way.
  return { entity: withoutVector(doc), warning, similar, contradicts };
}

/**
 * Find all entities in a space that match the given name (case-sensitive).
 * Returns an empty array when no match is found.
 * Name is a non-unique label, so multiple results are possible.
 */
export async function findEntitiesByName(spaceId: string, name: string): Promise<EntityDoc[]> {
  return col<EntityDoc>(`${spaceId}_entities`)
    .find(asFilter<EntityDoc>({ spaceId, name }), { projection: NEVER_RETURNED_PROJECTION })
    .toArray() as Promise<EntityDoc[]>;
}

/**
 * Fetch several entities by id in one query.
 *
 * One `$in` beats a lookup per id, and the projection is the shared one, so a caller cannot leak a vector.
 *
 * **It no longer feeds any embedding, and the sentence that used to be here was wrong.** It read: *"the
 * embedded text wants names — an entity's name is what a semantic search actually matches on, so dropping it
 * from the embed text would quietly degrade recall for every linked record."* Measured on a 199-question
 * benchmark, the opposite is true: dropping the names IMPROVED strict evidence recall by 1.5 points (0.8369
 * with them, 0.8528 without). A fact linked to five entities carried five names it does not say.
 *
 * Left in place because a projection-safe batch fetch by id is worth having and re-implementing it badly is
 * the likelier failure — but do not reach for it to build embed text. See `factEmbedText`.
 */
export async function findEntitiesByIds(spaceId: string, ids: readonly string[]): Promise<EntityDoc[]> {
  if (ids.length === 0) return [];
  return col<EntityDoc>(`${spaceId}_entities`)
    .find(asFilter<EntityDoc>({ _id: { $in: [...new Set(ids)] }, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION })
    .toArray() as Promise<EntityDoc[]>;
}

/** Find an entity by exact ID */
export async function getEntityById(spaceId: string, id: string): Promise<EntityDoc | null> {
  return col<EntityDoc>(`${spaceId}_entities`)
    .findOne(asFilter<EntityDoc>({ _id: id, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as Promise<EntityDoc | null>;
}

/**
 * Update an existing entity by ID. Partial update — only supplied fields are changed. Re-embeds when any
 * content field changes.
 *
 * `ifMatchSeq` is the optimistic-concurrency precondition: the write only lands if the record's `seq` is
 * still that value. `undefined` means no precondition and the write proceeds exactly as it always has.
 * See `writeFilterFor` for why it is enforced in the filter rather than by comparing the read.
 */
export async function updateEntityById(
  spaceId: string,
  id: string,
  updates: { name?: string; type?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; suppressEmbeddings?: boolean },
  deleteFieldsPaths?: string[],
  actor?: WebhookActor,
  ttlDays?: number | null,
  ifMatchSeq?: number,
  /** See `upsertEntity`'s: the classification, so a door never re-derives it for presentation. */
  onValidation?: (check: UpdateValidation) => void,
): Promise<EntityDoc | null> {
  const collection = col<EntityDoc>(`${spaceId}_entities`);
  const existing = await collection.findOne(asFilter<EntityDoc>({ _id: id, spaceId }),
    { projection: NEVER_RETURNED_PROJECTION }) as EntityDoc | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };
  const $unset: Record<string, unknown> = {};

  const newName = updates.name ?? existing.name;
  const newType = updates.type ?? existing.type;
  const newDesc = updates.description !== undefined ? updates.description : existing.description;
  let newTags = mergeTagsOrKeep(existing.tags, updates.tags);
  let newProps = mergePropertiesOrKeep(existing.properties, updates.properties) ?? {};

  // Apply deleteFields after merge
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    const merged: Record<string, unknown> = {
      description: newDesc,
      tags: newTags,
      properties: newProps,
    };
    applyDeleteFields(merged, deleteFieldsPaths);

    // Reflect deletions back
    if (!('description' in merged)) {
      $unset['description'] = '';
    }
    if (!('tags' in merged)) {
      newTags = [];
      $unset['tags'] = '';
    } else {
      newTags = merged['tags'] as string[];
    }
    if (!('properties' in merged)) {
      newProps = {} as Record<string, string | number | boolean>;
      $unset['properties'] = '';
    } else {
      newProps = merged['properties'] as Record<string, string | number | boolean>;
    }
  }

  /*
   * Validated HERE, after `deleteFields` has been applied, so the document checked is the document written.
   *
   * The order matters and is the same one `updateFact` needs: a patch that REMOVES a required property has
   * only broken the record once the deletion is folded in, so validating before this point would check a
   * merged record the caller is not about to store. `newType` rather than `existing.type` for the same
   * reason — re-typing re-validates against the NEW type's schema, which is what #1047 fixed at the route and
   * this brings inside.
   */
  const check = classifyEntityUpsertAgainst(getSpaceMeta(spaceId), existing,
    { name: newName, type: newType, properties: newProps, tags: newTags });
  if (check.blocked) throw new SchemaViolationError(check);
  onValidation?.(check);

  if (updates.suppressEmbeddings !== undefined) $set['suppressEmbeddings'] = updates.suppressEmbeddings;
  if (updates.name !== undefined) $set['name'] = newName;
  if (updates.type !== undefined) $set['type'] = newType;
  // `setUnlessDeleted` rather than a guard on `$unset['x']`: that value is the empty string, so the old test was
  // always true and every whole-field `deleteFields` produced a rejected write. See its doc comment.
  setUnlessDeleted($set, $unset, 'description', newDesc, updates.description !== undefined || !!deleteFieldsPaths);
  setUnlessDeleted($set, $unset, 'tags', newTags, updates.tags !== undefined || !!deleteFieldsPaths);
  setUnlessDeleted($set, $unset, 'properties', newProps, updates.properties !== undefined || !!deleteFieldsPaths);

  // The re-embed is ENQUEUED after the write, not computed here. See `embedStoredRecord` for why computing
  // it inline was wrong rather than merely slow: the text would come from this function's stale read.

  applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
    { collection: 'entity', existing: existing as unknown as Record<string, unknown> }); // F10
  const updateOp: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
  // Lost-update detection, identical to `updateFact` and for the same reason: `returnDocument: "before"`
  // hands back the record as it was at WRITE time, so comparing its seq with the one read at the top of this
  // function is exactly the test for another writer landing in the window. Observation only — no write that
  // previously succeeded is now rejected.
  const beforeWrite = await collection.findOneAndUpdate(
    asFilter<EntityDoc>(writeFilterFor(id, ifMatchSeq)),
    asUpdate<EntityDoc>(updateOp),
    { returnDocument: 'before' },
  ) as EntityDoc | null;
  brainWriteSeqTotal.labels({
    collection: 'entities',
    outcome: writeOutcome(!!beforeWrite, ifMatchSeq !== undefined, !!beforeWrite && beforeWrite.seq !== existing.seq),
  }).inc();
  // Nothing matched, so nothing was written. Everything below builds the response out of `existing`, which
  // would describe a write that did not happen — a fabricated 200 that predates the precondition and was
  // reachable whenever a record was deleted inside the read-then-write window.
  if (!beforeWrite) return null;

  const result = {
    ...existing,
    name: newName,
    type: newType,
    tags: newTags,
    properties: newProps,
    updatedAt: now,
    seq,
    ...(updates.description !== undefined ? { description: newDesc } : {}),
  } as EntityDoc;
  if ('_expireAt' in $set) result._expireAt = $set['_expireAt'] as Date;
  else if ('_expireAt' in $unset) delete (result as { _expireAt?: unknown })._expireAt;

  // Apply deleteFields to the returned doc for consistency
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    applyDeleteFields(result as unknown as Record<string, unknown>, deleteFieldsPaths);
  }

  // ONE enqueue, unconditionally, for every successful update.
  //
  // It used to be conditional on `excludeFromVectorSearch` being present, because every other path embedded
  // inline. Now that the vector always comes from the queue, the same call covers both jobs: recompute the
  // text from the record as STORED, and honour the exclusion flag in whichever direction it was moved —
  // `embedStoredRecord` unsets the vector when the flag is on and computes one when it is off, so this path
  // still never has to know which way the toggle went.
  await enqueueEmbedJob(spaceId, 'entity', result._id);
  if (actor) emitWebhookEvent({ event: 'entity.updated', spaceId, entry: { ...result, embedding: undefined }, ...actor });
  return result;
}

/** List entities with optional filter */
export async function listEntities(
  spaceId: string,
  filter: Record<string, unknown> = {},
  limit = 50,
  skip = 0,
  sort?: SortSpec,
): Promise<EntityDoc[]> {
  const cursor = col<EntityDoc>(`${spaceId}_entities`)
    .find(asFilter<EntityDoc>({ ...filter, spaceId }), { projection: NEVER_RETURNED_PROJECTION });
  // A properties-value filter is a collection scan by nature ($expr cannot use an index), so it
  // carries its own deadline instead of running unbounded on a large space.
  cursor.maxTimeMS(filter['$expr'] ? PROPERTIES_SCAN_MAX_MS : 60_000);
  // Default is natural (insertion) order — unchanged for every existing caller. A sort is only
  // applied when one is explicitly requested.
  if (sort) cursor.sort(toMongoSort(sort));
  return cursor
    .skip(parseSkip(skip))
    .limit(parseLimit(limit, 20, 1000))
    .toArray() as Promise<EntityDoc[]>;
}

/** Delete an entity and write tombstone */
export async function deleteEntity(
  spaceId: string,
  entityId: string,
  actor?: WebhookActor,
): Promise<boolean> {
  const existing = await col<EntityDoc>(`${spaceId}_entities`)
    .findOne(asFilter<EntityDoc>({ _id: entityId, spaceId }), { projection: { seq: 1 } }) as { seq?: number } | null;
  const seq = await nextSeq(spaceId);
  const result = await col<EntityDoc>(`${spaceId}_entities`).deleteOne({
    _id: entityId,
    spaceId,
  });
  if (result.deletedCount === 0) return false;
  // The record is gone, so its embed job has nothing left to embed. Eager rather than left to the worker: the
  // worker only claims `pending` jobs, so a job that had already gone terminal `failed` would never be claimed
  // again and would outlive the record for ever — visible since #861 as a permanent failure naming a recordId
  // that 404s.
  await retireEmbedJob(spaceId, 'entity', entityId);

  const tombstone: TombstoneDoc = {
    _id: entityId,
    type: 'entity',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
    ...(existing?.seq !== undefined ? { originalSeq: existing.seq } : {}),
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    asFilter<TombstoneDoc>({ _id: entityId }),
    asDoc<TombstoneDoc>(tombstone),
    { upsert: true },
  );
  // Erasure has to reach the biometric copy too — see unlabelFacesForEntities.
  await unlabelFacesForEntities(spaceId, [entityId]);
  if (actor) emitWebhookEvent({ event: 'entity.deleted', spaceId, entry: { _id: entityId }, ...actor });
  return true;
}

/**
 * Bulk-delete every entity in a space, writing a tombstone per deleted doc.
 *
 * The cascade is the reason this passes `afterDelete` rather than being one line: every entity in the space is
 * gone, so every face label is dangling BY DEFINITION. Cleared wholesale rather than by handing `ids` to a
 * `$in`, which on a 100k-entity wipe would build a 100k-element query for a filter that means "all of them" —
 * the same round-trip trap the shared helper's seq-block reservation exists to avoid.
 *
 * It is also the one thing that makes this wipe different from the other three, and the thing an extraction
 * treating them as identical drops. `the-bulk-wipe-writes-a-tombstone-per-record-db.test.js` asserts it here
 * and asserts its ABSENCE on a fact wipe, so a shared hook wired to the wrong callers fails too.
 */
export async function bulkDeleteEntities(spaceId: string): Promise<number> {
  return await wipeSpaceCollection(spaceId, 'entities', 'entity', {
    afterDelete: () => unlabelAllFaces(spaceId).then(() => undefined),
  });
}

/**
 * Find every item in a space that references the given entity — in EITHER direction.
 *
 * It was called `findEntityBacklinks` and this line said *"hold inbound references"*, while the edge scan
 * below has always matched `$or: [{from}, {to}]`. So the name and the docblock agreed with the 409's wording
 * and all three disagreed with the query — a reader who came here to resolve the message's ambiguity was
 * told the same wrong thing a second time, which is what happened to the fleet integrator on 2026-08-30.
 *
 * Both ends is the RIGHT check: an edge left pointing FROM a deleted entity dangles exactly as much as one
 * pointing at it. The response field is still called `backlinks` because that is a published contract.
 *
 * This returns rows WITHOUT the `end` field. `entityDeleteBlockers` fills that in, so the coverage question
 * this function answers — is every kind of reference found — stays separate from how a refusal is worded.
 * Checks edges (from/to), facts (entityIds), chrono entries (entityIds), and labelled face
 * records (`faceEntityId`).
 * Returns a (possibly empty) list of backlink entries.
 *
 * Faces were the gap: this scanned `_edges` / `_facts` / `_chrono` and not `_files`, so under
 * `strictLinkage` — the strongest setting available — a person referenced *only* by their face
 * labels deleted cleanly, and the 409 that exists to say "something still points at this" stayed
 * silent about the one reference class holding biometric data.
 */
/**
 * The ids of records of one class that reference `targetId`, through whichever storage shape this space
 * answers from.
 *
 * The fork lives here and nowhere else. `usesLinkRecords` is the one decision; a reader choosing for itself
 * is how five readers came to follow five different subsets of six fields.
 */
/**
 * Every record that references `targetId`, grouped by the class that references it.
 *
 * ## Batched, and the measurement is why
 *
 * The first version took ONE class and was called in a loop — six link queries plus six document reads for
 * a single delete. On a corpus of 8 380 links that measured **11.4 ms against the array path's 3.0 ms**,
 * for the same answer: 3.8× slower on the scan that stands in front of every delete.
 *
 * The indexed lookup was never the cost. The ROUND TRIPS were. One query on `{to}` returns every class at
 * once and one read per COLLECTION applies the scope — which also stops a file being fetched three times,
 * once per class it holds.
 */
async function referencesByClass(
  spaceId: string, targetId: string, classes: readonly LinkClass[],
): Promise<Array<{ cls: LinkClass; id: string }>> {
  if (classes.length === 0) return [];

  if (!usesLinkRecords(spaceId)) {
    // The ARRAY path, one read per class, exactly as 3.x did it. Every unconverted space answers here.
    const out: Array<{ cls: LinkClass; id: string }> = [];
    for (const cls of classes) {
      const rows = await col<{ _id: string }>(`${spaceId}_${cls.collection}`)
        .find(asFilter<{ _id: string }>(linksToAny(spaceId, cls, [targetId])), { projection: { _id: 1 } })
        .toArray() as Array<{ _id: string }>;
      for (const r of rows) out.push({ cls, id: r._id });
    }
    return out;
  }

  const byPair = new Map<string, LinkClass>();
  for (const c of classes) byPair.set(`${c.kind}>${c.toKind}`, c);

  const idsPerCollection = new Map<LinkClass['collection'], Set<string>>();
  const claimed: Array<{ cls: LinkClass; id: string }> = [];
  for (const r of await linksPointingAt(spaceId, [targetId])) {
    const cls = byPair.get(`${r.fromKind}>${r.toKind}`);
    if (!cls) continue;
    let ids = idsPerCollection.get(cls.collection);
    if (!ids) { ids = new Set(); idsPerCollection.set(cls.collection, ids); }
    ids.add(r.from);
    claimed.push({ cls, id: r.from });
  }

  // The chunk exclusion, applied against the records: a link row has no `parentFileId`, so a file link and
  // a chunk link are indistinguishable in the links collection.
  const admitted = new Set<string>();
  for (const [collection, ids] of idsPerCollection) {
    // `_id` only: this scan reports ids, and the union projection would send every field of every class.
    for (const d of await docsFromCollection<{ _id: string }>(spaceId, collection, [...ids], { _id: 1 })) {
      admitted.add(d._id);
    }
  }
  return claimed.filter(c => admitted.has(c.id));
}

/**
 * What still points at a record — the scan that refuses a delete under strict linkage.
 *
 * **`targetKind` since 4.0**, defaulting to `entity` because that is every existing caller and the published
 * `backlinks` contract. A fact, a chrono entry and a file can all be pointed AT now, and until they could
 * be seen here, deleting one that something named was never refused.
 */
export async function findEntityReferences(spaceId: string, targetId: string, targetKind: RefKind = 'entity'): Promise<BacklinkEntry[]> {
  const backlinks: BacklinkEntry[] = [];

  // Edges referencing this record as from or to. Edge endpoints carry their own kind since 3.7, so an edge
  // whose `from` is a fact is found here too — and `fromKind`/`toKind` are absent on a pre-3.7 edge,
  // which means entity, which is why the kind is matched permissively for that case alone.
  const kindMatches = (side: string) => targetKind === 'entity'
    ? { $or: [{ [side]: targetId, [`${side}Kind`]: { $exists: false } }, { [side]: targetId, [`${side}Kind`]: 'entity' }] }
    : { [side]: targetId, [`${side}Kind`]: targetKind };
  const edges = await col<EdgeDoc>(`${spaceId}_edges`)
    .find(asFilter<EdgeDoc>({ spaceId, $or: [kindMatches('from'), kindMatches('to')] }), { projection: { _id: 1 } })
    .toArray() as Array<{ _id: string }>;
  for (const e of edges) backlinks.push({ type: 'edge', _id: e._id });

  /*
   * Every class whose TO kind is the kind of thing being deleted — six of them now, where this was three
   * hand-written blocks that each knew one collection and one field.
   *
   * **The three it could not see were the three nobody had written a reader for.** Deleting a fact that a
   * chrono entry named was never refused, even under strict linkage, because `chrono.memoryIds` had no
   * scan — and this is the scan that refuses. A class this cannot see is a delete it cannot block, which
   * makes coverage here a data-safety property rather than a completeness one.
   *
   * Derived from `LINK_CLASSES` rather than written out for the same reason: a seventh class added later
   * gets the block automatically, where a fourth hand-written block would have been forgotten exactly the
   * way the file one was.
   */
  for (const { cls, id } of await referencesByClass(spaceId, targetId,
    LINK_CLASSES.filter(c => c.toKind === targetKind))) {
    backlinks.push({ type: cls.kind, _id: id });
  }

  /*
   * Files that reference this entity in `entityIds` — a modelled reference, exactly like a fact's.
   *
   * This was missing while the `faceEntityId` scan below was present, which is the interesting part: the same
   * collection had already been patched once, for the other field, and its sibling was not added alongside. So
   * an entity referenced ONLY by a file's `entityIds` deleted cleanly under `strictLinkage` and the file was
   * left pointing at a record that no longer exists — the very outcome the setting is bought for.
   *
   * It blocks, unlike the face scan. Both doors filter `b.type !== 'face'`, and that exemption is deliberate
   * and narrow: a face label is an annotation the system inferred, while `entityIds` is a link somebody wrote.
   */

  // Face records labelled with this entity. These live in `${spaceId}_files` as face-chunk filemeta
  // docs, which is why the class scans above miss them.
  //
  // ENTITIES ONLY, and the guard is not defensive tidiness: `faceEntityId` holds an entity id, so running
  // this for a fact target would compare a fact id against a column of entity ids. It would find
  // nothing, every time, which is exactly what a silently wrong scan looks like from the outside.
  if (targetKind === 'entity') {
    const faces = await col<FileMetaDoc>(`${spaceId}_files`)
      .find(asFilter<FileMetaDoc>({ faceEntityId: targetId }), { projection: { _id: 1 } })
      .toArray() as Array<{ _id: string }>;
    for (const f of faces) backlinks.push({ type: 'face', _id: f._id });
  }

  return backlinks;
}

/** Cap on how many entity ids a name filter may expand to, bounding the `$in` it produces. */
export const NAME_FILTER_ID_CAP = 500;

/**
 * Entity ids whose NAME contains `needle` (case-insensitive substring), within one member space.
 *
 * The From/To and Entities columns display entity NAMES while the records store ids, so a column filter
 * has to translate before it can query. Doing it here — rather than post-filtering the page in the
 * client — means the filter applies to the whole collection, not just the rows that happened to load.
 *
 * Called per MEMBER (inside `collectAcrossMembers`): ids belong to the member that owns them, and
 * resolving against another member's entities would match nothing while looking like it worked.
 *
 * Returns at most `NAME_FILTER_ID_CAP` ids. An empty result is meaningful — it means "no entity by that
 * name", so the caller filters to nothing rather than falling back to unfiltered.
 */
export async function resolveEntityIdsByName(spaceId: string, needle: string): Promise<string[]> {
  const trimmed = needle.trim();
  if (!trimmed) return [];
  const docs = await col<EntityDoc>(`${spaceId}_entities`)
    .find(asFilter<EntityDoc>({ name: textContains(trimmed) }), { projection: { _id: 1 } })
    .limit(NAME_FILTER_ID_CAP)
    .toArray();
  return docs.map(d => String(d._id));
}
