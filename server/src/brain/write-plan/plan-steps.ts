/**
 * The steps every kind's planner takes the same way, written once.
 *
 * ## Why it exists
 *
 * Turning four writers into four planners moved every per-kind rule into one place per kind — and left the
 * steps that are NOT per-kind written four times. One of them had already split before anyone noticed: the
 * edge planner built a converge's result by removing every key the update unsets, the other three removed
 * only `_expireAt`, and they agreed only because nothing else is unset today. A planner that reads its own
 * result back from a narrow copy reports a record the store does not hold.
 *
 * So the kind-independent steps live here, and what each holds is the line a hand-written copy would drop:
 *
 * - `convergeResult` removes EVERY unset key, not the one that happens to be unset now.
 * - `vectorBeforeWrite` puts suppression first, so no caller can compute a vector the flag forbids.
 * - `neighbourAdvisories` runs the one neighbour search both checks share, and only over a vector computed
 *   before the write — a vector computed after it would find the record itself.
 * - `finishInsert` stamps flags and skew and strips the seq the commit allocates; a forgotten strip would
 *   write a placeholder `seq: 0` over the real one.
 */
import { embed } from '../embedding.js';
import { checkDuplicates, type SimilarMatch } from '../recall.js';
import { findInsertContradictions, type ContradictionWarning } from '../insert-contradictions.js';
import { suppressedAfterWrite } from '../suppress-embeddings.js';
import { applyRecordFlags, type RecordFlags } from '../record-flag.js';
import { stampSkewOnCreate } from '../stamp-skew.js';
import { stampOp, stampSetOf, type MetaForWrite, type SchemaCheckOutcome } from '../../spaces/schema-stamp.js';
import type { DupeCheckOpts } from '../write-options.js';
import type { SpaceMeta } from '../../config/types.js';
import { RequestRefusal } from '../../util/errors.js';
import { DELETABLE_FIELDS, reflectDeleteFields, refuseUndeletableFields } from '../delete-fields.js';
import type { ReadSet } from './read-set.js';
import type { PlanKind } from './types.js';

/** What a converge leaves stored: the record as read, the write's `$set` over it, every `$unset` key gone. */
export function convergeResult(
  existing: object,
  set: Record<string, unknown>,
  unset: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(existing as Record<string, unknown>), ...set };
  for (const key of Object.keys(unset)) delete result[key];
  return result;
}

/**
 * What a write may take away from a record it converges onto. A converge merges (tags union, properties shallow-merge), so by itself it can never
 * remove anything; these two inputs are how a caller that holds the target says what goes.
 *
 * - `deleteFields`: dot paths applied AFTER the merge (`applyDeleteFields`), the same as the update writers'.
 * - `replaceTags`: the target tag array, written as it is. Never a union plus a deletion: the merge unions, and a whole-field `$unset` wins.
 */
export interface Removals {
  readonly deleteFields?: readonly string[] | undefined;
  readonly replaceTags?: readonly string[] | undefined;
}

/** What {@link foldRemovals} decided: the stated fields the converge writes, the fields it unsets, and the fields the record is LEFT with. */
export interface FoldedRemovals {
  /** The converge's stated fields (`tags`, `properties`, `description`, ...) after the removals: the planner spreads them into its `$set`. */
  readonly data: Record<string, unknown>;
  /** The listed fields the removals took away whole: the planner spreads them into its `$unset`. */
  readonly unset: Record<string, unknown>;
  /** The listed fields as the record is left with them, a removed one absent: what the embed text and the classification read. */
  readonly left: Record<string, unknown>;
  /** Whether anything is removed or replaced on a stored record: the planner then judges the record it LEAVES (`recordAfterPatch`), as a PATCH is. */
  readonly removing: boolean;
}

/**
 * The record a converge leaves once its removals are applied, decided in one place for the four planners.
 *
 * ## The question it answers, and what it prevents
 *
 * "What do the stated fields become after the merge and the removals?" A planner that applied the removal before the merge would see it undone
 * (the merge unions tags and lays the stated properties over the stored ones), one that applied it to the stored record would mutate the read
 * set's copy, one that took a path nobody validated would write a system field, and one that took `deleteFields` on an INSERT would accept it and
 * do nothing. The order, the copy, the path rule and the insert refusal are all inside, so no planner can leave one out.
 *
 * `stated` is what the converge writes of the fields a removal can reach, already merged (`tags` union, `properties` shallow-merge, a stated
 * `description`). A listed field it does not state is the stored one's. Nothing is cloned or reflected when nothing is removed, so a plan
 * without removals costs what it did.
 */
export function foldRemovals(
  kind: keyof typeof DELETABLE_FIELDS,
  existing: object | null,
  stated: Record<string, unknown>,
  removal: Removals,
): FoldedRemovals {
  const paths = removal.deleteFields ?? [];
  refuseUndeletableFields(paths);
  if (existing === null) {
    if (paths.length > 0) {
      throw new RequestRefusal('`deleteFields` removes fields of a stored record, and this write creates a new one: there is nothing to remove');
    }
    return { data: removal.replaceTags ? { ...stated, tags: [...removal.replaceTags] } : stated, unset: {}, left: stated, removing: false };
  }
  const stored = existing as Record<string, unknown>;
  const fields: readonly string[] = DELETABLE_FIELDS[kind];
  if (paths.length === 0 && removal.replaceTags === undefined) {
    const left: Record<string, unknown> = {};
    for (const f of fields) {
      const v = f in stated ? stated[f] : stored[f];
      if (v !== undefined) left[f] = v;
    }
    return { data: stated, unset: {}, left, removing: false };
  }
  // Copies: `applyDeleteFields` mutates what it is given, and the stored record is the read set's, shared with every other plan of a batch.
  const data: Record<string, unknown> = structuredClone(stated);
  if (removal.replaceTags !== undefined) data['tags'] = [...removal.replaceTags];
  const left: Record<string, unknown> = {};
  for (const f of fields) {
    const v = f in data ? data[f] : structuredClone(stored[f]);
    left[f] = f === 'tags' ? (v ?? []) : f === 'properties' ? (v ?? {}) : v;
  }
  const unset: Record<string, unknown> = {};
  reflectDeleteFields(left, paths, fields, data, unset);
  for (const f of fields) if (left[f] === undefined) delete left[f];
  return { data, unset, left, removing: true };
}

/** A vector computed before the write, in the fields a record stores it under. */
export interface InlineVector {
  embedding: number[];
  embeddingModel: string;
}

/**
 * Whether the record this write leaves is suppressed, and — only when it is not and the caller needs one now —
 * its vector. `text` is a function because building it can cost a read (an edge resolves its endpoint names),
 * and that read belongs only on the inline path.
 *
 * Suppression is decided on the record the write LEAVES: the stored flag unless this write states one
 * (`Q-194`). It wins over `wanted`, because `suppressEmbeddings` IS the absence of a vector.
 */
export async function vectorBeforeWrite(args: {
  spaceId: string;
  kind: PlanKind;
  existing: object | null;
  /** The fields the type schema is keyed on: `{ type }`, or `{ label }` for an edge. */
  schemaKey: Record<string, unknown>;
  stated: boolean | undefined;
  /** The caller needs the vector before the write: it waits for it, or a check compares against it. */
  wanted: boolean;
  /** The meta of the plan schema an import proposes, when the write has one: the type tier is read from it, not from the stored meta (F7). */
  planMeta?: SpaceMeta | undefined;
  text: () => string | Promise<string>;
}): Promise<{ suppressed: boolean; vector: InlineVector | null }> {
  const suppressed = suppressedAfterWrite(args.spaceId, args.kind,
    args.existing as Record<string, unknown> | null, args.schemaKey, args.stated, args.planMeta);
  if (suppressed || !args.wanted) return { suppressed, vector: null };
  // Unguarded on purpose: the caller asked for a record that is searchable when this returns.
  const result = await embed(await args.text());
  return { suppressed, vector: { embedding: result.vector, embeddingModel: result.model } };
}

/**
 * The near-duplicate and contradiction advisories for a record about to be written. ONE neighbour search
 * serves both flags, and only over a vector computed BEFORE the write, so the record cannot match itself.
 * With no vector there is nothing to compare, and nothing is reported.
 */
export async function neighbourAdvisories(
  spaceId: string,
  kind: PlanKind,
  vector: InlineVector | null,
  opts: DupeCheckOpts | undefined,
  claims: { properties?: Record<string, unknown> } & Record<string, unknown>,
): Promise<{ similar?: SimilarMatch[]; contradicts?: ContradictionWarning[] }> {
  if (!vector || !(opts?.checkDuplicates || opts?.checkContradictions)) return {};
  const hits = await checkDuplicates(spaceId, kind, vector.embedding, opts.dupeThreshold, opts.dupeTopK);
  if (hits.length === 0) return {};
  const out: { similar?: SimilarMatch[]; contradicts?: ContradictionWarning[] } = {};
  if (opts.checkDuplicates) out.similar = hits;
  if (opts.checkContradictions) {
    const found = await findInsertContradictions(spaceId, kind, claims as never, hits);
    if (found.length > 0) out.contradicts = found;
  }
  return out;
}

/**
 * Stamp a freshly built record and record it as planned: its flags, its skew warning, then the document the
 * insert writes — without the placeholder `seq`, which the commit allocates.
 *
 * Retention is NOT stamped here. Each planner stamps its own, naming its collection and the key its schema is
 * found under (`label` for an edge), because a wrong key there is silent: the schema tier is never found and
 * the space window applies instead. `retention-reaches-every-collection` reads that call per planner.
 */
export function finishInsert<D extends { _id: string; seq: number; createdAt: string } & RecordFlags>(args: {
  view: ReadSet;
  kind: PlanKind;
  doc: D;
  opts: RecordFlags | undefined;
  /** The pair the planner validated with (`readMetaForWrite`): the insert is stamped from it, never from a meta read again here. */
  write: MetaForWrite;
  /** The planner's check of this record: the insert carries the stamp only when it found nothing. */
  check: SchemaCheckOutcome;
}): Record<string, unknown> {
  const { doc, write } = args;
  // Stored, not merely consulted: everything that revisits a record later reads the tiers off the document.
  applyRecordFlags(doc, args.opts);
  // Warn-not-refuse: a caller's own stamp checked against ours; stored only when it disagrees.
  stampSkewOnCreate(doc as never, write.meta);
  // The schema stamp (Q-736): the field when the record conforms as written, nothing when it does not (an insert has no stamp to remove).
  const stamp = stampOp(write, args.check);
  Object.assign(doc, stampSetOf(stamp));
  const { seq: _seq, ...insert } = doc;
  args.view.noteWritten(args.kind, doc, true);
  return insert;
}
