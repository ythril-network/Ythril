/**
 * A fact write, DECIDED — every rule `saveFact` applies, against a read set, with nothing written.
 *
 * The body of the old `saveFact` up to its write, moved here unchanged in what it decides; the commit writes
 * the plan and `saveFact` is the door that asks for one. See `types.ts` for why the two are apart.
 */
import { authorRef } from '../../config/author.js';
import { type ContradictionWarning } from '../insert-contradictions.js';
import { factEmbedText } from '../embed-text.js';
import { derivedFieldsForWrite } from '../derived-text-on-write.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { applyPropertyDefaults } from '../../spaces/schema-validation.js';
import { readMetaForWrite, stampOp, stampSetOf, stampUnsetOf } from '../../spaces/schema-stamp.js';
import { classifyFactUpsertAgainst, recordAfterPatch, SchemaViolationError, type UpdateValidation } from '../write-validation.js';
import { mergeTags, mergeProperties } from '../merge-fields.js';
import { type SimilarMatch } from '../recall.js';
import type { DupeCheckOpts } from '../write-options.js';
import type { FactDoc } from '../../config/types.js';
import { linkTargets, refuseLinks } from './plan-links.js';
import type { ReadSet, ReadWant } from './read-set.js';
import type { WritePlan } from './types.js';
import { trustFor, mintedWant, mintedRecord, insertIdentity, type PlanTrust } from './trust.js';
import { convergeResult, finishInsert, foldRemovals, neighbourAdvisories, vectorBeforeWrite } from './plan-steps.js';

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
  /**
   * The property keys the instance itself writes on a fact, exempt from the undeclared-key rule (`Q-93`). Set by the one writer that owns
   * them (the extractor, through `bulkWrite`'s trusted argument) and by nothing that reads a request.
   */
  instanceWrittenKeys?: readonly string[];
  /** Dot paths removed from the stored fact after the merge (`foldRemovals`); refused on an insert, and a system field or a malformed path is refused by name. */
  deleteFields?: readonly string[];
  /** The target tag array, written as it is in place of the union (`foldRemovals`): how a caller takes one tag away. */
  replaceTags?: readonly string[];
}

export interface FactPlanned {
  plan: WritePlan;
  similar?: SimilarMatch[];
  contradicts?: ContradictionWarning[];
}

/** What `planFact` will ask the read set. */
export function factWant(input: FactInput, trust?: PlanTrust): ReadWant {
  return { records: { ...linkTargets({ entity: input.linkEntities ?? [] }), ...(input.id ? { fact: [input.id] } : mintedWant('fact', trust)) } };
}

/** `trust`: the minted id and the plan schema a trusted in-process caller hands the planner, never a request (`trust.ts`). */
export async function planFact(spaceId: string, input: FactInput, view: ReadSet, trust?: PlanTrust): Promise<FactPlanned> {
  const linkEntities = input.linkEntities ?? [];
  const { fact, description, type, opts, ttlDays } = input;
  const trusted = trustFor(spaceId, trust, input.id);
  const existing = (input.id ? view.stored('fact', input.id) : mintedRecord(view, 'fact', trusted)) as unknown as FactDoc | null;
  // A new fact has nothing to replace: the target IS its tags.
  const tags = existing === null && input.replaceTags ? [...input.replaceTags] : input.tags ?? [];

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
  // The meta and the schema stamp in ONE read (Q-736): the stamp names the schema this check judged with, never a later one.
  const write = readMetaForWrite(spaceId, trusted?.planMeta);
  const properties = existing
    ? input.properties
    : applyPropertyDefaults(type ? write.meta?.typeSchemas?.fact?.[type] : undefined, input.properties);
  // The removals, after the merge: what the record is LEFT with, and what the converge sets and unsets (`foldRemovals`).
  const folded = foldRemovals('fact', existing, existing ? {
    tags: mergeTags(existing.tags, tags),
    ...(description !== undefined ? { description } : {}),
    ...(properties !== undefined ? { properties: mergeProperties(existing.properties, properties) } : {}),
  } : {}, input);
  // A removal is judged on the record it leaves, as a PATCH is; every other write on the merge of what it states over what is stored.
  const check = folded.removing
    ? classifyFactUpsertAgainst(write.meta, existing, recordAfterPatch(existing!, { fact, ...(type !== undefined ? { type } : {}), ...folded.data }, folded.unset), input.instanceWrittenKeys)
    : classifyFactUpsertAgainst(write.meta, existing, { fact, type, description, tags, properties }, input.instanceWrittenKeys);
  if (check.blocked) throw new SchemaViolationError(check);
  opts?.onValidation?.(check);

  // No entity names: a fact embeds its own content. See `factEmbedText` for the measurement. The text is the record the write
  // STORES: on a converge the merge (tags union, properties shallow-merge, description kept when the write names none) with the removals
  // applied, exactly what the `$set` below writes, so a text stored or embedded here is the text the queued job would build (as `planEntity` does).
  const left = folded.left as { tags?: string[]; description?: string; properties?: Record<string, string | number | boolean> };
  const embedText = existing
    ? factEmbedText(fact, left.tags ?? [], left.description, left.properties)
    : factEmbedText(fact, tags, description, properties);

  /*
   * Embed now, or hand it to the queue? An insert-time duplicate/contradiction check needs the vector BEFORE the
   * insert, so the new record cannot self-match — those flags IMPLY waiting. Suppression wins over all three:
   * `suppressEmbeddings` IS the absence of a vector, so computing one here stores what the flag forbids. And
   * the record tier is the one the record will HAVE — the stored flag unless this write states one (`Q-194`).
   */
  const { suppressed, vector } = await vectorBeforeWrite({
    spaceId, kind: 'fact', existing, schemaKey: { type: type ?? existing?.type }, stated: opts?.suppressEmbeddings,
    wanted: opts?.waitForEmbedding === true || opts?.checkDuplicates === true || opts?.checkContradictions === true,
    planMeta: trusted?.planMeta !== undefined ? write.meta : undefined,
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
    // The vector and the text it was made from go in together or not at all: with no vector computed the previous pair
    // stays, describing each other, while the queued job catches up (rule I, `derivedFieldsForWrite`).
    const derived = await derivedFieldsForWrite({ text: () => embedText, vector, suppressed, onto: 'stored' });
    // Stamped when the converged record conforms, unstamped when it does not (a stamp means "conforms as stored").
    const stamp = stampOp(write, check);
    // `folded.data` is the merged tags, a stated description and the merged properties (when stated), with the removals applied.
    const $set: Record<string, unknown> = {
      fact, ...folded.data, updatedAt: now, ...derived.set, ...stampSetOf(stamp),
    };
    if (type !== undefined) $set['type'] = type;
    const $unset: Record<string, unknown> = { ...folded.unset, ...derived.unset, ...stampUnsetOf(stamp) };
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

  // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always (a trusted minted id is the instance's own).
  const doc: FactDoc = {
    _id: insertIdentity(trusted), spaceId, fact, tags, author: authorRef(),
    createdAt: now, updatedAt: now, seq: 0,
    ...(await derivedFieldsForWrite({ text: () => embedText, vector, suppressed, onto: 'insert' })).set,
  };
  if (type !== undefined) doc.type = type;
  if (description !== undefined) doc.description = description;
  if (properties !== undefined) doc.properties = properties;
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'fact', type: doc.type });
  const insert = finishInsert({ view, kind: 'fact', doc, opts, write, check });
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
