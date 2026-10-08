import { TYPE_FIELD } from './ttl.js';
import type { KnowledgeType, BrainEmbedRecordType } from '../config/types.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { RECORD_SUPPRESS_FIELD, parseRecordFlag } from './record-flag.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';

/**
 * Should this record be embedded at all?
 *
 * ## Why the tiers, and why THIS order
 *
 * Asked by an operator for records that are **state rather than prose**: a queue row whose name and
 * description never change, whose weight is PATCHed every tick, and which nobody will ever search for by
 * meaning. Each of those writes re-embedded text byte-identical to the last, ~4,800 times a day, producing a
 * vector that already existed.
 *
 * `record > schema > space`, matching `retention` exactly (owner decision). Two tiered settings that resolve
 * differently is the kind of thing nobody discovers until it is wrong, and there is no reason for this one to
 * be novel.
 *
 * ## Suppresses the WRITE, not the read
 *
 * The operator was explicit: excluding from search while still computing the vector saves nothing, because
 * the cost is the embedding call. So this is consulted where a vector is WRITTEN.
 *
 * ## The edge trap
 *
 * A schema is looked up by the record's type field, and **edges key on `label` while everything else keys on
 * `type`**. `EdgeDoc` carries both, so reading `type` for an edge finds a schema that is never there and
 * looks like it worked — the suppression would silently never apply to the one record kind the owner
 * specifically widened this to cover. `TYPE_FIELD` already encodes that and is reused rather than re-derived.
 */
export interface SuppressInputs {
  /** The per-record flag, if the record carries one. `undefined` means "not stated". */
  record?: boolean | undefined;
  /** The type schema for this record's type, if any. */
  schema?: { suppressEmbeddings?: boolean } | undefined;
  /** The space-wide setting from the Danger Zone. */
  space?: boolean | undefined;
}

/** `record > schema > space`, with "not stated" falling through rather than counting as `false`. */
export function embeddingSuppressed(i: SuppressInputs): boolean {
  if (i.record !== undefined) return i.record;
  if (i.schema?.suppressEmbeddings !== undefined) return i.schema.suppressEmbeddings;
  return i.space === true;
}

/**
 * ## One name for the record tier, and only one
 *
 * The per-record tier was called `excludeFromVectorSearch` until 3.1.0 while the two tiers below it were
 * already called `suppressEmbeddings`. Owner-raised 2026-08-15: the old name reads as *removed from
 * search*, which would include traversal, and it does not — the flag is implemented as the ABSENCE of a
 * vector, so `query`, `list`, `get`, the `traverse` tool and recall's own `traverse` expansion all still
 * reach the record. `suppressEmbeddings` names what actually happens, at every tier.
 *
 * ## The old spelling is GONE as of 4.0 (`D-6`), both halves at once
 *
 * It survived as an input alias AND as a stored key written beside this one, because these are per-space
 * collections that replicate by whole-document `replaceOne`, last-writer-wins by seq — not a field merge.
 * A peer on a pre-3.1.0 build rewriting a normalised record would drop a field it does not know, and the
 * record it re-embeds is one its owner asked to keep unembedded: a suppressed record becoming rankable
 * again, plus the model call that was the point of suppressing it.
 *
 * **What made it safe to drop is the peer floor (`N-1`), not time passing.** The floor is this instance's
 * own MAJOR, so a 4.x build refuses every 3.x peer and no peer that could strip the mark is on the
 * network. `release-gate.mjs` refuses a tag below 4.0 while this key is absent, which is where that
 * assumption is actually tested.
 *
 * **Both halves went together, deliberately.** Leaving the stored key and dropping the input means a
 * record already carrying it keeps working while nobody can set it — two spellings, one readable.
 * Dropping the stored key and keeping the input means a caller is told 201 for a field that is written
 * and never read. Either alone is worse than both staying.
 *
 * No stored-value migration is needed: every write since 3.1.0 has set this key, and a record that
 * carries only the legacy one predates 3.1.0 — which the floor now excludes from the network anyway.
 */
export { RECORD_SUPPRESS_FIELD } from './record-flag.js';

/**
 * The record tier's value for a stored document.
 *
 * Returns `true` or `undefined` and never `false`, which is not a rounding of the stored value but the tier
 * rule: **`false` means "not stated"** and must fall THROUGH to the schema and space tiers rather than
 * overriding them. Returning `false` here would make the space-wide switch do nothing for any record that
 * had ever been explicitly un-suppressed.
 *
 */
export function recordSuppression(doc: Record<string, unknown> | undefined): true | undefined {
  const v = doc?.[RECORD_SUPPRESS_FIELD];
  return v === true ? true : undefined;
}

/**
 * Would the record a write LEAVES be suppressed? The record tier from the write when it states one, and from
 * the STORED record when it does not (`Q-194`).
 *
 * Asked with the payload alone, a write that did not restate the flag read as "not suppressed" and an inline
 * embed stored a vector on a record its author had retired from meaning-ranked search — `upsertEntity`,
 * `saveFact`, `createChrono`, `upsertEdge` and the merge each did. The stored flag is the forgettable half, so
 * it is this function's to read, not each writer's.
 *
 * @param typed the fields the type tier keys on as the record will have them (`type`, or `label` for an edge).
 */
export function suppressedAfterWrite(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  stored: Record<string, unknown> | null | undefined,
  typed: Record<string, unknown>,
  stated: boolean | undefined,
): boolean {
  return embeddingSuppressedFor(spaceId, recordType, {
    ...typed,
    [RECORD_SUPPRESS_FIELD]: stated !== undefined ? stated : stored?.[RECORD_SUPPRESS_FIELD],
  });
}

/** Mongo fragment matching the records the record tier does NOT suppress. */
export function recordNotSuppressedFilter(): Record<string, unknown> {
  return { [RECORD_SUPPRESS_FIELD]: { $ne: true } };
}

/**
 * Read the record tier out of a request body or a set of MCP tool args.
 *
 * One parser for both doors, because this is exactly the shape that goes wrong here: the same rule written
 * twice, one copy validating and the other checking only `typeof === 'boolean'` and silently dropping
 * anything else. `undefined` means the caller said nothing; the refusal text is shared so a `400` and a tool
 * error read identically.
 *
 * The pre-3.1.0 spelling is no longer accepted (`D-6`). It was an input alias for as long as the stored key
 * existed — refusing a name the database depended on would have been the worse half — and both left at
 * once, which is why a caller sending it now gets a refusal rather than a silent drop.
 */
export function parseRecordSuppression(
  body: unknown,
): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  return parseRecordFlag(body, RECORD_SUPPRESS_FIELD);
}

/**
 * The type name to look a schema up by, for a given record.
 *
 * Exported because the caller has the document and this file has the rule. Returning `undefined` rather than
 * guessing keeps an untyped record out of the schema tier instead of matching some other type's schema.
 */
export function schemaKeyFor(
  kind: KnowledgeType,
  doc: Record<string, unknown> | undefined,
): string | undefined {
  const field = TYPE_FIELD[kind];
  const v = doc?.[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Would a record of this shape be embedded, or suppressed? The three-tier resolution, callable BEFORE a write.
 *
 * ## Why this had to be extractable
 *
 * The comment below used to say *"this is the single place the flag has any effect. Every writer of a vector
 * reaches this function"* — and that was not true. The four creators (`fact.ts`, `entities.ts`, `chrono.ts`,
 * `edges.ts`) compute the vector INLINE when the caller asks for `waitForEmbedding`, `checkDuplicates` or
 * `checkContradictions`, and then skip the enqueue precisely because they already have one. The enqueue was
 * the only path that consulted suppression, so the inline path stored a vector the flag forbids and nothing
 * ever came back to remove it.
 *
 * **The default MCP write hit this**: `checkDuplicates` defaults to `true` on those tools, so an ordinary
 * `saveFact` into a suppressed space stored a vector, every time, and the operator's setting did nothing they
 * could see. `suppressEmbeddings` is implemented AS the absence of a vector — there is no query-time filter —
 * so a stored vector is not a cosmetic inconsistency, it is the feature not working.
 *
 * One function, both callers: the queue asks it about a stored document and a creator asks it about the
 * document it is about to store. A second copy of a three-tier resolution is exactly the drift this codebase
 * names as its most frequent defect, and this one already had a comment claiming the copy did not exist.
 *
 * `doc` need only carry what the decision reads — the record's own `suppressEmbeddings` and its type field
 * (`label` for an edge, `type` for the rest, which `schemaKeyFor` already encodes). A creator can pass the two
 * fields it has before the document is assembled.
 */
export function embeddingSuppressedFor(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  doc: Record<string, unknown>,
  /**
   * The space's meta, when the caller resolved it once for a whole batch (`enqueueIngestedRecords`). Omitted,
   * it is resolved here — the same lookup, so a caller cannot pass a different space's tiers by forgetting.
   */
  meta: ReturnType<typeof getSpaceMeta> = getSpaceMeta(spaceId),
): boolean {
  // A FILE has no type and therefore no type schema — the same asymmetry `TtlBucket` exists to name. So a file
  // skips the middle tier entirely and is governed by the record flag or the space setting. Narrowing here
  // rather than casting, because a cast would silently index `typeSchemas` with `'file'` and always miss.
  const knowledgeType: KnowledgeType | undefined = recordType === 'file' ? undefined : recordType;
  const schemaKey = knowledgeType === undefined ? undefined : schemaKeyFor(knowledgeType, doc);
  return embeddingSuppressed({
    record: recordSuppression(doc),
    schema: knowledgeType === undefined || schemaKey === undefined
      ? undefined
      : meta?.typeSchemas?.[knowledgeType]?.[schemaKey],
    space: meta?.suppressEmbeddings === true,
  });
}

/** How far up `parentFileId` a derived record looks for its owner. A caption chunk of an image extracted from a
 *  document is two levels down; nothing is deeper. */
export const MAX_ANCESTRY = 3;

/**
 * Whether a derived record's ANCESTORS say its embeddings are suppressed — the half of {@link fileEmbeddingSuppressed}
 * that reads other rows.
 *
 * A chunk carries no flag of its own: its owner set one on the file. Read only one level up, the caption chunk of an
 * image extracted from a suppressed document would still embed, because the extracted image is the parent and the
 * document is the grandparent. A missing ancestor counts as suppressed — fail closed, because the alternative sends
 * the passage to an embedder that may be external, against a choice nobody can see any more.
 */
async function ancestorSuppressed(spaceId: string, file: Record<string, unknown>): Promise<boolean> {
  let parentId = file['parentFileId'];
  for (let depth = 0; depth < MAX_ANCESTRY && typeof parentId === 'string'; depth++) {
    const parent = await col(spaceCollection(spaceId, 'files')).findOne(
      asFilter({ _id: parentId }),
      { projection: { parentFileId: 1, [RECORD_SUPPRESS_FIELD]: 1 } },
    ) as Record<string, unknown> | null;
    if (!parent) return true;
    if (recordSuppression(parent) === true) return true;
    parentId = parent['parentFileId'];
  }
  return false;
}

/**
 * Would this FILE row hold a vector? The one answer for every writer of a vector onto a file row: the embed queue
 * (`embedStoredRecord`) and the producers that turn a file into passages (`storeConversionResults`, the image, audio
 * and video embedders), through {@link storedFileEmbeddingSuppressed}.
 *
 * ## What this prevents
 *
 * `suppressEmbeddings` is implemented AS the absence of a vector. The queue honoured it, and the four producers
 * above did not (Q-255): a file the operator had retired from meaning-ranked search kept a vector on every passage its
 * conversion or media job produced — found by exactly the mechanism the flag exists to switch off, and sent to an
 * embedder that may be external. The ancestor walk lived privately in the queue, so a producer that wanted it would
 * have written a second copy; it is here, once.
 *
 * A file has TWO tiers (record, space) — no type, so no type schema — which `embeddingSuppressedFor` already
 * resolves for `'file'`. On top of that a DERIVED row (a chunk, a converted or extracted copy, a caption chunk) is
 * suppressed when any ancestor is, up to {@link MAX_ANCESTRY}, or when an ancestor is missing.
 *
 * @param file the file row, or the fields a decision reads: its own `suppressEmbeddings` and its `parentFileId`.
 */
export async function fileEmbeddingSuppressed(spaceId: string, file: Record<string, unknown>): Promise<boolean> {
  if (embeddingSuppressedFor(spaceId, 'file', file)) return true;
  return typeof file['parentFileId'] === 'string' && await ancestorSuppressed(spaceId, file);
}

/**
 * {@link fileEmbeddingSuppressed} for the file a JOB was claimed for, which is all a producer is given: its id.
 *
 * The row is read HERE, so a producer cannot decide from a copy it kept across the job. **A row that is not there
 * counts as suppressed** — the same fail-closed rule as a missing ancestor — and is not an embed failure: the job
 * did nothing wrong and a retry could not change it. A producer asks ONCE at its entry (one job, one answer), never
 * per chunk or per segment.
 */
export async function storedFileEmbeddingSuppressed(spaceId: string, fileId: string): Promise<boolean> {
  const row = await col(spaceCollection(spaceId, 'files')).findOne(
    asFilter({ _id: fileId }),
    { projection: { parentFileId: 1, [RECORD_SUPPRESS_FIELD]: 1 } },
  ) as Record<string, unknown> | null;
  return row === null || await fileEmbeddingSuppressed(spaceId, row);
}
