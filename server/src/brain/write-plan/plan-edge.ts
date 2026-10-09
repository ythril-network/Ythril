/**
 * An edge write, DECIDED — every rule `upsertEdge` applies, against a read set, with nothing written.
 *
 * An edge's identity is its triplet and the kinds of its two ends, so the "existing" record is found by that
 * identity rather than by an id; a write of a triplet already stored converges onto it. The endpoint rules need
 * what the payload does not carry — the TYPE of the entity at each end, and how many other edges share this
 * subject under a functional label — and the read set holds both, including what this batch has already planned.
 *
 * ## The refusal is its own function (`Q-170`)
 *
 * `edgeRefusal` is the refusal half of the decision: the triplet, the defaults, the resolved ends, the classifier and —
 * under `strictLinkage` — whether each end exists. It is asked twice for one edge on purpose: by a door BEFORE the
 * record an inline edge hangs off is written, so that a refusal leaves nothing behind, and by `planEdge` before it decides
 * anything, because the writer cannot enforce a weaker rule than the one the door asked. It records nothing and embeds
 * nothing, so asking it is free of consequence — the property the first ask depends on.
 *
 * The kinds a plan stores are the kinds its caller RESOLVED, always. A bulk edge whose end was a `$ref` to a fact
 * used to be existence-checked as a fact and stored as an entity endpoint (`Q-193`), because the door passed a
 * kind only when the caller had typed one; the door now always passes them, and this stores what it is given.
 */
import { authorRef } from '../../config/author.js';
import { edgeEmbedText } from '../embed-text.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { getSpaceMeta, applyPropertyDefaults, type ResolvedEdgeEnds } from '../../spaces/schema-validation.js';
import { isStrictLinkage } from '../../spaces/proxy.js';
import {
  classifyEdgeUpsertAgainst, danglingReferenceCheck, EdgeSchemaViolation, type UpdateValidation,
} from '../write-validation.js';
import { mergePropertiesOrKeep, mergeTagsOrKeep } from '../merge-fields.js';
import { type RecordFlags } from '../record-flag.js';
import { edgeIdFor } from '../edge-id.js';
import { storedEdgeKind, edgeEndpointKind, missingRefsRefusal } from '../entity-refs.js';
import { resolveEdgeEndpointNames } from '../edge-endpoint-names.js';
import type { EdgeDoc } from '../../config/types.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { ReadSet, type ReadWant, type Triplet } from './read-set.js';
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

// Declared in `write-validation.ts`, beside the `SchemaViolationError` it extends; re-exported because this is where the
// refusal is raised and `edges.ts` and `bulk.ts` already import it from here.
export { EdgeSchemaViolation };

export interface EdgePlanned {
  plan: WritePlan;
  /** Whether the triplet was stored before this write — what a batch counts as updated. */
  existed: boolean;
}

/**
 * The record an inline edge hangs off, as a refusal needs to know it BEFORE that record is written.
 *
 * - `id` is the record's own, or — for a create — a placeholder no collection holds (`minted`), which is what an edge's
 *   `from` is while the record does not exist yet.
 * - `type` is the type the record WILL have, `null` when it has none (`undefined` never): an entity's `endpoints` rule
 *   is judged by the type the write leaves, not by the stored one, and a subject that is not an entity has none.
 * - `minted`: nothing stored can be an edge from it, so its triplets and its functional count are answered without a read.
 *
 * Built by one function (`connectionSubject`, `brain/write-connections.ts`), because a door building it by hand is a door
 * that reads the stored type of a record its own patch is about to change.
 */
export interface EdgeSubject { id: string; type: string | null; minted: boolean }

/**
 * What `edgeRefusal` and `planEdge` will ask the read set: the entity ends' types, the existence of every other end
 * (`strictLinkage` only — a lax space refuses nothing for a dangling end), the triplet, a functional label's subject.
 *
 * With a `subject`, the subject's own end is neither read nor looked up: the caller already says what it is, and for a
 * `minted` one nothing stored can match its triplet or share its functional label.
 */
export function edgeWant(spaceId: string, input: EdgeInput, subject?: EdgeSubject): ReadWant {
  const { from, to, label } = input;
  const fromKind = input.opts?.fromKind;
  const toKind = input.opts?.toKind;
  const ends = [{ id: from, kind: edgeEndpointKind(fromKind) }, { id: to, kind: edgeEndpointKind(toKind) }]
    .filter(e => e.id !== subject?.id);
  const entityEnds = ends.filter(e => e.kind === 'entity').map(e => e.id);
  const exist: NonNullable<ReadWant['exist']> = {};
  if (isStrictLinkage(spaceId)) {
    for (const e of ends) if (e.kind !== 'entity') exist[e.kind] = [...(exist[e.kind] ?? []), e.id];
  }
  return {
    records: entityEnds.length > 0 ? { entity: entityEnds } : {},
    ...(Object.keys(exist).length > 0 ? { exist } : {}),
    ...(subject?.minted ? {} : {
      triplets: [{ from, to, label, fromKind, toKind }],
      ...(isFunctionalLabel(spaceId, label) ? { functional: [{ from, label }] } : {}),
    }),
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
  subject?: EdgeSubject, sameBody: readonly Triplet[] = [],
): ResolvedEdgeEnds {
  const out: ResolvedEdgeEnds = {};
  // The subject's type is the type its record will HAVE, so it is never read back from the store (which holds the old one).
  const typeOf = (id: string): string | null | undefined => {
    if (id === subject?.id) return subject.type;
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
  if (functional) out.otherEdgesFromSubject = view.otherEdgesFromSubject(input.from, input.label, input.to, sameBody);
  return out;
}

/** What an edge write that was NOT refused leaves its caller: the stored edge it lands on, the properties to store, and the classification. */
export interface EdgeAllowed {
  existing: EdgeDoc | null;
  /** The caller's properties with the space's defaults filled in — on an insert only, so an update cannot resurrect a deletion. */
  withDefaults: EdgeInput['properties'];
  check: UpdateValidation;
}

/**
 * Refuse an edge write that the space's rules do not allow — or return what the write would be allowed to store.
 *
 * ## What it prevents
 *
 * The refusal of an edge was decided in three places: the planner (schema), the doors (an end that names nothing) and,
 * for an edge a record write carries inline, nowhere before the record was stored. A record whose inline edge was
 * refused AFTER it was written is a caller told "refused" holding a row they did not ask for. This is the one
 * function that decides, and a door asks it before it writes anything.
 *
 * ## What it is
 *
 * Pure: it reads only what the read set holds and records NOTHING in it — no `noteWritten`, so a refused edge leaves no
 * phantom behind for the next item of a batch — and starts no embedding. The caller must have `load`ed what
 * `edgeWant` names, with the same `subject`.
 *
 * - **`strictLinkage` only** refuses an end that names nothing, in the collection its kind names. A lax space has
 *   chosen to accept dangling ends. The subject's own end is not asked about: it is the record being written.
 * - **`subject`** says what the edge hangs off when that record is not stored yet (or about to change): its type is the
 *   type the write leaves, and a minted one has no stored edges.
 * - **`sameBody`** is the edges of the same write that already passed. A refusal records nothing, so without it two
 *   edges under one `functional` label in one body would each meet a count that cannot see the other.
 *
 * A violation the stored edge already had does not refuse an unrelated write (`classifyEdgeUpsertAgainst`); only what
 * this write introduces does.
 */
export function edgeRefusal(
  spaceId: string, input: EdgeInput, view: ReadSet, subject: EdgeSubject | undefined, sameBody: readonly EdgeInput[],
): EdgeAllowed {
  const { from, to, label, properties, opts } = input;
  if (isStrictLinkage(spaceId)) {
    for (const [id, kind, field] of [[from, edgeEndpointKind(opts?.fromKind), 'from'], [to, edgeEndpointKind(opts?.toKind), 'to']] as const) {
      if (id === subject?.id) continue;
      const dangling = missingRefsRefusal(spaceId, field, kind, view.missing(kind, [id]));
      if (dangling) throw new EdgeSchemaViolation(danglingReferenceCheck(field, id, dangling.message));
    }
  }
  if (subject?.minted) view.mint(subject.id);
  const existing = view.triplet({ from, to, label, fromKind: opts?.fromKind, toKind: opts?.toKind });

  /*
   * THE SCHEMA IS ENFORCED HERE, so that no caller can reach the collection around it — owner's ruling,
   * 2026-08-29: "upsertEdge should validate of course." Defaults fill in what the caller omitted before
   * validation and only on an INSERT.
   */
  const meta = getSpaceMeta(spaceId);
  const withDefaults = existing ? properties : applyPropertyDefaults(meta?.typeSchemas?.edge?.[label], properties);
  const functional = isFunctionalLabel(spaceId, label);
  const passed = sameBody.map(e => ({ from: e.from, to: e.to, label: e.label, fromKind: e.opts?.fromKind, toKind: e.opts?.toKind }));
  const ends = resolvedEnds(view, input, functional, subject, passed);
  const check = classifyEdgeUpsertAgainst(meta, existing, { label, properties: withDefaults }, ends);
  if (check.blocked) throw new EdgeSchemaViolation(check);
  return { existing, withDefaults, check };
}

export async function planEdge(spaceId: string, input: EdgeInput, view: ReadSet): Promise<EdgePlanned> {
  const { from, to, label, weight, type, description, tags, ttlDays, properties, opts } = input;
  // The refusal first: nothing below is decided, noted or embedded for an edge the space does not allow.
  const { existing, withDefaults, check } = edgeRefusal(spaceId, input, view, undefined, []);
  opts?.onValidation?.(check);
  const meta = getSpaceMeta(spaceId);

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
