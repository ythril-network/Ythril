/**
 * Entity merge engine.
 *
 * Computes a MergePlan for two entities (survivor + absorbed), then either
 * returns the plan as a 409-style conflict (when unresolved keys remain)
 * or executes the merge atomically (when all conflicts are resolved).
 *
 * The merge logic is intentionally ID-agnostic — it works on any two entity
 * IDs in the same space.  Candidate discovery is the caller's responsibility.
 */

import { col, getMongo, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { NUMERIC_MERGE_FNS, BOOLEAN_MERGE_FNS } from '../config/types-knowledge.js';
import { embed } from './embedding.js';
import { entityEmbedText } from './embed-text.js';
import { getEntityById } from './entities.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { mergeTags } from './merge-fields.js';
import { edgeIdFor } from './edge-id.js';
import { rekeyEdge, embedQueueWorkFor } from './edge-rekey.js';
import { enqueueEmbedJob, retireEmbedJob } from './embed-queue.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { validateEdge } from '../spaces/schema-validation.js';
import type { ResolvedEdgeEnds } from '../spaces/schema-validation.js';
import { validateEntity, getSpaceMeta, applyValidation, type SchemaViolation } from '../spaces/schema-validation.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { EntityDoc, EdgeDoc, MemoryDoc, ChronoEntry, FileMetaDoc, TombstoneDoc, SpaceMeta, PropertySchema } from '../config/types.js';

// ── Public types ───────────────────────────────────────────────────────────

/** A single property conflict between two entities. */
export interface PropertyConflict {
  key: string;
  type: string;
  survivorValue: unknown;
  absorbedValue: unknown;
  suggestedFn?: string;
  resolved: boolean;
  resolution?: string;
  customValue?: unknown;
}

/** A property that only exists on the absorbed entity — auto-added on merge. */
export interface AbsorbedOnlyProperty {
  key: string;
  value: unknown;
}

/** Warning about edges that will become duplicates after relinking. */
export interface DuplicateEdgeWarning {
  /** ID of the first (survivor-side) edge. */
  survivorEdgeId: string;
  /** ID of the duplicate (absorbed-side) edge after relinking. */
  absorbedEdgeId: string;
  from: string;
  to: string;
  label: string;
}

/**
 * An edge whose label's endpoint or cardinality rule the relink will break.
 *
 * ## Why this is a warning and not a refusal
 *
 * `DuplicateEdgeWarning` above set the precedent: merge reports what relinking will do and lets the operator
 * proceed. Refusing would leave somebody unable to merge two duplicate entities because a rule was declared
 * after the fact — and the merge is the repair for exactly that. It is the same reasoning `preExisting` exists
 * for on the write path: a schema declared later must never make the records it describes unmaintainable.
 *
 * ## Why a merge can do what no write can
 *
 * Since S-3 every path that CREATES an edge refuses a broken endpoint rule, because they all go through
 * `upsertEdge`. A merge creates nothing: it rewrites the `from` or `to` of every edge touching the absorbed
 * entity, on the collection, inside a transaction. So this was the one way left to move an edge onto an end
 * its label forbids — and a merge is how an operator fixes a record typed wrongly, which makes "the two
 * entities have different types" the normal case rather than a mistake.
 */
export interface EndpointRuleWarning {
  /** The edge that will be relinked. */
  edgeId: string;
  label: string;
  /**
   * Which end of this edge the merge moves — and the ONLY end reported.
   *
   * The other end is not changed by the merge. If it already breaks the rule that is stored data, and
   * `POST /validate-schema` is what reports those; repeating it here would make a preview look like it had
   * caused a violation it merely found, and the operator cannot fix it by merging anyway.
   *
   * `both` is a self-loop on the absorbed entity, where the relink moves the whole edge.
   */
  end: 'from' | 'to' | 'both';
  /** `fromType`, `toType` or `functional` — the same field names the write path refuses with. */
  field: string;
  /** What the label admits, in the same words a refused write would give. */
  reason: string;
}

/** The full merge plan returned on 409 when unresolved conflicts exist. */
export interface MergePlan {
  survivorId: string;
  absorbedId: string;
  propertyConflicts: PropertyConflict[];
  absorbedOnlyProperties: AbsorbedOnlyProperty[];
  duplicateEdgeWarnings: DuplicateEdgeWarning[];
  /**
   * Edges the relink will move onto an end their label forbids. Reported, never blocking — see
   * `EndpointRuleWarning`, and `fullyResolved` deliberately does not consult this.
   */
  endpointRuleWarnings: EndpointRuleWarning[];
}

/** Resolution provided by the caller for a single property. */
export interface PropertyResolution {
  key: string;
  resolution: string;       // "survivor" | "absorbed" | "fn:<name>" | "custom"
  customValue?: unknown;
}

// ── Numeric merge functions ────────────────────────────────────────────────

const NUMERIC_FNS: Record<string, (a: number, b: number) => number> = {
  avg:   (a, b) => (a + b) / 2,
  min:   (a, b) => Math.min(a, b),
  max:   (a, b) => Math.max(a, b),
  sum:   (a, b) => a + b,
};

const BOOLEAN_FNS: Record<string, (a: boolean, b: boolean) => boolean> = {
  and: (a, b) => a && b,
  or:  (a, b) => a || b,
  xor: (a, b) => a !== b,
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Determine the type of a property: use schema declaration first, infer from value otherwise. */
function resolvePropertyType(
  key: string,
  value: unknown,
  schemas?: Record<string, PropertySchema>,
): string {
  const schema = schemas?.[key];
  if (schema?.type) return schema.type;
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return t;
  if (value !== null && typeof value === 'object') return 'object';
  return 'unknown';
}

/** Get the schema-declared mergeFn for a property, if any. */
function getSuggestedFn(key: string, schemas?: Record<string, PropertySchema>): string | undefined {
  return schemas?.[key]?.mergeFn;
}

// ── Plan computation ───────────────────────────────────────────────────────

/**
 * Compute a MergePlan for two entities in the same space.
 *
 * If `resolutions` are provided, they are applied to the plan — conflicts that
 * match a resolution entry are marked `resolved: true`.
 *
 * Returns the plan plus a `fullyResolved` boolean indicating whether all
 * conflicts have been addressed.
 */
export async function computeMergePlan(
  spaceId: string,
  survivorId: string,
  absorbedId: string,
  resolutions: PropertyResolution[] = [],
): Promise<{ plan: MergePlan; fullyResolved: boolean; survivor: EntityDoc; absorbed: EntityDoc } | { error: string; status: number }> {
  const survivor = await getEntityById(spaceId, survivorId);
  if (!survivor) return { error: `Survivor entity '${survivorId}' not found`, status: 404 };

  const absorbed = await getEntityById(spaceId, absorbedId);
  if (!absorbed) return { error: `Absorbed entity '${absorbedId}' not found`, status: 404 };

  const meta = getConfig().spaces.find(s => s.id === spaceId)?.meta;
  const entitySchemas = meta?.typeSchemas?.entity?.[survivor.type ?? '']?.propertySchemas;

  const resolutionMap = new Map(resolutions.map(r => [r.key, r]));

  // ── Property conflicts ────────────────────────────────────────────────
  const propertyConflicts: PropertyConflict[] = [];
  const absorbedOnlyProperties: AbsorbedOnlyProperty[] = [];

  const survivorProps = survivor.properties ?? {};
  const absorbedProps = absorbed.properties ?? {};

  // Check all absorbed property keys
  for (const key of Object.keys(absorbedProps)) {
    if (key in survivorProps) {
      // Both have this key — conflict if values differ
      if (survivorProps[key] !== absorbedProps[key]) {
        const type = resolvePropertyType(key, survivorProps[key], entitySchemas);
        const suggestedFn = getSuggestedFn(key, entitySchemas);
        const res = resolutionMap.get(key);
        const resolved = !!res;

        propertyConflicts.push({
          key,
          type,
          survivorValue: survivorProps[key],
          absorbedValue: absorbedProps[key],
          ...(suggestedFn ? { suggestedFn } : {}),
          resolved,
          ...(resolved ? { resolution: res!.resolution, ...(res!.customValue !== undefined ? { customValue: res!.customValue } : {}) } : {}),
        });
      }
      // Same value → no conflict, survivor value kept
    } else {
      // Only on absorbed — will be auto-added
      absorbedOnlyProperties.push({ key, value: absorbedProps[key] });
    }
  }

  // ── Duplicate edge warnings ───────────────────────────────────────────
  const duplicateEdgeWarnings = await detectDuplicateEdges(spaceId, survivorId, absorbedId);

  // ── Endpoint / cardinality rules the relink will break ────────────────
  const endpointRuleWarnings = await detectEndpointRuleBreaks(spaceId, survivor, absorbedId);

  const plan: MergePlan = {
    survivorId,
    absorbedId,
    propertyConflicts,
    absorbedOnlyProperties,
    duplicateEdgeWarnings,
    endpointRuleWarnings,
  };

  /*
   * `endpointRuleWarnings` is deliberately NOT consulted here. Only an unresolved PROPERTY conflict makes a
   * plan unresolved, because only that has an answer the caller has to supply. A broken endpoint rule has no
   * resolution to offer — the operator either wants the merge or does not — so folding it in would turn a
   * report into a refusal and leave duplicates unmergeable in any space that declared a rule late.
   */
  const fullyResolved = propertyConflicts.every(c => c.resolved);

  return { plan, fullyResolved, survivor, absorbed };
}

/**
 * Which relinked edges will break their label's endpoint or cardinality rule.
 *
 * Decided by `validateEdge`, the same pure function the write path refuses with, called with a
 * `ResolvedEdgeEnds` describing the END THAT MOVES and nothing else. That is what an absent field in that
 * object means — *the caller did not look* — so the other end reports nothing, which is exactly the behaviour
 * this needs and the reason not to re-implement the comparison here.
 *
 * The violations are filtered to the endpoint fields: `validateEdge` also checks the label allowlist and the
 * property schemas, and a merge changes neither. Reporting those would tell an operator their merge caused
 * something that was stored before they started.
 */
async function detectEndpointRuleBreaks(
  spaceId: string,
  survivor: EntityDoc,
  absorbedId: string,
): Promise<EndpointRuleWarning[]> {
  const meta = getSpaceMeta(spaceId);
  const edgeSchemas = meta?.typeSchemas?.edge;
  // Nothing declared, nothing to break — and this is the common case, so it costs one config read.
  if (!edgeSchemas || Object.keys(edgeSchemas).length === 0) return [];

  const edgeColl = col<EdgeDoc>(`${spaceId}_edges`);
  const moving = await edgeColl
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: absorbedId }, { to: absorbedId }] }))
    .toArray() as EdgeDoc[];
  if (moving.length === 0) return [];

  /*
   * How many edges each (subject, label) pair will hold AFTER the relink — the number `functional` is about,
   * and a merge is the only operation that can raise it without writing an edge. Two people each reporting to
   * somebody is legitimate; merging them leaves one person with two managers, and no write created that.
   *
   * Counted over the survivor's own edges plus the moving ones, with the relink applied to both ends.
   */
  const survivorEdges = await edgeColl
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: survivor._id }, { to: survivor._id }] }))
    .toArray() as EdgeDoc[];
  const afterFrom = (e: EdgeDoc) => (e.from === absorbedId ? survivor._id : e.from);
  const afterTo = (e: EdgeDoc) => (e.to === absorbedId ? survivor._id : e.to);
  const subjectCounts = new Map<string, Set<string>>();
  for (const e of [...survivorEdges, ...moving]) {
    const key = `${afterFrom(e).length}:${afterFrom(e)}${e.label}`;
    // Keyed by the DISTINCT object, because identity is the triplet: two rows that relink onto the same
    // (from, to, label) are one edge afterwards, which is what `duplicateEdgeWarnings` is separately about.
    if (!subjectCounts.has(key)) subjectCounts.set(key, new Set());
    subjectCounts.get(key)!.add(afterTo(e));
  }

  const out: EndpointRuleWarning[] = [];
  for (const e of moving) {
    const isFrom = e.from === absorbedId;
    const isTo = e.to === absorbedId;
    const end: 'from' | 'to' | 'both' = isFrom && isTo ? 'both' : isFrom ? 'from' : 'to';

    /*
     * Only the moving end is resolved. `validateEdge` reports on a field only when it was given one, so the
     * unmoved end cannot produce a row — which is the whole reason the resolved-ends object distinguishes
     * `undefined` (not looked) from `null` (looked, untyped).
     */
    const resolved: ResolvedEdgeEnds = {
      ...(isFrom ? { fromType: survivor.type ?? null } : {}),
      ...(isTo ? { toType: survivor.type ?? null } : {}),
    };
    // `functional` counts the OTHER edges from the subject, so the edge being examined is excluded.
    if (isFrom) {
      const key = `${survivor._id.length}:${survivor._id}${e.label}`;
      const distinct = subjectCounts.get(key)?.size ?? 1;
      resolved.otherEdgesFromSubject = Math.max(0, distinct - 1);
    }

    for (const v of validateEdge(meta ?? {}, { label: e.label, properties: e.properties ?? {} }, resolved)) {
      if (v.field !== 'fromType' && v.field !== 'toType' && v.field !== 'functional') continue;
      out.push({ edgeId: e._id, label: e.label, end, field: v.field, reason: v.reason });
    }
  }
  return out;
}

/** Detect edges that would become duplicates (same from, to, label) after relinking. */
async function detectDuplicateEdges(
  spaceId: string,
  survivorId: string,
  absorbedId: string,
): Promise<DuplicateEdgeWarning[]> {
  const edgeColl = col<EdgeDoc>(`${spaceId}_edges`);

  // All edges currently referencing the absorbed entity
  const absorbedEdges = await edgeColl
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: absorbedId }, { to: absorbedId }] }))
    .toArray() as EdgeDoc[];

  // All edges currently referencing the survivor entity
  const survivorEdges = await edgeColl
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: survivorId }, { to: survivorId }] }))
    .toArray() as EdgeDoc[];

  const warnings: DuplicateEdgeWarning[] = [];

  // Build a set of (from, to, label) triplets from survivor edges
  const survivorTriplets = new Map<string, string>(); // triplet key → edge ID
  for (const e of survivorEdges) {
    // Keyed on the derivation, for the reason spelled out at the relink: a joined string collides two
    // distinct relationships the moment a label contains the separator, and reports them as duplicates.
    survivorTriplets.set(edgeIdFor(e.from, e.to, e.label, e.fromKind, e.toKind), e._id);
  }

  // For each absorbed edge, compute what its triplet would be after relinking
  for (const e of absorbedEdges) {
    const newFrom = e.from === absorbedId ? survivorId : e.from;
    const newTo = e.to === absorbedId ? survivorId : e.to;
    // Relinking substitutes one ENTITY id for another, so the kinds are unchanged by it and travel with the
    // edge. Dropping them would report two edges that differ only in endpoint kind as duplicates of each other.
    const key = edgeIdFor(newFrom, newTo, e.label, e.fromKind, e.toKind);
    const survivorEdgeId = survivorTriplets.get(key);
    if (survivorEdgeId) {
      warnings.push({
        survivorEdgeId,
        absorbedEdgeId: e._id,
        from: newFrom,
        to: newTo,
        label: e.label,
      });
    }
  }

  return warnings;
}

// ── Resolution application ─────────────────────────────────────────────────

/**
 * Property keys that must never be written through a computed index, or they
 * would mutate the object prototype instead of adding a data property.
 */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key` is safe to assign as a plain data property. */
function isSafeKey(key: string): boolean {
  return !PROTO_KEYS.has(key);
}

/**
 * Apply resolved property values and return the final merged properties.
 *
 * Prototype-polluting keys (`__proto__`, `constructor`, `prototype`) are
 * rejected before assignment. Object spread copies data properties (it does not
 * invoke the `__proto__` setter), so the danger is only the computed
 * `result[key] = value` writes below — which `isSafeKey` guards. Merge property
 * values are only scalars today, so the blast radius was small, but this keeps
 * the pattern out of a path that assigns user/peer-supplied keys.
 */
export function applyResolutions(
  survivorProps: Record<string, string | number | boolean>,
  absorbedProps: Record<string, string | number | boolean>,
  conflicts: PropertyConflict[],
  absorbedOnly: AbsorbedOnlyProperty[],
): Record<string, string | number | boolean> {
  const result = { ...survivorProps };

  // Apply absorbed-only properties
  for (const p of absorbedOnly) {
    if (!isSafeKey(p.key)) {
      log.warn(`merge: skipping prototype-polluting property key '${p.key}'`);
      continue;
    }
    result[p.key] = p.value as string | number | boolean;
  }

  // Apply conflict resolutions
  for (const c of conflicts) {
    if (!isSafeKey(c.key)) {
      log.warn(`merge: skipping prototype-polluting property key '${c.key}'`);
      continue;
    }
    const resolution = c.resolution!;
    if (resolution === 'survivor') {
      // Keep survivor value (already in result)
      continue;
    } else if (resolution === 'absorbed') {
      result[c.key] = c.absorbedValue as string | number | boolean;
    } else if (resolution === 'custom') {
      if (c.customValue !== undefined) {
        result[c.key] = c.customValue as string | number | boolean;
      }
    } else if (resolution.startsWith('fn:')) {
      const fnName = resolution.slice(3);
      if (c.type === 'number' && NUMERIC_FNS[fnName]) {
        result[c.key] = NUMERIC_FNS[fnName](c.survivorValue as number, c.absorbedValue as number);
      } else if (c.type === 'boolean' && BOOLEAN_FNS[fnName]) {
        result[c.key] = BOOLEAN_FNS[fnName](c.survivorValue as boolean, c.absorbedValue as boolean);
      } else {
        // Validation should prevent reaching this branch — log a warning so mismatches are diagnosable.
        log.warn(`merge: fn '${fnName}' not applicable for type '${c.type}' on property '${c.key}' — keeping survivor value`);
      }
    }
  }

  return result;
}

// ── Merge execution ────────────────────────────────────────────────────────

/**
 * Compare two edge documents ignoring `_id`, `seq`, `updatedAt` — returns true
 * when every other field is identical (i.e. one is a true duplicate of the other
 * after relinking).
 */
function edgesIdentical(a: EdgeDoc, b: EdgeDoc): boolean {
  return a.from === b.from
    && a.to === b.to
    && a.label === b.label
    && a.spaceId === b.spaceId
    && a.type === b.type
    && a.weight === b.weight
    && a.description === b.description
    && JSON.stringify(a.properties ?? {}) === JSON.stringify(b.properties ?? {})
    && JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? []);
}

/**
 * Execute the merge inside a MongoDB transaction: relink edges/memories/chronos,
 * auto-delete duplicate edges (when 100% identical except _id), apply resolved
 * properties to survivor, delete absorbed entity + write tombstone.
 *
 * Precondition: all property conflicts must be resolved before calling this.
 */
/**
 * A merge refused because the survivor would violate its own space's schema.
 *
 * Typed rather than a bare `Error` so a caller can tell "this merge is not allowed" from "the merge broke".
 * `dupe-scanner.ts` runs `automerge` unattended and must be able to count refusals without parsing prose — a
 * refusal it cannot see is the do-nothing option wearing the strict option's name.
 */
export class MergeSchemaViolation extends Error {
  constructor(
    readonly survivorId: string,
    readonly absorbedId: string,
    readonly spaceId: string,
    readonly violations: SchemaViolation[],
  ) {
    super(
      `merge refused: the survivor '${survivorId}' would violate the schema of space '${spaceId}' after `
      + `absorbing '${absorbedId}' — ${violations.map(v => `${v.field}: ${v.reason}`).join('; ')}`,
    );
    this.name = 'MergeSchemaViolation';
  }
}

export async function executeMerge(
  spaceId: string,
  survivor: EntityDoc,
  absorbed: EntityDoc,
  mergedProperties: Record<string, string | number | boolean>,
  actor?: WebhookActor,
): Promise<{ entity: EntityDoc; deletedDuplicateEdgeIds: string[] }> {
  /** Embed-queue work from re-keyed edges, drained once the transaction has committed. */
  const rekeyedEdgeJobs: { retire: string; enqueue: string }[] = [];
  const session = getMongo().startSession();
  const deletedDuplicateEdgeIds: string[] = [];

  try {
    await session.withTransaction(async () => {
      const now = new Date().toISOString();
      const seq = await nextSeq(spaceId);

      const edgeColl = col<EdgeDoc>(`${spaceId}_edges`);

      // ── 1. Relink edges ────────────────────────────────────────────────
      // Unique compound index on (spaceId, from, to, label) means we must
      // detect and delete absorbed edges that would collide BEFORE relinking.
      // Handle self-loops: when absorbed has an edge A→A, both from and to
      // need to become survivor.

      // Collect all absorbed edges (from=absorbed OR to=absorbed).
      const absorbedEdges = await edgeColl
        .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: absorbed._id }, { to: absorbed._id }] }), { session })
        .toArray() as EdgeDoc[];

      // Build a set of existing survivor edge keys for collision detection.
      const survivorEdges = await edgeColl
        .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: survivor._id }, { to: survivor._id }] }), { session })
        .toArray() as EdgeDoc[];
      /*
       * Keyed on the DERIVATION, not on a joined string.
       *
       * It was `${from}|${to}|${label}`, which is ambiguous the moment any part can contain the separator:
       * `('a|b','c','d')` and `('a','b|c','d')` produce one key for two genuinely different relationships,
       * which reports them as duplicates of each other. Endpoint ids are UUIDs, but a LABEL is
       * operator-supplied text and nothing forbids a pipe in it.
       *
       * `edgeIdFor` length-prefixes each part for exactly that reason, and it is also the id the relink now
       * moves the edge onto — so keying on anything else would be a second answer to the question the unique
       * index already settles.
       */
      const survivorKeys = new Set(survivorEdges.map(e => edgeIdFor(e.from, e.to, e.label, e.fromKind, e.toKind)));

      // Phase 1a: delete absorbed edges whose post-relink key collides with
      // an existing survivor edge (would violate the unique index).
      const edgesToRelink: EdgeDoc[] = [];
      for (const edge of absorbedEdges) {
        const newFrom = edge.from === absorbed._id ? survivor._id : edge.from;
        const newTo = edge.to === absorbed._id ? survivor._id : edge.to;
        const postKey = edgeIdFor(newFrom, newTo, edge.label, edge.fromKind, edge.toKind);
        if (survivorKeys.has(postKey)) {
          // This absorbed edge would collide — delete it as a duplicate.
          await edgeColl.deleteOne(asFilter<EdgeDoc>({ _id: edge._id }), { session });
          const tombSeq = await nextSeq(spaceId);
          await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
            asFilter<TombstoneDoc>({ _id: edge._id }),
            asDoc<TombstoneDoc>({ _id: edge._id, type: 'edge', spaceId, deletedAt: now, instanceId: getConfig().instanceId, seq: tombSeq }),
            { upsert: true, session },
          );
          deletedDuplicateEdgeIds.push(edge._id);
        } else {
          edgesToRelink.push(edge);
          // Register the post-relink key so subsequent absorbed edges
          // in the same batch don't collide with each other.
          survivorKeys.add(postKey);
        }
      }

      /*
       * Phase 1b: relink remaining absorbed edges (no collision risk).
       *
       * RE-KEYED rather than `$set`, since 3.6. Relinking an endpoint changes what the edge IS, and an edge's
       * `_id` is derived from `(from, to, label)` — so a `$set` left the edge under an id its own identity no
       * longer derived, and the next peer to create that triplet derived the right id, inserted, and hit the
       * unique index instead of converging. `rekeyEdge` owns the delete-and-insert, the tombstone, and the
       * seq ordering that makes one safe on a synced collection.
       *
       * Phase 1a above has already removed every absorbed edge whose post-relink identity a survivor holds,
       * so `EdgeIdentityTaken` here would mean 1a and the derivation disagree — which is why both now key on
       * `edgeIdFor` rather than on two spellings of the same triplet.
       */
      for (const edge of edgesToRelink) {
        const newFrom = edge.from === absorbed._id ? survivor._id : edge.from;
        const newTo = edge.to === absorbed._id ? survivor._id : edge.to;
        const moved = await rekeyEdge(spaceId, edge, { from: newFrom, to: newTo }, { updatedAt: now }, [], session);
        if (moved) {
          // Collected, not applied: the embed queue takes no session, so touching it here would let the
          // worker act on an edge this transaction has not committed. Drained after `withTransaction`
          // returns — see `embedQueueWorkFor`.
          rekeyedEdgeJobs.push(embedQueueWorkFor(moved));
          continue;
        }
        /*
         * `rekeyEdge` returned null, so the edge stays where it is and the endpoints are written in place —
         * which is what this loop did before 3.6 and what it must still do. Two reasons it declines, and
         * both need this: the identity did not actually change (a self-loop already on the survivor), and
         * the edge was authored by a PEER, whose copy would refuse our tombstone and end up holding two
         * rows. Dropping the write here would leave the edge pointing at the entity the merge just absorbed.
         */
        const updates: Record<string, unknown> = { updatedAt: now, seq: await nextSeq(spaceId) };
        if (edge.from === absorbed._id) updates['from'] = survivor._id;
        if (edge.to === absorbed._id) updates['to'] = survivor._id;
        await edgeColl.updateOne(
          asFilter<EdgeDoc>({ _id: edge._id }),
          asUpdate<EdgeDoc>({ $set: updates }),
          { session },
        );
      }

      // ── 2. Relink memories ─────────────────────────────────────────────
      const memoryColl = col<MemoryDoc>(`${spaceId}_memories`);
      const affectedMemories = await memoryColl
        .find(asFilter<MemoryDoc>({ spaceId, entityIds: absorbed._id }), { session })
        .toArray() as MemoryDoc[];
      for (const mem of affectedMemories) {
        const newEntityIds = mem.entityIds.map(id => id === absorbed._id ? survivor._id : id);
        const dedupedIds = [...new Set(newEntityIds)];
        const memSeq = await nextSeq(spaceId);
        await memoryColl.updateOne(
          asFilter<MemoryDoc>({ _id: mem._id }),
          asUpdate<MemoryDoc>({ $set: { entityIds: dedupedIds, updatedAt: now, seq: memSeq } }),
          { session },
        );
      }

      // ── 3. Relink chrono entries ───────────────────────────────────────
      const chronoColl = col<ChronoEntry>(`${spaceId}_chrono`);
      const affectedChronos = await chronoColl
        .find(asFilter<ChronoEntry>({ spaceId, entityIds: absorbed._id }), { session })
        .toArray() as ChronoEntry[];
      for (const ch of affectedChronos) {
        const newEntityIds = ch.entityIds.map(id => id === absorbed._id ? survivor._id : id);
        const dedupedIds = [...new Set(newEntityIds)];
        const chSeq = await nextSeq(spaceId);
        await chronoColl.updateOne(
          asFilter<ChronoEntry>({ _id: ch._id }),
          asUpdate<ChronoEntry>({ $set: { entityIds: dedupedIds, updatedAt: now, seq: chSeq } }),
          { session },
        );
      }

      // ── 3b. Relink FILE metadata records ───────────────────────────────
      //
      // A file record is a knowledge-graph document like the others and carries `entityIds` — that is how a
      // file is linked to an entity, and `assertRefsResolve` enforces at write time that every id in it names
      // a real entity.
      //
      // This phase was missing. Edges, memories and chrono were relinked and files were not, so a merge left
      // every file whose `entityIds` held the absorbed id pointing at an entity that phase 5 then DELETED.
      // The merge path broke the invariant the write path enforces.
      //
      // It was invisible from every direction: the ER model counts `linkedFrom.files` as a first-class
      // relationship, so the number was simply wrong; `danglingEdges` in that same model counts dangling
      // EDGES and never looked at files; `strictLinkage` blocks deleting an entity that anything still
      // backlinks, and a merge deletes the absorbed entity directly rather than passing that guard. A
      // traversal from the file came back empty, which reads as "nothing linked" rather than as a broken link.
      /*
       * TWO ways a file record can name an entity, and only one of them was relinked.
       *
       * `entityIds` is the array every record type has. **`faceEntityId` is a single-valued field on a face
       * chunk** (`{fileId}#face-chunkN`), and it was missed for a reason worth writing down: the gate that
       * shipped with the `entityIds` fix derives the record kinds it checks from the interfaces that DECLARE
       * `entityIds` — so a differently-named, singular link is outside its scope by construction, and the
       * field it cannot see is the biometric one.
       *
       * What that cost: after a merge, face chunks still pointed at the absorbed id, which phase 5 then
       * deleted. `labelStillResolves` looks the label up and returns null when it does not resolve, so every
       * one of those faces silently stopped counting — the surviving person's gallery went empty, and nothing
       * anywhere said so. A delete has `unlabelFacesForEntities` for exactly this; a merge had nothing.
       *
       * **Relinked, not unlabelled**, and that is the whole difference from the delete path. A delete means
       * the person is gone, so the labels are wrong and clearing them is right. A merge means these two
       * records were always the SAME person — so the absorbed one's faces are the survivor's faces, and
       * clearing them would throw away correct biometric labels the operator asked to keep. `faceScore` rides
       * along for the same reason: it measures "how sure are we this face is that person", and the merge is a
       * statement that the person did not change.
       *
       * One pass over both, rather than a second loop: a face chunk may also carry `entityIds`, and two
       * updates would spend two `seq` values on one record and let the two halves drift apart later.
       */
      const fileColl = col<FileMetaDoc>(`${spaceId}_files`);
      const affectedFiles = await fileColl
        .find(asFilter<FileMetaDoc>({
          spaceId,
          $or: [{ entityIds: absorbed._id }, { faceEntityId: absorbed._id }],
        }), { session })
        .toArray() as FileMetaDoc[];
      for (const f of affectedFiles) {
        const set: Record<string, unknown> = { updatedAt: now, seq: await nextSeq(spaceId) };
        if ((f.entityIds ?? []).includes(absorbed._id)) {
          // `?? []` because `entityIds` is OPTIONAL on a file record, unlike memories and chrono where it is
          // required. The guard above already proves it is present — the fallback keeps the map total over
          // the type rather than relying on that.
          const newEntityIds = (f.entityIds ?? []).map(id => id === absorbed._id ? survivor._id : id);
          set['entityIds'] = [...new Set(newEntityIds)];
        }
        if (f.faceEntityId === absorbed._id) set['faceEntityId'] = survivor._id;
        await fileColl.updateOne(
          asFilter<FileMetaDoc>({ _id: f._id }),
          asUpdate<FileMetaDoc>({ $set: set }),
          { session },
        );
      }

      // ── 4. Update survivor entity ──────────────────────────────────────
      const mergedTags = mergeTags(survivor.tags, absorbed.tags);
      const entityColl = col<EntityDoc>(`${spaceId}_entities`);

      /*
       * The survivor's content changed, so its vector must be recomputed — UNLESS the type is suppressed.
       *
       * A fifth inline embed, found by the gate that covers the four creators rather than by looking for it.
       * A merge in a suppressed space handed the survivor a vector nothing would remove: the merge writes the
       * document directly and never enqueues, so the queue's check — the last place suppression takes
       * effect — was never reached. Same shape as the creators, one path further along.
       */
      const suppressed = embeddingSuppressedFor(spaceId, 'entity', { type: survivor.type });
      let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
      if (!suppressed) {
        try {
          const embResult = await embed(entityEmbedText(
            survivor.name, survivor.type, mergedTags, survivor.description, mergedProperties,
          ));
          embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
        } catch { /* embedding unavailable — keep existing embedding */ }
      }

      /*
       * THE MERGE PATH RUNS THE VALIDATORS THE WRITE PATH RUNS. It did not, and nothing noticed.
       *
       * `mergeProperties` applies each property's `mergeFn`, so the survivor's properties are a value NEITHER
       * input necessarily had — a `sum` can exceed a `maximum`, a `concat` can break a `pattern`, a pick can
       * land outside an `enum`. This file imported nothing from `spaces/schema-validation.ts`, so a background
       * `automerge` that nobody invoked could write a survivor into a `strict` space that the same space would
       * have refused through `save_entity`.
       *
       * The precedent is exact, from CHANGELOG: *"An entity merge left every FILE linked to the absorbed entity
       * pointing at a record it had just deleted… The merge path broke the invariant the write path enforces."*
       * Same file, same shape, one invariant over.
       *
       * **It reports and proceeds; it does not refuse.** Refusing is a real option and a real question — an
       * automerge that stops leaves the duplicates it was meant to resolve, which may be worse than a survivor
       * that violates a property rule — and that trade is the owner's, parked as P-19. What is not in question
       * is that the violation must be visible: this codebase has twice concluded that *the fix is visibility,
       * not severity*, for the sync drop and for the media-worker swallow.
       */
      const violations = validateEntity(getSpaceMeta(spaceId) ?? {}, {
        name: survivor.name, type: survivor.type, properties: mergedProperties,
      });
      const verdict = applyValidation(getSpaceMeta(spaceId), violations);
      if (verdict.blocked) {
        /*
         * A `strict` space refuses this merge, exactly as it refuses the equivalent direct write.
         *
         * Owner's ruling, 2026-08-29: a space set to strict has said it wants refusals, and this was the one
         * write path that ignored it. It shipped as report-and-proceed first, deliberately, because the trade
         * is real — `automerge` runs unattended, so refusing leaves the duplicates it exists to resolve. That
         * was the owner's call and he made it.
         *
         * Throwing HERE is why the check sits at this point: everything above runs inside
         * `session.withTransaction`, so the relinked edges, the rewritten references and the survivor's own
         * update roll back together. A refusal that left half a merge applied would be worse than the
         * violation it prevented.
         */
        throw new MergeSchemaViolation(survivor._id, absorbed._id, spaceId, violations);
      }
      if (verdict.warnings.length > 0) {
        log.warn(
          `merge: the survivor '${survivor._id}' in space '${spaceId}' violates its own schema after merging `
          + `'${absorbed._id}' — the merged properties are a value neither input had. The space is in 'warn' `
          + `mode so the merge PROCEEDED; these would have been refused on a direct write: `
          + verdict.warnings.map(v => `${v.field}: ${v.reason}`).join('; '),
        );
      }

      await entityColl.updateOne(
        asFilter<EntityDoc>({ _id: survivor._id }),
        asUpdate<EntityDoc>({ $set: { properties: mergedProperties, tags: mergedTags, updatedAt: now, seq, ...embeddingFields } }),
        { session },
      );

      // ── 5. Delete absorbed entity + write tombstone ────────────────────
      const absorbedSeq = await nextSeq(spaceId);
      await entityColl.deleteOne(asFilter<EntityDoc>({ _id: absorbed._id, spaceId }), { session });
      await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
        asFilter<TombstoneDoc>({ _id: absorbed._id }),
        asDoc<TombstoneDoc>({ _id: absorbed._id, type: 'entity', spaceId, deletedAt: now, instanceId: getConfig().instanceId, seq: absorbedSeq }),
        { upsert: true, session },
      );

      // Store result on survivor for return
      Object.assign(survivor, {
        properties: mergedProperties,
        tags: mergedTags,
        updatedAt: now,
        seq,
        ...embeddingFields,
      });
    });
  } finally {
    await session.endSession();
  }

  /*
   * Now that the transaction has committed. `enqueueEmbedJob` wakes the worker synchronously and neither it
   * nor `retireEmbedJob` takes a session, so doing this inside `withTransaction` let the worker claim a job
   * for an uncommitted edge, read nothing, report `gone` — which counts as success and DELETES the job —
   * and leave a re-keyed edge permanently without a vector.
   *
   * Relinking changes an edge's embed text either way, because it is built from the endpoint NAMES.
   */
  for (const job of rekeyedEdgeJobs) {
    await retireEmbedJob(spaceId, 'edge', job.retire);
    await enqueueEmbedJob(spaceId, 'edge', job.enqueue);
  }

  // Centralised webhook emission: a merge is an update to the survivor, deletion of the
  // absorbed entity, and deletion of any duplicate edges collapsed in the process. All four
  // fire here so every caller (REST, duplicates, dupe-scanner, MCP) is consistent.
  if (actor) {
    emitWebhookEvent({ event: 'entity.merged', spaceId, entry: { survivor: { ...survivor, embedding: undefined }, absorbedId: absorbed._id }, ...actor });
    emitWebhookEvent({ event: 'entity.updated', spaceId, entry: { ...survivor, embedding: undefined }, ...actor });
    emitWebhookEvent({ event: 'entity.deleted', spaceId, entry: { _id: absorbed._id }, ...actor });
    for (const dupId of deletedDuplicateEdgeIds) {
      emitWebhookEvent({ event: 'edge.deleted', spaceId, entry: { _id: dupId }, ...actor });
    }
  }

  return {
    entity: survivor,
    deletedDuplicateEdgeIds,
  };
}

// ── Validation helpers ─────────────────────────────────────────────────────

// From the lists the TYPES are derived from, so a function the schema offers cannot be one this refuses.
const VALID_NUMERIC_FNS = new Set<string>(NUMERIC_MERGE_FNS);
const VALID_BOOLEAN_FNS = new Set<string>(BOOLEAN_MERGE_FNS);

/**
 * Validate a resolution string for a given property type.
 * Returns an error message if invalid, or null if valid.
 */
export function validateResolution(resolution: string, type: string, hasCustomValue: boolean): string | null {
  if (resolution === 'survivor' || resolution === 'absorbed') return null;
  if (resolution === 'custom') {
    if (!hasCustomValue) return 'resolution "custom" requires a customValue';
    return null;
  }
  if (resolution.startsWith('fn:')) {
    const fnName = resolution.slice(3);
    if (type === 'number') {
      if (!VALID_NUMERIC_FNS.has(fnName)) return `unknown numeric merge function: ${fnName}`;
      return null;
    }
    if (type === 'boolean') {
      if (!VALID_BOOLEAN_FNS.has(fnName)) return `unknown boolean merge function: ${fnName}`;
      return null;
    }
    return `fn: resolutions require type "number" or "boolean", got "${type}"`;
  }
  return `unknown resolution: ${resolution}`;
}
