/**
 * The query vectors of recall, kept per (prepared text, model, endpoint) for a while (bundle-378, Q-976 S2, contract row 5).
 *
 * ## The question it answers
 *
 * "What is the query vector of this text under the model configured now?" A recall's fixed cost is mostly its query's embedding: one model
 * call per request, for a text an agent loop or a type-ahead often sends again. The vector of a text is the same for as long as the model,
 * its endpoint and the task prefix are, so it is kept and reused (`recall.ts` `embedQuery` builds the key and owns the one instance).
 *
 * ## What it prevents
 *
 * - **Another model's vector.** Ranking one model's vectors against another's returns plausible results in the wrong order. The key holds
 *   the configured model and endpoint and the PREPARED text (`prepareInput`: the task prefix the scheme adds is part of it), so a changed
 *   model, endpoint or prefix scheme is a miss.
 * - **A bound that grows, or a vector kept for ever.** At most `max` entries, the least recently used going first (`LruMap`), each for
 *   `ttlMs`.
 * - **A kept failure.** Only a vector is kept: a model call that failed is asked again by the next recall.
 * - **The same text embedded twice at once.** Two recalls of one text while its vector is being made share the one call.
 * - **A cached result.** It holds vectors only, keyed by text and model; it names no space and no caller, so every recall still runs its
 *   searches and its rights filter whatever the cache answered.
 *
 * A kept vector is handed out as a copy: a caller that changed it would change it for every later recall. The module imports nothing but
 * the bounded map, so it sits outside the server's import cycles.
 */
import { LruMap } from '../util/lru-map.js';

/** The most query vectors kept. */
export const QUERY_EMBEDDINGS_MAX = 1_000;
/** How long a query vector is kept, in milliseconds. */
export const QUERY_EMBEDDING_TTL_MS = 10 * 60_000;

/** A vector and the model that made it (`embedding.ts` `EmbeddingResult`). */
export interface QueryVector { vector: number[]; model: string; dimensions: number }

/** What a vector is kept under: the prepared text, the configured model, and where it is computed. */
export interface QueryEmbeddingKey { input: string; model: string; endpoint: string }

interface Entry<V extends QueryVector> { result: V; until: number }

const copyOf = <V extends QueryVector>(r: V): V => ({ ...r, vector: r.vector.slice() });

/** A bounded, timed map of query vectors, and the calls in flight. */
export class QueryEmbeddingCache<V extends QueryVector = QueryVector> {
  private readonly kept: LruMap<string, Entry<V>>;
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { max: number; ttlMs: number; now?: () => number }) {
    this.kept = new LruMap<string, Entry<V>>(opts.max);
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /** Entries kept now. */
  size(): number { return this.kept.size; }

  /** The vector of `key`: kept, or computed by `compute` (once for every caller asking meanwhile) and kept. */
  async get(key: QueryEmbeddingKey, compute: () => Promise<V>): Promise<V> {
    const k = JSON.stringify([key.endpoint, key.model, key.input]);
    const hit = this.kept.get(k);
    if (hit !== undefined) {
      if (hit.until > this.now()) return copyOf(hit.result);
      this.kept.delete(k);
    }
    let pending = this.inFlight.get(k);
    if (pending === undefined) {
      pending = compute();
      this.inFlight.set(k, pending);
      pending.then((result) => { this.kept.set(k, { result: copyOf(result), until: this.now() + this.ttlMs }); }, () => undefined)
        .finally(() => { this.inFlight.delete(k); });
    }
    return copyOf(await pending);
  }
}
