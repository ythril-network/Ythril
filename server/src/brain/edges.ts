import { edgeIdFor } from './edge-id.js';
import { rekeyEdge, embedQueueWorkFor, type EdgeRekey } from './edge-rekey.js';
import { brainWriteSeqTotal } from '../metrics/registry.js';
import { authorRef } from '../config/author.js';
import { col, getMongo, asFilter, asDoc, asUpdate, asBulk } from '../db/mongo.js';
import type { ClientSession } from 'mongodb';
import { nextSeq, reserveSeqBlock } from '../util/seq.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { toMongoSort, type SortSpec } from './list-sort.js';
import { NEVER_RETURNED_PROJECTION, withoutVector } from './read-projection.js';
import { findEdgeByTriplet } from './edge-lookup.js';
import { classifyEdgeUpsertAgainst, SchemaViolationError, type UpdateValidation } from './write-validation.js';
import { applyPropertyDefaults } from '../spaces/schema-validation.js';
import { textSearchOr, SEARCHABLE_FIELDS } from './text-search.js';
import { embed } from './embedding.js';
import { edgeEmbedText } from './embed-text.js';
import { getConfig } from '../config/loader.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from './ttl.js';
import { stampSkewOnCreate } from './stamp-skew.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { applyDeleteFields, setUnlessDeleted } from './delete-fields.js';
import { mergePropertiesOrKeep, mergeTagsOrKeep } from './merge-fields.js';
import { enqueueEmbedJob, retireEmbedJob } from './embed-queue.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { linkClassFor, LINK_CLASSES } from './link-adjacency.js';
import { frontierEdgeQuery, type TraverseNarrowing } from './frontier-query.js';
import { linkedRecordsAtFrontier, entitiesLinkedFromRecords, linkedRecordName, linkedRecordType, type LinkedRecord, type LinkInclusion }
  from './link-frontier.js';
import { getEntityById } from './entities.js';
import { resolveEdgeEndpointNames, resolveEdgeEndsForWrite } from './edge-endpoint-names.js';
import { storedEdgeKind } from './entity-refs.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { EdgeDoc, EntityDoc, TombstoneDoc, ChronoEntry, FactDoc, FileMetaDoc } from '../config/types.js';
import type { RefKind } from '../config/types-knowledge.js';
import { tagContains, textContains, propertiesValueContains, PROPERTIES_SCAN_MAX_MS } from './tag-filter.js';
import { writeFilterFor, writeOutcome } from './write-precondition.js';

export interface TraverseNode {
  _id: string;
  name: string;
  type: string;
  depth: number;
  /**
   * WHICH collection this node lives in.
   *
   * Absent on an entity — every node was one until chrono entries became reachable, so absence keeps every
   * existing response byte-identical. Present and `'chrono'` on a chrono entry, or `'fact'` on a fact,
   * because each is looked up in a different collection and a caller that follows `_id` needs to know where
   * to look. Guessing from `type` does not work: a chrono's `type` is `event`/`deadline`/…, a fact's is
   * optional entirely, and an entity's is whatever the space calls it.
   */
  kind?: 'chrono' | 'fact' | 'file';
  /**
   * File META only, and only on a `kind: 'file'` node. A file's searchable body is its CHUNKS, which are
   * large and are what recall returns; a traverse answer that carried passage text would blow up in size for
   * a walk that asked about structure. So a file node reports what the file IS — its path as `name`, plus
   * these two — and a caller who wants the content reads it with the file API.
   */
  description?: string;
  tags?: string[];
}

export interface TraverseEdge {
  _id: string;
  from: string;
  to: string;
  label: string;
}

export interface TraverseResult {
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  truncated: boolean;
}

/**
 * The id of a SYNTHETIC traverse edge — the link from an entity to a chrono entry, fact or file.
 *
 * ## What it replaces, and why that was wrong in both directions
 *
 * These edges used to carry the TARGET DOCUMENT'S OWN `_id`, on this rationale: *"nothing has to invent an
 * edge id that does not exist — a caller looking it up finds the chrono, not a 404."*
 *
 * **The consumer half of that was the exact opposite of true.** `getEdgeById` queries `${spaceId}_edges` and
 * nothing else, and a chrono lives in `_chrono`, a fact in `_facts`, a file in `_files`. So the
 * "helpful" id 404s on every edge-lookup path the product actually has — `GET /edges/:id`, the PATCH, and
 * `update_edge`. The one lookup that does resolve is `GET /chrono/:id`, which needs an id the caller already
 * has from the NODE. The affordance was never delivered; only the collision was.
 *
 * **And it made the links disappear.** A graph library has ONE id namespace for nodes and edges — cytoscape
 * skips a repeated id with a bare `continue` inside its `Collection` constructor, before the code path that
 * would have thrown. Nodes are added before edges, so the node always won and the edge was always dropped,
 * silently. What an operator saw was a detached band of chrono bubbles floating above the graph, connected
 * to nothing, with no console output and an edge count that overreported by exactly that many.
 *
 * ## The shape
 *
 * Label-prefixed and carrying both endpoints, so it can collide with neither a stored edge `_id` (a UUID) nor
 * any node id (also a UUID). Two seeds linking to the SAME chrono entry produce two different edges, which is
 * correct — they are two different relationships — and under the old scheme they were one id twice.
 *
 * It is deliberately NOT a UUID: a synthetic edge has no stored record, and an id shaped like a real one
 * invites exactly the lookup that cannot work. This one says what it is.
 */
export function syntheticEdgeId(label: string, from: string, to: string): string {
  return `${label}:${from}:${to}`;
}


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

/**
 * A refused edge write, carrying the whole classification rather than a message.
 *
 * Both doors already answer with `{ error: 'schema_violation', message, violations, introduced, preExisting }`,
 * and neither should have to rebuild that from prose. Carrying `UpdateValidation` means the response shape is
 * unchanged by moving the check, which is the whole point: this is a relocation of one rule, not a new refusal.
 */
export class EdgeSchemaViolation extends Error {
  constructor(readonly check: UpdateValidation) {
    super(check.message ?? 'schema_violation');
    this.name = 'EdgeSchemaViolation';
  }
}

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
  opts?: {
    waitForEmbedding?: boolean;
    /** Retire this edge from meaning-ranked search at creation — see `DupeCheckOpts.suppressEmbeddings`. */
    suppressEmbeddings?: boolean;
    onValidation?: (check: UpdateValidation) => void;
    fromKind?: RefKind;
    toKind?: RefKind;
  },
): Promise<EdgeDoc> {
  const collection = col<EdgeDoc>(`${spaceId}_edges`);
  const existing = await findEdgeByTriplet(spaceId, from, to, label, opts?.fromKind, opts?.toKind);

  /*
   * THE SCHEMA IS ENFORCED HERE, so that no caller can reach the collection around it.
   *
   * It used to be enforced by the two API routes, each calling `classifyEdgeUpsert` before calling this
   * function — one rule, written twice, and both copies reachable only if you remembered them. Two callers did
   * not: `api/contradictions.ts` writes a `supersedes` edge straight through this function, so in a space whose
   * `typeSchemas.edge` allowlist did not name `supersedes` the server wrote an edge that space forbids; and
   * `brain/bulk.ts` carried its own third copy of the check.
   *
   * Owner's ruling, 2026-08-29: *"upsertEdge should validate of course."* So the door is the function, not the
   * route. The routes keep their response shapes by catching `EdgeSchemaViolation` — which carries the whole
   * classification, not just a message, precisely so neither door has to re-derive it.
   */
  /*
   * Declared defaults fill in what the caller omitted, before validation and only on an INSERT.
   *
   * Before validation because a property that is `required` and has a `default` must not be a violation — the
   * default is what satisfies the requirement. Only on insert because on an update an absent property may be
   * one the caller has just removed, and resurrecting a deliberate deletion is worse than a default that does
   * not apply. See `applyPropertyDefaults`.
   */
  const meta = getSpaceMeta(spaceId);
  const withDefaults = existing
    ? properties
    : applyPropertyDefaults(meta?.typeSchemas?.edge?.[label], properties);

  /*
   * The endpoint rules need what the payload does not carry: the TYPE of the entity at each end, and how many
   * other edges share this subject. Resolved here because this function is async and already talks to the
   * database; `classifyEdgeUpsertAgainst` is reached from paths that legitimately cannot look, so it takes what
   * it is given and reports nothing about what it is not.
   */
  const resolvedEnds = await resolveEdgeEndsForWrite(spaceId, from, to, label, opts ?? {});
  const check = classifyEdgeUpsertAgainst(meta, existing, { label, properties: withDefaults }, resolvedEnds);
  if (check.blocked) throw new EdgeSchemaViolation(check);
  opts?.onValidation?.(check);

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  const effectiveDesc = description ?? (existing as EdgeDoc | null)?.description;
  const effectiveType = type ?? (existing as EdgeDoc | null)?.type;
  const effectiveTags = mergeTagsOrKeep((existing as EdgeDoc | null)?.tags, tags);
  // `withDefaults`, not `properties` — the defaults were validated above and must be the values STORED.
  // Validating one document and writing another is the shape that produced the fact-upsert defect.
  const effectiveProps = mergePropertiesOrKeep((existing as EdgeDoc | null)?.properties, withDefaults);

  // Embed the edge text (best-effort) — resolve entity names so the vector captures semantics
  // Queued by default — see the note in `upsertEntity`. Resolving the endpoint NAMES is a database read,
  // so it happens only on the inline path; the queued job resolves them itself from the stored edge.
  let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText?: string } = {};
  // Suppression wins over `waitForEmbedding` — see `embeddingSuppressedFor`. An edge keys its schema on
  // `label`, not `type`, which `schemaKeyFor` already encodes; passing `type` here would look up a schema
  // that is never there and silently never suppress.
  //
  // Hoisted rather than asked inline, because the enqueue below has to consult the same answer: skipping the
  // inline embed and queueing anyway stores the vector the flag forbids moments later. The RECORD tier is
  // stated here, which it was not until 2026-09-02 — see `DupeCheckOpts`.
  const suppressed = embeddingSuppressedFor(spaceId, 'edge',
    { label, suppressEmbeddings: opts?.suppressEmbeddings });
  if (opts?.waitForEmbedding === true && !suppressed) {
    const [fromName, toName] = await resolveEdgeEndpointNames(spaceId, from, to, opts?.fromKind, opts?.toKind);
    const embedText = edgeEmbedText(fromName, label, toName, effectiveTags, effectiveType, effectiveDesc, effectiveProps);
    const embResult = await embed(embedText);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model, matchedText: embedText };
  }

  if (existing) {
    const $set: Record<string, unknown> = { updatedAt: now, seq, ...embeddingFields };
    if (weight !== undefined) $set['weight'] = weight;
    if (type !== undefined) $set['type'] = type;
    if (description !== undefined) $set['description'] = description;
    // When tags are provided, persist the merged result; otherwise leave existing tags unchanged
    if (tags !== undefined) $set['tags'] = effectiveTags;
    if (properties !== undefined) $set['properties'] = effectiveProps;
    const $unset: Record<string, unknown> = {};
    // Correcting a kind back to `entity` must UNSET it, not store the string: absent is the canonical form,
    // and leaving `'entity'` behind would make this edge unfindable by its own triplet lookup.
    for (const side of ['fromKind', 'toKind'] as const) {
      const given = side === 'fromKind' ? opts?.fromKind : opts?.toKind;
      if (given === undefined) continue;
      const stored = storedEdgeKind(given);
      if (stored) $set[side] = stored; else $unset[side] = '';
    }
    applyExpiryToUpdate(spaceId, ttlDays, (existing as EdgeDoc)._expireAt != null, $set, $unset,
      { collection: 'edge', existing: existing as unknown as Record<string, unknown> }); // F10
    const updateOp: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
    await collection.updateOne(
      asFilter<EdgeDoc>({ _id: (existing as EdgeDoc)._id }),
      asUpdate<EdgeDoc>(updateOp),
    );
    const updatedEdge: EdgeDoc = {
      ...(existing as EdgeDoc),
      seq,
      updatedAt: now,
      ...(weight !== undefined ? { weight } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags: effectiveTags } : {}),
      ...(properties !== undefined ? { properties: effectiveProps } : {}),
      ...embeddingFields,
    };
    if ('_expireAt' in $set) updatedEdge._expireAt = $set['_expireAt'] as Date;
    else if ('_expireAt' in $unset) delete (updatedEdge as { _expireAt?: unknown })._expireAt;
    if (!embeddingFields.embedding && !suppressed) await enqueueEmbedJob(spaceId, 'edge', updatedEdge._id);
    if (actor) emitWebhookEvent({ event: 'edge.created', spaceId, entry: { ...updatedEdge, embedding: undefined }, ...actor });
    return withoutVector(updatedEdge);
  }

  const doc: EdgeDoc = {
    _id: edgeIdFor(from, to, label, opts?.fromKind, opts?.toKind),
    spaceId,
    from,
    to,
    /*
     * Stored only when stated. Absent is the reading every edge already has, so an entity-to-entity edge
     * written today is byte-identical to one written before the field existed — which is what keeps this off
     * every peer's sync feed as a change.
     *
     * `edgeIdFor` deliberately does NOT take them: the id is derived from `(from, to, label)` and folding two
     * more values in would change the id of every edge in every space, which is a rewrite of a replicated
     * collection to buy protection against a collision between a UUID and a file path.
     */
    /*
      * Normalised, so there is exactly ONE stored representation of an entity endpoint: absent. An explicit
      * `'entity'` and an absent field describe the same edge and derive the same `_id`, so storing both is a
      * duplicate key — while the unique index would see two different keys and the triplet lookup would match
      * only one of them. `storedEdgeKind` is where that reasoning lives.
      */
     ...(storedEdgeKind(opts?.fromKind) ? { fromKind: storedEdgeKind(opts?.fromKind) } : {}),
     ...(storedEdgeKind(opts?.toKind) ? { toKind: storedEdgeKind(opts?.toKind) } : {}),
    label,
    tags: tags ?? [],
    ...(type !== undefined ? { type } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(properties !== undefined ? { properties } : {}),
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    ...embeddingFields,
  };
  // Stored, not merely consulted — see the note in `saveFact`.
  if (opts?.suppressEmbeddings !== undefined) doc.suppressEmbeddings = opts.suppressEmbeddings;
  // `doc.label`, NOT `doc.type` — an edge has both, and the schema is keyed by label (see validateEdgeWrite).
  // Passing `type` here would look right and read a schema that is never there.
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'edge', type: doc.label });
  // Warn-not-refuse: a caller's own stamp checked against ours. Stored only when it disagrees beyond the space's
  // threshold, so presence is the signal. The write proceeds either way -- a backdated import is legitimate.
  stampSkewOnCreate(doc, getSpaceMeta(spaceId));
  await collection.insertOne(asDoc<EdgeDoc>(doc));
  if (!embeddingFields.embedding && !suppressed) await enqueueEmbedJob(spaceId, 'edge', doc._id);
  if (actor) emitWebhookEvent({ event: 'edge.created', spaceId, entry: { ...doc, embedding: undefined }, ...actor });
  return withoutVector(doc);
}

/** List edges for a space, optionally filtering by from/to entity */
export async function listEdges(
  spaceId: string,
  filter: { from?: string; to?: string; label?: string; type?: string; tag?: string; search?: string; description?: string; properties?: string; fromIds?: string[]; toIds?: string[] } = {},
  limit = 50,
  skip = 0,
  sort?: SortSpec,
): Promise<EdgeDoc[]> {
  const q: Record<string, unknown> = { spaceId };
  if (filter.from) q['from'] = filter.from;
  if (filter.to) q['to'] = filter.to;
  if (filter.label) q['label'] = filter.label;
  if (filter.type) q['type'] = filter.type;
  // `tags` is an array field; a scalar match is Mongo array-contains (edge HAS this tag).
  if (filter.tag) q['tags'] = tagContains(filter.tag);
  // Per-column description filter. `search` below also spans `label`, so a column control needs its own.
  if (filter.description) q['description'] = textContains(filter.description);
  if (filter.properties) Object.assign(q, propertiesValueContains(filter.properties));
  // Name filters arrive already resolved to ids (per member). An EMPTY list means "no entity by that
  // name", so it must filter to nothing — not be skipped, which would silently show everything.
  if (filter.fromIds) q['from'] = { $in: filter.fromIds };
  if (filter.toIds) q['to'] = { $in: filter.toIds };
  // Freetext substring over the edge's text fields (2b-iii-a).
  const search = textSearchOr(filter.search, SEARCHABLE_FIELDS.edges);
  if (search) Object.assign(q, search);
  return col<EdgeDoc>(`${spaceId}_edges`)
    .find(asFilter<EdgeDoc>(q), { projection: NEVER_RETURNED_PROJECTION })
    .maxTimeMS(q['$expr'] ? PROPERTIES_SCAN_MAX_MS : 60_000)
    .sort(sort ? toMongoSort(sort) : { seq: -1, createdAt: -1, _id: -1 })
    .skip(parseSkip(skip))
    .limit(parseLimit(limit, 20, 1000))
    .toArray() as Promise<EdgeDoc[]>;
}

/** Delete an edge by ID and write tombstone */
export async function deleteEdge(spaceId: string, edgeId: string, actor?: WebhookActor): Promise<boolean> {
  const existing = await col<EdgeDoc>(`${spaceId}_edges`)
    .findOne(asFilter<EdgeDoc>({ _id: edgeId, spaceId }), { projection: { seq: 1 } }) as { seq?: number } | null;
  const seq = await nextSeq(spaceId);
  const result = await col<EdgeDoc>(`${spaceId}_edges`).deleteOne({
    _id: edgeId,
    spaceId,
  });
  if (result.deletedCount === 0) return false;
  // The record is gone, so its embed job has nothing left to embed. Eager rather than left to the worker: the
  // worker only claims `pending` jobs, so a job that had already gone terminal `failed` would never be claimed
  // again and would outlive the record for ever — visible since #861 as a permanent failure naming a recordId
  // that 404s.
  await retireEmbedJob(spaceId, 'edge', edgeId);

  const tombstone: TombstoneDoc = {
    _id: edgeId,
    type: 'edge',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
    ...(existing?.seq !== undefined ? { originalSeq: existing.seq } : {}),
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    asFilter<TombstoneDoc>({ _id: edgeId }),
    asDoc<TombstoneDoc>(tombstone),
    { upsert: true },
  );
  if (actor) emitWebhookEvent({ event: 'edge.deleted', spaceId, entry: { _id: edgeId }, ...actor });
  return true;
}

/** Find an edge by exact ID */
export async function getEdgeById(spaceId: string, id: string): Promise<EdgeDoc | null> {
  return col<EdgeDoc>(`${spaceId}_edges`)
    .findOne(asFilter<EdgeDoc>({ _id: id, spaceId }),
      { projection: NEVER_RETURNED_PROJECTION }) as Promise<EdgeDoc | null>;
}

/** Update an existing edge by ID. Partial update — only supplied fields are changed. Re-embeds when any content field changes. */
export async function updateEdgeById(
  spaceId: string,
  id: string,
  updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string; suppressEmbeddings?: boolean; fromKind?: RefKind; toKind?: RefKind },
  deleteFieldsPaths?: string[],
  actor?: WebhookActor,
  ttlDays?: number | null,
  ifMatchSeq?: number,
  /** See `upsertEdge`'s: the classification, so a door never re-derives it for presentation. */
  onValidation?: (check: UpdateValidation) => void,
): Promise<EdgeDoc | null> {
  const collection = col<EdgeDoc>(`${spaceId}_edges`);
  const existing = await collection.findOne(asFilter<EdgeDoc>({ _id: id, spaceId }),
    { projection: NEVER_RETURNED_PROJECTION }) as EdgeDoc | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };
  const $unset: Record<string, unknown> = {};

  if (updates.suppressEmbeddings !== undefined) $set['suppressEmbeddings'] = updates.suppressEmbeddings;
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
  {
    const finalLabel = ('label' in $set ? $set['label'] : existing.label) as string;
    const finalProps = ('properties' in $unset ? {}
      : ('properties' in $set ? $set['properties'] : existing.properties)) as Record<string, string | number | boolean> | undefined;
    /*
     * The same resolution as the upsert path. A patch cannot move an endpoint — the triplet is the identity —
     * but it CAN change the label, and the rules belong to the label: patching `works_with` to `reports_to`
     * has to be checked against `reports_to`'s ends.
     */
    const resolvedEnds = await resolveEdgeEndsForWrite(spaceId, existing.from, existing.to, finalLabel,
      { ...(existing.fromKind ? { fromKind: existing.fromKind } : {}),
        ...(existing.toKind ? { toKind: existing.toKind } : {}) });
    const check = classifyEdgeUpsertAgainst(getSpaceMeta(spaceId), existing,
      { label: finalLabel, properties: finalProps }, resolvedEnds);
    if (check.blocked) throw new SchemaViolationError(check);
    onValidation?.(check);
  }

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
  if (updates.label !== undefined && updates.label !== existing.label) {
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
    const carried = { ...$set };
    delete carried['seq'];   // `rekeyEdge` takes its own, after the tombstone's — see its docblock
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
    const session = getMongo().startSession();
    let moved: EdgeRekey | null;
    try {
      // The callback's value is the transaction's value, so the result is read out rather than assigned into
      // an outer variable — a closure write is invisible to the type narrowing and would type as `never`.
      moved = await session.withTransaction(
        async () => rekeyEdge(spaceId, existing, { label: newLabel }, carried, Object.keys($unset), session),
      );
    } finally {
      await session.endSession();
    }
    if (moved) {
      // The queue AFTER the write, and here rather than inside `rekeyEdge` — see `embedQueueWorkFor`. There
      // is no transaction on this path, so the write is already durable. The embed text is built from the
      // label and the endpoint names, so a re-key always changes it.
      const work = embedQueueWorkFor(moved);
      await retireEmbedJob(spaceId, 'edge', work.retire);
      await enqueueEmbedJob(spaceId, 'edge', work.enqueue);
      brainWriteSeqTotal.labels({
        collection: 'edges', outcome: writeOutcome(true, ifMatchSeq !== undefined, false),
      }).inc();
      // `rekeyEdge` has already applied the whole-field removals to the STORED document, so this copy needs
      // only the dotted `deleteFields` paths, which reach inside `properties` rather than removing a field.
      const out = { ...moved.edge };
      if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
        applyDeleteFields(out as unknown as Record<string, unknown>, deleteFieldsPaths);
      }
      if (actor) emitWebhookEvent({ event: 'edge.updated', spaceId, entry: { ...out, embedding: undefined }, ...actor });
      // `rekeyEdge` already strips, and this is still not redundant: a reader here cannot see that, and the
      // pairing of a stripped webhook with an unstripped return is exactly the shape that leaked on four
      // record kinds. The guarantee belongs where the document leaves the function.
      return withoutVector(out);
    }
  }

  const updateOp: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
  // Lost-update detection, identical to `updateFact` and for the same reason: `returnDocument: "before"`
  // hands back the record as it was at WRITE time, so comparing its seq with the one read at the top of this
  // function is exactly the test for another writer landing in the window. Observation only — no write that
  // previously succeeded is now rejected.
  const beforeWrite = await collection.findOneAndUpdate(
    asFilter<EdgeDoc>(writeFilterFor(id, ifMatchSeq)),
    asUpdate<EdgeDoc>(updateOp),
    { returnDocument: 'before' },
  ) as EdgeDoc | null;
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
  await enqueueEmbedJob(spaceId, 'edge', result._id);
  if (actor) emitWebhookEvent({ event: 'edge.updated', spaceId, entry: { ...result, embedding: undefined }, ...actor });
  return result;
}

/**
 * The three synthetic link labels, re-exported from where a link is DEFINED.
 *
 * They were declared here, beside the one traversal that emitted them. A second traversal now emits the same
 * three, so they moved onto `LinkClass` — a label is part of what a link is, not part of one walk. These
 * names stay because they are what `edgeLabels` callers and four test suites already spell.
 */
// `!` because `LINK_CLASSES` declares all three — a missing one is a programming error, not a runtime state.
export const CHRONO_LINK_LABEL = linkClassFor('chrono', 'entity')!.label;
export const FACT_LINK_LABEL = linkClassFor('fact', 'entity')!.label;
export const FILE_LINK_LABEL = linkClassFor('file', 'entity')!.label;

/**
 * Every synthetic link label, all six.
 *
 * The three named constants above are the ENTITY classes and keep their names because `edgeLabels`
 * callers and four test suites already spell them. They are no longer the whole set: three more classes
 * gained readers in 4.0, and a caller building an `edgeLabels` filter from the three would silently
 * exclude the other half of the graph.
 */
export const ALL_LINK_LABELS: readonly string[] = LINK_CLASSES.map(c => c.label);

/**
 * BFS graph traversal from a starting entity.
 *
 * ── Chrono entries are nodes ──────────────────────────────────────────────────────────────────────────────
 *
 * `chrono.entityIds` is the only thing linking a chrono to the graph, and until now it was legible to
 * `query()` and invisible to `traverse` — which is the retrieval path an agent reaches for first. An
 * integrator measured the cost: reconstructing a 33-day hardware-RMA timeline took four `query()` calls plus
 * two repo greps, and the first pass still missed the actual carrier ticket, which had to be found by a name
 * regex instead of by traversal from the incident.
 *
 * So a chrono whose `entityIds` contains a frontier node is reached as though it were joined by an INBOUND
 * edge — which is what that field is. No schema change and no migration: the link already exists, it simply
 * had no reader here.
 *
 * **On by default, because the defect was discoverability.** A flag defaulting to off leaves the graph
 * looking the same to everyone who does not already know the answer. What that costs is a response that can
 * now contain a node from another collection, so every chrono node carries `kind: 'chrono'` and entity nodes
 * are unchanged down to the byte. `includeChrono: false` restores the old shape for a client that assumed
 * one collection.
 *
 * The synthetic edge is labelled `chrono.entityIds` and carries its OWN id — see `syntheticEdgeId`. It used
 * to reuse the chrono's `_id`, on a rationale that was the opposite of true.
 *
 * @param memberIds  Space IDs to search for edges and entities (supports proxy spaces).
 * @param startId    UUID of the starting entity.
 * @param direction  Follow edges from the node (outbound), to the node (inbound), or both.
 * @param edgeLabels If provided, only traverse edges with one of these labels. Also filters the synthetic
 *                   chrono link, which is labelled `chrono.entityIds`.
 * @param maxDepth   Maximum hop count from startId (hard cap enforced by caller).
 * @param limit      Maximum total nodes to return.
 */
export async function traverseGraph(
  memberIds: string[],
  startId: string,
  direction: 'outbound' | 'inbound' | 'both' = 'outbound',
  edgeLabels?: string[],
  maxDepth = 3,
  limit = 100,
  /**
   * Follow `chrono.entityIds` as inbound links, so a chrono entry is reachable from the entities it is
   * about. Default ON — see the note above the function.
   */
  includeChrono = true,
  /**
   * Follow `fact.entityIds` the same way, so a fact about an entity is reachable from it.
   *
   * **Default OFF, unlike chrono, and the asymmetry is deliberate.** Chrono defaults on because chrono
   * entries are both invisible otherwise and sparse — an incident has ten, not ten thousand. Facts are
   * usually the most numerous record type in a space, and every node emitted counts against `limit`: on by
   * default, a fact-heavy space would fill the answer with facts and truncate away the entities the
   * caller traversed for. A flag that silently starves the primary result is worse than one you have to know
   * about, so this one is opt-in.
   */
  includeMemories = false,
  /**
   * Follow `file.entityIds`, so a document about an entity is reachable from it. Opt-in for the same reason as
   * facts, and the node carries **file meta only** — path, description, tags. Never chunk text: a file's
   * body is its chunks, they are the largest thing the product stores, and a structural walk must not pay for
   * them.
   */
  includeFiles = false,
  /**
   * Whether the returned answer carries the edge list.
   *
   * This does NOT change the walk. Edges are how the graph is traversed, so declining to follow them would
   * return a different set of nodes rather than a smaller payload — the flag is about what comes back, not
   * about what is visited.
   */
  includeEdges = true,
): Promise<TraverseResult> {
  // Set by a link scan that stopped reading rather than running out of matches. It cannot be answered on the
  // spot: the hop's records are already read and belong in the result, so the walk finishes and reports here.
  let scanCapped = false;
  const visited = new Set<string>([startId]);
  // frontier: nodes whose outgoing edges we need to explore at the current depth
  let frontier: string[] = [startId];
  let frontierSet = new Set<string>(frontier);
  let currentDepth = 0;
  const resultNodes: TraverseNode[] = [];
  const resultEdges: TraverseEdge[] = [];

  // Three return sites below, and every one of them owed the same decision about the edge list. A rule copied
  // three times is a rule that will eventually disagree with itself, so it is written once here.
  const answer = (truncated: boolean): TraverseResult =>
    ({ nodes: resultNodes, edges: includeEdges ? resultEdges : [], truncated: truncated || edgeScanCapped });

  /**
   * Set when a hop's EDGE read hit its budget (W-11). Read by every return site through `answer` above, for the
   * reason that comment gives: three return sites each owing the same decision is a rule that will disagree
   * with itself.
   *
   * Separate from the link scan's `scanCapped` only because they are set in different places; they mean the
   * same thing and are reported through the same flag.
   */
  let edgeScanCapped = false;

  while (frontier.length > 0 && currentDepth < maxDepth) {
    // Batch-fetch all edges for the current frontier across all member spaces
    const adjacentEdges: EdgeDoc[] = [];
    for (const mid of memberIds) {
      /*
       * BOUNDED, and the bound is documents rather than nodes (W-11).
       *
       * This was `.find(...).toArray()` with no limit, so one hub entity read its entire edge set into fact
       * per hop per member space. `limit` reads as the ceiling and is not: it counts nodes EMITTED, and a
       * neighbour that is already visited or is not an entity is skipped without spending any of it. So the
       * flag stayed quiet in exactly the case where the read was largest — a hub whose edges mostly lead back
       * where you came from.
       *
       * `+ 1` is how truncation is DETECTED rather than guessed: reading one more than the budget says whether
       * there was more, without reading how much more.
       *
       * Same shape as `linkedRecordsAtFrontier` beside it, deliberately — that scan already took a budget and
       * returned `scanCapped`, and its docblock carries the reasoning this comment is short for. Two
       * implementations of one rule is what `frontierEdgeQuery` was extracted to stop; the BOUND is the same
       * kind of rule and belongs on both.
       */
      const hopBudget = Math.max(0, limit - resultNodes.length);
      const q = frontierEdgeQuery(mid, frontier, { edgeLabels, direction });
      const edges = await col<EdgeDoc>(`${mid}_edges`)
        .find(asFilter<EdgeDoc>(q), { projection: NEVER_RETURNED_PROJECTION })
        .limit(hopBudget + 1).toArray() as EdgeDoc[];
      if (edges.length > hopBudget) {
        // A capped scan is a truncation even when the answer never fills up: the budget was spent on documents
        // that are then discarded, so "it did not fill up" says nothing about whether it is complete.
        edgeScanCapped = true;
        edges.length = hopBudget;
      }
      adjacentEdges.push(...edges);
    }

    // Collect new neighbor IDs (not yet visited) and their traversed edges
    const newNeighborIds: string[] = [];
    const edgesForNewNeighbors: EdgeDoc[] = [];
    for (const edge of adjacentEdges) {
      let neighborId: string;
      if (direction === 'outbound') {
        neighborId = edge.to;
      } else if (direction === 'inbound') {
        neighborId = edge.from;
      } else {
        // For 'both', skip if both ends are in the current frontier (same-level connection)
        if (frontierSet.has(edge.from) && frontierSet.has(edge.to)) continue;
        neighborId = frontierSet.has(edge.from) ? edge.to : edge.from;
      }
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      newNeighborIds.push(neighborId);
      edgesForNewNeighbors.push(edge);
    }

    // Linked records that point AT the current frontier. `entityIds` is an inbound link in everything but
    // name, so this reads it as one — see the note above the function.
    //
    // Collected BEFORE the early break, and counted by it. Keying the break on entity neighbours alone meant
    // an entity whose only link is a timeline returned nothing at all — which is the reported scenario, not
    // an edge case: an incident with ten chrono entries and no edges is exactly what someone traverses from.
    // Verified against a running server; the source-level gate passed happily either way.
    //
    // Three blocks until 3.6, one per class, differing in the small. `linkedRecordsAtFrontier` is now the
    // only implementation and recall's expansion calls the same one.
    // Bounded by THIS walk's node cap. Without it one hub entity returns its whole mention set per class per
    // member space per hop, and the cap below cannot help because it counts records after they are hydrated.
    const { records: linkedHere, scanCapped: hopScanCapped } = await linkedRecordsAtFrontier(
      memberIds, frontier, frontierSet, visited,
      { includeChrono, includeMemories, includeFiles }, edgeLabels,
      Math.max(0, limit - resultNodes.length));

    /*
     * A capped scan is a truncation even when the result never fills up, and that is the whole point: the
     * bound is spent on documents that are then discarded, so this loop can burn its budget on records
     * already visited and still exit below `limit`. The check on `resultNodes.length` is the only other
     * truncation signal here, and it cannot see that.
     *
     * Remembered rather than returned on: this hop's records HAVE been read and belong in the answer, so
     * leaving here would throw away the very work the bound was spent on. The flag is read at the bottom.
     */
    if (hopScanCapped) scanCapped = true;

    if (newNeighborIds.length === 0 && linkedHere.length === 0) break;

    // Batch-fetch entity docs for all new neighbors
    const entityMap = new Map<string, EntityDoc>();
    for (const mid of memberIds) {
      const entities = await col<EntityDoc>(`${mid}_entities`)
        .find(asFilter<EntityDoc>({ _id: { $in: newNeighborIds }, spaceId: mid }),
          { projection: NEVER_RETURNED_PROJECTION })
        .toArray() as EntityDoc[];
      for (const e of entities) entityMap.set(e._id, e);
    }


    // Build results for this depth level
    const nextFrontier: string[] = [];
    for (let i = 0; i < newNeighborIds.length; i++) {
      const neighborId = newNeighborIds[i];
      const entity = entityMap.get(neighborId);
      if (!entity) continue;

      const edge = edgesForNewNeighbors[i];
      resultEdges.push({ _id: edge._id, from: edge.from, to: edge.to, label: edge.label });
      resultNodes.push({ _id: entity._id, name: entity.name, type: entity.type, depth: currentDepth + 1 });

      if (resultNodes.length >= limit) {
        return answer(true);
      }

      nextFrontier.push(neighborId);
    }

    // A linked record is emitted at this depth but does NOT join the next frontier: it links to entities,
    // never to another record of its own kind, so expanding from one would only walk back to entities
    // already visited. Files carry their meta — never chunk text, which is what the class projection is for.
    for (const rec of linkedHere) {
      resultEdges.push({
        _id: syntheticEdgeId(rec.label, rec.via, rec.doc._id), from: rec.via, to: rec.doc._id, label: rec.label,
      });
      const file = rec.kind === 'file' ? rec.doc as FileMetaDoc : undefined;
      resultNodes.push({
        _id: rec.doc._id, name: linkedRecordName(rec), type: linkedRecordType(rec),
        depth: currentDepth + 1, kind: rec.kind,
        ...(file?.description ? { description: file.description } : {}),
        ...(file?.tags && file.tags.length > 0 ? { tags: file.tags } : {}),
      });
      if (resultNodes.length >= limit) {
        return answer(true);
      }
    }

    frontier = nextFrontier;
    frontierSet = new Set<string>(frontier);
    currentDepth++;
  }

  // NOT `answer(false)`. The walk ran out of frontier, which is what a complete neighbourhood looks like —
  // and also what a neighbourhood looks like when a scan stopped reading and the records it would have
  // reached were never added to it. Only the flag can tell those apart.
  return answer(scanCapped);
}

// The recall-augmenting traversal lives in `recall-seed-traversal.ts` (A-4): 374 lines, and a different
// subject from the walk above — that one starts at ONE node, this one at the records a search matched.
// `frontierEdgeQuery` and `TraverseNarrowing`, which BOTH use, went sideways into `frontier-query.ts`.
