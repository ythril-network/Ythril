/**
 * Fact records — create (`saveFact`), update, delete, list, count, bulk-delete.
 *
 * The recall engine lives in recall.ts, the filter DSL in filter.ts, and the structured query
 * surface in query.ts (A17.4). `saveFact` reaches into recall.ts for the optional insert-time
 * duplicate check; nothing here is imported back by those modules.
 */
import { reconcileLinks, removeLinksFrom, assertDesiredLinks } from './links.js';
import { type ContradictionWarning } from './insert-contradictions.js';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { withSeq } from '../util/seq.js';
import { brainWriteSeqTotal } from '../metrics/registry.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { toMongoSort, type SortSpec } from './list-sort.js';
import { applyExpiryToUpdate } from './ttl.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { classifyFactUpsertAgainst, SchemaViolationError, type UpdateValidation } from './write-validation.js';
import { applyDeleteFields } from './delete-fields.js';
import { mergePropertiesOrKeep } from './merge-fields.js';
import { enqueueEmbedJob, retireEmbedJob, EMBED_PRIORITY } from './embed-queue.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { FactDoc } from '../config/types.js';
import { writeTombstone } from './tombstones.js';
import type { SimilarMatch } from './recall.js';
import type { DupeCheckOpts } from './write-options.js';
import { listReadMaxMs } from './tag-filter.js';
import { writeFilterFor, writeOutcome } from './write-precondition.js';
import { NEVER_RETURNED_PROJECTION, withoutVector, eventEntryOf } from './read-projection.js';
import { spaceCollection } from '../db/space-collection.js';
import { planFact, factWant, type FactInput } from './write-plan/plan-fact.js';
import { planAndCommitOne } from './write-plan/plan-and-commit.js';

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
  /*
   * The DOOR, and nothing else. Every rule a fact write applies is in `write-plan/plan-fact.ts`, decided
   * against a read set; the write is the commit's (`write-plan/commit.ts`). A batch asks for the same plans
   * in bulk, so this and `bulkWrite` cannot come to mean different things (`Q-99` part 3).
   */
  const input: FactInput = { fact, linkEntities, tags, description, properties, type, opts, ttlDays, id };
  const done = await planAndCommitOne(spaceId, factWant(input), view => planFact(spaceId, input, view));
  const stored = { ...done.plan.result, seq: done.seq } as unknown as FactDoc;
  // `fact.updated`, not `created`, on a converge — a subscriber must be able to tell a retry from a new record.
  if (actor) {
    emitWebhookEvent({ event: done.plan.op === 'insert' ? 'fact.created' : 'fact.updated', spaceId,
      entry: eventEntryOf(stored), ...actor });
  }
  // Advisory only — the record is stored either way.
  return withoutVector({ ...stored, ...(done.similar ? { similar: done.similar } : {}),
    ...(done.contradicts ? { contradicts: done.contradicts } : {}) });
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

  // The seq is taken AT the write (`withSeq` below), not here (`Q-196`).
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now };
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
  const before = await withSeq(spaceId, (seq) => {
    $set['seq'] = seq;
    const updateOp: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
    return col<FactDoc>(spaceCollection(spaceId, 'facts')).findOneAndUpdate(
      asFilter<FactDoc>(writeFilterFor(memoryId, ifMatchSeq)),
      asUpdate<FactDoc>(updateOp),
      { returnDocument: 'before' },
    );
  }, 'fact.update') as FactDoc | null;
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
  await enqueueEmbedJob(spaceId, 'fact', result._id, { priority: EMBED_PRIORITY.write });
  // Only when the caller NAMED it. Omitting `linkEntities` on a patch means "leave the links alone", and
  // passing `{ entity: undefined }` would read as "remove them all" — the same absent-versus-empty
  // distinction `deleteFields` exists for, one level down.
  //
  // `deleteFields` no longer reaches the links: it names RECORD fields, and the links are not one any more.
  if (updates.linkEntities !== undefined) {
    await reconcileLinks(spaceId, result._id, 'fact', { entity: updates.linkEntities }, result.author);
  }
  if (actor) emitWebhookEvent({ event: 'fact.updated', spaceId, entry: eventEntryOf(result), ...actor });
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

  await writeTombstone(spaceId, { _id: memoryId, type: 'fact', originalSeq: existing?.seq });
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
    // The deadline is an option of the read, not a call on its cursor (Q-358; see `listChrono`).
    .find(asFilter<FactDoc>(filter), { maxTimeMS: listReadMaxMs(Boolean(filter['$expr'])) })
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
