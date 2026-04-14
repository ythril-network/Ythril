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

import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getEntityById, deleteEntity } from './entities.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { EntityDoc, EdgeDoc, MemoryDoc, ChronoEntry, SpaceMeta, PropertySchema } from '../config/types.js';

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
  const entitySchemas = meta?.propertySchemas?.entity;

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
    .find({ spaceId, $or: [{ from: absorbedId }, { to: absorbedId }] } as never)
    .toArray() as EdgeDoc[];

  // All edges currently referencing the survivor entity
  const survivorEdges = await edgeColl
    .find({ spaceId, $or: [{ from: survivorId }, { to: survivorId }] } as never)
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
 * Execute the merge atomically: relink edges/memories/chronos, apply resolved
 * properties to survivor, delete absorbed entity.
 *
 * Precondition: all property conflicts must be resolved before calling this.
 */
export async function executeMerge(
  spaceId: string,
  survivor: EntityDoc,
  absorbed: EntityDoc,
  mergedProperties: Record<string, string | number | boolean>,
): Promise<EntityDoc> {
  const now = new Date().toISOString();
  const seq = await nextSeq(spaceId);

  // ── 1. Relink edges ──────────────────────────────────────────────────
  const edgeColl = col<EdgeDoc>(`${spaceId}_edges`);

  // Update edges where absorbed is the `from`
  const fromEdges = await edgeColl
    .find({ spaceId, from: absorbed._id } as never)
    .toArray() as EdgeDoc[];
  for (const edge of fromEdges) {
    const edgeSeq = await nextSeq(spaceId);
    await edgeColl.updateOne(
      { _id: edge._id } as never,
      { $set: { from: survivor._id, updatedAt: now, seq: edgeSeq } } as never,
    );
  }

  // Update edges where absorbed is the `to`
  const toEdges = await edgeColl
    .find({ spaceId, to: absorbed._id } as never)
    .toArray() as EdgeDoc[];
  for (const edge of toEdges) {
    const edgeSeq = await nextSeq(spaceId);
    await edgeColl.updateOne(
      { _id: edge._id } as never,
      { $set: { to: survivor._id, updatedAt: now, seq: edgeSeq } } as never,
    );
  }

  // ── 2. Relink memories ───────────────────────────────────────────────
  const memoryColl = col<MemoryDoc>(`${spaceId}_memories`);
  const affectedMemories = await memoryColl
    .find({ spaceId, entityIds: absorbed._id } as never)
    .toArray() as MemoryDoc[];
  for (const mem of affectedMemories) {
    const newEntityIds = mem.entityIds.map(id => id === absorbed._id ? survivor._id : id);
    // Deduplicate in case survivor was already referenced
    const dedupedIds = [...new Set(newEntityIds)];
    const memSeq = await nextSeq(spaceId);
    await memoryColl.updateOne(
      { _id: mem._id } as never,
      { $set: { entityIds: dedupedIds, updatedAt: now, seq: memSeq } } as never,
    );
  }

  // ── 3. Relink chrono entries ─────────────────────────────────────────
  const chronoColl = col<ChronoEntry>(`${spaceId}_chrono`);
  const affectedChronos = await chronoColl
    .find({ spaceId, entityIds: absorbed._id } as never)
    .toArray() as ChronoEntry[];
  for (const ch of affectedChronos) {
    const newEntityIds = ch.entityIds.map(id => id === absorbed._id ? survivor._id : id);
    const dedupedIds = [...new Set(newEntityIds)];
    const chSeq = await nextSeq(spaceId);
    await chronoColl.updateOne(
      { _id: ch._id } as never,
      { $set: { entityIds: dedupedIds, updatedAt: now, seq: chSeq } } as never,
    );
  }

  // ── 4. Update survivor entity ────────────────────────────────────────
  // Merge tags (deduplicated union)
  const mergedTags = Array.from(new Set([...(survivor.tags ?? []), ...(absorbed.tags ?? [])]));
  // Keep survivor's name, type, description by default
  const entityColl = col<EntityDoc>(`${spaceId}_entities`);

  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const embResult = await embed(entityEmbedText(
      survivor.name, survivor.type, mergedTags, survivor.description, mergedProperties,
    ));
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
  } catch { /* embedding unavailable — keep existing embedding */ }

  await entityColl.updateOne(
    { _id: survivor._id } as never,
    { $set: { properties: mergedProperties, tags: mergedTags, updatedAt: now, seq, ...embeddingFields } } as never,
  );

  // ── 5. Delete absorbed entity ────────────────────────────────────────
  await deleteEntity(spaceId, absorbed._id);

  // Return the updated survivor
  return {
    ...survivor,
    properties: mergedProperties,
    tags: mergedTags,
    updatedAt: now,
    seq,
    ...embeddingFields,
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
