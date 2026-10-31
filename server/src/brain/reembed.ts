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
 * so it is not vectorless. The repair therefore queues every record the worker would settle, asking the worker's own classifier
 * (`embedOwed`, `embed-record.ts`) in ONE walk (`match: 'owed'`, `queue-embed-sweep.ts`): a record whose stored `matchedText`
 * differs from the text its builder gives today is owed as surely as one with no vector. The pair a write stores
 * (`derived-text-on-write.ts`) is the record of what is owed, so nothing else has to remember it.
 *
 * ## Each record is counted once
 *
 * The walk puts every record in exactly one outcome: owed (queued while the cap lasts, else `remaining`), `skippedSuppressed`, or
 * nothing, so `enqueued + remaining + skippedSuppressed` is the counted set and no count is ever subtracted. It replaced two walks
 * (`vectorless`, `stale`) whose counts were summed and subtracted, which a record with `embedding: null` fell between, and which
 * re-queued an orphan chunk or a chunk of a suppressed file on every call (Q-656).
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
 * A record that is STILL suppressed is never given a vector, and the worker's own resolver decides it (the record's three
 * tiers; for a file row, its two tiers and then its ancestors). Re-deriving the rule here would let a backfill re-index exactly
 * what an operator asked to keep out of recall.
 *
 * A suppressed record is still OWED when the worker has something to do for it: its lexical text is missing or old (the job
 * writes the text and calls no model, counted in `stale`), or it still holds a vector (the job removes it). A suppressed record
 * with its current text and no vector is `skippedSuppressed`. So running the backfill while suppression is on is not an error: it
 * writes searchable text only, and what it leaves alone comes back under `skippedSuppressed`, which tells the operator the setting
 * is still on.
 *
 * ## The walk terminates because it reads in `_id` order and asks the worker's question
 *
 * The first version filtered on "has no vector" alone with `find(filter).limit(n)` and no sort, so the same suppressed page came
 * back on every call and **blocked every embeddable record behind it, permanently**. The walk now reads every candidate in
 * `_id` order and caps what it QUEUES, never what it reads; a record the worker settles leaves the owed set, so a repeated call
 * reaches the records behind it.
 *
 * ## Nothing is capped silently
 *
 * `limit` bounds one call. When more owed records remain, `remaining` says how many and `truncated` is `true`. A
 * backfill that quietly stopped at a round number would read as "the space is fully indexed now", which is the
 * same class of lie as the missing sweep this replaces.
 *
 * `remaining` counts only work that CAN be done: a record left alone under suppression is in `skippedSuppressed`, never in
 * `remaining`. One exception to "a drained space owes nothing": a record whose text cannot be built (a field of the wrong type,
 * which a pull can store) is owed on every call, so its job fails where `list_embed_jobs` shows it until the record is corrected.
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
  /**
   * Records a job was queued for: every record the worker would change (`embedOwed`), up to the cap. That is a record with no
   * vector (absent, `null` or `[]`) that is not suppressed, a vector beside text the record no longer has, a suppressed record whose
   * text is stale or that still holds a vector, a textless derived row still holding a derived field, and a record whose text cannot
   * be built (owed on every call: its job fails where `list_embed_jobs` shows it). A vector made by another model is a reindex's.
   */
  enqueued: number;
  /**
   * Suppressed records left alone: their text is current and they hold no vector, so the worker has nothing to do for them. A
   * suppressed record owed its text or the removal of its vector is not here: it is queued, or counted in `remaining` past the cap.
   * `enqueued + remaining + skippedSuppressed` counts each record once.
   */
  skippedSuppressed: number;
  /**
   * Of `enqueued`, the records whose stored text differs from their current text and that hold a vector (made from text the record
   * no longer has: an update whose job was lost) or are suppressed (their lexical text is missing or old). A record with no vector
   * that is not suppressed is queued without being `stale`; a stale record past the cap counts in `remaining` only.
   */
  stale: number;
  /** Per-kind breakdown of what was enqueued, so an operator can see WHERE the gap was. */
  byKind: Record<string, number>;
  /** Owed records left over after `limit`, each counted once. Zero when the space is fully swept. */
  remaining: number;
  /** True when `remaining > 0` — call again to continue. */
  truncated: boolean;
}

/**
 * Queue an embedding job for every record in the space the worker would change: one walk (`match: 'owed'`, `queueEmbedSweep`)
 * that reads every candidate once and counts it in exactly one outcome. See the module comment for the outcomes.
 *
 * It covers the repair of an update whose job was lost: the record kept the vector and the lexical text of its previous content,
 * so "has no vector" cannot see it, and its stale text can. That costs one read of every candidate of the space per call, while
 * `limit` still bounds what is queued.
 *
 * `kinds` narrows the sweep; omitted means all of them. `limit` bounds one call — see the class comment on why the
 * remainder is reported rather than hidden. The walk lives with the reindex's in `queue-embed-sweep.ts`; what is this
 * capability's own is the cap, the background lane, and the `owed` match. A derived record with no text of its own (a face
 * chunk, a converted copy) is a candidate only while it still holds a derived field for the worker to clear: nothing gives it a
 * vector, so a backfill that queued it otherwise would report it as remaining work on every call for ever.
 */
export async function reembedSpace(
  spaceId: string,
  { kinds = REEMBED_KINDS, limit = REEMBED_DEFAULT_LIMIT }: { kinds?: BrainEmbedRecordType[]; limit?: number } = {},
): Promise<ReembedResult> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), REEMBED_MAX_LIMIT);
  const swept = await queueEmbedSweep(spaceId, {
    kinds, match: 'owed', limit: cap, priority: EMBED_PRIORITY.background,
  });
  // Each count straight from the one walk: no sum of two walks, and no subtraction.
  const result: ReembedResult = {
    spaceId,
    enqueued: swept.enqueued,
    skippedSuppressed: swept.skippedSuppressed,
    stale: swept.stale,
    byKind: { ...swept.byKind },
    remaining: swept.remaining,
    truncated: false,
  };
  result.truncated = result.remaining > 0;
  return result;
}
