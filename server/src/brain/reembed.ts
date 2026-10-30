/**
 * Backfill missing embeddings for a space.
 *
 * ## Why this exists
 *
 * `suppressEmbeddings` shipped without a way back. Records written while suppression was on have no vector, and
 * nothing revisited them — so turning the setting off left the space permanently half-indexed, with recall blind
 * to everything written during the suppressed period and no symptom beyond worse results. The owner's call was
 * blunt: *"there should be a way to backfill"*.
 *
 * It is not only for suppression. The same gap opens whenever an enqueue fails: `enqueueEmbedJob` deliberately
 * swallows its error rather than failing the caller's write, and its comment claimed "the periodic backfill sweep
 * will find it". **There was no such sweep** — the comment described a repair mechanism that had never been
 * built, which is exactly the kind of reassurance that stops anyone looking. This is that sweep, on demand.
 *
 * ## An UPDATE whose job was lost is the same gap, and "has no vector" does not see it
 *
 * A record whose text changed while its job could not be queued keeps the vector and the lexical text of its previous content,
 * so it is not vectorless. The repair therefore also queues every record whose stored `matchedText` differs from the text its
 * builder gives today (`stale`, `queue-embed-sweep.ts`): the pair a write stores (`derived-text-on-write.ts`) is the record of what
 * is owed, so nothing else has to remember it.
 *
 * ## It ENQUEUES, and does not embed
 *
 * A space can hold a million records and the model is the slow part. Embedding inline would time out the request
 * somewhere in the middle, having done partial work with no record of where it stopped. Enqueuing is idempotent
 * per record (`enqueueEmbedJob` upserts by job id), so a repeated call over the same space converges instead of
 * duplicating.
 *
 * ## A backfill must not fight the setting
 *
 * A record that is STILL suppressed is skipped, and the same `embeddingSuppressed` resolver the write path uses
 * decides it. Re-deriving the rule here would let a backfill re-index exactly what an operator asked to keep out
 * of recall — the resolver is imported for that reason, not for convenience.
 *
 * So the operator's sequence is: turn suppression off, then backfill. Running it while still suppressed is not an
 * error and reports honestly — every candidate comes back under `skippedSuppressed`, which tells the operator the
 * setting is still on rather than leaving them to wonder why nothing happened.
 *
 * ## Suppression is excluded in the QUERY, and that is what makes the sweep terminate
 *
 * The first version filtered on "has no vector" alone and skipped suppressed documents inside the loop. It did
 * not converge, and the failure was worse than a misleading counter:
 *
 *  - a suppressed record matches "has no vector" **by construction** — suppression is what removed the vector;
 *  - `find(filter).limit(n)` has no sort, so the same first `n` documents come back on every call;
 *  - the sweep never writes to a suppressed record, so they never leave the result set.
 *
 * So a page of suppressed records at the front of a collection **blocked every embeddable record behind it,
 * permanently**, while `truncated: true` told the caller to keep calling. All three tiers are expressible as a
 * filter (see `suppressionExclusion`), so now the cursor advances: enqueued records gain a vector and drop out,
 * and suppressed records were never in.
 *
 * ## Nothing is capped silently
 *
 * `limit` bounds one call. When more candidates remain, `remaining` says how many and `truncated` is `true`. A
 * backfill that quietly stopped at a round number would read as "the space is fully indexed now", which is the
 * same class of lie as the missing sweep this replaces.
 *
 * `remaining` counts only work that CAN be done. A space whose suppression is still on reports `remaining: 0`
 * with every candidate under `skippedSuppressed` — "there is no work", which is a different statement from
 * "there is work left", and the one an operator can act on.
 */

import { EMBED_PRIORITY } from './embed-queue.js';
import { queueEmbedSweep, EMBED_SWEEP_KINDS, suppressionExclusion, type SuppressMeta } from './queue-embed-sweep.js';
import type { BrainEmbedRecordType } from '../config/types.js';

// Moved into the shared walk with the reindex; re-exported because both doors and their tests name them here.
export { suppressionExclusion };
export type { SuppressMeta };

/** Every record kind that carries a vector — the sweep's own list, so a backfill and a reindex cover the same kinds. */
export const REEMBED_KINDS = EMBED_SWEEP_KINDS;

/** Default and ceiling for one call. The ceiling exists so a single request cannot enqueue unbounded work. */
export const REEMBED_DEFAULT_LIMIT = 5_000;
export const REEMBED_MAX_LIMIT = 50_000;

export interface ReembedResult {
  spaceId: string;
  /** Records a job was queued for: those with no vector that are not suppressed, and the `stale` ones. */
  enqueued: number;
  /**
   * Candidates left alone because suppression still applies at some tier. A suppressed record owed its lexical text is not here: it is
   * queued (its job writes the text and calls no model) and counted in `stale`, or in `remaining` when past the cap.
   */
  skippedSuppressed: number;
  /**
   * Of `enqueued`, the records queued because their stored text differs from their current text: a vector made from text the record
   * no longer has (an update whose job was lost), or a suppressed record whose lexical text is missing or old.
   */
  stale: number;
  /** Per-kind breakdown of what was enqueued, so an operator can see WHERE the gap was. */
  byKind: Record<string, number>;
  /** Candidates left over after `limit`. Zero when the space is fully swept. */
  remaining: number;
  /** True when `remaining > 0` — call again to continue. */
  truncated: boolean;
}

/**
 * Queue an embedding job for every record in the space that has no vector and is not suppressed, and for every record whose stored
 * text differs from its current text (a vector made from text it no longer has, or a suppressed record whose lexical text is missing
 * or old).
 *
 * The second half is the repair of an update whose job was lost: the record kept the vector and the lexical text of its previous
 * content, so "has no vector" cannot see it. It costs one read of every record of the space per call (the `stale` walk,
 * `queueEmbedSweep`), while `limit` still bounds what is queued.
 *
 * `kinds` narrows the sweep; omitted means all of them. `limit` bounds one call — see the class comment on why the
 * remainder is reported rather than hidden. The walk is `queueEmbedSweep`'s, shared with the reindex; what is this
 * capability's own is the cap, the background lane, and the "vectorless" and "stale" matches. A derived record with no text of
 * its own (a face chunk, a converted copy) is never a candidate: nothing gives it a vector, so a backfill that queued
 * it would report it as remaining work on every call for ever.
 */
export async function reembedSpace(
  spaceId: string,
  { kinds = REEMBED_KINDS, limit = REEMBED_DEFAULT_LIMIT }: { kinds?: BrainEmbedRecordType[]; limit?: number } = {},
): Promise<ReembedResult> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), REEMBED_MAX_LIMIT);
  const swept = await queueEmbedSweep(spaceId, {
    kinds, match: 'vectorless', limit: cap, priority: EMBED_PRIORITY.background,
  });
  // The records whose stored text is not their current text, under what is left of the one cap: the two walks select disjoint records,
  // so the cap is shared, never spent twice.
  const stale = await queueEmbedSweep(spaceId, {
    kinds, match: 'stale', limit: cap - swept.enqueued, priority: EMBED_PRIORITY.background,
  });
  const byKind: Record<string, number> = { ...swept.byKind };
  for (const [kind, n] of Object.entries(stale.byKind)) byKind[kind] = (byKind[kind] ?? 0) + n;
  const result: ReembedResult = {
    spaceId,
    enqueued: swept.enqueued + stale.enqueued,
    // A suppressed record owed its lexical text is queued (counted in `stale`, and in `remaining` past the cap), so it is not also a
    // record left alone: the vectorless walk saw it as skipped, and the stale walk says which of those it took back.
    skippedSuppressed: Math.max(0, swept.skippedSuppressed - stale.staleSuppressed),
    stale: stale.stale,
    byKind,
    remaining: swept.remaining + stale.remaining,
    truncated: false,
  };
  result.truncated = result.remaining > 0;
  return result;
}
