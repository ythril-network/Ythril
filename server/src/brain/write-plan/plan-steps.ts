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
import type { SpaceMeta } from '../../config/types.js';
import type { DupeCheckOpts } from '../write-options.js';
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
  text: () => string | Promise<string>;
}): Promise<{ suppressed: boolean; vector: InlineVector | null }> {
  const suppressed = suppressedAfterWrite(args.spaceId, args.kind,
    args.existing as Record<string, unknown> | null, args.schemaKey, args.stated);
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
  meta: SpaceMeta | undefined;
}): Record<string, unknown> {
  const { doc } = args;
  // Stored, not merely consulted: everything that revisits a record later reads the tiers off the document.
  applyRecordFlags(doc, args.opts);
  // Warn-not-refuse: a caller's own stamp checked against ours; stored only when it disagrees.
  stampSkewOnCreate(doc as never, args.meta);
  const { seq: _seq, ...insert } = doc;
  args.view.noteWritten(args.kind, doc, true);
  return insert;
}
