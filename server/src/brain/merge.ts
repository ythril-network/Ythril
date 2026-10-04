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

import type { ClientSession } from 'mongodb';
import { col, asFilter, asUpdate, asBulk } from '../db/mongo.js';
import { withSeq, withAllocatedSeqs } from '../util/seq.js';
import { readStoredById } from '../db/read-by-id.js';
import { inHeldTransaction } from './held-transaction.js';
import { NUMERIC_MERGE_FNS, BOOLEAN_MERGE_FNS } from '../config/types-knowledge.js';
import { embed } from './embedding.js';
import { entityEmbedText } from './embed-text.js';
import { getEntityById } from './entities.js';
import { getConfig } from '../config/loader.js';
import { log, peerList, peerText } from '../util/log.js';
import { mergeTags } from './merge-fields.js';
import { edgeIdFor } from './edge-id.js';
import { linkIdFor } from './links.js';
import { rekeyEdges, embedQueueWorkFor, type EdgeRekey } from './edge-rekey.js';
import { enqueueWriteEmbedJobs, retireEmbedJobs, EMBED_PRIORITY } from './embed-queue.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { validateEdge } from '../spaces/schema-validation.js';
import type { ResolvedEdgeEnds } from '../spaces/schema-validation.js';
import { validateEntity, getSpaceMeta, applyValidation, type SchemaViolation } from '../spaces/schema-validation.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { EntityDoc, EdgeDoc, FileMetaDoc, LinkDoc, PropertySchema } from '../config/types.js';
import { writeTombstone, removeWithTombstones } from './tombstones.js';
import { spaceCollection } from '../db/space-collection.js';
import { atReadSeq } from '../db/at-read-seq.js';

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
 * What the PLAN reads of an edge: its identity and its properties (the endpoint rules read them). Never the
 * vector — a hub's edges carry one each, and a plan computed over them read tens of megabytes it never looked at.
 */
const PLAN_EDGE_PROJECTION = { _id: 1, from: 1, to: 1, label: 1, fromKind: 1, toKind: 1, properties: 1 } as const;

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

  const edgeColl = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));
  const moving = await edgeColl
    .find(relinkFilters(spaceId, absorbedId).edges, { projection: PLAN_EDGE_PROJECTION })
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
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: survivor._id }, { to: survivor._id }] }), { projection: PLAN_EDGE_PROJECTION })
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
  const edgeColl = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));

  // All edges currently referencing the absorbed entity
  const absorbedEdges = await edgeColl
    .find(relinkFilters(spaceId, absorbedId).edges, { projection: PLAN_EDGE_PROJECTION })
    .toArray() as EdgeDoc[];

  // All edges currently referencing the survivor entity
  const survivorEdges = await edgeColl
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: survivorId }, { to: survivorId }] }), { projection: PLAN_EDGE_PROJECTION })
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
  _absorbedProps: Record<string, string | number | boolean>,
  conflicts: PropertyConflict[],
  absorbedOnly: AbsorbedOnlyProperty[],
): Record<string, string | number | boolean> {
  const result = { ...survivorProps };

  // Apply absorbed-only properties
  for (const p of absorbedOnly) {
    if (!isSafeKey(p.key)) {
      log.warn(`merge: skipping prototype-polluting property key '${peerText(p.key)}'`);
      continue;
    }
    result[p.key] = p.value as string | number | boolean;
  }

  // Apply conflict resolutions
  for (const c of conflicts) {
    if (!isSafeKey(c.key)) {
      log.warn(`merge: skipping prototype-polluting property key '${peerText(c.key)}'`);
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
        log.warn(`merge: fn '${peerText(fnName)}' not applicable for type '${peerText(c.type)}' on property '${peerText(c.key)}' — keeping survivor value`);
      }
    }
  }

  return result;
}

// ── Merge execution ────────────────────────────────────────────────────────

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

  /** What a door carries beside the message (`structuredContent` on MCP, the body on REST): the violations. */
  toStructured(): Record<string, unknown> {
    return { violations: this.violations };
  }
}

/**
 * The most records ONE merge relinks: the absorbed entity's edges, the links that name it, and the face labels on
 * it (`Q-107` part 3a). A merge relinks all of them in one transaction under the seq horizon hold, so its size is
 * both a transaction the store has to hold and a time every seq-paged reader of the space waits.
 *
 * SET FROM MEASUREMENT, never chosen: `testing/bench/merge-hub-in-one-transaction.mjs` merges hubs of growing size
 * with a full-size vector on every edge (a re-key carries it), on the test store the compose file defines. The bound
 * sits at no more than half the size that measured as the ceiling, and its merge at no more than half the hold
 * deadline. The numbers are in the commit that set it; the docs state the value through a gate that reads this.
 */
export const MERGE_MAX_RELINKS = 2_500;

/**
 * The `code` a refused merge answers with — the one list, so a description that names one and a gate that checks
 * a description against real names read the same words.
 */
export const MERGE_REFUSAL_CODES = ['merge_too_large'] as const;

/** What a merge relinks, by kind — the bound counts their sum (`relinkTally`). */
export interface RelinkTally { edges: number; links: number; faces: number }

const relinkTotal = (t: RelinkTally): number => t.edges + t.links + t.faces;

/** What a too-large refusal is built from: both entities, the absorbed one's tally, and the other direction's count. */
export interface MergeTooLargeFacts {
  survivor: Pick<EntityDoc, '_id' | 'name'>;
  absorbed: Pick<EntityDoc, '_id' | 'name'>;
  spaceId: string;
  tally: RelinkTally;
  bound: number;
  /** What merging the other way round — the survivor absorbed — would relink, counted the same way. */
  reverseRelinks: number;
}

/**
 * A merge refused because it would relink more than `MERGE_MAX_RELINKS` records — refused before anything is
 * written, the seq counter included. `merge_too_large` is the code every door answers with, beside the count and
 * the bound, so a caller can tell how far over it is.
 *
 * The message is what the Review page's toast shows, so every sentence in it refers to something its reader can see
 * or do (bundle-30 I7). It names both entities by NAME, because the page shows a pair by name and never by id (the
 * ids follow in brackets, for an API caller). It suggests only what a door offers: deleting edges or links the
 * absorbed entity no longer needs, and only when that can bring the merge under the bound (no door removes a face
 * label); and merging the other way round, only when that merge fits — counted, never assumed. It used to say "move
 * or delete some of its edges", and no door can move an edge: an edge's ends are not patchable.
 */
export class MergeTooLarge extends Error {
  readonly code = MERGE_REFUSAL_CODES[0];
  readonly survivorId: string;
  readonly absorbedId: string;
  readonly spaceId: string;
  readonly relinks: number;
  readonly bound: number;
  constructor(facts: MergeTooLargeFacts) {
    super(mergeTooLargeMessage(facts));
    this.name = 'MergeTooLarge';
    this.survivorId = facts.survivor._id;
    this.absorbedId = facts.absorbed._id;
    this.spaceId = facts.spaceId;
    this.relinks = relinkTotal(facts.tally);
    this.bound = facts.bound;
  }

  /** What a door carries beside the message: the code, the count and the bound. */
  toStructured(): Record<string, unknown> {
    return { code: this.code, relinks: this.relinks, bound: this.bound };
  }
}

/** An entity's name as the refusal quotes it: bounded, and on one line (automerge logs the refusal as one line). */
const nameOf = (e: Pick<EntityDoc, '_id' | 'name'>): string => `'${peerText(e.name, { max: 120 })}'`;

/** The too-large refusal's text — see `MergeTooLarge` for why each sentence is there. */
function mergeTooLargeMessage({ survivor, absorbed, spaceId, tally, bound, reverseRelinks }: MergeTooLargeFacts): string {
  const relinks = relinkTotal(tally);
  const over = relinks - bound;
  // The ids follow each name once, for an API caller. A pair with ONE name (a duplicate usually is) keeps them on
  // every mention, or "keep 'X' and absorb 'X'" would say nothing.
  const withId = (e: Pick<EntityDoc, '_id' | 'name'>): string => `${nameOf(e)} [${peerText(e._id)}]`;
  const sameName = absorbed.name === survivor.name;
  const gone = sameName ? withId(absorbed) : nameOf(absorbed);
  const kept = sameName ? withId(survivor) : nameOf(survivor);
  const out = [
    `merge_too_large: merging ${withId(absorbed)} into ${withId(survivor)} in space '${peerText(spaceId)}' would relink`
    + ` ${relinks} records — the edges (${tally.edges}), links (${tally.links}) and face labels (${tally.faces}) of ${gone}`
    + ` — and one merge relinks at most ${bound}.`,
    'Nothing was written.',
    tally.edges + tally.links >= over
      ? `Delete at least ${over} of the edges or links of ${gone} that are no longer needed, then merge again.`
      : `Deleting edges and links cannot bring this merge under the bound: the ${tally.faces} face labels of ${gone} alone exceed it.`,
  ];
  if (reverseRelinks <= bound) {
    out.push(`Or merge the other way round — keep ${gone} and absorb ${kept}: that relinks ${reverseRelinks} records, within the bound.`);
  }
  return out.join(' ');
}

/**
 * What a door answers for a REFUSED merge, or `null` when `err` is not a merge refusal — ONE mapping for the REST
 * merge route, `POST /api/duplicates/:id/merge`, the `graph_merge` tool and automerge's warning, so one refusal
 * cannot answer `400` on one door and `500` on another (it did: the REST route let a schema refusal reach the
 * global handler as a 500 while the tool answered 400).
 *
 *  - `MergeTooLarge` -> 422 `merge_too_large`, with the count and the bound: well-formed, refused.
 *  - `MergeSchemaViolation` -> 400: the space's strict schema refuses the merged survivor, the caller's to fix.
 *
 * A store failure is not a merge refusal and is not answered here: every door already classifies one through
 * `brain/store-failure.ts` (503, retryable), and a second mapping of it is what `R1` refuses.
 */
export function mergeRefusal(err: unknown): MergeRefusal | null {
  if (err instanceof MergeTooLarge) return { status: 422, refusal: err, body: { error: err.message, ...err.toStructured() } };
  if (err instanceof MergeSchemaViolation) return { status: 400, refusal: err, body: { error: err.message, ...err.toStructured() } };
  return null;
}

/** A refused merge as a door answers it: the status, the refusal (its message and `toStructured()`), the REST body. */
export interface MergeRefusal {
  status: 400 | 422;
  refusal: MergeTooLarge | MergeSchemaViolation;
  body: Record<string, unknown>;
}

/**
 * What a merge of `absorbedId` relinks, as filters: its edges (either end), the links that point at it, and the face
 * labels that name it. ONE definition for the plan, the bound (`relinkTally`) and the writer (`relinkAndAbsorb`):
 * each spelled them by hand, and a bound counted by a filter the writer does not use is a bound on something else
 * (bundle-30 I6, C12).
 *
 * Not `findEntityReferences` (`brain/entities.ts`): that asks what still points at a record, by the target's kind,
 * to refuse a delete — a different question with a different kind rule, and herding the two together would make the
 * merge's bound depend on the delete's needs.
 */
function relinkFilters(spaceId: string, absorbedId: string) {
  return {
    edges: asFilter<EdgeDoc>({ spaceId, $or: [{ from: absorbedId }, { to: absorbedId }] }),
    links: asFilter<LinkDoc>({ spaceId, to: absorbedId, toKind: 'entity' }),
    faces: asFilter<FileMetaDoc>({ spaceId, faceEntityId: absorbedId }),
  };
}

/** What a merge of `absorbedId` relinks, by kind, counted as the bound is: the bound is their sum. */
async function relinkTally(spaceId: string, absorbedId: string): Promise<RelinkTally> {
  const relinked = relinkFilters(spaceId, absorbedId);
  const [edges, links, faces] = await Promise.all([
    col<EdgeDoc>(spaceCollection(spaceId, 'edges')).countDocuments(relinked.edges),
    col<LinkDoc>(spaceCollection(spaceId, 'links')).countDocuments(relinked.links),
    col<FileMetaDoc>(spaceCollection(spaceId, 'files')).countDocuments(relinked.faces),
  ]);
  return { edges, links, faces };
}

/** What the merge transaction wrote, for the steps that run once it has committed. */
interface MergeWrite {
  seq: number;
  rekeyed: EdgeRekey[];
  deletedDuplicateEdgeIds: string[];
}


/**
 * Execute the merge: relink edges, links and face labels, drop an absorbed edge whose relinked identity a survivor
 * edge holds, apply the resolved properties to the survivor, delete the absorbed entity — ONE transaction under the
 * seq horizon hold (`inHeldTransaction`), each class of record one bulk write with one seq block.
 *
 * Before the hold, in this order and for these reasons: the schema check (pure — a refusal writes nothing, not
 * even a seq); the bound (`MERGE_MAX_RELINKS`, counted, so a hub is refused before its edges are read); and the
 * survivor's embedding (the model is not the driver, and every await inside the hold holds every reader of the
 * space — a first-time model load inside it used to outlive the hold's deadline and fail the merge 503).
 *
 * Precondition: all property conflicts must be resolved before calling this (`mergeEntities` is the door).
 */
export async function executeMerge(
  spaceId: string,
  survivor: EntityDoc,
  absorbed: EntityDoc,
  mergedProperties: Record<string, string | number | boolean>,
  actor?: WebhookActor,
): Promise<{ entity: EntityDoc; deletedDuplicateEdgeIds: string[] }> {
  const now = new Date().toISOString();
  const mergedTags = mergeTags(survivor.tags, absorbed.tags);

  /*
   * THE MERGE PATH RUNS THE VALIDATORS THE WRITE PATH RUNS. It did not, and nothing noticed.
   *
   * `mergeProperties` applies each property's `mergeFn`, so the survivor's properties are a value NEITHER
   * input necessarily had — a `sum` can exceed a `maximum`, a `concat` can break a `pattern`, a pick can
   * land outside an `enum`. This file imported nothing from `spaces/schema-validation.ts`, so a background
   * `automerge` that nobody invoked could write a survivor into a `strict` space that the same space would
   * have refused through `save_entity`.
   *
   * **A `strict` space refuses** (owner's ruling, 2026-08-29: a space set to strict has said it wants refusals),
   * and **`warn` reports and proceeds** — the middle setting has to keep meaning what it says. Checked BEFORE the
   * transaction: the check is pure, so a refusal writes nothing at all, where inside the transaction it rolled the
   * relinks back but had already spent their seqs.
   */
  const violations = validateEntity(getSpaceMeta(spaceId) ?? {}, {
    name: survivor.name, type: survivor.type, properties: mergedProperties,
  });
  const verdict = applyValidation(getSpaceMeta(spaceId), violations);
  if (verdict.blocked) throw new MergeSchemaViolation(survivor._id, absorbed._id, spaceId, violations);
  if (verdict.warnings.length > 0) {
    log.warn(
      `merge: the survivor '${peerText(survivor._id)}' in space '${peerText(spaceId)}' violates its own schema after merging `
      + `'${peerText(absorbed._id)}' — the merged properties are a value neither input had. The space is in 'warn' `
      + `mode so the merge PROCEEDED; these would have been refused on a direct write: `
      + peerList(verdict.warnings.map(v => `${v.field}: ${v.reason}`), '; '),
    );
  }

  const tally = await relinkTally(spaceId, absorbed._id);
  if (relinkTotal(tally) > MERGE_MAX_RELINKS) {
    // The other direction is counted only here, on the refusal path, so the refusal offers it only when it is true.
    const reverseRelinks = relinkTotal(await relinkTally(spaceId, survivor._id));
    throw new MergeTooLarge({ survivor, absorbed, spaceId, tally, bound: MERGE_MAX_RELINKS, reverseRelinks });
  }

  /*
   * The survivor's content changed, so its vector must be recomputed — UNLESS the type is suppressed.
   *
   * A fifth inline embed, found by the gate that covers the four creators rather than by looking for it. A merge
   * in a suppressed space handed the survivor a vector nothing would remove: the merge writes the document directly
   * and never enqueues, so the queue's check was never reached. Against the survivor's STORED record (`Q-194`):
   * asking with `{ type }` alone dropped the record tier.
   */
  const suppressed = embeddingSuppressedFor(spaceId, 'entity', survivor as unknown as Record<string, unknown>);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  if (!suppressed) {
    try {
      const embResult = await embed(entityEmbedText(survivor.name, survivor.type, mergedTags, survivor.description, mergedProperties));
      embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
    } catch { /* embedding unavailable — keep existing embedding */ }
  }

  const entityColl = col<EntityDoc>(spaceCollection(spaceId, 'entities'));
  const written = await inHeldTransaction(spaceId, 'entity.merge',
    (session) => relinkAndAbsorb(spaceId, survivor, absorbed, {
      now, session, set: { properties: mergedProperties, tags: mergedTags, updatedAt: now, ...embeddingFields },
    }),
    // A commit whose answer was lost may have landed: the survivor at the seq this transaction gave it IS the commit.
    { landed: async (w) => (await entityColl.countDocuments(asFilter<EntityDoc>(atReadSeq(survivor._id, w.seq)), { limit: 1 })) === 1 });

  Object.assign(survivor, { properties: mergedProperties, tags: mergedTags, updatedAt: now, seq: written.seq, ...embeddingFields });

  /*
   * Now that the transaction has committed. The queue takes no session, so touching it inside the transaction let
   * the worker claim a job for an uncommitted edge, read nothing, report `gone` — which counts as success and
   * DELETES the job — and leave a re-keyed edge permanently without a vector. Relinking changes an edge's embed text
   * either way, because it is built from the endpoint NAMES. Batched, and on the background lane: a hub's thousands
   * of re-embeds must not queue ahead of the writes people are waiting on. Never thrown: the merge is stored, and
   * reporting it failed would invite a retry of a merge whose absorbed entity no longer exists.
   */
  if (written.rekeyed.length > 0) {
    try {
      await retireEmbedJobs(spaceId, 'edge', written.rekeyed.map(m => embedQueueWorkFor(m).retire));
    } catch (err) {
      log.warn(`merge: '${peerText(absorbed._id)}' was merged into '${peerText(survivor._id)}' in '${peerText(spaceId)}', but the embed jobs of `
        + `${written.rekeyed.length} re-keyed edge(s) were not retired: ${peerText(err)}`);
    }
    await enqueueWriteEmbedJobs(spaceId, written.rekeyed.map(m => ({ recordType: 'edge' as const, recordId: embedQueueWorkFor(m).enqueue })),
      { priority: EMBED_PRIORITY.background });
  }

  // Centralised webhook emission: a merge is an update to the survivor, deletion of the absorbed entity, and
  // deletion of any duplicate edges collapsed in the process. All fire here so every door is consistent.
  if (actor) {
    emitWebhookEvent({ event: 'entity.merged', spaceId, entry: { survivor: { ...survivor, embedding: undefined }, absorbedId: absorbed._id }, ...actor });
    emitWebhookEvent({ event: 'entity.updated', spaceId, entry: { ...survivor, embedding: undefined }, ...actor });
    emitWebhookEvent({ event: 'entity.deleted', spaceId, entry: { _id: absorbed._id }, ...actor });
    for (const dupId of written.deletedDuplicateEdgeIds) {
      emitWebhookEvent({ event: 'edge.deleted', spaceId, entry: { _id: dupId }, ...actor });
    }
  }

  return { entity: survivor, deletedDuplicateEdgeIds: written.deletedDuplicateEdgeIds };
}

/**
 * The merge's writes, inside its transaction: every class of record one bulk write and one seq block.
 *
 * Nothing here is awaited that is not the driver — see `inHeldTransaction`.
 */
async function relinkAndAbsorb(
  spaceId: string, survivor: EntityDoc, absorbed: EntityDoc,
  { now, session, set }: { now: string; session: ClientSession; set: Record<string, unknown> },
): Promise<MergeWrite> {
  const edgeColl = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));

  // ── 1. Relink edges ──────────────────────────────────────────────────
  // WITH their vectors: a re-key carries the stored document across, embedding included (`rekeyEdges`). The ids
  // first, then the documents by id in chunks: inside the transaction a read must come back in one batch
  // (`db/write-bound.ts`), and a hub's edges with their vectors are far more than one batch holds.
  const absorbedIds = (await edgeColl
    .find(relinkFilters(spaceId, absorbed._id).edges, { session, projection: { _id: 1 } })
    .toArray() as Array<Pick<EdgeDoc, '_id'>>).map(e => e._id);
  const absorbedEdges = [...(await readStoredById<EdgeDoc>(spaceCollection(spaceId, 'edges'), absorbedIds, 'carried', { session })).values()];
  // Their IDENTITY only — the five fields the unique index is over, never the vector.
  const survivorEdges = await edgeColl
    .find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: survivor._id }, { to: survivor._id }] }),
      { session, projection: { _id: 1, from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 } })
    .toArray() as EdgeDoc[];

  /*
   * Collisions are found by IDENTITY — `(from, to, label, fromKind, toKind)`, keyed through `edgeIdFor` because it
   * length-prefixes each part (a joined string collides two relationships the moment a label holds the separator).
   * Never by the survivor edge's stored `_id`: an edge from before 3.6, or a peer's edge an earlier merge relinked
   * in place, is stored under an id its identity does not derive, and looked up by id its collision is invisible.
   */
  const survivorKeys = new Set(survivorEdges.map(e => edgeIdFor(e.from, e.to, e.label, e.fromKind, e.toKind)));
  const relinked = absorbedEdges.map(edge => ({
    edge,
    from: edge.from === absorbed._id ? survivor._id : edge.from,
    to: edge.to === absorbed._id ? survivor._id : edge.to,
  }));
  const duplicates: EdgeDoc[] = [];
  const edgesToRelink: typeof relinked = [];
  for (const r of relinked) {
    const postKey = edgeIdFor(r.from, r.to, r.edge.label, r.edge.fromKind, r.edge.toKind);
    // A survivor edge holds this identity, or an absorbed edge relinked earlier in this loop now does: the
    // absorbed one is a duplicate, deleted with its tombstone rather than relinked into the unique index.
    if (survivorKeys.has(postKey)) duplicates.push(r.edge);
    else { edgesToRelink.push(r); survivorKeys.add(postKey); }
  }

  // 1a. The duplicates: one delete, and their tombstones in one block, each carrying the seq of the edge it deletes.
  await removeWithTombstones(spaceId, 'edges',
    duplicates.map(e => ({ _id: e._id, type: 'edge' as const, deletedAt: now, originalSeq: e.seq })), { session });

  /*
   * 1b. RE-KEYED rather than `$set`, since 3.6. Relinking an endpoint changes what the edge IS, and its `_id` is
   * derived from its identity — a `$set` left it under an id the identity no longer derived, and the next peer to
   * create that relationship inserted and hit the unique index instead of converging. `rekeyEdges` owns the
   * delete-and-insert, the tombstones, and the seq ordering that makes one safe on a synced collection.
   *
   * Where it declines (`null`) the endpoints are written IN PLACE, which is what this did before 3.6 and must
   * still do: an edge a PEER authored is not moved (its copy would refuse our tombstone and hold two rows), and
   * dropping the write would leave the edge pointing at the entity this merge deletes.
   */
  const moved = await rekeyEdges(spaceId, edgesToRelink.map(r => ({ existing: r.edge, next: { from: r.from, to: r.to } })),
    { updatedAt: now }, [], session);
  const inPlace = edgesToRelink.filter((_, i) => moved[i] === null);
  if (inPlace.length > 0) {
    await withAllocatedSeqs(spaceId, inPlace.length, (first) => edgeColl.bulkWrite(asBulk<EdgeDoc>(inPlace.map((r, i) => {
      const updates: Record<string, unknown> = { updatedAt: now, seq: first + i };
      if (r.edge.from === absorbed._id) updates['from'] = survivor._id;
      if (r.edge.to === absorbed._id) updates['to'] = survivor._id;
      return { updateOne: { filter: { _id: r.edge._id }, update: { $set: updates } } };
    })), { ordered: false, session }), 'entity.merge.edge');
  }

  /*
   * ── 2. Relink FILE metadata: the face labels ──────────────────────────
   *
   * `faceEntityId` is a single-valued field on a face chunk (`{fileId}#face-chunkN`), and a merge missed it once
   * for a reason worth keeping: the gate that shipped with the `entityIds` fix derived the record kinds it checks
   * from the interfaces that DECLARE `entityIds`, so a differently-named, singular link was outside its scope by
   * construction — and the field it could not see is the biometric one. After a merge, face chunks still pointed
   * at the absorbed id, which this merge then deleted, and the surviving person's gallery silently emptied. The
   * file half was missing once before, too, and invisible from every direction: the ER model counts
   * `linkedFrom.files` as a first-class relationship, so the number was simply wrong, and a traversal from the file
   * came back empty, which reads as "nothing linked" rather than as a broken link.
   *
   * **Relinked, not unlabelled**, and that is the whole difference from the delete path. A delete means the person
   * is gone, so the labels are wrong. A merge means these two records were always the SAME person — so the absorbed
   * one's faces are the survivor's, and `faceScore` rides along because the person did not change. A file's
   * `entityIds` array went with the other five in 5.0; its links are re-keyed below.
   */
  const fileColl = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const affectedFiles = await fileColl
    .find(relinkFilters(spaceId, absorbed._id).faces, { session, projection: { _id: 1 } })
    .toArray() as Array<Pick<FileMetaDoc, '_id'>>;
  if (affectedFiles.length > 0) {
    await withAllocatedSeqs(spaceId, affectedFiles.length, (first) => fileColl.bulkWrite(asBulk<FileMetaDoc>(affectedFiles.map((f, i) => ({
      updateOne: { filter: { _id: f._id }, update: { $set: { faceEntityId: survivor._id, updatedAt: now, seq: first + i } } },
    }))), { ordered: false, session }), 'entity.merge.file');
  }

  /*
   * ── 3. Relink LINK RECORDS ─────────────────────────────────────────────
   *
   * On a space that has been through the link conversion — every space, at the boot after it is created — a link
   * is how a fact, a chrono entry or a file names an entity. **A link is RE-KEYED, not updated**: its `_id` is
   * derived from both endpoints (`linkIdFor`), so moving the `to` changes the identity. **The old id gets a
   * TOMBSTONE**, or the next pull from any peer still holding it re-creates the link pointing at the deleted
   * entity. An entity is only ever a `to` — nothing hangs off an entity — so there is no `from` half here.
   *
   * The survivor may ALREADY be linked from the same record: that row is kept as it is, author included, and only
   * the absorbed one goes — two rows describing one connection is what the derived id exists to prevent, and
   * overwriting the survivor's row would hand its authorship to whoever wrote the absorbed one.
   */
  const linkColl = col<LinkDoc>(spaceCollection(spaceId, 'links'));
  const affectedLinks = await linkColl
    .find(relinkFilters(spaceId, absorbed._id).links, { session })
    .toArray() as LinkDoc[];
  if (affectedLinks.length > 0) {
    const linkMoves = affectedLinks.map(link => ({ link, newId: linkIdFor(link.from, link.fromKind, survivor._id, 'entity') }));
    const held = await readStoredById<{ _id: string }>(spaceCollection(spaceId, 'links'), linkMoves.map(m => m.newId), { _id: 1 }, { session });
    const fresh = linkMoves.filter(m => !held.has(m.newId));
    // The old rows' tombstones BELOW the new rows' seqs — the re-key's order (`edge-rekey.ts`).
    await removeWithTombstones(spaceId, 'links',
      linkMoves.map(({ link }) => ({ _id: link._id, type: 'link' as const, deletedAt: now, originalSeq: link.seq })),
      { session, filter: { spaceId } });
    if (fresh.length > 0) {
      await withAllocatedSeqs(spaceId, fresh.length, (first) => linkColl.bulkWrite(asBulk<LinkDoc>(fresh.map(({ link, newId }, i) => ({
        replaceOne: {
          filter: { _id: newId, spaceId },
          replacement: { ...link, _id: newId, to: survivor._id, updatedAt: now, seq: first + i },
          upsert: true,
        },
      }))), { ordered: false, session }), 'entity.merge.link');
    }
  }

  // ── 4. Update the survivor, delete the absorbed entity + its tombstone ──
  const entityColl = col<EntityDoc>(spaceCollection(spaceId, 'entities'));
  const seq = await withSeq(spaceId, async (s) => {
    await entityColl.updateOne(asFilter<EntityDoc>({ _id: survivor._id }), asUpdate<EntityDoc>({ $set: { ...set, seq: s } }), { session });
    return s;
  }, 'entity.merge.survivor');
  await entityColl.deleteOne(asFilter<EntityDoc>({ _id: absorbed._id, spaceId }), { session });
  await writeTombstone(spaceId, { _id: absorbed._id, type: 'entity', deletedAt: now, originalSeq: absorbed.seq }, session);

  return {
    seq,
    rekeyed: moved.filter((m): m is EdgeRekey => m !== null),
    deletedDuplicateEdgeIds: duplicates.map(e => e._id),
  };
}

// ── The door ───────────────────────────────────────────────────────────────

/** What a merge door is answered: the plan's verdict, or the merge itself. Refusals are thrown (`mergeRefusal`). */
export type MergeOutcome =
  | { kind: 'not-found'; status: number; error: string }
  | { kind: 'invalid-resolution'; error: string }
  | { kind: 'unresolved'; plan: MergePlan }
  | { kind: 'merged'; plan: MergePlan; absorbed: EntityDoc; entity: EntityDoc; deletedDuplicateEdgeIds: string[] };

/**
 * Merge `absorbedId` into `survivorId` the way every door does: compute the plan, validate the resolutions given,
 * stop at an unresolved plan, apply the resolutions, execute.
 *
 * ONE function for the REST merge route, `POST /api/duplicates/:id/merge`, the `graph_merge` tool and automerge.
 * The sequence was written four times, and a check added to one copy is a check the other three do not make — the
 * shape this repository pays for most. A door decides only how to SAY the outcome; what happens is decided here.
 */
export async function mergeEntities(
  spaceId: string, survivorId: string, absorbedId: string, resolutions: PropertyResolution[], actor?: WebhookActor,
): Promise<MergeOutcome> {
  const result = await computeMergePlan(spaceId, survivorId, absorbedId, resolutions);
  if ('error' in result) return { kind: 'not-found', status: result.status, error: result.error };
  const { plan, fullyResolved, survivor, absorbed } = result;
  for (const c of plan.propertyConflicts) {
    if (!c.resolved) continue;
    const err = validateResolution(c.resolution!, c.type, c.customValue !== undefined);
    if (err) return { kind: 'invalid-resolution', error: `Invalid resolution for property '${c.key}': ${err}` };
  }
  if (!fullyResolved) return { kind: 'unresolved', plan };
  const mergedProperties = applyResolutions(
    survivor.properties ?? {}, absorbed.properties ?? {}, plan.propertyConflicts, plan.absorbedOnlyProperties,
  );
  const merged = await executeMerge(spaceId, survivor, absorbed, mergedProperties, actor);
  return { kind: 'merged', plan, absorbed, entity: merged.entity, deletedDuplicateEdgeIds: merged.deletedDuplicateEdgeIds };
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
