/**
 * A fact write, DECIDED — every rule `saveFact` applies, against a read set, with nothing written.
 *
 * The body of the old `saveFact` up to its write, moved here unchanged in what it decides; the commit writes
 * the plan and `saveFact` is the door that asks for one. See `types.ts` for why the two are apart.
 */
import { v4 as uuidv4 } from 'uuid';
import { authorRef } from '../../config/author.js';
import { type ContradictionWarning } from '../insert-contradictions.js';
import { factEmbedText } from '../embed-text.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { getSpaceMeta, applyPropertyDefaults } from '../../spaces/schema-validation.js';
import { classifyFactUpsertAgainst, SchemaViolationError, type UpdateValidation } from '../write-validation.js';
import { mergeTags, mergeProperties } from '../merge-fields.js';
import { type SimilarMatch } from '../recall.js';
import type { DupeCheckOpts } from '../write-options.js';
import type { FactDoc } from '../../config/types.js';
import { linkTargets, refuseLinks } from './plan-links.js';
import type { ReadSet, ReadWant } from './read-set.js';
import type { WritePlan } from './types.js';
import { convergeResult, finishInsert, neighbourAdvisories, vectorBeforeWrite } from './plan-steps.js';

export interface FactInput {
  fact: string;
  /** The entities this fact links to — a DESIRED LINK SET, never a stored field. */
  linkEntities?: string[];
  tags?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  type?: string;
  opts?: DupeCheckOpts & { onValidation?: (check: UpdateValidation) => void };
  ttlDays?: number | null;
  /** A caller-supplied id ADDRESSES an existing record (and makes a retry converge); it never mints one. */
  id?: string;
}

export interface FactPlanned {
  plan: WritePlan;
  similar?: SimilarMatch[];
  contradicts?: ContradictionWarning[];
}

/** What `planFact` will ask the read set. */
export function factWant(input: FactInput): ReadWant {
  return { records: { ...linkTargets({ entity: input.linkEntities ?? [] }), ...(input.id ? { fact: [input.id] } : {}) } };
}

export async function planFact(spaceId: string, input: FactInput, view: ReadSet): Promise<FactPlanned> {
  const linkEntities = input.linkEntities ?? [];
  const tags = input.tags ?? [];
  const { fact, description, type, opts, ttlDays } = input;
  const existing = input.id ? view.stored('fact', input.id) as unknown as FactDoc | null : null;

  /*
   * THE LINKS ARE REFUSED BEFORE THE RECORD IS WRITTEN — a bad id after the insert would leave the fact
   * stored without the links it asked for.
   */
  await refuseLinks(view, 'fact', { entity: linkEntities });

  /*
   * THE SCHEMA IS ENFORCED HERE, against the record the write will produce. Defaults on INSERT only, before
   * validation: a `required` property with a `default` is not a violation, and on an update an absent property
   * may be one the caller has just removed.
   */
  const meta = getSpaceMeta(spaceId);
  const properties = existing
    ? input.properties
    : applyPropertyDefaults(type ? meta?.typeSchemas?.fact?.[type] : undefined, input.properties);
  const check = classifyFactUpsertAgainst(meta, existing, { type, properties });
  if (check.blocked) throw new SchemaViolationError(check);
  opts?.onValidation?.(check);

  // No entity names: a fact embeds its own content. See `factEmbedText` for the measurement.
  const embedText = factEmbedText(fact, tags, description, properties);

  /*
   * Embed now, or hand it to the queue? An insert-time duplicate/contradiction check needs the vector BEFORE the
   * insert, so the new record cannot self-match — those flags IMPLY waiting. Suppression wins over all three:
   * `suppressEmbeddings` IS the absence of a vector, so computing one here stores what the flag forbids. And
   * the record tier is the one the record will HAVE — the stored flag unless this write states one (`Q-194`).
   */
  const { suppressed, vector } = await vectorBeforeWrite({
    spaceId, kind: 'fact', existing, schemaKey: { type: type ?? existing?.type }, stated: opts?.suppressEmbeddings,
    wanted: opts?.waitForEmbedding === true || opts?.checkDuplicates === true || opts?.checkContradictions === true,
    text: () => embedText,
  });
  const advisories = await neighbourAdvisories(spaceId, 'fact', vector, opts, { properties });
  const now = new Date().toISOString();

  /*
   * The idempotent branch: a supplied id that names a record CONVERGES rather than duplicating, with
   * `upsertEntity`'s merge semantics (tags union, properties shallow-merge) — one rule across the four kinds.
   * The link set is written UNCONDITIONALLY here, so a retried `saveFact` naming no entities wipes the stored
   * links; that asymmetry with chrono is the `M-2` row's question, not this one's.
   */
  if (existing) {
    const $set: Record<string, unknown> = {
      fact, tags: mergeTags(existing.tags, tags), matchedText: embedText, updatedAt: now,
    };
    // Only when a vector was computed: otherwise the previous one stays, describing the record as it was a
    // moment ago, while the queued job catches up. `matchedText` is always current, so the two can be compared.
    if (vector) Object.assign($set, vector);
    if (type !== undefined) $set['type'] = type;
    if (description !== undefined) $set['description'] = description;
    if (properties !== undefined) $set['properties'] = mergeProperties(existing.properties, properties);
    const $unset: Record<string, unknown> = {};
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'fact', existing: existing as unknown as Record<string, unknown> });
    const result = convergeResult(existing, $set, $unset);
    view.noteWritten('fact', result as unknown as { _id: string }, false);
    return {
      plan: {
        kind: 'fact', spaceId, id: existing._id, op: 'converge', set: $set, unset: $unset,
        expectSeq: existing.seq ?? null, result,
        // Enqueued even when the content is the same — the queue is what makes a stale vector catch up — but
        // not when suppressed, which would store the vector the flag forbids a few seconds later.
        enqueue: !vector && !suppressed,
        links: { fromKind: 'fact', desired: { entity: linkEntities }, author: existing.author ?? authorRef() },
        minted: false, dupeRules: false,
      },
      ...advisories,
    };
  }

  // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always.
  const doc: FactDoc = {
    _id: uuidv4(), spaceId, fact, tags, matchedText: embedText, author: authorRef(),
    createdAt: now, updatedAt: now, seq: 0,
    ...vector,
  };
  if (type !== undefined) doc.type = type;
  if (description !== undefined) doc.description = description;
  if (properties !== undefined) doc.properties = properties;
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'fact', type: doc.type });
  const insert = finishInsert({ view, kind: 'fact', doc, opts, meta });
  return {
    plan: {
      kind: 'fact', spaceId, id: doc._id, op: 'insert', doc: insert, result: insert,
      enqueue: !vector && !suppressed,
      links: { fromKind: 'fact', desired: { entity: linkEntities }, author: doc.author! },
      minted: true,
      // Only when embedded INLINE: a queued record gets them from the embed worker once its vector exists, and
      // running them here as well would evaluate it twice. Whether the space has `dupeRulesOnInsert` on is the
      // rule runner's own check (`evaluateRecordForDuplicates`), so it is not repeated here.
      dupeRules: vector !== null,
    },
    ...advisories,
  };
}
