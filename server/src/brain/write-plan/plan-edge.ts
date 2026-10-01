/**
 * An edge write, DECIDED — every rule `upsertEdge` applies, against a read set, with nothing written.
 *
 * An edge's identity is its triplet and the kinds of its two ends, so the "existing" record is found by that
 * identity rather than by an id; a write of a triplet already stored converges onto it. The endpoint rules need
 * what the payload does not carry — the TYPE of the entity at each end, and how many other edges share this
 * subject under a functional label — and the read set holds both, including what this batch has already planned.
 *
 * The kinds a plan stores are the kinds its caller RESOLVED, always. A bulk edge whose end was a `$ref` to a fact
 * used to be existence-checked as a fact and stored as an entity endpoint (`Q-193`), because the door passed a
 * kind only when the caller had typed one; the door now always passes them, and this stores what it is given.
 */
import { authorRef } from '../../config/author.js';
import { embed } from '../embedding.js';
import { edgeEmbedText } from '../embed-text.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { stampSkewOnCreate } from '../stamp-skew.js';
import { getSpaceMeta, applyPropertyDefaults, type ResolvedEdgeEnds } from '../../spaces/schema-validation.js';
import { classifyEdgeUpsertAgainst, type UpdateValidation } from '../write-validation.js';
import { mergePropertiesOrKeep, mergeTagsOrKeep } from '../merge-fields.js';
import { suppressedAfterWrite } from '../suppress-embeddings.js';
import { applyRecordFlags, type RecordFlags } from '../record-flag.js';
import { edgeIdFor } from '../edge-id.js';
import { storedEdgeKind, edgeEndpointKind } from '../entity-refs.js';
import { resolveEdgeEndpointNames } from '../edge-endpoint-names.js';
import type { EdgeDoc } from '../../config/types.js';
import type { RefKind } from '../../config/types-knowledge.js';
import type { ReadSet, ReadWant } from './read-set.js';
import type { WritePlan } from './types.js';

export interface EdgeInput {
  from: string;
  to: string;
  label: string;
  weight?: number;
  type?: string;
  description?: string;
  properties?: Record<string, string | number | boolean>;
  tags?: string[];
  ttlDays?: number | null;
  opts?: RecordFlags & {
    waitForEmbedding?: boolean;
    onValidation?: (check: UpdateValidation) => void;
    fromKind?: RefKind;
    toKind?: RefKind;
  };
}

/**
 * A refused edge write, carrying the whole classification rather than a message.
 *
 * Both doors answer with `{ error: 'schema_violation', message, violations, introduced, preExisting }`, and
 * neither should have to rebuild that from prose. Carrying `UpdateValidation` means the response shape is
 * unchanged by where the check runs. Declared here, where the refusal is raised; `edges.ts` re-exports it.
 */
export class EdgeSchemaViolation extends Error {
  constructor(readonly check: UpdateValidation) {
    super(check.message ?? 'schema_violation');
    this.name = 'EdgeSchemaViolation';
  }
}

export interface EdgePlanned {
  plan: WritePlan;
  /** Whether the triplet was stored before this write — what a batch counts as updated. */
  existed: boolean;
}

/** What `planEdge` will ask the read set: the entity ends' types, the triplet, a functional label's subject. */
export function edgeWant(spaceId: string, input: EdgeInput): ReadWant {
  const { from, to, label } = input;
  const fromKind = input.opts?.fromKind;
  const toKind = input.opts?.toKind;
  const entityEnds = [
    ...(edgeEndpointKind(fromKind) === 'entity' ? [from] : []),
    ...(edgeEndpointKind(toKind) === 'entity' ? [to] : []),
  ];
  const functional = getSpaceMeta(spaceId)?.typeSchemas?.edge?.[label]?.functional === true;
  return {
    records: entityEnds.length > 0 ? { entity: entityEnds } : {},
    triplets: [{ from, to, label, fromKind, toKind }],
    ...(functional ? { functional: [{ from, label }] } : {}),
  };
}

/**
 * The endpoint facts the classifier reads, from the read set — `resolveEdgeEndsForWrite`'s answer without its
 * queries. An entity end resolves to its type (`null`: there and untyped); an end that is not there resolves to
 * nothing, which is never a violation. Non-entity ends have no type in the endpoint vocabulary and are left out.
 */
function resolvedEnds(view: ReadSet, input: EdgeInput, functional: boolean): ResolvedEdgeEnds {
  const out: ResolvedEdgeEnds = {};
  const typeOf = (id: string): string | null | undefined => {
    const doc = view.stored('entity', id);
    return doc === null ? undefined : (typeof doc['type'] === 'string' ? doc['type'] : null);
  };
  if (edgeEndpointKind(input.opts?.fromKind) === 'entity') {
    const t = typeOf(input.from);
    if (t !== undefined) out.fromType = t;
  }
  if (edgeEndpointKind(input.opts?.toKind) === 'entity') {
    const t = typeOf(input.to);
    if (t !== undefined) out.toType = t;
  }
  if (functional) out.otherEdgesFromSubject = view.otherEdgesFromSubject(input.from, input.label, input.to);
  return out;
}

export async function planEdge(spaceId: string, input: EdgeInput, view: ReadSet): Promise<EdgePlanned> {
  const { from, to, label, weight, type, description, properties, tags, ttlDays, opts } = input;
  const existing = view.triplet({ from, to, label, fromKind: opts?.fromKind, toKind: opts?.toKind });

  /*
   * THE SCHEMA IS ENFORCED HERE, so that no caller can reach the collection around it — owner's ruling,
   * 2026-08-29: "upsertEdge should validate of course." Defaults fill in what the caller omitted before
   * validation and only on an INSERT.
   */
  const meta = getSpaceMeta(spaceId);
  const withDefaults = existing ? properties : applyPropertyDefaults(meta?.typeSchemas?.edge?.[label], properties);
  const functional = meta?.typeSchemas?.edge?.[label]?.functional === true;
  const ends = resolvedEnds(view, input, functional);
  const check = classifyEdgeUpsertAgainst(meta, existing, { label, properties: withDefaults }, ends);
  if (check.blocked) throw new EdgeSchemaViolation(check);
  opts?.onValidation?.(check);

  const now = new Date().toISOString();
  const effectiveDesc = description ?? existing?.description;
  const effectiveType = type ?? existing?.type;
  const effectiveTags = mergeTagsOrKeep(existing?.tags, tags);
  // `withDefaults`, not `properties` — the defaults were validated above and must be the values STORED.
  const effectiveProps = mergePropertiesOrKeep(existing?.properties, withDefaults);

  // Suppression wins over `waitForEmbedding`, on the record the write LEAVES (`Q-194`). An edge keys its schema
  // on `label`, not `type`, which `schemaKeyFor` already encodes.
  const suppressed = suppressedAfterWrite(spaceId, 'edge', existing as unknown as Record<string, unknown> | null,
    { label }, opts?.suppressEmbeddings);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText?: string } = {};
  if (opts?.waitForEmbedding === true && !suppressed) {
    // Resolving the endpoint NAMES is a read, so it happens only on the inline path; the queued job resolves
    // them itself from the stored edge.
    const [fromName, toName] = await resolveEdgeEndpointNames(spaceId, from, to, opts?.fromKind, opts?.toKind);
    const embedText = edgeEmbedText(fromName, label, toName, effectiveTags, effectiveType, effectiveDesc, effectiveProps);
    const embResult = await embed(embedText);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model, matchedText: embedText };
  }

  if (existing) {
    const $set: Record<string, unknown> = { updatedAt: now, ...embeddingFields };
    if (weight !== undefined) $set['weight'] = weight;
    if (type !== undefined) $set['type'] = type;
    if (description !== undefined) $set['description'] = description;
    // When tags are provided, persist the merged result; otherwise leave existing tags unchanged.
    if (tags !== undefined) $set['tags'] = effectiveTags;
    if (properties !== undefined) $set['properties'] = effectiveProps;
    const $unset: Record<string, unknown> = {};
    // Correcting a kind back to `entity` must UNSET it: absent is the canonical form, and a stored `'entity'`
    // would make this edge unfindable by its own triplet lookup.
    for (const side of ['fromKind', 'toKind'] as const) {
      const given = side === 'fromKind' ? opts?.fromKind : opts?.toKind;
      if (given === undefined) continue;
      const stored = storedEdgeKind(given);
      if (stored) $set[side] = stored; else $unset[side] = '';
    }
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'edge', existing: existing as unknown as Record<string, unknown> }); // F10
    const result: Record<string, unknown> = { ...existing, ...$set };
    for (const k of Object.keys($unset)) delete result[k];
    view.noteWritten('edge', result as unknown as { _id: string }, false);
    return {
      plan: {
        kind: 'edge', spaceId, id: existing._id, op: 'converge', set: $set, unset: $unset,
        expectSeq: existing.seq ?? null, result,
        enqueue: !embeddingFields.embedding && !suppressed,
        minted: false, dupeRules: false,
      },
      existed: true,
    };
  }

  const fromKind = storedEdgeKind(opts?.fromKind);
  const toKind = storedEdgeKind(opts?.toKind);
  const doc: EdgeDoc = {
    _id: edgeIdFor(from, to, label, opts?.fromKind, opts?.toKind),
    spaceId, from, to,
    // Normalised: an entity end is stored as ABSENT, the one representation the triplet lookup matches.
    ...(fromKind ? { fromKind } : {}),
    ...(toKind ? { toKind } : {}),
    label,
    tags: tags ?? [],
    ...(type !== undefined ? { type } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(withDefaults !== undefined ? { properties: withDefaults } : {}),
    author: authorRef(),
    createdAt: now, updatedAt: now, seq: 0,
    ...embeddingFields,
  };
  applyRecordFlags(doc, opts);
  // `doc.label`, NOT `doc.type` — an edge has both, and the schema is keyed by label.
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'edge', type: doc.label });
  stampSkewOnCreate(doc, meta);
  const { seq: _seq, ...insert } = doc;
  view.noteWritten('edge', doc, true);
  return {
    plan: {
      kind: 'edge', spaceId, id: doc._id, op: 'insert', doc: insert, result: insert,
      enqueue: !embeddingFields.embedding && !suppressed,
      minted: true, dupeRules: false,
    },
    existed: false,
  };
}
