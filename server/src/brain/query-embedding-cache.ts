/**
 * The query vectors of recall, kept per (caller, prepared text, model, endpoint) for a while (bundle-378, Q-976 S2, contract row 5; fix
 * round A).
 *
 * ## The question it answers
 *
 * "What is the query vector of this text, asked by this caller, under the model configured now?" A recall's fixed cost is mostly its query's
 * embedding: one model call per request, for a text an agent loop or a type-ahead often sends again. The vector of a text is the same for as
 * long as the model, its endpoint and the task prefix are, so it is kept and reused (`recall.ts` `embedQuery` builds the key and owns the one
 * instance).
 *
 * ## What it prevents
 *
 * - **One caller learning what another searched.** A hit is visible: the `embed` phase of `Server-Timing` is cheap, and the model call is
 *   absent. A cache shared by every caller tells any caller whether anyone recalled that exact text in the last ten minutes. The caller (the
 *   token id) is part of the key, so another caller's identical text is a miss for it, as if nobody had asked, and a call in flight for one
 *   caller is never joined by another. A call with no caller identity is never kept (`recall.ts` does not ask this cache).
 * - **Query text kept in memory.** A recall's `query` is bounded only by the body limit, so a key holding the text could retain about 10 GB
 *   in a thousand entries. The key is a SHA-256 of everything it names; no text, and no token id in the clear, is kept.
 * - **A vector kept past its time.** An entry's time was read only when it was asked for again, so an entry nobody asked for stayed for
 *   ever, under the bound alone. Entries past their time are dropped each time another is kept.
 * - **Another model's vector.** Ranking one model's vectors against another's returns plausible results in the wrong order. The key holds
 *   the configured model and endpoint and the PREPARED text (`prepareInput`: the task prefix the scheme adds is part of it), so a changed
 *   model, endpoint or prefix scheme is a miss.
 * - **A bound that grows.** At most `max` entries, the least recently used going first (`WalkableLru`), each for `ttlMs`.
 * - **A kept failure.** Only a vector is kept: a model call that failed is asked again by the next recall.
 * - **The same text embedded twice at once.** Two recalls of one text by one caller while its vector is being made share the one call.
 * - **A cached result.** It holds vectors only, never an answer or a space; every recall still runs its searches and its rights filter
 *   whatever the cache answered.
 *
 * A kept vector is handed out as a copy: a caller that changed it would change it for every later recall. Every lookup is counted
 * (`onLookup`, `ythril_cache_lookups_total{cache="query_vector"}`): a call that joins one in flight counts as a hit, since it makes no model call.
 * The module imports nothing but the bounded map and the hash, so it sits outside the server's import cycles.
 */
import { WalkableLru } from '../util/walkable-lru.js';
import { sha256Hex } from '../util/sha256-hex.js';

/** The most query vectors kept. */
export const QUERY_EMBEDDINGS_MAX = 1_000;
/** How long a query vector is kept, in milliseconds. */
export const QUERY_EMBEDDING_TTL_MS = 10 * 60_000;

/** A vector and the model that made it (`embedding.ts` `EmbeddingResult`). */
export interface QueryVector { vector: number[]; model: string; dimensions: number }

/** What a vector is kept under: the asking caller, the prepared text, the configured model, and where it is computed. */
export interface QueryEmbeddingKey { caller: string; input: string; model: string; endpoint: string }

interface Entry<V extends QueryVector> { result: V; until: number }

const copyOf = <V extends QueryVector>(r: V): V => ({ ...r, vector: r.vector.slice() });

/** A bounded, timed map of query vectors, and the calls in flight. */
export class QueryEmbeddingCache<V extends QueryVector = QueryVector> {
  private readonly kept: WalkableLru<Entry<V>>;
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onLookup: ((hit: boolean) => void) | undefined;

  constructor(opts: { max: number; ttlMs: number; now?: () => number; onLookup?: (hit: boolean) => void }) {
    this.kept = new WalkableLru<Entry<V>>(opts.max);
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
    this.onLookup = opts.onLookup;
  }

  /** Entries kept now. */
  size(): number { return this.kept.size; }

  /** The keys the entries are held under, for a spec: each a hash, never a text. */
  _keys(): string[] { return this.kept.heldKeys(); }

  /** The vector of `key`: kept, or computed by `compute` (once for every ask of the same caller meanwhile) and kept. */
  async get(key: QueryEmbeddingKey, compute: () => Promise<V>): Promise<V> {
    const k = sha256Hex(JSON.stringify([key.caller, key.endpoint, key.model, key.input]));
    const hit = this.kept.get(k);
    if (hit !== undefined) {
      if (hit.until > this.now()) { this.onLookup?.(true); return copyOf(hit.result); }
      this.kept.delete(k);
    }
    let pending = this.inFlight.get(k);
    if (pending === undefined) {
      this.onLookup?.(false);
      pending = compute();
      this.inFlight.set(k, pending);
      pending.then((result) => { this.keep(k, result); }, () => undefined)
        .finally(() => { this.inFlight.delete(k); });
    } else {
      this.onLookup?.(true);
    }
    return copyOf(await pending);
  }

  /** Keep a vector, and drop every entry past its time: nothing else would, for an entry no one asks for again. */
  private keep(k: string, result: V): void {
    const now = this.now();
    this.kept.forgetWhere((_, e) => e.until <= now);
    this.kept.set(k, { result: copyOf(result), until: now + this.ttlMs });
  }
}
