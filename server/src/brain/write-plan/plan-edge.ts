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
import { edgeEmbedText } from '../embed-text.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { getSpaceMeta, applyPropertyDefaults, type ResolvedEdgeEnds } from '../../spaces/schema-validation.js';
import { classifyEdgeUpsertAgainst, type UpdateValidation } from '../write-validation.js';
import { mergePropertiesOrKeep, mergeTagsOrKeep } from '../merge-fields.js';
import { type RecordFlags } from '../record-flag.js';
import { edgeIdFor } from '../edge-id.js';
import { storedEdgeKind, edgeEndpointKind } from '../entity-refs.js';
import { resolveEdgeEndpointNames } from '../edge-endpoint-names.js';
import type { EdgeDoc } from '../../config/types.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { ReadSet, type ReadWant } from './read-set.js';
import type { WritePlan } from './types.js';
import { convergeResult, finishInsert, vectorBeforeWrite } from './plan-steps.js';

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
  return {
    records: entityEnds.length > 0 ? { entity: entityEnds } : {},
    triplets: [{ from, to, label, fromKind, toKind }],
    ...(isFunctionalLabel(spaceId, label) ? { functional: [{ from, label }] } : {}),
  };
}

/**
 * Whether the space declares this label functional — a subject carries at most one edge under it. One reading
 * for the want and the plan: if they disagreed, the plan would ask the read set for a count it never loaded.
 */
function isFunctionalLabel(spaceId: string, label: string): boolean {
  return getSpaceMeta(spaceId)?.typeSchemas?.edge?.[label]?.functional === true;
}

/**
 * The endpoint facts for an edge's ends, read from the store — for a write that is not planned here (a patch,
 * which may change the label and so the rules). Through a one-shot read set, so a patch and a create resolve
 * ends by the same rule rather than by two implementations of it.
 */
export async function resolveEdgeEndsForWrite(
  spaceId: string, input: Pick<EdgeInput, 'from' | 'to' | 'label' | 'opts'>,
): Promise<ResolvedEdgeEnds> {
  const view = new ReadSet(spaceId);
  const { records, functional } = edgeWant(spaceId, input as EdgeInput);
  await view.load({ records, ...(functional ? { functional } : {}) });
  return resolvedEnds(view, input, isFunctionalLabel(spaceId, input.label));
}

/**
 * What a write needs to know about an edge's endpoints before a schema rule can be checked.
 *
 * `validateEdge` is pure and synchronous — two gates import it from `dist` and call it with plain objects — so
 * it cannot look anything up. The writer resolves and hands over what it FOUND, and an absent field is never a
 * violation: that is what lets the bulk importer, which legitimately cannot resolve a forward reference, use
 * the same validator without being told its payload is wrong.
 *
 * - **`null` is not `undefined`.** `null` means the entity is there and has no type, which an `endpoints` list
 *   matches with `UNTYPED`; `undefined` means it could not be resolved — a dangling reference, which
 *   `strictLinkage: false` makes a deliberate state. Collapsing them lets every untyped entity past every rule.
 * - **Types only for ENTITY ends.** `endpoints` is a vocabulary of entity types plus `UNTYPED`; a fact, chrono
 *   entry or file has no type in it, so resolving one would invent a value the schema cannot express.
 * - **The count excludes the edge being written.** An edge is not its own duplicate; without the exclusion a
 *   `functional` label can be written once and never touched again.
 */
function resolvedEnds(
  view: ReadSet, input: Pick<EdgeInput, 'from' | 'to' | 'label' | 'opts'>, functional: boolean,
): ResolvedEdgeEnds {
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
  const functional = isFunctionalLabel(spaceId, label);
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
  // `matchedText` only on the inline path, where the text is built: the queued job writes its own.
  let matchedText: string | undefined;
  const { suppressed, vector } = await vectorBeforeWrite({
    spaceId, kind: 'edge', existing, schemaKey: { label }, stated: opts?.suppressEmbeddings,
    wanted: opts?.waitForEmbedding === true,
    // Resolving the endpoint NAMES is a read, so it happens only on the inline path; the queued job resolves
    // them itself from the stored edge.
    text: async () => {
      const [fromName, toName] = await resolveEdgeEndpointNames(spaceId, from, to, opts?.fromKind, opts?.toKind);
      matchedText = edgeEmbedText(fromName, label, toName, effectiveTags, effectiveType, effectiveDesc, effectiveProps);
      return matchedText;
    },
  });
  const embeddingFields = vector ? { ...vector, matchedText: matchedText! } : {};

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
    const result = convergeResult(existing, $set, $unset);
    view.noteWritten('edge', result as unknown as { _id: string }, false);
    return {
      plan: {
        kind: 'edge', spaceId, id: existing._id, op: 'converge', set: $set, unset: $unset,
        expectSeq: existing.seq ?? null, result,
        enqueue: !vector && !suppressed,
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
  // `doc.label`, NOT `doc.type` — an edge has both, and the schema is keyed by label.
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'edge', type: doc.label });
  const insert = finishInsert({ view, kind: 'edge', doc, opts, meta });
  return {
    plan: {
      kind: 'edge', spaceId, id: doc._id, op: 'insert', doc: insert, result: insert,
      enqueue: !vector && !suppressed,
      minted: true, dupeRules: false,
    },
    existed: false,
  };
}
