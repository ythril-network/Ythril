import { type RecordFlags } from './record-flag.js';
import { rekeyEdge, embedQueueWorkFor, type EdgeRekey } from './edge-rekey.js';
import { brainWriteSeqTotal } from '../metrics/registry.js';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { writeAtReadVersion } from './write-at-read-version.js';
import { inHeldTransaction } from './held-transaction.js';
import { removeEdges } from './edge-removal.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { toMongoSort, LANDING_ORDER, type SortSpec } from './list-sort.js';
import { NEVER_RETURNED_PROJECTION, withoutVector, eventEntryOf } from './read-projection.js';
import { refuseForkEdit, remintForks } from './forks.js';
import { classifyEdgeUpsertAgainst, recordAfterPatch, SchemaViolationError, type UpdateValidation } from './write-validation.js';
import { conveniencePredicate, conveniencesFrom } from './list-conveniences.js';
import { applyExpiryToUpdate } from './ttl.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { applyDeleteFields, setUnlessDeleted } from './delete-fields.js';
import { mergePropertiesOrKeep, mergeTagsOrKeep } from './merge-fields.js';
import { enqueueEmbedJob, retireEmbedJob, EMBED_PRIORITY } from './embed-queue.js';
import { storedEdgeKind } from './entity-refs.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { EdgeDoc } from '../config/types.js';
import type { RefKind } from '../config/types-knowledge.js';
import { listReadMaxMs } from './tag-filter.js';
import { writeFilterFor, writeOutcome } from './write-precondition.js';
import { spaceCollection } from '../db/space-collection.js';
import { planEdge, edgeWant, resolveEdgeEndsForWrite, guardFor, type EdgeInput } from './write-plan/plan-edge.js';
import { writeRelabel } from './write-plan/guarded-relabel.js';
import { FUNCTIONAL_GUARD, UNSET_GUARD } from '../sync/local-only-fields.js';
import { planAndCommitOne } from './write-plan/plan-and-commit.js';
import { atReadSeq } from '../db/at-read-seq.js';
import { admitSpaceWrite, assertSpaceTakesWrites } from '../spaces/space-write-gate.js';

/**
 * Upsert a directed edge (from → to with label).
 * One edge per (from, to, label) triplet.
 */
/**
 * The edge an upsert would land on, by its identity triplet.
 *
 * An edge has no user-supplied id: `(from, to, label)` IS the identity, and three separate places
 * re-derived that filter — the upsert itself, the bulk importer's inserted-vs-updated counter, and now
 * validation. One of them getting it wrong would silently validate against the wrong record.
 *
 * ## It is also projected, which fixes a leak on a path nobody would look at for one
 *
 * `upsertEdge` spreads this document into the edge it RETURNS, and the route sends that as its 201. So an
 * ordinary edge update — no `waitForEmbedding`, no flag of any kind — answered with the stored float array,
 * measured against the live stack 2026-08-19. It was the only vector leak reachable without asking for an
 * inline embed.
 *
 * Nothing needs the old vector: the upsert either recomputes it or leaves the stored field untouched, and the
 * other two callers (the bulk importer's counter and `write-validation`) read `properties`.
 */
// Moved to `edge-lookup.ts` so `write-validation.ts` can have it without importing this file back — see the
// note there. Re-exported because it is part of this module's published surface and callers should not care.
export { findEdgeByTriplet } from './edge-lookup.js';

// Raised by the planner, where the check runs; re-exported for the callers that name it. A door that does not name it
// still answers it: it is a `SchemaViolationError`, which `connectionRefusalAnswer` and `callTool` map.
export { EdgeSchemaViolation } from './write-plan/plan-edge.js';

export async function upsertEdge(
  spaceId: string,
  from: string,
  to: string,
  label: string,
  weight?: number,
  type?: string,
  description?: string,
  properties?: Record<string, string | number | boolean>,
  tags?: string[],
  actor?: WebhookActor,
  ttlDays?: number | null,
  /**
   * Write options. An object rather than a twelfth positional — `saveFact` already carries a note saying
   * its twelfth was one too many, and this is the same signature growing the same way.
   */
  /**
   * `onValidation` hands the classification back to the caller — the warnings a `warn` space wants in its 201,
   * and the `preExisting`/`introduced` split. It exists so a door never has to run `classifyEdgeUpsert` a
   * second time for presentation: that would be two `findEdgeByTriplet` lookups per write, and it is how the
   * rule ended up written twice in the first place.
   */
  /**
   * `fromKind`/`toKind` ride in here rather than as a twelfth and thirteenth positional, for the reason the
   * note above already gives. They are data about the record rather than write options, which is not ideal —
   * but a signature this long is how a caller comes to pass `description` where `type` was meant, and that is
   * the worse failure. Omitting them means both endpoints are entities, which is what every existing caller
   * means.
   */
  // `RecordFlags` rather than the two booleans spelled out: they are declared once in `record-flag.ts`,
  // `applyRecordFlags` writes exactly that set, and a third flag would otherwise have to be added here and
  // in three sibling writers that all mean the same thing by it.
  opts?: RecordFlags & {
    waitForEmbedding?: boolean;
    onValidation?: (check: UpdateValidation) => void;
    fromKind?: RefKind;
    toKind?: RefKind;
  },
): Promise<EdgeDoc> {
  /*
   * The DOOR, and nothing else. Every rule an edge write applies is in `write-plan/plan-edge.ts`, decided
   * against a read set; the write is the commit's. A batch asks for the same plans in bulk (`Q-99` part 3). That
   * includes the refusals — the schema and, under `strictLinkage`, a far end that names nothing, of any kind — which
   * `edgeRefusal` decides for this door, the edge routes, an inline edge and a batch alike.
   */
  const input: EdgeInput = { from, to, label, weight, type, description, properties, tags, ttlDays, opts };
  assertSpaceTakesWrites(spaceId, 'edges');   // before the plan pays for an embedding; the commit asks again per stage
  const done = await planAndCommitOne(spaceId, edgeWant(spaceId, input), view => planEdge(spaceId, input, view));
  const edge = { ...done.plan.result, seq: done.seq } as unknown as EdgeDoc;
  // `edge.created` on both branches, as it has always been answered.
  if (actor) emitWebhookEvent({ event: 'edge.created', spaceId, entry: eventEntryOf(edge), ...actor });
  return withoutVector(edge);
}

/** List edges for a space, optionally filtering by from/to entity */
export async function listEdges(
  spaceId: string,
  filter: { from?: string; to?: string; label?: string; type?: string; tag?: string; search?: string; description?: string; properties?: string; fromIds?: string[]; toIds?: string[] } = {},
  limit = 50,
  skip = 0,
  sort?: SortSpec,
): Promise<EdgeDoc[]> {
  /*
   * The edge's OWN filters: its endpoints and its label. The five common conveniences —
   * `tag`, `type`, `description`, `properties`, `search` — go through `conveniencePredicate`, the module
   * the `filter` tool also calls, so an agent and the Edges tab cannot come to mean different things.
   */
  const base: Record<string, unknown> = { spaceId };
  if (filter.from) base['from'] = filter.from;
  if (filter.to) base['to'] = filter.to;
  if (filter.label) base['label'] = filter.label;
  // Name filters arrive already resolved to ids (per member). An EMPTY list means "no entity by that
  // name", so it must filter to nothing — not be skipped, which would silently show everything.
  if (filter.fromIds) base['from'] = { $in: filter.fromIds };
  if (filter.toIds) base['to'] = { $in: filter.toIds };
  // `filter` already spells the five convenience names exactly as the module reads them, so it is passed
  // whole rather than re-listed — a re-listing here is the sixth copy this module exists to remove.
  const merged = conveniencePredicate('edges', conveniencesFrom(filter as Record<string, unknown>), base);
  // `edges` has searchable fields, so the refusal branch is unreachable — throwing rather than falling
  // back to `base` keeps a silent full-collection read from ever being the answer here.
  if ('error' in merged) throw new Error(merged.error);
  const q = merged.predicate;
  return col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
    // The deadline is an option of the read, not a call on its cursor (Q-358; see `listChrono`).
    .find(asFilter<EdgeDoc>(q), {
      projection: NEVER_RETURNED_PROJECTION,
      maxTimeMS: listReadMaxMs(Boolean(q['$expr'])),
    })
    .sort(sort ? toMongoSort(sort) : { ...LANDING_ORDER })
    .skip(parseSkip(skip))
    .limit(parseLimit(limit, 20, 1000))
    .toArray() as Promise<EdgeDoc[]>;
}

/**
 * Delete an edge by ID, with its tombstone, its embed job retired and `edge.deleted` emitted — through
 * `removeEdges` (`brain/edge-removal.ts`), the one remover, so the delete and the tombstone commit together: two
 * separate writes left an edge gone here and alive on every peer when the tombstone failed.
 */
export async function deleteEdge(spaceId: string, edgeId: string, actor?: WebhookActor): Promise<boolean> {
  return (await removeEdges(spaceId, [edgeId], actor)).has(edgeId);
}

/** Find an edge by exact ID */
export async function getEdgeById(spaceId: string, id: string): Promise<EdgeDoc | null> {
  return col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
    .findOne(asFilter<EdgeDoc>({ _id: id, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as Promise<EdgeDoc | null>;
}

/** Update an existing edge by ID. Partial update — only supplied fields are changed. Re-embeds when any content field changes. */
export async function updateEdgeById(
  spaceId: string,
  id: string,
  updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string; suppressEmbeddings?: boolean; superseded?: boolean; fromKind?: RefKind; toKind?: RefKind },
  deleteFieldsPaths?: string[],
  actor?: WebhookActor,
  ttlDays?: number | null,
  ifMatchSeq?: number,
  /** See `upsertEdge`'s: the classification, so a door never re-derives it for presentation. */
  onValidation?: (check: UpdateValidation) => void,
): Promise<EdgeDoc | null> {
  // Refused before anything is read; the writes below (the re-key, or the in-place update) are admitted and counted again, at the instant they are made.
  assertSpaceTakesWrites(spaceId, 'edges');
  const collection = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));
  const existing = await collection.findOne(asFilter<EdgeDoc>({ _id: id, spaceId }),
    { projection: NEVER_RETURNED_PROJECTION }) as EdgeDoc | null;
  if (!existing) return null;
  // An unresolved version is read-only (Q-624 §8), the relabel above all: re-keyed onto its subject's derived id, a fork edge would take the identity slot.
  refuseForkEdit('edge', existing);

  // The version is stamped and the position taken AT the write (`writeAtReadVersion` below), not here: everything awaited between the
  // position and the write holds every position-paged reader of the space (`Q-196`).
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now };
  const $unset: Record<string, unknown> = {};

  if (updates.suppressEmbeddings !== undefined) $set['suppressEmbeddings'] = updates.suppressEmbeddings;
  if (updates.superseded !== undefined) $set['superseded'] = updates.superseded;
  /*
   * Correcting an endpoint's KIND is a patch, and it has to be, because there is no other way to fix one.
   * An edge's identity is its `(from, to, label)` triplet, so an endpoint cannot be moved by a patch — and
   * delete-and-recreate does not work across a sync network either, since a tombstone only deletes its
   * ISSUER's own content, so a peer-authored edge would survive its own deletion and come back.
   *
   * The re-embed is enqueued after this write and reads the STORED document, so a corrected kind changes the
   * edge's embedding on the next pass without this function computing anything: the endpoint resolves in the
   * collection the new kind names.
   */
  for (const side of ['fromKind', 'toKind'] as const) {
    const given = updates[side];
    if (given === undefined) continue;
    const stored = storedEdgeKind(given);
    if (stored) $set[side] = stored; else $unset[side] = '';
  }
  const newLabel = updates.label ?? existing.label;
  let newDesc = updates.description !== undefined ? updates.description : existing.description;
  let newTags = mergeTagsOrKeep(existing.tags, updates.tags);
  let newProps: Record<string, string | number | boolean> | undefined =
    mergePropertiesOrKeep(existing.properties, updates.properties) ?? {};
  let newType = updates.type !== undefined ? updates.type : existing.type;
  let newWeight: number | undefined = updates.weight !== undefined ? updates.weight : existing.weight;

  // Apply deleteFields after merge
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    const merged: Record<string, unknown> = {
      description: newDesc,
      tags: newTags,
      properties: newProps,
      weight: newWeight,
    };
    applyDeleteFields(merged, deleteFieldsPaths);

    if (!('description' in merged)) {
      newDesc = undefined;
      $unset['description'] = '';
    } else {
      newDesc = merged['description'] as string | undefined;
    }
    if (!('tags' in merged)) {
      newTags = [];
      $unset['tags'] = '';
    } else {
      newTags = merged['tags'] as string[];
    }
    if (!('properties' in merged)) {
      newProps = undefined;
      $unset['properties'] = '';
    } else {
      newProps = merged['properties'] as Record<string, string | number | boolean>;
    }
    if (!('weight' in merged)) {
      newWeight = undefined;
      $unset['weight'] = '';
    } else {
      newWeight = merged['weight'] as number;
    }
  }

  if (updates.label !== undefined) $set['label'] = newLabel;
  // `setUnlessDeleted` rather than a guard on `$unset['x']`: that value is the empty string, so the old test was
  // always true and every whole-field `deleteFields` produced a rejected write. See its doc comment.
  setUnlessDeleted($set, $unset, 'description', newDesc, updates.description !== undefined || !!deleteFieldsPaths);
  setUnlessDeleted($set, $unset, 'tags', newTags, updates.tags !== undefined || !!deleteFieldsPaths);
  setUnlessDeleted($set, $unset, 'properties', newProps, updates.properties !== undefined || !!deleteFieldsPaths);
  if (updates.type !== undefined) $set['type'] = newType;
  setUnlessDeleted($set, $unset, 'weight', newWeight, updates.weight !== undefined || !!deleteFieldsPaths);

  // The re-embed is ENQUEUED after the write — see `embedStoredRecord`. Computing it here would build the
  // text from this function's stale read, which is how a record's vector ends up describing a record that
  // no longer exists anywhere.

  /*
   * Validated after `deleteFields`, so the document checked is the document written.
   *
   * `upsertEdge` has enforced the schema internally since #1046 and this function did not — the half of the
   * owner's 2026-08-29 ruling that was missed even on the record kind that got the fix, because the row that
   * prompted it named the upsert. A patch may CHANGE THE LABEL, which selects a different type schema
   * entirely, so an edge could be moved onto a label whose rules its stored properties break.
   */
  // A closure, because a relabel the store refuses with a duplicate key asks it AGAIN against what the winner wrote (`writeRelabel`).
  const classify = async (): Promise<void> => {
    const finalLabel = ('label' in $set ? $set['label'] : existing.label) as string;
    /*
     * The same resolution as the upsert path. A patch cannot move an endpoint — the triplet is the identity —
     * but it CAN change the label, and the rules belong to the label: patching `works_with` to `reports_to`
     * has to be checked against `reports_to`'s ends.
     */
    const resolvedEnds = await resolveEdgeEndsForWrite(spaceId, {
      from: existing.from, to: existing.to, label: finalLabel,
      opts: { ...(existing.fromKind ? { fromKind: existing.fromKind } : {}),
        ...(existing.toKind ? { toKind: existing.toKind } : {}) },
    });
    const check = classifyEdgeUpsertAgainst(getSpaceMeta(spaceId), existing,
      recordAfterPatch(existing, $set, $unset), resolvedEnds);
    if (check.blocked) throw new SchemaViolationError(check);
    onValidation?.(check);
  };
  await classify();

  /*
   * THE WRITE GUARD of a relabel (`Q-439`): the marker is a function of `(from, label)`, so a write that changes the label sets it
   * afresh or drops it IN THE SAME WRITE — on the re-key (`rekeyEdge`) and on the in-place update a peer-authored edge falls back to
   * alike. Stamped when the new label is functional and the space refuses (`guardFor`, the one place that asks).
   */
  const relabelled = updates.label !== undefined && updates.label !== existing.label;
  const functionalGuard = relabelled ? guardFor(spaceId, existing.from, newLabel) : undefined;
  const relabelTarget = { id: existing._id, from: existing.from, to: existing.to, label: newLabel, fromKind: existing.fromKind, toKind: existing.toKind };

  applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
    { collection: 'edge', existing: existing as unknown as Record<string, unknown> }); // F10

  /*
   * A LABEL CHANGE IS AN IDENTITY CHANGE, so the edge moves onto the id its identity derives.
   *
   * `_id` is immutable, so this cannot be part of the `$set` below — it is a delete-and-insert, and
   * `rekeyEdge` owns the tombstone and the seq ordering that makes one safe on a synced collection. It
   * returns `null` when the derived id is the one already stored, which is every patch that does not touch
   * the label, and the ordinary update below runs unchanged.
   *
   * Validation has already run against the FINAL label above, so an edge cannot be re-keyed onto a label
   * whose type schema its stored properties break. `deleteFields` has been applied to `$unset`, which the
   * re-key must honour too, or a field the caller asked to remove would survive the move.
   */
  if (relabelled) {
    /*
     * `If-Match` is checked HERE rather than by the filter below, because there is no `findOneAndUpdate` on
     * this branch to carry `writeFilterFor`. Skipping it would make the precondition lapse on exactly one
     * kind of patch — an option that silently stops working on one code path is the defect this file's
     * neighbours keep fixing.
     */
    if (ifMatchSeq !== undefined && existing.seq !== ifMatchSeq) {
      brainWriteSeqTotal.labels({ collection: 'edges', outcome: writeOutcome(false, true, true) }).inc();
      return null;
    }
    const carried = { ...$set };   // no `seq`: `rekeyEdge` takes its own, after the tombstone's
    // The removals go too. Without them the re-inserted row keeps every field this patch deletes, while the
    // response says it does not — and for `ttlDays: null` that is an edge the sweep still expires.
    /*
     * IN A TRANSACTION, unlike the rest of this function.
     *
     * Every other patch is one `findOneAndUpdate` and is atomic for free. A re-key is a delete and an
     * insert, so a crash or a connection loss between them leaves the edge in NEITHER id — the caller's
     * relationship simply gone, with a 500 that does not say what happened to it. `merge.ts` already runs its
     * re-keys inside `withTransaction` for the same reason; this path had nothing.
     */
    // Under the horizon hold, bounded, and read back inside the hold when the commit's answer is lost
    // (`brain/held-transaction.ts`): the moved edge under its new id at the seq the re-key gave it IS the commit.
    // A duplicate key on the guard (or on the identity it moves onto) is answered by `writeRelabel`, never raised raw.
    const moved: EdgeRekey | null = await writeRelabel(spaceId, relabelTarget, functionalGuard, () => inHeldTransaction(spaceId, 'edge.relabel',
      async (session) => {
        const rekeyed = await rekeyEdge(spaceId, existing, { label: newLabel }, carried, Object.keys($unset), session, functionalGuard);
        // The subject's forks follow it onto the new id by a re-mint, in this transaction; their own label is authored body and stays (Q-624 §7).
        if (rekeyed) await remintForks(spaceId, 'edge', [{ oldSubject: existing._id, newSubject: rekeyed.edge._id }], { session, now });
        return rekeyed;
      },
      { landed: async (r) => r === null || (await collection.countDocuments(
        asFilter<EdgeDoc>(atReadSeq(r.edge._id, r.edge.seq)), { limit: 1 })) === 1 }), classify);
    if (moved) {
      // The queue AFTER the write, and here rather than inside `rekeyEdge` — see `embedQueueWorkFor`. There
      // is no transaction on this path, so the write is already durable. The embed text is built from the
      // label and the endpoint names, so a re-key always changes it.
      const work = embedQueueWorkFor(moved);
      await retireEmbedJob(spaceId, 'edge', work.retire);
      await enqueueEmbedJob(spaceId, 'edge', work.enqueue, { priority: EMBED_PRIORITY.write });
      brainWriteSeqTotal.labels({
        collection: 'edges', outcome: writeOutcome(true, ifMatchSeq !== undefined, false),
      }).inc();
      // `rekeyEdge` has already applied the whole-field removals to the STORED document, so this copy needs
      // only the dotted `deleteFields` paths, which reach inside `properties` rather than removing a field.
      const out = { ...moved.edge };
      if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
        applyDeleteFields(out as unknown as Record<string, unknown>, deleteFieldsPaths);
      }
      if (actor) emitWebhookEvent({ event: 'edge.updated', spaceId, entry: eventEntryOf(out), ...actor });
      // `rekeyEdge` already strips, and this is still not redundant: a reader here cannot see that, and the
      // pairing of a stripped webhook with an unstripped return is exactly the shape that leaked on four
      // record kinds. The guarantee belongs where the document leaves the function.
      return withoutVector(out);
    }
  }

  // Lost-update detection, identical to `updateFact` and for the same reason: `returnDocument: "before"`
  // hands back the record as it was at WRITE time, so comparing its seq with the one read at the top of this
  // function is exactly the test for another writer landing in the window. Observation only — no write that
  // previously succeeded is now rejected.
  // A relabel that stayed in place (a peer-authored edge): the guard follows the label in the same write — set for the new subject,
  // or dropped when the label no longer carries one (`_functionalGuard` is `WRITE_GUARD_FIELDS`' field).
  if (relabelled) {
    if (functionalGuard !== undefined) $set[FUNCTIONAL_GUARD] = functionalGuard; else Object.assign($unset, UNSET_GUARD);
  }
  let seq = 0;
  // Admitted and counted from its own check (`admitSpaceWrite`), each time it is attempted; a relabel that moved the edge was counted by `rekeyEdges`.
  const writeInPlace = () => admitSpaceWrite(spaceId, 'edges', () => writeAtReadVersion<EdgeDoc>(spaceId, 'edges', id, ifMatchSeq, (at) => {
    seq = at.version;
    const updateOp: Record<string, unknown> = { $set: { ...$set, ...at.patch } };
    if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
    return collection.findOneAndUpdate(
      asFilter<EdgeDoc>(writeFilterFor(id, { readSeq: at.readSeq, ifMatchSeq })),
      asUpdate<EdgeDoc>(updateOp),
      { returnDocument: 'before' },
    );
  }, 'edge.update')) as Promise<EdgeDoc | null>;
  const beforeWrite = relabelled ? await writeRelabel(spaceId, relabelTarget, functionalGuard, writeInPlace, classify) : await writeInPlace();
  brainWriteSeqTotal.labels({
    collection: 'edges',
    outcome: writeOutcome(!!beforeWrite, ifMatchSeq !== undefined, !!beforeWrite && beforeWrite.seq !== existing.seq),
  }).inc();
  // Nothing matched, so nothing was written; the response below is built from `existing`.
  if (!beforeWrite) return null;

  const result = {
    ...existing,
    label: newLabel,
    tags: newTags,
    updatedAt: now,
    seq,
    ...(updates.description !== undefined ? { description: newDesc } : {}),
    // Same `in` test as the write above. `applyDeleteFields` runs over this object a few lines down and would have
    // removed the key anyway, so this was right by accident rather than by decision — and an accident that agrees
    // with the write only while both stay wrong the same way.
    ...(!('properties' in $unset) && (updates.properties !== undefined || deleteFieldsPaths) ? { properties: newProps } : {}),
    ...(updates.type !== undefined ? { type: newType } : {}),
    ...(updates.weight !== undefined ? { weight: newWeight } : {}),
  } as EdgeDoc;
  if ('_expireAt' in $set) result._expireAt = $set['_expireAt'] as Date;
  else if ('_expireAt' in $unset) delete (result as { _expireAt?: unknown })._expireAt;

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
  await enqueueEmbedJob(spaceId, 'edge', result._id, { priority: EMBED_PRIORITY.write });
  if (actor) emitWebhookEvent({ event: 'edge.updated', spaceId, entry: eventEntryOf(result), ...actor });
  return result;
}
