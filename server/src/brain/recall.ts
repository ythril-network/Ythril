  /**
   * How this step says a stage did not run — the SAME channel the budget skip uses.
   *
   * It incremented the counter directly, so an unreachable or refusing reranker reached a dashboard and
   * never the caller, against a `degraded` reason the integration guide already documents.
   */
/**
 * Recall engine — semantic search across every knowledge type, plus duplicate detection.
 *
 * Split out of brain/fact.ts (A17.4). Owns recall/recallGlobal/findSimilar/checkDuplicates and
 * the doc -> RecallResult mapping. Depends on the filter DSL; deliberately does NOT depend on
 * fact CRUD, so the dependency runs one way: fact.ts -> recall.ts -> filter.ts.
 */
import { col, isVectorSearchAvailable, asFilter } from '../db/mongo.js';
import { NotFoundError } from '../util/errors.js';
import { embed } from './embedding.js';
import type { EmbeddingResult } from './embedding.js';
import { getEmbeddingConfig } from '../config/loader.js';
import { needsReindex } from '../spaces/_shared.js';
// The pure half — merge, rank and the text projections. Moved out to pay back part of this file's
// god-file ratchet raise; see recall-shape.ts for why the type import back here is not a cycle.
import { mergeRecallResults, rankOf, byIdAsc, byRankThenId, rerankTextOf, summariseRecall } from './recall-shape.js';
import { vectorFilterFieldsFor } from '../spaces/vector-index.js';
import { FilterExpression, buildMongoFilter, toNativeVectorFilter } from './filter.js';
import { isRawFilter, type RecallFilter } from './recall-filter.js';
import { deriveChronoStatus } from './chrono-status.js';
import { datePassedPolicy } from './chrono-date-policy.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { rerank, rerankConfigured, candidateMultiplier, MAX_CANDIDATES } from './rerank-client.js';
import { lexicalSearch, rrfFuse, hybridSearchEnabled, LEXICAL_LIMIT_MULTIPLIER, type LexicalHit } from './lexical-search.js';
import { atlasVectorScore, scoresAgree } from './vector-score.js';
import { matchFreshWrites } from './fresh-writes.js';
import type { ChronoStatus, RecordType } from '../config/types.js';
import { RECORD_TYPES } from '../config/types.js';
import { log } from '../util/log.js';
import { recallDegradedTotal, recallFreshWritesFoundTotal } from '../metrics/registry.js';
import { envInt } from '../config/env-num.js';

/**
 * End-to-end budget for one recall call.
 *
 * Every hop runs in series — embed the query, the per-type vector searches, the lexical channel, then
 * the cross-encoder — and each carried its own timeout with nothing watching the total. Worst case that
 * is 30 s of embedding plus Mongo plus 20 s of reranking: comfortably past the point where an MCP client
 * or a browser has given up, so the work completes into a caller that is no longer listening.
 *
 * 25 s sits under the ~30 s a typical MCP client waits. It is a **budget, not a hard abort** — the only
 * hop it can cancel is the reranker, because that is the only optional one. Raise it if your clients are
 * patient and your corpus is slow; lower it if you would rather degrade sooner.
 */
export const RECALL_BUDGET_MS = envInt('RECALL_BUDGET_MS', 25_000);

/**
 * Below this much remaining budget the reranker is skipped entirely rather than started.
 *
 * Starting a cross-encoder pass with two seconds left is the worst of both worlds: it will not finish,
 * and the time it burns comes out of what was left for returning the answer. Skipping returns the fused
 * order — a slightly worse ranking, delivered — which is the trade the whole pipeline already makes when
 * a reranker is unreachable.
 */
export const RERANK_MIN_BUDGET_MS = envInt('RERANK_MIN_BUDGET_MS', 3_000);

/**
 * The floor a per-call `maxTimeMS` is clamped to.
 *
 * A caller sending `maxTimeMS: 1` has asked for a deadline, not for a guaranteed empty answer — and an empty
 * answer is exactly what an unclamped 1 ms would produce on every call, which reads as a broken parameter
 * rather than as an honoured one. 250 ms is short enough that nobody who wanted "fail fast" is surprised.
 */
export const MIN_RECALL_BUDGET_MS = 250;

/**
 * The smallest deadline handed to a single collection search.
 *
 * The budget is consumed by the hops before this one, so late in a slow call the remainder can be near zero
 * or negative. Passing that through would abort searches that had time to answer, turning a nearly-spent
 * budget into a guaranteed timeout. A small floor means the last hop still gets a real chance.
 */
export const MIN_SEARCH_DEADLINE_MS = 100;

/**
 * Await per-type searches, keeping what answered and flagging what timed out.
 *
 * `Promise.all` was correct while a search could only succeed or fail the whole recall. With a deadline that
 * is no longer the right shape: the integrator's stated preference is **partial results plus a truthful flag
 * over an error over hanging**, so one collection running out of time must not discard the four that
 * answered. Every other rejection still propagates — a real error is not degradation, and swallowing it here
 * would turn a broken index into a quietly shorter answer, which is the failure mode this release exists to
 * remove.
 */
async function settleSearches(
  searches: Promise<RecallResult[]>[],
  noteDegraded: (reason: string) => void,
): Promise<RecallResult[][]> {
  const settled = await Promise.allSettled(searches);
  const kept: RecallResult[][] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') { kept.push(s.value); continue; }
    if (s.reason instanceof RecallSearchTimeout) {
      log.warn(`Recall: ${s.reason.message} — returning a partial answer`);
      noteDegraded('search_timeout');
      continue;
    }
    throw s.reason;
  }
  return kept;
}

/** One of the five names this repo had for `RecordType`. Kept as the name recall's signatures read. */
export type RecallKnowledgeType = RecordType;

/** Fields shared by every knowledge-type recall result. */
interface RecallBase {
  _id: string;
  spaceId: string;
  /** Vector similarity, on the configured `similarity` scale. `minScore` always filters on THIS. */
  score: number;
  /**
   * Cross-encoder relevance, present only when a reranker is configured and answered.
   *
   * Kept separate from `score` rather than overwriting it, because the two are different scales and
   * `minScore` is documented against the vector one. Folding them together would silently redefine
   * what a caller's threshold means. Ordering prefers this when present; filtering never uses it.
   */
  rerankScore?: number;
  /** MongoDB `textScore` from the lexical channel, when hybrid retrieval ran and this record matched. */
  lexicalScore?: number;
  /**
   * Reciprocal-Rank-Fusion score over the vector and lexical rankings. Ordering prefers it over the raw
   * vector score; `minScore` never uses it — the two are different scales and a caller's threshold was
   * written against vector similarity.
   */
  fusedScore?: number;
  createdAt?: string;
  updatedAt?: string;
  seq?: number;
  embeddingModel?: string;
  tags?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  /** Pre-embedding source text — the exact string fed to the embedding model for this document. */
  matchedText?: string;
}

export interface RecallMemory extends RecallBase {
  type: 'fact';
  fact: string;
  entityIds?: string[];
}

export interface RecallEntity extends RecallBase {
  type: 'entity';
  name: string;
  /** Entity type (named `entityType` to avoid conflict with the `type` discriminator). */
  entityType: string;
}

export interface RecallEdge extends RecallBase {
  type: 'edge';
  from: string;
  to: string;
  label: string;
  weight?: number;
  /** Edge relationship type (named `edgeType` to avoid conflict with the `type` discriminator). */
  edgeType?: string;
}

export interface RecallChrono extends RecallBase {
  type: 'chrono';
  title: string;
  /** Chrono type (event/deadline/plan/prediction/milestone). Named `chronoType` to
   *  avoid conflict with the `type` discriminator field. */
  chronoType: string;
  startsAt: string;
  /** Chrono status (upcoming/active/completed/overdue/cancelled). */
  status?: string;
  entityIds?: string[];
}

export interface RecallFile extends RecallBase {
  type: 'file';
  path: string;
  sizeBytes?: number;
  /** Set on chunk records: the H2/H3 heading that opened this chunk (null for paragraph-chunked txt). */
  headingText?: string | null;
  /** Set on chunk records: the Markdown body of this chunk. */
  content?: string;
  /** Set on chunk and _converted/ records: _id of the parent file's filemeta record. */
  parentFileId?: string;
  /** Set on chunk records: 0-based position within the document. */
  chunkIndex?: number;
  /** Set on media chunk records: 'image' | 'audio' | 'video'. */
  mediaType?: 'image' | 'audio' | 'video';
  /** Set on media file records: current async embedding status. */
  embeddingStatus?: 'pending' | 'processing' | 'complete' | 'failed' | 'skipped' | 'disabled';
  /** Set on audio/video chunk records: start time of the chunk in milliseconds. */
  chunkOffsetMs?: number;
  /** Set on audio/video chunk records: duration of the chunk in milliseconds. */
  chunkDurationMs?: number;
  /** Inline parent file metadata — populated on chunk records when parentFileId is present. */
  parentFile?: { path: string; description?: string; tags?: string[] };
}

/** Discriminated union of all knowledge-type recall results. Narrow by `result.type`. */
export type RecallResult = RecallMemory | RecallEntity | RecallEdge | RecallChrono | RecallFile;

/** Semantic recall using $vectorSearch (Atlas Local / Atlas / MongoDB 8.2+) */
export async function recall(
  spaceId: string,
  query: string,
  topK = 10,
  tags?: string[],
  types?: RecallKnowledgeType[],
  minPerType?: Partial<Record<RecallKnowledgeType, number>>,
  minScore?: number,
  filter?: RecallFilter,
  /**
   * Options added after this signature was already eight parameters long.
   *
   * A ninth positional argument would make every call site a row of undefineds to count through, and the
   * next option after it a tenth. New options go here instead; existing callers are untouched.
   */
  opts?: {
    maxPerType?: Partial<Record<RecallKnowledgeType, number>>;
    /**
     * Per-call deadline in ms. It can only ever LOWER the instance's `RECALL_BUDGET_MS`, never raise it —
     * extending an operator's ceiling from a request body is a denial-of-service lever, and the ceiling is
     * the operator's call.
     */
    maxTimeMS?: number;
    /**
     * Collector for degradation reasons, so the caller can tell the requester the answer is partial.
     *
     * A mutable array rather than a changed return type: `recall` is called from four places and its
     * `RecallResult[]` return flows into traverse, findSimilar and two response builders, so widening it to
     * an envelope would ripple through paths that have nothing to do with deadlines. The reasons are the
     * same closed vocabulary as `ythril_recall_degraded_total` — an unbounded set here would become an
     * unbounded metric label there.
     */
    degraded?: string[];
    /**
     * The query, already embedded — set by `recallGlobal` so a fan-out over N spaces costs ONE embedding
     * instead of N identical ones.
     *
     * Not a public option: nothing outside this module should be computing a query vector, because a caller
     * that embedded with a different `task` than `'query'` would search with a vector prepared for a
     * different purpose and quietly get worse results. It is here rather than as a positional argument
     * because this signature was already eight parameters long.
     */
    embedded?: EmbeddingResult;
    /**
     * Also scan the newest records straight from each collection, so a record written seconds ago is
     * findable before the index has ingested it.
     *
     * ## Why this is opt-in
     *
     * The lag is real and measured: an integrator's fact was not returned by `recall` for a distinctive
     * nine-word phrase **within 150 seconds** of writing it, while insert-time duplicate detection saw the
     * same record immediately. That asymmetry IS the diagnosis — the vector is on the document the moment it
     * is written, and it is `$vectorSearch`'s index that lags. `exact: true` is not the fix and was measured
     * not to be: it scans the INDEX exhaustively, not the collection, and reports the same lag to the
     * millisecond (ANN 1088 ms, ENN 1083 ms on the same insert).
     *
     * `matchFreshWrites` reads the collection instead, which is the one place the missing record certainly
     * is. It is bounded by a time window and a document cap, so its cost tracks churn rather than collection
     * size — but `recall` searches every requested type, so a busy space pays it per type.
     *
     * Default OFF, by the project's own rule for this trade: **when a person is waiting, performance; when
     * the work is in the background, accuracy.** Recall is the path someone waits on. The write half of this
     * (duplicate detection) is not opt-in precisely because it is not — it runs while a write is being
     * processed and correctness there is what stops a batch duplicating itself.
     *
     * Turn it on for the case it exists for: searching for something you just wrote.
     */
    includeFreshWrites?: boolean;
  },
): Promise<RecallResult[]> {
  if (!isVectorSearchAvailable()) {
    throw new Error(
      'Semantic recall is unavailable: $vectorSearch is not supported by the connected MongoDB. ' +
      'Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas.',
    );
  }
  if (needsReindex(spaceId)) {
    const embCfg = getEmbeddingConfig();
    throw new Error(
      `Space '${spaceId}' has embeddings from a different model than the currently configured '${embCfg.model}'. ` +
      `Semantic recall is disabled until re-indexed. Call POST /api/brain/spaces/${spaceId}/reindex.`,
    );
  }
  // The clock for the whole call. Every hop below runs in series — embed, the vector searches, the
  // lexical channel, then the reranker — and each one had its own timeout with nothing watching the
  // total. Worst case that is 30 s of embedding plus Mongo plus 20 s of reranking, well past the point
  // where the MCP client or the browser has given up and thrown the answer away. See RECALL_BUDGET_MS.
  const startedAt = Date.now();

  // The effective budget for THIS call: the caller may lower the instance ceiling, never raise it. A floor
  // keeps `maxTimeMS: 1` from being a guaranteed empty answer that reads as a bug — the caller asked for a
  // deadline, not for nothing, and 250 ms is short enough to honour the intent.
  const effectiveBudgetMs = Math.max(
    MIN_RECALL_BUDGET_MS,
    Math.min(opts?.maxTimeMS ?? RECALL_BUDGET_MS, RECALL_BUDGET_MS),
  );
  const noteDegraded = (reason: string): void => {
    recallDegradedTotal.labels({ reason }).inc();
    if (opts?.degraded && !opts.degraded.includes(reason)) opts.degraded.push(reason);
  };
  /** What is left of the budget, as a Mongo deadline. Never below a floor, or the search cannot start. */
  const searchDeadline = (): number =>
    Math.max(MIN_SEARCH_DEADLINE_MS, effectiveBudgetMs - (Date.now() - startedAt));

  // One text, one vector. `recallGlobal` embeds the query ONCE and hands it down, because it fans out over
  // spaces and every one of those calls would otherwise embed the identical string again — N spaces, N calls,
  // N times the cost, the concurrency footprint and the failure surface, for a byte-identical vector.
  //
  // The canary operator found this from the outside while a reindex saturated their shared embedder: every
  // recall produced exactly five `POST /v1/embeddings`, all five 429'd, and the query died. They read the five
  // as one per knowledge type; it is one per SPACE, which is why the fix lives at the fan-out and not in the
  // per-type search. A 1-wide request fits where an N-wide burst does not.
  const embResult = opts?.embedded ?? await embed(query, 'query');

  const activeTypes: RecallKnowledgeType[] = (types && types.length > 0)
    ? types
    : [...RECORD_TYPES];

  // Phase 1: for each type with a minPerType floor > 0, guarantee that many results
  const guaranteed: RecallResult[] = [];
  const guaranteedIds = new Set<string>();
  if (minPerType) {
    const floorSearches = Object.entries(minPerType)
      .filter(([t, floor]) => activeTypes.includes(t as RecallKnowledgeType) && (floor ?? 0) > 0)
      .map(([t, floor]) =>
        recallByType(spaceId, t as RecallKnowledgeType, embResult.vector, floor!, tags, filter, searchDeadline()),
      );
    const floorResults = (await settleSearches(floorSearches, noteDegraded)).flat();
    for (const r of floorResults) {
      if (!guaranteedIds.has(r._id)) {
        guaranteedIds.add(r._id);
        guaranteed.push(r);
      }
    }
  }

  // Phase 2: run the global unrestricted search for all active types.
  //
  // With a reranker configured, cast a WIDER net first. A cross-encoder can only re-order what the
  // vector search already found, so reranking exactly the results you would have returned anyway buys
  // nothing — the over-fetch is the whole mechanism.
  const reranking = rerankConfigured();
  // Bounded absolutely as well as by `topK`. The over-fetch IS the reranking mechanism, so the multiplier
  // stays — but `topK` has no ceiling of its own since `P-34`, and a per-type fetch that scales without
  // one is how an oversized request becomes an oversized query rather than a slow answer.
  const perTypeK = Math.min(Math.ceil(topK * (reranking ? candidateMultiplier() : 1.5)), MAX_PER_TYPE_CANDIDATES);
  const searches = activeTypes.map(t => recallByType(spaceId, t, embResult.vector, perTypeK, tags, filter, searchDeadline()));
  const allResults = (await settleSearches(searches, noteDegraded)).flat();

  // Phase 2a: the records the INDEX has not ingested yet, read straight from each collection.
  //
  // Opt-in — see `includeFreshWrites`. Best-effort in the strongest sense: a failure here returns nothing
  // rather than taking the index results down with it, because a search that answers less is a worse
  // outcome than a search that answers without the newest few seconds.
  if (opts?.includeFreshWrites) {
    const seen = new Set(allResults.map(r => r._id));
    const freshPerType = await Promise.all(activeTypes.map(async t => {
      const collName = `${spaceId}_${KNOWLEDGE_COLLECTION[t]}`;
      const matches = await matchFreshWrites(collName, embResult.vector).catch(() => []);
      return { type: t, matches };
    }));
    const missingIds = freshPerType.flatMap(({ type, matches }) =>
      matches.filter(m => !seen.has(m._id)).map(m => ({ type, id: m._id, score: m.score })));
    if (missingIds.length > 0) {
      // Hydrate through the same path the index results came from, so a fresh hit and an indexed hit are
      // the same shape — a caller must not be able to tell which channel found a record.
      const hydrated = await hydrateFreshHits(spaceId, missingIds);
      allResults.push(...hydrated);
      // Counted, NOT reported as `degraded`. This search found MORE than the index could offer, which is the
      // opposite of degradation, and `ythril_recall_degraded_total` documents its own reason set as closed
      // precisely so it does not accumulate labels that mean unrelated things. What the count is worth is
      // turning "the index lags" from an anecdote into a measurement: every increment is a record a plain
      // recall would have missed.
      recallFreshWritesFoundTotal.inc(hydrated.length);
    }
  }

  allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || byIdAsc(a, b));

  // Phase 2b: the LEXICAL channel, fused into the vector order by RRF.
  //
  // Vector search is weakest exactly where the corpus is most precise — article numbers, form ids,
  // clause names — because an opaque identifier has no useful semantic neighbourhood. This gives those
  // queries a channel that can actually see them. Best-effort throughout: a space with no text index
  // contributes an empty channel and the vector order stands unchanged.
  if (hybridSearchEnabled()) {
    await applyLexicalFusion(spaceId, query, embResult.vector, activeTypes, perTypeK, allResults, tags, filter);
  }

  // Phase 3: rerank the candidate pool, if a cross-encoder is configured. Best-effort by construction —
  // `applyRerank` leaves the vector order untouched when the reranker has no opinion.
  //
  // Skipped outright when the budget is nearly gone. The reranker is the last hop and the only optional
  // one, so it is where a deadline should bite: starting a 20-second cross-encoder pass with three
  // seconds left guarantees the caller times out and gets NOTHING, where skipping it returns the fused
  // order — slightly worse ranking, delivered. Degrading beats being right too late.
  // The per-call budget, not the instance one: a caller who asked for 5 s must have the reranker skipped at
  // 5 s, or the parameter bounds nothing that matters. `RECALL_BUDGET_MS` remains the ceiling.
  const remaining = effectiveBudgetMs - (Date.now() - startedAt);
  if (reranking && remaining < RERANK_MIN_BUDGET_MS) {
    noteDegraded('rerank_skipped_budget');
    log.warn(`Recall: ${remaining}ms of the ${effectiveBudgetMs}ms budget left — skipping the reranker and returning the fused order`);
  } else if (reranking) {
    await applyRerank(query, guaranteed, allResults, remaining, noteDegraded);
  }

  const final = mergeRecallResults(guaranteed, allResults, topK, minScore, opts?.maxPerType);

  // Enrich file chunk results with inline parent metadata.
  //
  // This used to sit AFTER an early `return` in the minScore branch, so asking for a minimum score
  // silently changed the SHAPE of the response: file chunks came back without their parent's path,
  // description and tags. Scoring and enrichment are unrelated concerns, and nothing ever meant them
  // to interact — the two landed in the same refactor and the ordering was never deliberate.
  await enrichFileChunksWithParent(spaceId, final);

  return final;
}



/**
 * Fuse a lexical ranking into the candidate pool's order, in place.
 *
 * **It reorders; it does not introduce.** Only records the vector search already returned are affected.
 * That is a deliberate bound, and it is enough for the case this exists for: with `candidateMultiplier`
 * over-fetching, the exact-token match is normally *in* the pool but ranked low behind plausible-looking
 * prose — lexical agreement lifts it into the final `topK`. A record outside the pool entirely cannot be
 * rescued; widening `candidateMultiplier` is the lever for that.
 *
 * Introducing records was considered and rejected: a lexically-found record has no measured vector
 * similarity, so it would need either a fabricated `score` (a claim, and one `minScore` would then act
 * on) or a re-implementation of Atlas's score normalisation from guesswork. Both are worse than a stated
 * bound.
 *
 * Eligibility is applied by the QUERY, using the same `tags`/`filter` match the vector path builds — a
 * lexical channel that skipped them would resurrect records the caller filtered out.
 */
async function applyLexicalFusion(
  spaceId: string,
  query: string,
  queryVector: number[],
  activeTypes: RecallKnowledgeType[],
  perTypeK: number,
  pool: RecallResult[],
  tags?: string[],
  filter?: RecallFilter,
): Promise<void> {
  if (pool.length === 0) return;

  // Same two matches `recallByType`'s exhaustive path applies, so the two channels agree on eligibility.
  const eligibility: Record<string, unknown> = {};
  if (tags && tags.length > 0) eligibility['tags'] = { $all: tags };
  // Either grammar reaches the same eligibility match, so the lexical channel agrees with the vector one about which
  // records qualify. A raw filter arrives already validated and needs no translation.
  const built = filter == null ? null : isRawFilter(filter) ? filter.__raw : (Object.keys(filter).length > 0 ? buildMongoFilter(filter) : null);
  const match = built ? { ...eligibility, ...built } : eligibility;

  const limit = perTypeK * LEXICAL_LIMIT_MULTIPLIER;
  const perType = await Promise.all(
    activeTypes.map(t => lexicalSearch(spaceId, t, query, limit, match)),
  );
  const lexical = perType.flat().sort((a, b) => b.lexicalScore - a.lexicalScore || byIdAsc(a, b));
  if (lexical.length === 0) return; // no text index, or nothing matched — vector order stands

  const inPool = new Map(pool.map(r => [r._id, r]));
  for (const hit of lexical) {
    const rec = inPool.get(hit._id);
    if (rec) rec.lexicalScore = hit.lexicalScore;
  }

  // Admit lexical hits the vector search never returned, each with a MEASURED similarity. Done before
  // the ranking below so an introduced record participates in fusion like any other.
  for (let i = 0; i < activeTypes.length; i++) {
    const type = activeTypes[i]!;
    const hits = perType[i] ?? [];
    if (hits.length === 0) continue;
    const introduced = await introduceLexicalOnly(
      spaceId, type, hits, queryVector, inPool, match, perTypeK,
    );
    for (const rec of introduced) {
      pool.push(rec);
      inPool.set(rec._id, rec);
    }
  }

  const vectorRanked = [...pool].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || byIdAsc(a, b)).map(r => r._id);
  // Ranks are the LEXICAL ranks, not re-numbered after dropping out-of-pool ids: a document that placed
  // 5th lexically genuinely placed 5th, and compressing the ranks would overstate it.
  const lexicalRanked = lexical.map(h => h._id);
  const fused = rrfFuse([vectorRanked, lexicalRanked]);
  for (const rec of pool) {
    const f = fused.get(rec._id);
    if (f !== undefined) rec.fusedScore = f;
  }
}

/**
 * Bring lexical-only records into the pool, with a similarity that is measured rather than invented.
 *
 * ## What this unblocks
 *
 * The lexical channel exists for tokens whose embeddings are nearly arbitrary — part codes, clause
 * names, `event-qps`. Those are exactly the records most likely to fall *outside* the vector over-fetch,
 * so a channel that could only reorder the pool was weakest precisely where it was needed. Widening
 * `candidateMultiplier` was the only lever, and it taxes every query to rescue a rare one.
 *
 * ## Why the original objection no longer holds
 *
 * Introducing was rejected because a lexically-found record has no measured vector similarity, leaving
 * only a fabricated score or a guessed reproduction of Atlas's normalisation. Neither is needed: the
 * embedding is one `$in` away and the query vector is in hand, so the similarity is computed exactly.
 *
 * The normalisation is then **verified, not assumed**. Records appearing in both channels already carry
 * an Atlas-reported score, so every query supplies its own free sample: recompute those locally and
 * compare. Agreement means the mapping is right and lexical-only scores sit on the same scale as the
 * rest. Disagreement means something changed, and this returns nothing — hybrid falls back to
 * reorder-only rather than putting an unverified number where `minScore` will act on it.
 *
 * With no overlap to check against there is no evidence, so nothing is introduced. Silent on the happy
 * path, and self-disabling on the unhappy one.
 */
async function introduceLexicalOnly(
  spaceId: string,
  knowledgeType: RecallKnowledgeType,
  hits: LexicalHit[],
  queryVector: number[],
  inPool: Map<string, RecallResult>,
  eligibility: Record<string, unknown>,
  cap: number,
): Promise<RecallResult[]> {
  if (queryVector.length === 0) return [];

  const overlapIds: string[] = [];
  const newIds: string[] = [];
  for (const h of hits) {
    if (inPool.has(h._id)) {
      if (overlapIds.length < 3) overlapIds.push(h._id);   // verification sample only
    } else if (newIds.length < cap) {
      newIds.push(h._id);
    }
  }
  if (newIds.length === 0) return [];
  // No overlap means no way to check the mapping against Atlas on this query. Decline rather than
  // introduce on an unverified formula.
  if (overlapIds.length === 0) return [];

  const similarity = getEmbeddingConfig().similarity;
  const { commonProject, typeProject } = recallProjection(knowledgeType);
  const collName = `${spaceId}_${KNOWLEDGE_COLLECTION[knowledgeType]}`;

  try {
    const docs = await col(collName).aggregate<Record<string, unknown>>([
      { $match: { ...eligibility, _id: { $in: [...overlapIds, ...newIds] } } },
      { $project: { ...commonProject, ...typeProject, embedding: 1 } },
    ]).toArray();

    const byId = new Map(docs.map(d => [d['_id'] as string, d]));

    // The self-check. Every overlap record must reproduce.
    for (const id of overlapIds) {
      const doc = byId.get(id);
      const known = inPool.get(id)?.score;
      const vec = doc?.['embedding'];
      if (!doc || typeof known !== 'number' || !Array.isArray(vec)) continue;
      const local = atlasVectorScore(vec as number[], queryVector, similarity);
      if (local === null || !scoresAgree(local, known)) {
        log.warn(
          `Hybrid recall: local score reproduction disagrees with the search engine for ${collName} ` +
          `(local ${local === null ? 'n/a' : local.toFixed(6)} vs reported ${known.toFixed(6)}, ` +
          `similarity '${similarity}'). Not introducing lexical-only records.`,
        );
        return [];
      }
    }

    const out: RecallResult[] = [];
    for (const id of newIds) {
      const doc = byId.get(id);
      const vec = doc?.['embedding'];
      if (!doc || !Array.isArray(vec)) continue;      // filtered out by eligibility, or never embedded
      const score = atlasVectorScore(vec as number[], queryVector, similarity);
      if (score === null) continue;                    // dimension mismatch mid-migration
      delete doc['embedding'];                         // never leaves this function
      doc['score'] = score;
      const rec = mapToRecallResult(doc, knowledgeType);
      rec.lexicalScore = hits.find(h => h._id === id)?.lexicalScore;
      out.push(rec);
    }
    return out;
  } catch (err) {
    // Best-effort like the rest of this path: a failure here leaves the vector order untouched.
    log.debug(`Lexical introduction skipped for ${collName}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}



/**
 * Score the candidate pool with the cross-encoder and stamp `rerankScore` on each result, in place.
 *
 * Both lists are passed because a floor-guaranteed result competes for order with the global ones — a
 * reranker that saw only half the pool would produce two incomparable orderings in one response.
 * Deduped by `_id` so a record appearing in both lists is scored once and both references updated.
 *
 * Best-effort throughout: a `null` from the reranker leaves every result untouched, and the caller falls
 * back to vector order. It never throws, because a reranker outage must not turn into a failed search.
 */
async function applyRerank(
  query: string,
  guaranteed: RecallResult[],
  allResults: RecallResult[],
  /** What is left of the call's budget. The reranker's own timeout is capped to it. */
  budgetMs: number,
  /**
   * How this step says a stage did not run — the SAME channel the budget skip uses.
   *
   * It used to increment `recallDegradedTotal` directly, which told an operator with a dashboard and nobody
   * else. Two ways the reranker fails to run, one signature — results ordered by meaning alone, a 200, and
   * a plausible list — and only the budget one reachable from the answer.
   *
   * Found by wiring a real cross-encoder to a bench instance for the first time: every call came back
   * `413 Payload Too Large`, because `MAX_CANDIDATES` is 100 and a stock text-embeddings-inference server
   * accepts 32 per request. `degraded` was null and the results looked fine.
   */
  noteDegraded: (reason: string) => void,
): Promise<void> {
  // One entry per distinct record, holding every reference to it so a single score updates all of them.
  const byId = new Map<string, RecallResult[]>();
  for (const r of [...guaranteed, ...allResults]) {
    const refs = byId.get(r._id);
    if (refs) refs.push(r); else byId.set(r._id, [r]);
  }
  // Highest vector score first, so the absolute cap drops the least plausible candidates rather than an
  // arbitrary slice — the cap is a cost ceiling, not a sampling strategy.
  const ids = [...byId.keys()]
    .sort((a, b) => ((byId.get(b)![0].score ?? 0) - (byId.get(a)![0].score ?? 0)) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
  if (ids.length === 0) return;

  const passages = ids.map(id => rerankTextOf(byId.get(id)![0]));
  const scores = await rerank(query, passages, budgetMs);
  if (!scores) {
    // Configured but it did not answer. `rerank()` already logged why; this is what makes a reranker
    // that has been down for a week visible without anyone reading a week of logs — and, through
    // `noteDegraded`, visible to the caller holding the answer rather than only on a dashboard.
    noteDegraded('rerank_unavailable');
    return; // no opinion — vector order stands
  }

  for (const { index, score } of scores) {
    const id = ids[index];
    if (id === undefined) continue; // parseScores bounds this, but the pairing is worth not assuming
    for (const ref of byId.get(id)!) ref.rerankScore = score;
  }
}

// ── Insert-time duplicate detection ──────────────────────────────────────────

/** A near-duplicate surfaced by an insert-time similarity check. */
export interface SimilarMatch {
  _id: string;
  type: RecallKnowledgeType;
  score: number;
  summary: string;
}

/** Default cosine-similarity threshold at/above which an insert is flagged as a likely duplicate. */
export const DEFAULT_DUPE_THRESHOLD = 0.92;
const DEFAULT_DUPE_TOPK = 3;



/**
 * Insert-time near-duplicate check: return existing records of the same type scoring at or above
 * `threshold`. Best-effort — returns `[]` (never throws) when vector search is unavailable, the space
 * needs reindexing, or the search fails, so it can never block a write. Supply `excludeId` to drop a
 * self-match when called post-insert.
 *
 * Reads **two** sources, because neither alone can answer the question:
 *
 *  - the ANN index, which knows the whole space but not the last few seconds of it;
 *  - the collection's newest records ({@link matchFreshWrites}), which is exactly the set the index has
 *    not ingested yet — and exactly where a duplicate of a record being written right now would be.
 *
 * The second half is the fix for C-L5-3. Before it, an agent writing a batch of related records could not
 * be warned about the batch it was writing: every duplicate warning named an older record, and none ever
 * named a sibling. `exact: true` looks like the fix and is not — it scans the index exhaustively rather
 * than the collection, and measures the same lag to the millisecond.
 */
export async function checkDuplicates(
  spaceId: string,
  type: RecallKnowledgeType,
  vector: number[],
  threshold = DEFAULT_DUPE_THRESHOLD,
  topK = DEFAULT_DUPE_TOPK,
  excludeId?: string,
): Promise<SimilarMatch[]> {
  if (!vector || vector.length === 0) return [];
  if (!isVectorSearchAvailable() || needsReindex(spaceId)) return [];
  const collName = `${spaceId}_${KNOWLEDGE_COLLECTION[type]}`;
  try {
    // In parallel: the two halves are independent, and the check sits on a write path.
    const [hits, fresh] = await Promise.all([
      recallByType(spaceId, type, vector, topK),
      // `.catch` here as well as inside, because the property being protected belongs to this composition
      // rather than to the callee: `Promise.all` rejects as a unit, so a throw from the fresh half would
      // reach the catch below and discard the index results too — turning a best-effort addition into a
      // way to lose the half that worked.
      matchFreshWrites(collName, vector).catch(() => []),
    ]);

    const matches = new Map<string, SimilarMatch>();
    for (const h of hits) {
      if (h._id === excludeId || (h.score ?? 0) < threshold) continue;
      matches.set(h._id, { _id: h._id, type: h.type, score: h.score, summary: summariseRecall(h) });
    }

    // Free verification, taken whenever it is available. A record in BOTH channels carries a score the
    // search engine reported and one computed here, so every check that overlaps supplies its own sample
    // — the same self-check `introduceLexicalOnly` runs, for the same reason. Disagreement means the
    // local reproduction is wrong, and a wrong score is worse than a missing one on a threshold.
    const reported = new Map(hits.map(h => [h._id, h.score]));
    for (const f of fresh) {
      const known = reported.get(f._id);
      if (typeof known === 'number' && !scoresAgree(f.score, known)) {
        log.warn(
          `Duplicate check: fresh-write score disagrees with the search engine for ${collName} ` +
          `(local ${f.score.toFixed(6)} vs reported ${known.toFixed(6)}). Using the index alone.`,
        );
        return [...matches.values()];
      }
    }

    const unseen = fresh.filter(f => f._id !== excludeId && f.score >= threshold && !matches.has(f._id));
    if (unseen.length > 0) {
      // Only now fetch the records themselves, and only the ones that actually cleared the threshold —
      // usually none. The scan deliberately returns ids and scores so it never carries record bodies.
      const { commonProject, typeProject } = recallProjection(type);
      const docs = await col(collName).aggregate<Record<string, unknown>>([
        { $match: { _id: { $in: unseen.map(f => f._id) } } },
        { $project: { ...commonProject, ...typeProject } },
      ]).toArray();
      const scoreById = new Map(unseen.map(f => [f._id, f.score]));
      for (const doc of docs) {
        doc['score'] = scoreById.get(doc['_id'] as string);
        const rec = mapToRecallResult(doc, type);
        matches.set(rec._id, { _id: rec._id, type: rec.type, score: rec.score, summary: summariseRecall(rec) });
      }
    }

    return [...matches.values()].sort((a, b) => b.score - a.score || byIdAsc(a, b));
  } catch {
    return [];
  }
}

/** Maps knowledge types to their MongoDB collection suffixes. */
const KNOWLEDGE_COLLECTION: Record<RecallKnowledgeType, string> = {
  fact: 'facts',
  entity: 'entities',
  edge: 'edges',
  chrono: 'chrono',
  file: 'files',
};

/**
 * The fields a recall result is built from, per knowledge type.
 *
 * Shared by the vector path and the lexical-introduction path so the two cannot drift into returning
 * differently-shaped records for the same type — a record's contents must not depend on which channel
 * happened to find it.
 */
function recallProjection(knowledgeType: RecallKnowledgeType): {
  commonProject: Record<string, number>;
  typeProject: Record<string, number>;
} {
  const commonProject = { _id: 1, spaceId: 1, _knowledgeType: 1, score: 1, createdAt: 1, updatedAt: 1, seq: 1, embeddingModel: 1, matchedText: 1 };
  let typeProject: Record<string, number> = {};
  if (knowledgeType === 'fact') {
    typeProject = { fact: 1, tags: 1, entityIds: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'entity') {
    typeProject = { name: 1, type: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'edge') {
    typeProject = { from: 1, to: 1, label: 1, weight: 1, type: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'chrono') {
    typeProject = { title: 1, description: 1, type: 1, status: 1, startsAt: 1, endsAt: 1, tags: 1, entityIds: 1, properties: 1 };
  } else if (knowledgeType === 'file') {
    typeProject = { path: 1, description: 1, tags: 1, sizeBytes: 1, properties: 1, headingText: 1, content: 1, parentFileId: 1, chunkIndex: 1, mediaType: 1, embeddingStatus: 1, chunkOffsetMs: 1, chunkDurationMs: 1 };
  }
  return { commonProject, typeProject };
}

/** Run $vectorSearch against a single collection and map results to RecallResult. */
async function recallByType(
  spaceId: string,
  knowledgeType: RecallKnowledgeType,
  queryVector: number[],
  topK: number,
  tags?: string[],
  filter?: RecallFilter,
  /**
   * Server-side deadline for this collection's search, in ms.
   *
   * The vector aggregations carried NO time limit at all, which made the end-to-end budget decorative
   * for the hop most likely to be slow: `RECALL_BUDGET_MS` could only ever cancel the reranker, so a slow
   * `$vectorSearch` blew past any deadline and the caller had already given up. A per-call `maxTimeMS`
   * that cannot cut this is a promise the server cannot keep.
   */
  maxTimeMS?: number,
): Promise<RecallResult[]> {
  const collSuffix = KNOWLEDGE_COLLECTION[knowledgeType];
  const collName = `${spaceId}_${collSuffix}`;
  const indexName = `${spaceId}_${collSuffix}_embedding`;

  // `mongoFilter` counts: without it here a raw filter would fall through to the unfiltered ANN path and be silently
  // ignored — a filtered search returning unfiltered results, which is the defect class this whole change came from.
  const hasFilter = filter != null && (isRawFilter(filter) || Object.keys(filter).length > 0);
  const hasTags = tags != null && tags.length > 0;

  // Shared tail: attach score/type, then project type-specific fields (always dropping the vector).
  const { commonProject, typeProject } = recallProjection(knowledgeType);
  const tail: object[] = [
    { $addFields: { _knowledgeType: knowledgeType, score: { $meta: 'vectorSearchScore' } } },
    { $project: { ...commonProject, ...typeProject } },
  ];

  /** ANN: approximate nearest-neighbour, no filtering. Used when nothing is filtered. */
  const annStage = () => ({
    $vectorSearch: { index: indexName, path: 'embedding', queryVector, numCandidates: Math.min(topK * 15, 1000), limit: topK },
  });

  /**
   * Exhaustive fallback: `exact:true` scores ALL vectors, then post-`$match` filters and re-limits.
   * Correct for any filter (including dynamic `properties.*` and `$exists`), but pays O(N) scoring.
   * The historical path — used only when a filter can't be pushed into the index natively.
   */
  const exhaustivePipeline = (): object[] => {
    const ennLimit = Math.min(10000, Math.max(topK * 100, 1000));
    const p: object[] = [{ $vectorSearch: { index: indexName, path: 'embedding', queryVector, exact: true, limit: ennLimit } }];
    if (hasTags) p.push({ $match: { tags: { $all: tags } } });
    if (hasFilter) p.push({ $match: isRawFilter(filter!) ? filter.__raw : buildMongoFilter(filter as FilterExpression) });
    p.push({ $limit: topK });
    return [...p, ...tail];
  };

  // Decide the primary path (P6).
  //  - no filter  → ANN (unchanged).
  //  - declarable filter → `exact:true` + native `filter`: Atlas restricts to the matching subset
  //    FIRST, then exhaustively scores only that subset. Exact results, cost ∝ matching set, not N.
  //  - non-declarable filter (dynamic properties / $exists) → exhaustive scan + post-$match.
  let primary: object[];
  let usedNativeFilter = false;
  if (!hasFilter && !hasTags) {
    primary = [annStage(), ...tail];
  } else {
    const declared = new Set(vectorFilterFieldsFor(spaceId, collSuffix));
    // A raw filter is never declarable: `toNativeVectorFilter` speaks the operator-object grammar, and `$or` has no
    // native `$vectorSearch` equivalent. Passing `undefined` sends it down the exhaustive branch below.
    const nativeFilter = isRawFilter(filter) ? null : toNativeVectorFilter(tags, filter, declared);
    if (nativeFilter) {
      usedNativeFilter = true;
      primary = [
        { $vectorSearch: { index: indexName, path: 'embedding', queryVector, exact: true, filter: nativeFilter, limit: topK } },
        ...tail,
      ];
    } else {
      primary = exhaustivePipeline();
    }
  }

  const swallowIndexError = (err: unknown): RecallResult[] => {
    const msg = err instanceof Error ? err.message : String(err);
    // A missing OR not-yet-queryable vector index means "no results from this collection", not a
    // failure: a new space builds its indexes asynchronously (B1) and Atlas refuses queries against
    // an index still in INITIAL_SYNC. Transient empty state, not an error to surface.
    if (/index.*not.*found|no.*such.*index|search.*index|cannot query.*vector index|while in state (INITIAL_SYNC|PENDING|BUILDING|STARTING)/i.test(msg)) {
      return [];
    }
    throw err;
  };

  /** Apply the deadline only when there is one, so an unbounded call behaves exactly as before. */
  const run = (pipeline: object[]) => {
    const cursor = col(collName).aggregate<Record<string, unknown>>(pipeline);
    return (maxTimeMS != null ? cursor.maxTimeMS(maxTimeMS) : cursor).toArray();
  };

  try {
    const docs = await run(primary);
    return docs.map(d => mapToRecallResult(d, knowledgeType));
  } catch (err) {
    // A deadline that expired is NOT an index error and must not be swallowed as an empty collection —
    // that is the difference between "this space holds nothing matching" and "we ran out of time", and
    // reporting the first when the second happened is the failure this whole release has been about. It is
    // rethrown so `recall` can count it and flag the answer as partial.
    if (isMaxTimeExpired(err)) throw new RecallSearchTimeout(knowledgeType);
    // If the native-filter query failed — e.g. the index has not yet been rebuilt with a
    // just-added filter field — retry on the exhaustive path, which needs no declared fields. This
    // keeps recall correct through the brief window after a schema change while the index rebuilds.
    if (usedNativeFilter) {
      try {
        const docs = await run(exhaustivePipeline());
        return docs.map(d => mapToRecallResult(d, knowledgeType));
      } catch (err2) {
        if (isMaxTimeExpired(err2)) throw new RecallSearchTimeout(knowledgeType);
        return swallowIndexError(err2);
      }
    }
    return swallowIndexError(err);
  }
}

/**
 * Turn fresh-write hits into full `RecallResult`s.
 *
 * Hydrated through the SAME projection the index path uses, so a record found by scanning the collection is
 * byte-identical in shape to one found by `$vectorSearch`. A caller must not be able to tell which channel
 * found a record — the moment they can, the flag stops being "search harder" and becomes a second result
 * type to handle.
 *
 * The score comes from `matchFreshWrites`, which computes it with `atlasVectorScore` — the same mapping the
 * engine reports, and one the duplicate path already cross-checks against the engine on every overlap.
 */
async function hydrateFreshHits(
  spaceId: string,
  hits: { type: RecallKnowledgeType; id: string; score: number }[],
): Promise<RecallResult[]> {
  const byType = new Map<RecallKnowledgeType, { id: string; score: number }[]>();
  for (const h of hits) {
    const list = byType.get(h.type) ?? [];
    list.push({ id: h.id, score: h.score });
    byType.set(h.type, list);
  }

  const out: RecallResult[] = [];
  for (const [type, entries] of byType) {
    const { commonProject, typeProject } = recallProjection(type);
    const collName = `${spaceId}_${KNOWLEDGE_COLLECTION[type]}`;
    try {
      const docs = await col(collName).aggregate<Record<string, unknown>>([
        { $match: { _id: { $in: entries.map(e => e.id) } } },
        { $project: { ...commonProject, ...typeProject } },
      ]).toArray();
      const scoreOf = new Map(entries.map(e => [e.id, e.score]));
      for (const d of docs) {
        out.push(mapToRecallResult({ ...d, score: scoreOf.get(d['_id'] as string) }, type));
      }
    } catch {
      // Best-effort by design: a hydration failure drops the fresh half and keeps the index half, which is
      // strictly better than failing a search that had already found something.
    }
  }
  return out;
}

/**
 * One collection's search hit the deadline.
 *
 * A named error rather than an empty array, because those two mean opposite things and the caller has to be
 * able to tell them apart: an empty result is an answer, a timeout is an admission. `recall` turns this into
 * a `search_timeout` flag on a partial answer instead of letting it fail the whole call.
 */
class RecallSearchTimeout extends Error {
  constructor(public readonly knowledgeType: RecallKnowledgeType) {
    super(`recall: the ${knowledgeType} search exceeded its deadline`);
    this.name = 'RecallSearchTimeout';
  }
}

/**
 * Did MongoDB abort this operation because `maxTimeMS` expired?
 *
 * Keyed on **error code 50** (`MaxTimeMSExpired`) first, because a code is stable where a message is not.
 * The message check is a fallback for drivers or proxies that wrap the error and lose the code — without it,
 * a wrapped timeout would fall through to `swallowIndexError`, fail its regex, and surface as a 500 for what
 * is a deliberate deadline.
 */
function isMaxTimeExpired(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 50) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /maxtimems|operation exceeded time limit|exceeded time limit/i.test(msg);
}

function mapToRecallResult(doc: Record<string, unknown>, knowledgeType: RecallKnowledgeType): RecallResult {
  const base: RecallBase = {
    _id: doc['_id'] as string,
    spaceId: doc['spaceId'] as string,
    score: doc['score'] as number,
    createdAt: doc['createdAt'] as string | undefined,
    updatedAt: doc['updatedAt'] as string | undefined,
    seq: doc['seq'] as number | undefined,
    embeddingModel: doc['embeddingModel'] as string | undefined,
    tags: doc['tags'] as string[] | undefined,
    description: doc['description'] as string | undefined,
    properties: doc['properties'] as Record<string, string | number | boolean> | undefined,
    matchedText: doc['matchedText'] as string | undefined,
  };
  switch (knowledgeType) {
    case 'fact':
      return { ...base, type: 'fact', fact: doc['fact'] as string, entityIds: doc['entityIds'] as string[] | undefined };
    case 'entity':
      return { ...base, type: 'entity', name: doc['name'] as string, entityType: doc['type'] as string };
    case 'edge':
      return { ...base, type: 'edge', from: doc['from'] as string, to: doc['to'] as string, label: doc['label'] as string, weight: doc['weight'] as number | undefined, edgeType: doc['type'] as string | undefined };
    case 'chrono':
      return { ...base, type: 'chrono', title: doc['title'] as string, chronoType: doc['type'] as string, startsAt: doc['startsAt'] as string, status: deriveChronoStatus({ status: doc['status'] as ChronoStatus, startsAt: doc['startsAt'] as string, endsAt: doc['endsAt'] as string | undefined },
        new Date(), datePassedPolicy(getSpaceMeta(doc['spaceId'] as string), doc['type'] as string | undefined)), entityIds: doc['entityIds'] as string[] | undefined };
    case 'file':
      return { ...base, type: 'file', path: doc['path'] as string, sizeBytes: doc['sizeBytes'] as number | undefined, headingText: doc['headingText'] as string | null | undefined, content: doc['content'] as string | undefined, parentFileId: doc['parentFileId'] as string | undefined, chunkIndex: doc['chunkIndex'] as number | undefined, mediaType: doc['mediaType'] as 'image' | 'audio' | 'video' | undefined, embeddingStatus: doc['embeddingStatus'] as RecallFile['embeddingStatus'], chunkOffsetMs: doc['chunkOffsetMs'] as number | undefined, chunkDurationMs: doc['chunkDurationMs'] as number | undefined };
  }
}

/**
 * For file chunk results that have a parentFileId, batch-fetch the parent
 * file document and attach `parentFile: { path, description?, tags? }` inline.
 * Non-chunk file results and non-file results are left unchanged.
 */
async function enrichFileChunksWithParent(spaceId: string, results: RecallResult[]): Promise<void> {
  const fileChunks = results.filter(
    (r): r is RecallFile => r.type === 'file' && typeof r.parentFileId === 'string',
  );
  if (fileChunks.length === 0) return;

  const parentIds = [...new Set(fileChunks.map(r => r.parentFileId as string))];

  // Batch-fetch parent file docs — projection only (no embedding field)
  const parents = (await col(`${spaceId}_files`)
    .find(asFilter({ _id: { $in: parentIds } }), { projection: { path: 1, description: 1, tags: 1 } })
    .toArray()) as unknown as Array<{ _id: string; path?: string; description?: string; tags?: string[] }>;

  const parentMap = new Map(parents.map(p => [p._id, p]));

  for (const chunk of fileChunks) {
    const parent = parentMap.get(chunk.parentFileId as string);
    if (parent) {
      chunk.parentFile = {
        path: parent.path ?? (parent._id),
        ...(parent.description ? { description: parent.description } : {}),
        ...(parent.tags?.length ? { tags: parent.tags } : {}),
      };
    }
  }
}

/** Semantic recall across multiple spaces (parallel) */
/**
 * The most candidates one TYPE may be fetched for a single recall, however large `topK` is.
 *
 * `topK` has no ceiling of its own since `P-34` — the owner's reasoning being that the byte budget already
 * returns whole records and reports truncation, so the ANSWER never needed a cap. What still needs one is
 * the WORK: the per-type over-fetch is the reranking mechanism and scales with `topK`, so without this a
 * `topK: 100000` becomes a query for a million candidates rather than a slow answer.
 *
 * 2000 because the vector search's own `numCandidates` is already bounded at 1000 and its ENN fallback at
 * 10000, so this sits between them: high enough that no realistic request meets it, low enough that an
 * unrealistic one is bounded rather than refused.
 */
export const MAX_PER_TYPE_CANDIDATES = 2000;

export async function recallGlobal(
  spaceIds: string[],
  query: string,
  topK = 10,
  tags?: string[],
  types?: RecallKnowledgeType[],
  minPerType?: Partial<Record<RecallKnowledgeType, number>>,
  minScore?: number,
  filter?: RecallFilter,
  opts?: {
    maxPerType?: Partial<Record<RecallKnowledgeType, number>>;
    maxTimeMS?: number;
    degraded?: string[];
    /*
     * The fresh-write scan, which this signature did not declare — so the MCP tool's cross-space branch
     * had nowhere to put it and the flag was silently inert on the idiomatic call. `recall`'s own options
     * have always had it; the fan-out spreads `opts` into every per-space call below, so declaring it
     * here is the whole fix.
     */
    includeFreshWrites?: boolean;
  },
): Promise<RecallResult[]> {
  // Embed ONCE for the whole fan-out. Every space below searches the same text, so without this the query is
  // embedded once per space: identical input, identical vector, N times the cost and N times the chance that
  // a busy embedder refuses one of them and takes the whole recall with it.
  const embedded = await embed(query, 'query');

  const results = await Promise.all(spaceIds.map(
    id => recall(id, query, topK, tags, types, minPerType, minScore, filter, { ...opts, embedded }),
  ));
  const flat = results.flat();
  // Sort by score descending, deduplicate by _id
  const seen = new Set<string>();
  const deduped: RecallResult[] = [];
  // Same key as the per-space merge. Rerank scores from separate `recall` calls ARE comparable — same
  // model, same query — so ordering across spaces by them is sound; ordering by vector score while the
  // per-space lists were ordered by the cross-encoder would undo the reranking at the last step.
  for (const r of flat.sort(byRankThenId)) {
    if (!seen.has(r._id)) {
      seen.add(r._id);
      deduped.push(r);
    }
  }
  // The ceiling has to be re-applied to the MERGED set, not left to the per-space calls.
  //
  // Each `recall` above already honoured it for its own space, which is what shapes each space's ranking —
  // but three spaces capped at 2 entities each would return six. `maxPerType` is a statement about the
  // answer the caller receives, so it is enforced where the answer is assembled. Reusing
  // `mergeRecallResults` with no floor rather than writing a second cap loop: two implementations of one
  // rule is the shape that has cost this repo four bugs, and `minScore` is deliberately not re-applied here
  // because each space already filtered on it.
  return opts?.maxPerType
    ? mergeRecallResults([], deduped, topK, undefined, opts.maxPerType)
    : deduped.slice(0, topK);
}

/** Retrieve the stored embedding vector for an entry by its ID and knowledge type. */
async function getEntryEmbedding(
  spaceId: string,
  entryId: string,
  entryType: RecallKnowledgeType,
): Promise<{ vector: number[]; doc: Record<string, unknown> } | 'no-embedding' | null> {
  const collSuffix = KNOWLEDGE_COLLECTION[entryType];
  const collName = `${spaceId}_${collSuffix}`;
  const doc = await col(collName).findOne(
    asFilter({ _id: entryId, spaceId }),
    { projection: { embedding: 1, _id: 1, spaceId: 1, name: 1, fact: 1, label: 1, title: 1, path: 1, type: 1, description: 1 } },
  ) as Record<string, unknown> | null;
  if (!doc) return null;
  const vector = doc['embedding'] as number[] | undefined;
  // Told apart from `null` deliberately. Since writes stopped waiting for the embedding model, "exists but
  // has no vector yet" is a routine state lasting milliseconds — not an anomaly — and reporting it as "not
  // found" sends an operator hunting for a record that is sitting right there.
  if (!vector || !Array.isArray(vector) || vector.length === 0) return 'no-embedding';
  return { vector, doc };
}

export interface FindSimilarResult {
  source: RecallResult;
  results: RecallResult[];
}

/**
 * Find entries with high vector similarity to an existing entry.
 * Uses the entry's stored embedding vector directly — no re-embedding.
 */
export async function findSimilar(
  spaceId: string,
  entryId: string,
  entryType: RecallKnowledgeType,
  topK = 10,
  targetTypes?: RecallKnowledgeType[],
  minScore?: number,
  crossSpaceIds?: string[],
): Promise<FindSimilarResult> {
  if (!isVectorSearchAvailable()) {
    throw new Error(
      'Vector search is unavailable: $vectorSearch is not supported by the connected MongoDB. ' +
      'Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas.',
    );
  }

  // Fetch the source entry's stored embedding
  const entry = await getEntryEmbedding(spaceId, entryId, entryType);
  if (entry === 'no-embedding') {
    throw new NotFoundError(
      `Entry '${entryId}' exists in space '${spaceId}' (type: ${entryType}) but is not embedded yet, so ` +
      'there is nothing to compare it against. Embedding is queued and normally completes in milliseconds — ' +
      'retry, or write with waitForEmbedding: true when you need the record searchable the moment the write returns.',
    );
  }
  if (!entry) {
    throw new NotFoundError(`Entry '${entryId}' not found in space '${spaceId}' (type: ${entryType}).`);
  }

  const activeTypes: RecallKnowledgeType[] = (targetTypes && targetTypes.length > 0)
    ? targetTypes
    : [...RECORD_TYPES];

  // Fetch topK+1 to account for self-match removal
  const fetchK = topK + 1;

  // Determine which spaces to search
  const searchSpaces = crossSpaceIds && crossSpaceIds.length > 0 ? crossSpaceIds : [spaceId];

  const allResults: RecallResult[] = [];
  for (const sid of searchSpaces) {
    if (needsReindex(sid)) continue; // skip spaces needing reindex
    const searches = activeTypes.map(t => recallByType(sid, t, entry.vector, fetchK));
    const spaceResults = (await Promise.all(searches)).flat();
    allResults.push(...spaceResults);
  }

  // Sort by score descending, exclude self-match, deduplicate
  allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || byIdAsc(a, b));
  const seen = new Set<string>();
  const filtered: RecallResult[] = [];
  for (const r of allResults) {
    if (r._id === entryId) continue; // exclude self
    if (seen.has(r._id)) continue;
    seen.add(r._id);
    if (minScore != null && minScore > 0 && (r.score ?? 0) < minScore) continue;
    filtered.push(r);
    if (filtered.length >= topK) break;
  }

  // Build source summary
  const source = mapToRecallResult(entry.doc, entryType);
  source.score = 1.0;

  return { source, results: filtered };
}
