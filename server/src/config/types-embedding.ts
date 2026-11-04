/**
 * How this instance reaches its text embedder: the local model or an HTTP endpoint, its model, width and similarity, the task
 * prefix, how many embeds run at once and how large one request may be.
 *
 * Split out of `types.ts` (bundle-237) when `maxInputBytes` would have taken it past its size limit, the way `types-scanners.ts`
 * (`Q-390`) was: the record moved WHOLE with every field and docblock it carried, and re-exported from `types.ts`, so no importer
 * changes. It imports nothing, so it cannot become half of a module cycle.
 */
export interface EmbeddingConfig {
  /** If set, route embedding requests to this OpenAI-compatible HTTP endpoint.
   *  If absent, the bundled local ONNX model is used (default, works out of the box). */
  baseUrl?: string;
  /**
   * How many chunk embeds may run at once while converting one document. Absent = per-embedder default:
   * low for the bundled local model (one inference process runs one embed at a time, so more only queues, in front of
   * every recall and write too), higher for an HTTP endpoint (network-bound, the work is elsewhere). See
   * `embed-concurrency.ts` for the measurements. Raise it only with CPU headroom to spare; clamped to 1…32.
   */
  embedConcurrency?: number;
  /**
   * The most UTF-8 bytes one embedder request may carry, task prefix included. Absent = 6,000; range 512…65,536. An embedder with a
   * small context (512 tokens) needs it lower. Read through `embedInputCeiling()` (`brain/embed-text.ts`), which never means "no limit":
   * a stored value outside the range (a hand-edited `config.json` is not validated at load) reads as the default. A change re-chunks
   * a file only when it is re-converted (`retry_embed_file`).
   */
  maxInputBytes?: number;
  model: string;
  dimensions: number;
  similarity: 'cosine' | 'dotProduct' | 'euclidean';
  /**
   * Where the HTTP embedding endpoint lives (only relevant when `baseUrl` is set). `local` (default) = a
   * trusted internal endpoint (e.g. Ollama on the cluster network) reached with a plain fetch; `external` =
   * an operator-supplied public endpoint reached through the SSRF-guarded fetch at runtime (SSRF follow-up
   * part 2). Mirrors `visionProvider`/`sttProvider`. Absent/`local` keeps today's behaviour.
   */
  provider?: 'local' | 'external';
  /**
   * Which task-prefix convention the embedding model expects.
   *
   * Asymmetric retrieval models want the query and the stored passage marked differently, and get
   * measurably worse recall without it. The convention is per MODEL FAMILY, not per deployment, so it
   * cannot be inferred from `baseUrl`:
   *
   * - `nomic` — `search_document: ` / `search_query: ` (nomic-embed-text-*).
   * - `qwen`  — query-side instruction only; passages are embedded bare (Qwen3-Embedding).
   * - `none`  — no prefix. Correct for OpenAI `text-embedding-3-*`, bge-m3, and anything symmetric,
   *             where a prefix is just noise in the vector.
   * - `auto`  — **the default, and exactly what this instance did before the field existed**: `nomic`
   *             for the bundled local model, `none` for an HTTP endpoint. Chosen so that upgrading
   *             changes no vector. It is a compatibility default, not a good one — an operator running
   *             nomic behind Ollama should set `nomic` explicitly and re-index.
   *
   * Changing this changes every vector, so a corpus embedded under one scheme cannot be searched under
   * another. The admin UI treats it like `model`/`dimensions`/`similarity` and requires confirmation.
   */
  prefixScheme?: 'auto' | 'none' | 'nomic' | 'qwen';
  /** API key for an external embedding endpoint. Stored in `secrets.json` (never `config.json`), masked in
   *  the admin API. */
  apiKey?: string;
}
