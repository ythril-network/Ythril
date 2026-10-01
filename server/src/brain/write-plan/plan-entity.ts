/**
 * An entity write, DECIDED — every rule `upsertEntity` applies, against a read set, with nothing written.
 *
 * Identity: a supplied `id` addresses an existing entity and converges onto it; it never becomes a new
 * entity's id (ID IS ID). Without one, a new entity is minted every time — a name is a non-unique label, which
 * is why the insert warns when the name and type are already taken.
 */
import { v4 as uuidv4 } from 'uuid';
import { authorRef } from '../../config/author.js';
import { type ContradictionWarning } from '../insert-contradictions.js';
import { entityEmbedText } from '../embed-text.js';
import { stampExpiryOnCreate, applyExpiryToUpdate } from '../ttl.js';
import { getSpaceMeta, applyPropertyDefaults } from '../../spaces/schema-validation.js';
import { classifyEntityUpsertAgainst, SchemaViolationError, type UpdateValidation } from '../write-validation.js';
import { mergeTagsAndProperties } from '../merge-fields.js';
import { type SimilarMatch } from '../recall.js';
import type { DupeCheckOpts } from '../write-options.js';
import type { EntityDoc } from '../../config/types.js';
import type { ReadSet, ReadWant } from './read-set.js';
import type { WritePlan } from './types.js';
import { convergeResult, finishInsert, neighbourAdvisories, vectorBeforeWrite } from './plan-steps.js';

export interface EntityInput {
  name: string;
  type: string;
  tags?: string[];
  properties?: Record<string, string | number | boolean>;
  description?: string;
  id?: string;
  opts?: DupeCheckOpts;
  ttlDays?: number | null;
  /** Hands the classification back, so a door never runs the classifier a second time for presentation. */
  onValidation?: (check: UpdateValidation) => void;
}

export interface EntityPlanned {
  plan: WritePlan;
  warning?: string;
  similar?: SimilarMatch[];
  contradicts?: ContradictionWarning[];
}

/** What `planEntity` will ask the read set. */
export function entityWant(input: EntityInput): ReadWant {
  return input.id
    ? { records: { entity: [input.id] } }
    : { nameTypes: [{ name: input.name, type: input.type }] };
}

export async function planEntity(spaceId: string, input: EntityInput, view: ReadSet): Promise<EntityPlanned> {
  const { name, type, description, opts, ttlDays } = input;
  const tags = input.tags ?? [];
  const existing = input.id ? view.stored('entity', input.id) as unknown as EntityDoc | null : null;

  /*
   * THE SCHEMA IS ENFORCED HERE, against the merged record. Declared defaults fill in what the caller omitted
   * BEFORE validation and only on an INSERT — on an update an absent property may be one just removed.
   */
  const meta = getSpaceMeta(spaceId);
  const properties = (existing ? input.properties : applyPropertyDefaults(meta?.typeSchemas?.entity?.[type], input.properties))
    ?? input.properties ?? {};
  const check = classifyEntityUpsertAgainst(meta, existing, { name, type, properties, tags });
  if (check.blocked) throw new SchemaViolationError(check);
  input.onValidation?.(check);

  const now = new Date().toISOString();
  // `matchedText` is stored either way: it is exactly what the queued job will embed.
  const merged = mergeTagsAndProperties(existing, { tags, properties });
  const embedText = entityEmbedText(name, type, merged.tags, description ?? existing?.description, merged.properties);

  /*
   * The duplicate/contradiction checks compare THIS record's vector against its neighbours, so they imply the
   * wait. Suppression wins over all three — on the record the write LEAVES, the stored flag unless this write
   * states one (`Q-194`): asked with the payload alone, a rewrite that did not restate the flag got a vector.
   */
  const { suppressed, vector } = await vectorBeforeWrite({
    spaceId, kind: 'entity', existing, schemaKey: { type }, stated: opts?.suppressEmbeddings,
    wanted: opts?.waitForEmbedding === true || opts?.checkDuplicates === true || opts?.checkContradictions === true,
    text: () => embedText,
  });
  const embeddingFields = { matchedText: embedText, ...vector };

  if (existing) {
    const $set: Record<string, unknown> = { name, type, tags: merged.tags, properties: merged.properties, updatedAt: now, ...embeddingFields };
    if (description !== undefined) $set['description'] = description;
    const $unset: Record<string, unknown> = {};
    applyExpiryToUpdate(spaceId, ttlDays, existing._expireAt != null, $set, $unset,
      { collection: 'entity', existing: existing as unknown as Record<string, unknown> }); // F10
    const result = convergeResult(existing, $set, $unset);
    view.noteWritten('entity', result as unknown as { _id: string }, false);
    return {
      plan: {
        kind: 'entity', spaceId, id: existing._id, op: 'converge', set: $set, unset: $unset,
        expectSeq: existing.seq ?? null, result,
        enqueue: !vector && !suppressed,
        minted: false, dupeRules: false,
      },
    };
  }

  // Warn when inserting without an explicit id and entities with this name and type already exist.
  let warning: string | undefined;
  if (!input.id) {
    const existingCount = view.entitiesNamed(name, type);
    if (existingCount > 0) {
      warning = `${existingCount} existing entit${existingCount === 1 ? 'y' : 'ies'} with name '${name}' and type '${type}' already exist in this space. A new entity was created because no id was supplied. To update an existing entity, provide its id.`;
    }
  }

  const advisories = await neighbourAdvisories(spaceId, 'entity', vector, opts, { properties });

  // ID IS ID (owner ruling, 2026-08-12): the identity is ours to mint, always.
  const doc: EntityDoc = {
    _id: uuidv4(), spaceId, name, type, tags, properties, author: authorRef(),
    createdAt: now, updatedAt: now, seq: 0, ...embeddingFields,
  };
  if (description !== undefined) doc.description = description;
  // `typed` is what makes the SCHEMA tier reachable for retention.
  stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'entity', type: doc.type });
  const insert = finishInsert({ view, kind: 'entity', doc, opts, meta });
  return {
    plan: {
      kind: 'entity', spaceId, id: doc._id, op: 'insert', doc: insert, result: insert,
      enqueue: !vector && !suppressed,
      minted: true,
      /*
       * Behind the embedding, not beside it: the rule evaluates the STORED record against its neighbours, and
       * a record with no vector yet has none to compare. Only when embedded INLINE — otherwise the embed worker
       * runs it once the vector exists, so this is what stops it running twice. Whether the space has
       * `dupeRulesOnInsert` on is the rule runner's own check, so it is not repeated here.
       */
      dupeRules: vector !== null,
    },
    ...(warning ? { warning } : {}),
    ...advisories,
  };
}
