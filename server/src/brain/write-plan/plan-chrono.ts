/**
 * A chrono write, DECIDED — every rule `createChrono` applies, against a read set, with nothing written.
 *
 * One difference from the code it was moved out of, and it is the fix: a converge onto an existing entry
 * QUEUES its re-embed (`Q-192`). The insert branch always did and the converge branch never did, so an entry
 * rewritten with new content kept the vector of the content it no longer had.
 */
import { authorRef } from '../../config/author.js';
import { type ContradictionWarning } from '../insert-contradictions.js';
import { chronoEmbedText } from '../embed-text.js';
import { derivedFieldsForWrite } from '../derived-text-on-write.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { applyPropertyDefaults, getAllowedChronoTypes } from '../../spaces/schema-validation.js';
import { chronoTypeError } from '../record-checks.js';
import { RequestRefusal } from '../../util/errors.js';
import { readMetaForWrite, stampOp, stampSetOf, stampUnsetOf } from '../../spaces/schema-stamp.js';
import { classifyChronoUpsertAgainst, recordAfterPatch, SchemaViolationError, type UpdateValidation } from '../write-validation.js';
import { mergeTags, mergeProperties } from '../merge-fields.js';
import { type SimilarMatch } from '../recall.js';
import type { DupeCheckOpts } from '../write-options.js';
import type { ChronoEntry, ChronoType, ChronoStatus } from '../../config/types.js';
import { linkTargets, refuseLinks } from './plan-links.js';
import type { ReadSet, ReadWant } from './read-set.js';
import type { WritePlan } from './types.js';
import { trustFor, mintedWant, mintedRecord, insertIdentity, type PlanTrust } from './trust.js';
import { convergeResult, finishInsert, foldRemovals, neighbourAdvisories, vectorBeforeWrite } from './plan-steps.js';

export interface ChronoFields {
  title: string;
  type: ChronoType;
  startsAt: string;
  description?: string;
  endsAt?: string;
  status?: ChronoStatus;
  confidence?: number;
  tags?: string[];
  /**
   * The entities and facts this entry links to — DESIRED LINK SETS, never stored fields. They were `entityIds`
   * and `memoryIds`, written onto the record AND handed to the reconcile; 5.0 made the link rows the storage.
   */
  linkEntities?: string[];
  linkFacts?: string[];
  properties?: Record<string, string | number | boolean>;
  recurrence?: ChronoEntry['recurrence'];
  /**
   * A caller-supplied UUID v4, which makes this write idempotent: a retried create that names an existing entry
   * CONVERGES on the same content instead of producing a second calendar entry.
   */
  id?: string;
}

export interface ChronoInput {
  fields: ChronoFields;
  ttlDays?: number | null;
  opts?: DupeCheckOpts & { onValidation?: (check: UpdateValidation) => void };
  /** Dot paths removed from the stored entry after the merge (`foldRemovals`); refused on an insert, and a system field or a malformed path is refused by name. */
  deleteFields?: readonly string[];
  /** The target tag array, written as it is in place of the union (`foldRemovals`): how a caller takes one tag away. */
  replaceTags?: readonly string[];
}

export interface ChronoPlanned {
  plan: WritePlan;
  similar?: SimilarMatch[];
  contradicts?: ContradictionWarning[];
}

const desiredOf = (f: ChronoFields) => ({ entity: f.linkEntities ?? [], fact: f.linkFacts ?? [] });

/** What `planChrono` will ask the read set. */
export function chronoWant(input: ChronoInput, trust?: PlanTrust): ReadWant {
  return { records: { ...linkTargets(desiredOf(input.fields)), ...(input.fields.id ? { chrono: [input.fields.id] } : mintedWant('chrono', trust)) } };
}

/** `trust`: the minted id and the plan schema a trusted in-process caller hands the planner, never a request (`trust.ts`). */
export async function planChrono(spaceId: string, input: ChronoInput, view: ReadSet, trust?: PlanTrust): Promise<ChronoPlanned> {
  const { ttlDays, opts } = input;
  let fields = input.fields;
  const desired = desiredOf(fields);
  const trusted = trustFor(spaceId, trust, fields.id);
  // THE LINKS ARE REFUSED BEFORE THE ENTRY IS WRITTEN — see `planFact`.
  await refuseLinks(view, 'chrono', desired);

  const existing = fields.id ? view.stored('chrono', fields.id) as unknown as ChronoEntry | null
    : mintedRecord(view, 'chrono', trusted) as unknown as ChronoEntry | null;

  // THE SCHEMA IS ENFORCED HERE, against the merged record; defaults on insert only.
  // The meta and the schema stamp in ONE read (Q-736): the stamp names the schema this check judged with, never a later one.
  const write = readMetaForWrite(spaceId, trusted?.planMeta);
  // A record built from a document (an import's trusted arguments) meets the allowlist the doors hold a create to, in every validation mode:
  // the plan schema's chrono types when it defines any, else the built-in ones (review F2).
  if (trusted) {
    const typeRefusal = chronoTypeError(fields.type, getAllowedChronoTypes(write.meta));
    if (typeRefusal) throw new RequestRefusal(typeRefusal);
  }
  const withDefaults = existing
    ? fields.properties
    : applyPropertyDefaults(write.meta?.typeSchemas?.chrono?.[fields.type], fields.properties);
  const status = fields.status ?? 'upcoming';
  // A new entry has nothing to replace: the target IS its tags.
  const tags = existing === null && input.replaceTags ? [...input.replaceTags] : fields.tags ?? [];
  // The removals, after the merge: what the entry is LEFT with, and what the converge sets and unsets (`foldRemovals`).
  const folded = foldRemovals('chrono', existing, existing ? {
    tags: mergeTags(existing.tags, tags),
    ...(fields.endsAt !== undefined ? { endsAt: fields.endsAt } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.confidence !== undefined ? { confidence: fields.confidence } : {}),
    ...(withDefaults !== undefined ? { properties: mergeProperties(existing.properties, withDefaults) } : {}),
    ...(fields.recurrence !== undefined ? { recurrence: fields.recurrence } : {}),
  } : {}, input);
  // A removal is judged on the entry it leaves, as a PATCH is; every other write on the merge of what it states over what is stored.
  const check = folded.removing
    ? classifyChronoUpsertAgainst(write.meta, existing,
      recordAfterPatch(existing!, { title: fields.title, type: fields.type, startsAt: fields.startsAt, status, ...folded.data }, folded.unset))
    : classifyChronoUpsertAgainst(write.meta, existing,
      { title: fields.title, type: fields.type, description: fields.description, tags: existing === null ? tags : fields.tags, properties: withDefaults });
  if (check.blocked) throw new SchemaViolationError(check);
  opts?.onValidation?.(check);
  fields = { ...fields, properties: withDefaults };

  const now = new Date().toISOString();

  // A suppressed record stays findable lexically: `derivedFieldsForWrite` stores its text with no vector.
  // The text is the record the write STORES: on a converge the merge (see `planFact`) with the removals applied, exactly what the `$set` below writes.
  const left = folded.left as { tags?: string[]; description?: string; properties?: Record<string, string | number | boolean> };
  const embedText = existing
    ? chronoEmbedText(fields.title, fields.type, status, left.description, left.tags ?? [], left.properties)
    : chronoEmbedText(fields.title, fields.type, status, fields.description, tags, fields.properties);
  // Suppression wins over `waitForEmbedding`, on the record the write LEAVES (`Q-194`).
  // A removal of the flag leaves the entry with none, which is `false` to the decision (never "state nothing": that reads the stored `true`).
  const { suppressed, vector } = await vectorBeforeWrite({
    spaceId, kind: 'chrono', existing, schemaKey: { type: fields.type },
    stated: 'suppressEmbeddings' in folded.unset ? false : opts?.suppressEmbeddings,
    wanted: opts?.waitForEmbedding === true,
    planMeta: trusted?.planMeta !== undefined ? write.meta : undefined,
    text: () => embedText,
  });
  // The vector and the text it was made from go in together or not at all (rule I, `derivedFieldsForWrite`).
  const derived = await derivedFieldsForWrite({ text: () => embedText, vector, suppressed, onto: existing ? 'stored' : 'insert' });

  // The structured judge compares the stored `status`, not the dates (see structured-claims.ts for why).
  const advisories = await neighbourAdvisories(spaceId, 'chrono', vector, opts, { properties: fields.properties, status });

  // The idempotent branch: a supplied id that names an entry converges rather than duplicating.
  if (existing) {
    // Stamped when the converged record conforms, unstamped when it does not (a stamp means "conforms as stored").
    const stamp = stampOp(write, check);
    // `folded.data` is the merged tags and every stated optional field (properties merged), with the removals applied.
    const $set: Record<string, unknown> = {
      title: fields.title, type: fields.type, startsAt: fields.startsAt, status,
      ...folded.data, updatedAt: now, ...derived.set, ...stampSetOf(stamp),
    };
    const $unset: Record<string, unknown> = { ...folded.unset, ...derived.unset, ...stampUnsetOf(stamp) };
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'chrono', existing: existing as unknown as Record<string, unknown> });
    const result = convergeResult(existing, $set, $unset);
    view.noteWritten('chrono', result as unknown as { _id: string }, false);
    return {
      plan: {
        kind: 'chrono', spaceId, id: existing._id, op: 'converge', set: $set, unset: $unset,
        expectSeq: existing.seq ?? null, result,
        // `Q-192`: the content just changed, so the stored vector is stale — the queue is what makes it catch up.
        enqueue: !vector && !suppressed,
        // Both classes, from the converged entry: this branch merges, so what it now says is the reconcile's input.
        links: { fromKind: 'chrono', desired, author: existing.author ?? authorRef() },
        minted: false, dupeRules: false,
      },
      ...advisories,
    };
  }

  // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always (a trusted minted id is the instance's own).
  const doc: ChronoEntry = {
    _id: insertIdentity(trusted), spaceId, title: fields.title, type: fields.type, startsAt: fields.startsAt, status, tags,
    author: authorRef(), createdAt: now, updatedAt: now, seq: 0, ...derived.set,
  };
  if (fields.description !== undefined) doc.description = fields.description;
  if (fields.endsAt !== undefined) doc.endsAt = fields.endsAt;
  if (fields.confidence !== undefined) doc.confidence = fields.confidence;
  if (fields.properties !== undefined) doc.properties = fields.properties;
  if (fields.recurrence !== undefined) doc.recurrence = fields.recurrence;
  // The collection+type is passed so the SCHEMA tier applies (record > schema > space).
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'chrono', type: doc.type });
  const insert = finishInsert({ view, kind: 'chrono', doc, opts, write, check });
  return {
    plan: {
      kind: 'chrono', spaceId, id: doc._id, op: 'insert', doc: insert, result: insert,
      enqueue: !vector && !suppressed,
      // A chrono entry holds TWO classes, told apart by the to-kind — which is why one reconcile takes both.
      links: { fromKind: 'chrono', desired, author: doc.author! },
      minted: true, dupeRules: false,
    },
    ...advisories,
  };
}
