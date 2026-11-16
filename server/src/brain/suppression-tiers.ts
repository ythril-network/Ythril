/**
 * The three embedding-suppression tiers, classified into Mongo filters once: the suppressed records and their complement.
 *
 * ## What it prevents (Q-184)
 *
 * Two sweeps ask "which records are suppressed" in opposite directions. The queue sweep (`queue-embed-sweep.ts`) wants the
 * records it MAY embed; the suppression sweep (`suppression-sweep.ts`) wants the suppressed records that still hold a vector, to
 * strip. Each used to loop over `meta.typeSchemas` with a rule of its own, and they agreed by a hand check only: a rule
 * changed in one would not reach the other, and a record would be embedded and stripped in a loop (excluded from neither), or
 * neither. Here ONE classification of the meta yields both filters, so they cannot disagree, and
 * `the-suppression-tiers-partition-every-record-db` proves in a real MongoDB that every record matches exactly one of them.
 *
 * ## The tier rule, once
 *
 * `record > schema > space`, "not stated" falling through.
 *
 *  - **record**: `suppressEmbeddings: true` suppresses. `false` is NOT stated at this tier (`$ne: true`, never
 *    `{ $exists: false }`): a record that opts in is simply not suppressed by the record tier, and the lower tiers still speak.
 *  - **schema**: a type whose schema states `true` suppresses its records; one that states `false` RELEASES them from the space
 *    tier; one that states nothing falls through. The names are enumerable from `meta.typeSchemas`, so they become `$in` / `$nin`
 *    on the type field. Edges key on `label` and everything else on `type` (`TYPE_FIELD`): reading `type` for an edge finds no
 *    schema and silently suppresses nothing. A file has no type, so no schema tier.
 *  - **space**: suppresses every record no lower tier speaks for, so a record whose type is not stated, and a record with no type.
 *
 * `notSuppressed` is `null` when nothing is left over (the space suppresses and no type is released, or a file under a
 * suppressing space): the sweep then says "no work" instead of a backlog it can never clear.
 *
 * Takes the meta, never a space id: **pure**, so a test builds the tiers by hand. It does not ask whether a record holds a
 * vector; that is `holds-vector.ts`'s question, asked by the caller that strips.
 */

import { TYPE_FIELD } from './ttl.js';
import { recordNotSuppressedFilter, RECORD_SUPPRESS_FIELD } from './suppress-embeddings.js';
import type { KnowledgeType, BrainEmbedRecordType } from '../config/types.js';

/** Just the fields the classification reads, so a test can build the tiers by hand. */
export interface SuppressMeta {
  suppressEmbeddings?: boolean | undefined;
  typeSchemas?: Partial<Record<KnowledgeType, Record<string, { suppressEmbeddings?: boolean } | undefined>>> | undefined;
}

export interface SuppressionTiers {
  /** The records that resolve to suppressed. */
  suppressed: Record<string, unknown>;
  /** The records that do not, or `null` when there are none. Exactly the complement of {@link suppressed}. */
  notSuppressed: Record<string, unknown> | null;
}

export function suppressionTiers(meta: SuppressMeta | undefined, kind: BrainEmbedRecordType): SuppressionTiers {
  const knowledgeType: KnowledgeType | undefined = kind === 'file' ? undefined : kind;
  const field = knowledgeType === undefined ? undefined : TYPE_FIELD[knowledgeType];
  const spaceWide = meta?.suppressEmbeddings === true;

  // The one classification: every named type is stated `true`, stated `false`, or not stated (and then in neither list).
  const statedTrue: string[] = [];
  const statedFalse: string[] = [];
  for (const [name, schema] of Object.entries(knowledgeType === undefined ? {} : meta?.typeSchemas?.[knowledgeType] ?? {})) {
    const v = (schema as { suppressEmbeddings?: boolean } | undefined)?.suppressEmbeddings;
    if (v === true) statedTrue.push(name);
    else if (v === false) statedFalse.push(name);
  }
  const stated = [...statedTrue, ...statedFalse];

  const suppressedOr: Record<string, unknown>[] = [{ [RECORD_SUPPRESS_FIELD]: true }];
  if (field) suppressedOr.push({ [field]: { $in: statedTrue }, ...recordNotSuppressedFilter() });
  if (spaceWide) suppressedOr.push({ ...(field ? { [field]: { $nin: stated } } : {}), ...recordNotSuppressedFilter() });
  const suppressedFilter = { $or: suppressedOr };

  if (spaceWide) {
    // Only a type that states `false` escapes the space tier, and a record that opts out of it still does not.
    if (statedFalse.length === 0 || !field) return { suppressed: suppressedFilter, notSuppressed: null };
    return { suppressed: suppressedFilter, notSuppressed: { [field]: { $in: statedFalse }, ...recordNotSuppressedFilter() } };
  }
  const notSuppressed: Record<string, unknown> = { ...recordNotSuppressedFilter() };
  if (field && statedTrue.length > 0) notSuppressed[field] = { $nin: statedTrue };
  return { suppressed: suppressedFilter, notSuppressed };
}
