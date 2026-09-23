/**
 * Reranker client — an optional cross-encoder that re-scores retrieval candidates.
 *
 * **What it is for.** The vector search embeds the query and each passage independently, so it can only
 * compare two summaries of meaning. A cross-encoder reads the (query, passage) pair together and scores
 * the actual match. That lifts precision in the top few results — the only region a caller ever sees.
 *
 * **What it cannot do.** It has no index, so it can only re-order candidates something else already
 * found. Over-fetch first (see `candidateMultiplier`), then rerank; reranking exactly `topK` candidates
 * returns the same set in a different order and buys nothing.
 *
 * **Egress.** This is the most revealing pairing in the system: the operator's question AND the passages
 * their own corpus returned for it. That is why it ships unconfigured, and why a non-local endpoint goes
 * through `ssrfSafeFetch` under the same private-address policy as every other model call. Self-hosting
 * `bge-reranker-v2-m3` keeps both halves on the instance.
 *
 * **Failure is never fatal.** Every path returns `null`, which means "no opinion" — the caller keeps the
 * vector order. A reranker that is down must degrade search quality, never break search.
 */
import { getMediaEmbeddingConfig, getModelSlots } from '../config/loader.js';
import { slotTimeoutMs } from '../config/model-slots.js';
import { boundedJson } from '../util/bounded-read.js';
import { allowPrivateForSlot, isLocalModelEndpoint } from '../config/model-egress-policy.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { log } from '../util/log.js';

/**
 * The reranker's own ceiling, resolved per call.
 *
 * A CEILING and not a flat budget: the signal takes `min(this, the caller's remaining recall budget)`, so a
 * value above `RECALL_BUDGET_MS` never binds and raising it only helps a caller who has budget left.
 */
const rerankTimeout = () => slotTimeoutMs('rerank', getModelSlots());

/** Bounds on `candidateMultiplier`. Below 2 there is nothing to rescue; above 10 every search overpays. */
// Defined in `config/setting-bounds.ts` — this module imports the loader, and the loader imports that file,
// so owning them here would close a runtime import cycle. Re-exported so every existing importer is unchanged.
import { MIN_CANDIDATE_MULTIPLIER, MAX_CANDIDATE_MULTIPLIER } from '../config/setting-bounds.js';
export { MIN_CANDIDATE_MULTIPLIER, MAX_CANDIDATE_MULTIPLIER };
export const DEFAULT_CANDIDATE_MULTIPLIER = 4;

/**
 * Absolute ceiling on candidates sent in one rerank call, independent of `topK` × multiplier.
 *
 * A cross-encoder is a forward pass PER PASSAGE — cost is linear in the candidate count, not amortised
 * like an ANN lookup. Without this, `topK=200` would quietly turn one search into an 800-passage batch.
 */
export const MAX_CANDIDATES = 100;

/**
 * How many passages may go in ONE request to the reranker (`Q-42`).
 *
 * `MAX_CANDIDATES` bounds how many passages are scored and said nothing about how many travel together, so
 * a hundred went as one body. A stock text-embeddings-inference server accepts 32 and answers
 * `413 Payload Too Large`, which reaches the caller as `rerank_unavailable` — a search permanently served
 * in fused order while looking exactly like a working one. Reported by the canary operator 2026-09-23.
 *
 * **32 rather than 100, and the total work is unchanged.** A cross-encoder is a forward pass per passage,
 * so four requests of 32 cost what one of 128 costs; what changes is that each body is one a stock server
 * will accept. A deployment whose reranker takes more can raise it and get its single request back.
 */
export const DEFAULT_MAX_PASSAGES_PER_REQUEST = 32;

/** Floor and ceiling for that setting. One passage per request is legal and slow; above the candidate cap
 *  is a setting that could never take effect, which is worse than a refusal. */
export const MAX_PASSAGES_PER_REQUEST_MIN = 1;
export const MAX_PASSAGES_PER_REQUEST_MAX = MAX_CANDIDATES;

/** The configured batch size, clamped and defaulted. Junk must not become a junk request pattern. */
export function maxPassagesPerRequest(): number {
  const raw = getMediaEmbeddingConfig().rerank?.maxPassagesPerRequest;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_PASSAGES_PER_REQUEST;
  return Math.min(MAX_PASSAGES_PER_REQUEST_MAX, Math.max(MAX_PASSAGES_PER_REQUEST_MIN, Math.floor(raw)));
}

/**
 * Split `total` passages into request-sized windows, in GLOBAL index space.
 *
 * Pure, and exported so it can be tested without a server, because the failure it prevents is arithmetic:
 * a score whose index is local to the second batch, read as an index into the first, moves the WRONG
 * passage. That is a wrong answer rather than a missing one — the class `parseScores` already drops
 * out-of-range indices for — and it would be invisible in every response.
 *
 * A junk `size` falls back to the default rather than propagating: zero or negative would never advance
 * the window, and a fraction would make one request per passage.
 */
export function planBatches(total: number, size: number): { start: number; end: number }[] {
  const step = Number.isInteger(size) && size >= MAX_PASSAGES_PER_REQUEST_MIN
    ? size
    : DEFAULT_MAX_PASSAGES_PER_REQUEST;
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < total; start += step) out.push({ start, end: Math.min(start + step, total) });
  return out;
}

/** One passage's verdict: its position in the input array and the cross-encoder's relevance score. */
export interface RerankScore {
  index: number;
  score: number;
}

/** True when a reranker endpoint AND model are both configured. Without both there is nothing to call. */
export function rerankConfigured(): boolean {
  const r = getMediaEmbeddingConfig().rerank;
  return !!r?.baseUrl?.trim() && !!r?.model?.trim();
}

/** The configured multiplier, clamped and defaulted. A junk value must not become a junk fan-out. */
export function candidateMultiplier(): number {
  const raw = getMediaEmbeddingConfig().rerank?.candidateMultiplier;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CANDIDATE_MULTIPLIER;
  return Math.min(MAX_CANDIDATE_MULTIPLIER, Math.max(MIN_CANDIDATE_MULTIPLIER, Math.floor(raw)));
}

/**
 * The URL to POST to, and which request dialect it implies.
 *
 * Two wire shapes are in wide use and they are not compatible:
 *
 * - **Cohere/Jina style** — `POST /v1/rerank` `{model, query, documents, top_n}` → `{results:[{index,
 *   relevance_score}]}`. Cohere, Jina, vLLM's score endpoint, Infinity.
 * - **TEI style** — `POST /rerank` `{query, texts}` → `[{index, score}]`. HuggingFace
 *   text-embeddings-inference, which is the usual way `bge-reranker-v2-m3` gets self-hosted.
 *
 * Rather than guess, or send a union of fields and hope the server ignores the ones it does not know,
 * **the operator's URL declares the dialect**: a `baseUrl` already ending in `/rerank` is used as-is and
 * read as TEI; `…/v1/rerank` is used as-is and read as Cohere; a bare host gets `/v1/rerank` appended.
 * Guessing here would produce a 422 that looks like "the reranker is broken".
 */
export function resolveEndpoint(baseUrl: string): { url: string; dialect: 'cohere' | 'tei' } {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v1\/rerank$/.test(trimmed)) return { url: trimmed, dialect: 'cohere' };
  if (/\/rerank$/.test(trimmed)) return { url: trimmed, dialect: 'tei' };
  return { url: `${trimmed}/v1/rerank`, dialect: 'cohere' };
}

/** Build the request body for the dialect the endpoint declared. */
export function buildBody(
  dialect: 'cohere' | 'tei',
  model: string,
  query: string,
  passages: string[],
): Record<string, unknown> {
  return dialect === 'tei'
    ? { query, texts: passages, raw_scores: false }
    : { model, query, documents: passages, top_n: passages.length };
}

/**
 * Normalise either response shape into scores, dropping anything unreadable.
 *
 * Returns `null` only when the body is not recognisable at all. An entry with a missing or non-finite
 * score is dropped rather than defaulted: a passage scored `0` because the provider sent nonsense would
 * be pushed to the bottom of the results, which is a silent wrong answer, not a missing one. An
 * out-of-range index is dropped for the same reason — it would otherwise reorder the wrong passage.
 */
export function parseScores(body: unknown, count: number): RerankScore[] | null {
  const rows: unknown[] | null =
    Array.isArray(body) ? body
    : (body && typeof body === 'object' && Array.isArray((body as { results?: unknown[] }).results))
      ? (body as { results: unknown[] }).results
      : null;
  if (!rows) return null;

  const out: RerankScore[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const index = typeof rec['index'] === 'number' ? rec['index'] : Number.NaN;
    const rawScore = rec['relevance_score'] ?? rec['score'];
    const score = typeof rawScore === 'number' ? rawScore : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    if (!Number.isFinite(score)) continue;
    out.push({ index, score });
  }
  return out;
}

/**
 * Score `passages` against `query` with the configured cross-encoder.
 *
 * Returns `null` — never throws, never guesses — when there is no opinion to be had: unconfigured,
 * unreachable, non-2xx, or an unreadable body. The caller must read `null` as "keep the vector order",
 * not as "these passages are irrelevant". Silently zeroing an unreachable reranker would reorder every
 * result set by nothing at all and look exactly like a working search.
 */
export async function rerank(
  query: string,
  passages: string[],
  /**
   * What is left of the caller's end-to-end budget. The reranker's own timeout is capped to it, so a
   * pass that could not finish in time is abandoned early instead of running on past the point where
   * anyone is still listening. Omitted (or non-finite) means the full slot budget.
   */
  budgetMs?: number,
): Promise<RerankScore[] | null> {
  const cfg = getMediaEmbeddingConfig().rerank;
  if (!rerankConfigured() || !cfg?.baseUrl || !cfg.model) return null;
  if (passages.length === 0) return null;

  const { url, dialect } = resolveEndpoint(cfg.baseUrl);
  /*
   * ONE deadline for the whole pass, shared by every batch (`Q-42`).
   *
   * Not one budget each: the caller's `budgetMs` is what is left of a recall somebody is waiting on, and
   * four batches each allowed the full slot budget could spend four times it. The signal is built once and
   * every request takes it, so the pass as a whole is bounded exactly as the single request was.
   */
  const signal = AbortSignal.timeout(
    Number.isFinite(budgetMs) && budgetMs! > 0 ? Math.min(rerankTimeout(), budgetMs!) : rerankTimeout(),
  );
  const headers = {
    'content-type': 'application/json',
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  };

  const batches = planBatches(passages.length, maxPassagesPerRequest());

  const one = async ({ start, end }: { start: number; end: number }): Promise<RerankScore[] | null> => {
    const slice = passages.slice(start, end);
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(dialect, cfg.model!, query, slice)),
      signal,
    };
    const res = isLocalModelEndpoint(cfg.baseUrl!)
      ? await fetch(url, init)
      : await ssrfSafeFetch(url, init, { allowPrivate: allowPrivateForSlot('rerank') });
    if (!res.ok) {
      log.warn(`Rerank: HTTP ${res.status} from the reranker — keeping the vector order`);
      return null;
    }
    const scores = parseScores(await boundedJson(res, 'reranker'), slice.length);
    if (!scores) {
      log.warn('Rerank: unreadable response shape — keeping the vector order');
      return null;
    }
    // Back into the caller's index space. A batch scores 0..n-1 of its own slice and the caller holds the
    // whole list, so an un-offset index would move a different passage entirely.
    return scores.map(s => ({ index: s.index + start, score: s.score }));
  };

  try {
    const results = await Promise.all(batches.map(one));
    /*
     * ANY batch failing abandons the whole pass, deliberately.
     *
     * Merging the ones that answered would order part of the list by cross-encoder score and the rest by
     * vector score, in one list, with nothing saying which is which — two orderings interleaved is a
     * plausible wrong answer, and this file's whole contract is that a reranker may make search worse but
     * never silently wrong. `null` means "keep the vector order", which is one ordering and an honest one.
     */
    if (results.some(r => r === null)) return null;
    return results.flat() as RerankScore[];
  } catch (err) {
    // Deliberately logs neither the query nor the passages: both are user content and this line goes to
    // the log. The same rule the NLI client follows.
    log.warn(`Rerank failed — keeping the vector order: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
