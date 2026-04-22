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

import { col, getMongo, mFilter, mDoc, mUpdate } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getEntityById } from './entities.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { EntityDoc, EdgeDoc, MemoryDoc, ChronoEntry, TombstoneDoc, SpaceMeta, PropertySchema } from '../config/types.js';

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

/** The full merge plan returned on 409 when unresolved conflicts exist. */
export interface MergePlan {
  survivorId: string;
  absorbedId: string;
  propertyConflicts: PropertyConflict[];
  absorbedOnlyProperties: AbsorbedOnlyProperty[];
  duplicateEdgeWarnings: DuplicateEdgeWarning[];
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

/** Derive the text to embed for an entity (mirrors entityEmbedText in entities.ts). */
function entityEmbedText(
  name: string,
  type: string,
  tags: string[] = [],
  description?: string,
  properties: Record<string, string | number | boolean> = {},
): string {
  const parts: string[] = [name, type];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  const propEntries = Object.entries(properties);
  if (propEntries.length > 0) {
    parts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
  }
  return parts.join(' ');
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

  const plan: MergePlan = {
    survivorId,
    absorbedId,
    propertyConflicts,
    absorbedOnlyProperties,
    duplicateEdgeWarnings,
  };

  const fullyResolved = propertyConflicts.every(c => c.resolved);

  return { plan, fullyResolved, survivor, absorbed };
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
    .find(mFilter<EdgeDoc>({ spaceId, $or: [{ from: absorbedId }, { to: absorbedId }] }))
    .toArray() as EdgeDoc[];

  // All edges currently referencing the survivor entity
  const survivorEdges = await edgeColl
    .find(mFilter<EdgeDoc>({ spaceId, $or: [{ from: survivorId }, { to: survivorId }] }))
    .toArray() as EdgeDoc[];

  const warnings: DuplicateEdgeWarning[] = [];

  // Build a set of (from, to, label) triplets from survivor edges
  const survivorTriplets = new Map<string, string>(); // triplet key → edge ID
  for (const e of survivorEdges) {
    survivorTriplets.set(`${e.from}|${e.to}|${e.label}`, e._id);
  }

  // For each absorbed edge, compute what its triplet would be after relinking
  for (const e of absorbedEdges) {
    const newFrom = e.from === absorbedId ? survivorId : e.from;
    const newTo = e.to === absorbedId ? survivorId : e.to;
    const key = `${newFrom}|${newTo}|${e.label}`;
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
 * Apply resolved property values and return the final merged properties.
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
    result[p.key] = p.value as string | number | boolean;
  }

  // Apply conflict resolutions
  for (const c of conflicts) {
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
export async function executeMerge(
  spaceId: string,
  survivor: EntityDoc,
  absorbed: EntityDoc,
  mergedProperties: Record<string, string | number | boolean>,
): Promise<{ entity: EntityDoc; deletedDuplicateEdgeIds: string[] }> {
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
        .find(mFilter<EdgeDoc>({ spaceId, $or: [{ from: absorbed._id }, { to: absorbed._id }] }), { session })
        .toArray() as EdgeDoc[];

      // Build a set of existing survivor edge keys for collision detection.
      const survivorEdges = await edgeColl
        .find(mFilter<EdgeDoc>({ spaceId, $or: [{ from: survivor._id }, { to: survivor._id }] }), { session })
        .toArray() as EdgeDoc[];
      const survivorKeys = new Set(survivorEdges.map(e => `${e.from}|${e.to}|${e.label}`));

      // Phase 1a: delete absorbed edges whose post-relink key collides with
      // an existing survivor edge (would violate the unique index).
      const edgesToRelink: EdgeDoc[] = [];
      for (const edge of absorbedEdges) {
        const newFrom = edge.from === absorbed._id ? survivor._id : edge.from;
        const newTo = edge.to === absorbed._id ? survivor._id : edge.to;
        const postKey = `${newFrom}|${newTo}|${edge.label}`;
        if (survivorKeys.has(postKey)) {
          // This absorbed edge would collide — delete it as a duplicate.
          await edgeColl.deleteOne(mFilter<EdgeDoc>({ _id: edge._id }), { session });
          const tombSeq = await nextSeq(spaceId);
          await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
            mFilter<TombstoneDoc>({ _id: edge._id }),
            mDoc<TombstoneDoc>({ _id: edge._id, type: 'edge', spaceId, deletedAt: now, instanceId: getConfig().instanceId, seq: tombSeq }),
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

      // Phase 1b: relink remaining absorbed edges (no collision risk).
      for (const edge of edgesToRelink) {
        const updates: Record<string, string> = { updatedAt: now };
        if (edge.from === absorbed._id) updates['from'] = survivor._id;
        if (edge.to === absorbed._id) updates['to'] = survivor._id;
        const edgeSeq = await nextSeq(spaceId);
        (updates as Record<string, unknown>)['seq'] = edgeSeq;
        await edgeColl.updateOne(
          mFilter<EdgeDoc>({ _id: edge._id }),
          mUpdate<EdgeDoc>({ $set: updates }),
          { session },
        );
      }

      // ── 2. Relink memories ─────────────────────────────────────────────
      const memoryColl = col<MemoryDoc>(`${spaceId}_memories`);
      const affectedMemories = await memoryColl
        .find(mFilter<MemoryDoc>({ spaceId, entityIds: absorbed._id }), { session })
        .toArray() as MemoryDoc[];
      for (const mem of affectedMemories) {
        const newEntityIds = mem.entityIds.map(id => id === absorbed._id ? survivor._id : id);
        const dedupedIds = [...new Set(newEntityIds)];
        const memSeq = await nextSeq(spaceId);
        await memoryColl.updateOne(
          mFilter<MemoryDoc>({ _id: mem._id }),
          mUpdate<MemoryDoc>({ $set: { entityIds: dedupedIds, updatedAt: now, seq: memSeq } }),
          { session },
        );
      }

      // ── 3. Relink chrono entries ───────────────────────────────────────
      const chronoColl = col<ChronoEntry>(`${spaceId}_chrono`);
      const affectedChronos = await chronoColl
        .find(mFilter<ChronoEntry>({ spaceId, entityIds: absorbed._id }), { session })
        .toArray() as ChronoEntry[];
      for (const ch of affectedChronos) {
        const newEntityIds = ch.entityIds.map(id => id === absorbed._id ? survivor._id : id);
        const dedupedIds = [...new Set(newEntityIds)];
        const chSeq = await nextSeq(spaceId);
        await chronoColl.updateOne(
          mFilter<ChronoEntry>({ _id: ch._id }),
          mUpdate<ChronoEntry>({ $set: { entityIds: dedupedIds, updatedAt: now, seq: chSeq } }),
          { session },
        );
      }

      // ── 4. Update survivor entity ──────────────────────────────────────
      const mergedTags = Array.from(new Set([...(survivor.tags ?? []), ...(absorbed.tags ?? [])]));
      const entityColl = col<EntityDoc>(`${spaceId}_entities`);

      let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
      try {
        const embResult = await embed(entityEmbedText(
          survivor.name, survivor.type, mergedTags, survivor.description, mergedProperties,
        ));
        embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
      } catch { /* embedding unavailable — keep existing embedding */ }

      await entityColl.updateOne(
        mFilter<EntityDoc>({ _id: survivor._id }),
        mUpdate<EntityDoc>({ $set: { properties: mergedProperties, tags: mergedTags, updatedAt: now, seq, ...embeddingFields } }),
        { session },
      );

      // ── 5. Delete absorbed entity + write tombstone ────────────────────
      const absorbedSeq = await nextSeq(spaceId);
      await entityColl.deleteOne(mFilter<EntityDoc>({ _id: absorbed._id, spaceId }), { session });
      await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
        mFilter<TombstoneDoc>({ _id: absorbed._id }),
        mDoc<TombstoneDoc>({ _id: absorbed._id, type: 'entity', spaceId, deletedAt: now, instanceId: getConfig().instanceId, seq: absorbedSeq }),
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

  return {
    entity: survivor,
    deletedDuplicateEdgeIds,
  };
}

// ── Validation helpers ─────────────────────────────────────────────────────

const VALID_NUMERIC_FNS = new Set(['avg', 'min', 'max', 'sum']);
const VALID_BOOLEAN_FNS = new Set(['and', 'or', 'xor']);

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
