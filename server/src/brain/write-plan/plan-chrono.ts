/**
 * A chrono write, DECIDED — every rule `createChrono` applies, against a read set, with nothing written.
 *
 * One difference from the code it was moved out of, and it is the fix: a converge onto an existing entry
 * QUEUES its re-embed (`Q-192`). The insert branch always did and the converge branch never did, so an entry
 * rewritten with new content kept the vector of the content it no longer had.
 */
import { v4 as uuidv4 } from 'uuid';
import { authorRef } from '../../config/author.js';
import { findInsertContradictions, type ContradictionWarning } from '../insert-contradictions.js';
import { embed } from '../embedding.js';
import { chronoEmbedText } from '../embed-text.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { stampSkewOnCreate } from '../stamp-skew.js';
import { getSpaceMeta, applyPropertyDefaults } from '../../spaces/schema-validation.js';
import { classifyChronoUpsertAgainst, SchemaViolationError, type UpdateValidation } from '../write-validation.js';
import { mergeTags, mergeProperties } from '../merge-fields.js';
import { suppressedAfterWrite } from '../suppress-embeddings.js';
import { applyRecordFlags } from '../record-flag.js';
import { checkDuplicates, type SimilarMatch } from '../recall.js';
import type { DupeCheckOpts } from '../write-options.js';
import type { ChronoEntry, ChronoType, ChronoStatus } from '../../config/types.js';
import { linkTargets, refuseLinks } from './plan-links.js';
import type { ReadSet, ReadWant } from './read-set.js';
import type { WritePlan } from './types.js';

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
}

export interface ChronoPlanned {
  plan: WritePlan;
  similar?: SimilarMatch[];
  contradicts?: ContradictionWarning[];
}

const desiredOf = (f: ChronoFields) => ({ entity: f.linkEntities ?? [], fact: f.linkFacts ?? [] });

/** What `planChrono` will ask the read set. */
export function chronoWant(input: ChronoInput): ReadWant {
  return { records: { ...linkTargets(desiredOf(input.fields)), ...(input.fields.id ? { chrono: [input.fields.id] } : {}) } };
}

export async function planChrono(spaceId: string, input: ChronoInput, view: ReadSet): Promise<ChronoPlanned> {
  const { ttlDays, opts } = input;
  let fields = input.fields;
  const desired = desiredOf(fields);
  // THE LINKS ARE REFUSED BEFORE THE ENTRY IS WRITTEN — see `planFact`.
  refuseLinks(view, 'chrono', desired);

  const existing = fields.id ? view.stored('chrono', fields.id) as unknown as ChronoEntry | null : null;

  // THE SCHEMA IS ENFORCED HERE, against the merged record; defaults on insert only.
  const meta = getSpaceMeta(spaceId);
  const withDefaults = existing
    ? fields.properties
    : applyPropertyDefaults(meta?.typeSchemas?.chrono?.[fields.type], fields.properties);
  const check = classifyChronoUpsertAgainst(meta, existing, { type: fields.type, properties: withDefaults });
  if (check.blocked) throw new SchemaViolationError(check);
  opts?.onValidation?.(check);
  fields = { ...fields, properties: withDefaults };

  const now = new Date().toISOString();
  const status = fields.status ?? 'upcoming';
  const tags = fields.tags ?? [];

  // `matchedText` is stored either way: a suppressed record stays findable lexically.
  const embedText = chronoEmbedText(fields.title, fields.type, status, fields.description, tags, fields.properties);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText: string } = { matchedText: embedText };
  // Suppression wins over `waitForEmbedding`, on the record the write LEAVES (`Q-194`).
  const suppressed = suppressedAfterWrite(spaceId, 'chrono', existing as unknown as Record<string, unknown> | null,
    { type: fields.type }, opts?.suppressEmbeddings);
  if (opts?.waitForEmbedding === true && !suppressed) {
    const embResult = await embed(embedText);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model, matchedText: embedText };
  }

  // ONE neighbour search serves both flags, before the insert so it cannot self-match. The structured judge
  // compares the stored `status`, not the dates (see structured-claims.ts for why).
  let similar: SimilarMatch[] | undefined;
  let contradicts: ContradictionWarning[] | undefined;
  if ((opts?.checkDuplicates || opts?.checkContradictions) && embeddingFields.embedding) {
    const hits = await checkDuplicates(spaceId, 'chrono', embeddingFields.embedding, opts.dupeThreshold, opts.dupeTopK);
    if (opts.checkDuplicates && hits.length > 0) similar = hits;
    if (opts.checkContradictions && hits.length > 0) {
      const found = await findInsertContradictions(spaceId, 'chrono', { properties: fields.properties, status }, hits);
      if (found.length > 0) contradicts = found;
    }
  }
  const advisories = { ...(similar ? { similar } : {}), ...(contradicts ? { contradicts } : {}) };

  // The idempotent branch: a supplied id that names an entry converges rather than duplicating.
  if (existing) {
    const $set: Record<string, unknown> = {
      title: fields.title, type: fields.type, startsAt: fields.startsAt, status,
      tags: mergeTags(existing.tags, tags), updatedAt: now, ...embeddingFields,
    };
    if (fields.endsAt !== undefined) $set['endsAt'] = fields.endsAt;
    if (fields.description !== undefined) $set['description'] = fields.description;
    if (fields.confidence !== undefined) $set['confidence'] = fields.confidence;
    if (fields.properties !== undefined) $set['properties'] = mergeProperties(existing.properties, fields.properties);
    if (fields.recurrence !== undefined) $set['recurrence'] = fields.recurrence;
    const $unset: Record<string, unknown> = {};
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'chrono', existing: existing as unknown as Record<string, unknown> });
    const result: Record<string, unknown> = { ...existing, ...$set };
    if ('_expireAt' in $unset) delete result['_expireAt'];
    view.noteWritten('chrono', result as unknown as { _id: string }, false);
    return {
      plan: {
        kind: 'chrono', spaceId, id: existing._id, op: 'converge', set: $set, unset: $unset,
        expectSeq: existing.seq ?? null, result,
        // `Q-192`: the content just changed, so the stored vector is stale — the queue is what makes it catch up.
        enqueue: !embeddingFields.embedding && !suppressed,
        // Both classes, from the converged entry: this branch merges, so what it now says is the reconcile's input.
        links: { fromKind: 'chrono', desired, author: existing.author ?? authorRef() },
        minted: false, dupeRules: false,
      },
      ...advisories,
    };
  }

  // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always.
  const doc: ChronoEntry = {
    _id: uuidv4(), spaceId, title: fields.title, type: fields.type, startsAt: fields.startsAt, status, tags,
    author: authorRef(), createdAt: now, updatedAt: now, seq: 0, ...embeddingFields,
  };
  applyRecordFlags(doc, opts);
  if (fields.description !== undefined) doc.description = fields.description;
  if (fields.endsAt !== undefined) doc.endsAt = fields.endsAt;
  if (fields.confidence !== undefined) doc.confidence = fields.confidence;
  if (fields.properties !== undefined) doc.properties = fields.properties;
  if (fields.recurrence !== undefined) doc.recurrence = fields.recurrence;
  // The collection+type is passed so the SCHEMA tier applies (record > schema > space).
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'chrono', type: doc.type });
  stampSkewOnCreate(doc, meta);
  const { seq: _seq, ...insert } = doc;
  view.noteWritten('chrono', doc, true);
  return {
    plan: {
      kind: 'chrono', spaceId, id: doc._id, op: 'insert', doc: insert, result: insert,
      enqueue: !embeddingFields.embedding && !suppressed,
      // A chrono entry holds TWO classes, told apart by the to-kind — which is why one reconcile takes both.
      links: { fromKind: 'chrono', desired, author: doc.author! },
      minted: true, dupeRules: false,
    },
    ...advisories,
  };
}
