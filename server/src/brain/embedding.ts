import fs from 'node:fs';
import { boundedJson, boundedErrorText } from '../util/bounded-read.js';
import path from 'node:path';
import { getDataRoot, getEmbeddingConfig, getModelSlots } from '../config/loader.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { allowPrivateForSlot } from '../config/model-egress-policy.js';
import { embeddingsUrlFor } from '../files/converters/vlm-endpoint.js';
import { log } from '../util/log.js';
import { embeddingDurationSeconds, embeddingQueueDepth, embeddingRetryTotal } from '../metrics/registry.js';
import { slotTimeoutMs } from '../config/model-slots.js';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

export type EmbeddingTask = 'document' | 'query';
export type PrefixScheme = 'auto' | 'none' | 'nomic' | 'qwen';

/**
 * Task prefixes, per model family.
 *
 * An asymmetric retrieval model is trained with the query and the stored passage marked differently.
 * Embedding both sides bare does not fail — it just retrieves worse, which is why this went unnoticed on
 * the HTTP path for as long as it did.
 *
 * `qwen` is deliberately one-sided: Qwen3-Embedding takes an instruction on the QUERY only and embeds
 * passages bare. Applying the nomic shape to it would be worse than applying nothing.
 */
const TASK_PREFIX: Record<Exclude<PrefixScheme, 'auto'>, Record<EmbeddingTask, string>> = {
  none:  { document: '', query: '' },
  nomic: { document: 'search_document: ', query: 'search_query: ' },
  qwen:  { document: '', query: 'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ' },
};

/**
 * Resolve `auto` to the scheme this instance used BEFORE the setting existed.
 *
 * The bundled local model is nomic, and the local path always prefixed. The HTTP path never did — that
 * was the bug, but it is also the behaviour every existing external corpus was embedded under, so `auto`
 * must keep reproducing it or upgrading would silently invalidate those vectors. An operator running
 * nomic behind Ollama has to opt in to `nomic` and re-index; the UI warns exactly as it does for a model
 * change.
 */
export function resolvePrefixScheme(cfg: { baseUrl?: string; prefixScheme?: PrefixScheme }): Exclude<PrefixScheme, 'auto'> {
  const scheme = cfg.prefixScheme ?? 'auto';
  if (scheme !== 'auto') return scheme;
  return cfg.baseUrl ? 'none' : 'nomic';
}

/**
 * The exact string that gets embedded.
 *
 * **This is the single input-preparation site, on purpose.** It used to live inside the local branch of
 * `embed()`, so configuring an HTTP endpoint silently dropped the prefix and degraded every search. One
 * function, called once before the branch, is what makes that impossible to reintroduce.
 */
export function prepareInput(
  text: string,
  task: EmbeddingTask,
  cfg: { baseUrl?: string; prefixScheme?: PrefixScheme },
): string {
  return TASK_PREFIX[resolvePrefixScheme(cfg)][task] + text;
}

/**
 * Above this many characters, a local embed is worth one `warn` — it is past the point where a single vector
 * can be about anything specific, and it means something upstream produced an unchunked body.
 *
 * ~8,000 chars is roughly 2,000 tokens: comfortably inside the model's window (so this is not the truncation
 * threshold, which the tokeniser owns) and comfortably past the point where averaging destroys the signal.
 */
const MAX_LOCAL_EMBED_CHARS = 8_000;

// ── Local ONNX pipeline singleton ─────────────────────────────────────────
type LocalPipeline = (text: string, opts: Record<string, unknown>) => Promise<any>;

let _pipelineInit: Promise<LocalPipeline> | null = null;
let _pipelineModelId: string | null = null;

/**
 * Is this instance forbidden from fetching a model at runtime?
 *
 * Reads the ECOSYSTEM names first on purpose. An operator air-gapping a stack sets `HF_HUB_OFFLINE=1`,
 * and `docker-compose.yml` already sets exactly that on the `unstructured` sidecar — so an operator has
 * every reason to believe the convention is honoured stack-wide. It was not: transformers.js does not
 * read those variables at all (they belong to Python's `huggingface_hub`), so the Node process ignored
 * them completely. `YTHRIL_MODELS_OFFLINE` is the explicit spelling for anyone who would rather not
 * borrow another project's variable.
 */
function modelsOffline(): boolean {
  const truthy = (v: string | undefined): boolean =>
    v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'no';
  return truthy(process.env['HF_HUB_OFFLINE'])
    || truthy(process.env['TRANSFORMERS_OFFLINE'])
    || truthy(process.env['YTHRIL_MODELS_OFFLINE']);
}

/**
 * Is `modelId` already in the on-disk cache, so that loading it needs no network?
 *
 * transformers.js keys its `FileCache` as `<cacheDir>/<model-id>/<file>` — verified against the cache the
 * Dockerfile bakes, which contains `nomic-ai/nomic-embed-text-v1.5/{config.json,tokenizer.json,onnx/…}`.
 * `config.json` is the first file every load asks for, so its presence is the cheap, accurate test for
 * "this load will stay local". Deliberately synchronous and best-effort: this only decides whether to
 * WARN, never whether to load.
 */
function isCached(cacheDir: string, modelId: string): boolean {
  try {
    return fs.existsSync(path.join(cacheDir, ...modelId.split('/'), 'config.json'));
  } catch {
    return false;
  }
}

function getLocalPipeline(modelId: string): Promise<LocalPipeline> {
  // Re-init only if the configured model changes (rare: config reload)
  if (_pipelineInit && _pipelineModelId === modelId) return _pipelineInit;
  _pipelineModelId = modelId;
  _pipelineInit = (async (): Promise<LocalPipeline> => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // MODEL_CACHE_DIR: baked into Docker image at /app/model-cache (set in Dockerfile).
    // Falls back to DATA_ROOT/.model-cache for local development.
    const cacheDir = process.env['MODEL_CACHE_DIR'] ??
                     path.join(getDataRoot(), '.model-cache');
    env.cacheDir = cacheDir;

    // A cache MISS reaches out to huggingface.co, and nothing used to say so.
    //
    // `env.allowRemoteModels` defaults to `true` in @huggingface/transformers, so `pipeline(…)` on a model
    // that is not in `cacheDir` silently downloads it: the instance's IP and the model id it asked for,
    // to a third party, with no configuration, from a product whose README says "works fully offline".
    // The shipped image bakes exactly ONE model, `nomic-ai/nomic-embed-text-v1.5`, so every other id —
    // and any id at all on a from-source install with an empty cache — was that request.
    //
    // Two changes, and neither of them can break the default:
    //   1. the offline flag is honoured (see `modelsOffline`), and the published image sets it;
    //   2. when remote IS allowed and the model is absent, the egress is ANNOUNCED before it happens.
    //
    // Measured rather than assumed, because the ordering inside `getModelFile` decides whether this is
    // safe: the `FileCache` is consulted BEFORE any local-or-remote decision, so a populated `cacheDir`
    // satisfies a load with remote fetching disabled. Loading the baked model against a real populated
    // cache with `allowRemoteModels = false` succeeded; a different id under the same conditions failed.
    const offline = modelsOffline();
    const cached = isCached(cacheDir, modelId);
    if (offline) env.allowRemoteModels = false;
    else if (!cached) {
      log.warn(
        `Embedding model '${modelId}' is not in the local cache (${cacheDir}), so loading it will DOWNLOAD it `
        + 'from huggingface.co — roughly 274 MB, and that request carries this instance\'s IP address and the '
        + 'model id. Set HF_HUB_OFFLINE=1 (or YTHRIL_MODELS_OFFLINE=1) to forbid it, and bake the model into '
        + 'your image instead. The published Ythril image already ships with the flag set.',
      );
    }

    log.info(`Loading embedding model ${modelId} (cache: ${cacheDir}${offline ? ', offline' : ''})`);
    let pipe: unknown;
    try {
      pipe = await pipeline('feature-extraction', modelId);
    } catch (err) {
      // The library's own message on a blocked miss names `node_modules/@huggingface/transformers/models/`,
      // a path that has nothing to do with where Ythril keeps its models — so an operator would go looking
      // in the wrong place for a file that was never meant to be there. Say what actually happened.
      if (offline && !cached) {
        throw new Error(
          `Embedding model '${modelId}' is not in the model cache (${cacheDir}) and runtime downloads are `
          + 'disabled by HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / YTHRIL_MODELS_OFFLINE. Either bake the model '
          + 'into the image (see docs/integration-guide/02-hosting.md), point MODEL_CACHE_DIR at a cache that '
          + 'has it, or unset the flag to allow a one-time download from huggingface.co. '
          + `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }
    log.info(`Embedding model ready: ${modelId}`);
    return pipe as LocalPipeline;
  })();
  return _pipelineInit;
}

// ── HTTP endpoint fallback ─────────────────────────────────────────────────
/** `input` is already task-prefixed by `prepareInput` — do not prefix again here. */
/**
 * A refusal from the embedding endpoint, carrying enough to decide whether trying again is sensible.
 *
 * The message is unchanged from what it was — `Embedding request failed (HTTP 429): …` — because operators
 * have that string in their runbooks and their logs, and it is what a caller shows a requester.
 */
export class EmbeddingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** From `Retry-After`, when the server sent one and it was a number we can act on. */
    readonly retryAfterMs: number | null,
  ) {
    super(`Embedding request failed (HTTP ${status}): ${body}`);
    this.name = 'EmbeddingHttpError';
  }
}

/**
 * Statuses where trying again is the right move, and nothing else.
 *
 * A 400 or a 413 means the REQUEST is wrong and will be wrong every time — retrying it burns the caller's
 * deadline to arrive at the same answer more slowly. A 401 retried is a lockout waiting to happen.
 */
const RETRYABLE_EMBED_STATUS = new Set([429, 502, 503, 504]);

/**
 * Three attempts, and the delays are deliberately SMALL.
 *
 * This sits inside `recall`, which has a deadline the operator set and the caller may have lowered. A textbook
 * 1s/2s/4s backoff would turn one busy moment into a recall that misses its budget and degrades — trading a
 * clear failure for a slow partial answer, which is worse.
 *
 * The refusals that prompted this came back in under 3 milliseconds: the upstream was refusing instantly, not
 * queueing. Against that, a short pause is all it takes for a concurrent burst to clear, and the total added
 * latency in the worst case is under half a second.
 */
const EMBED_RETRY_DELAYS_MS = [120, 360] as const;

/** Half the delay as fixed floor, half as jitter — so N concurrent callers do not retry in lockstep. */
function jittered(baseMs: number): number {
  return Math.round(baseMs / 2 + Math.random() * (baseMs / 2));
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw.trim());
  // Only a plain number of seconds. The HTTP-date form is legal and we do not honour it: parsing a date
  // against our clock to decide a sub-second sleep is more ways to be wrong than it is worth.
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Ask the endpoint, retrying only a transient refusal.
 *
 * ## Why this exists
 *
 * An operator moved their embedder to a shared GPU endpoint. While a reindex saturated it, EVERY recall
 * failed — the 429 went straight to the caller with no retry, no jitter and no backoff, and the user's query
 * was simply gone. Their words: *"a single retry with a little jitter would absorb this entirely."*
 *
 * The file pipeline had all of this already: persisted jobs, backoff, a terminal `failed` state and a
 * `retry_embed_file` recovery path. Recall had none of it, on the same dependency.
 *
 * A `Retry-After` longer than our own budget is a refusal to wait, not an instruction to: we give up and let
 * the caller see the 429, rather than sleeping past a deadline somebody set.
 */
export async function embedViaHttpWithRetry(
  attempt: (n: number) => Promise<EmbeddingResult>,
): Promise<EmbeddingResult> {
  let lastErr: unknown;
  for (let i = 0; i <= EMBED_RETRY_DELAYS_MS.length; i++) {
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof EmbeddingHttpError && RETRYABLE_EMBED_STATUS.has(err.status);
      const delayLeft = i < EMBED_RETRY_DELAYS_MS.length;
      if (!retryable || !delayLeft) break;

      const base = EMBED_RETRY_DELAYS_MS[i]!;
      const asked = (err as EmbeddingHttpError).retryAfterMs;
      if (asked !== null && asked > base * 4) {
        // The server named a wait we are not willing to take inside a request. Surface the refusal.
        log.warn(`Embedding endpoint asked for ${asked}ms via Retry-After; longer than this request will wait.`);
        break;
      }
      const delay = jittered(asked !== null && asked > 0 ? Math.min(asked, base * 4) : base);
      embeddingRetryTotal.labels({ status: String((err as EmbeddingHttpError).status) }).inc();
      log.warn(`Embedding endpoint refused (HTTP ${(err as EmbeddingHttpError).status}); `
        + `retrying in ${delay}ms (attempt ${i + 2} of ${EMBED_RETRY_DELAYS_MS.length + 1}).`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function embedViaHttp(
  input: string,
  cfg: ReturnType<typeof getEmbeddingConfig>,
): Promise<EmbeddingResult> {
  // Normalised rather than concatenated: appending `/v1/embeddings` meant this slot required a base
  // WITHOUT `/v1` while vision required one WITH it, for the same server. The probe normalises, so the
  // Models card went green off `/v1/models` while every embed 404'd on `/v1/v1/embeddings` — and a failing
  // embedder does not announce itself, it shows up as recall that returns nothing.
  const url = embeddingsUrlFor(cfg.baseUrl!);
  // External endpoints go through the SSRF-guarded fetch (DNS-resolve + IP-pin + redirect re-validation);
  // a local/trusted endpoint (e.g. on-cluster Ollama, private address) uses a plain fetch, which the guard
  // would rightly reject. Mirrors the vision/STT provider split (SSRF follow-up part 2).
  // External → SSRF-guarded. `allowPrivateForSlot('embedding')` lets a self-hosted OpenAI-compatible
  // embedding server live on a cluster address without dropping the guard: DNS-pinning and redirect
  // re-validation still apply, only the private-address rejection lifts. Per-slot, so an operator whose
  // embedder is on-cluster but whose assist model is a public vendor does not have to relax both.
  const doFetch = cfg.provider === 'external'
    ? (((url: string, init?: RequestInit) =>
        ssrfSafeFetch(url, init ?? {}, { allowPrivate: allowPrivateForSlot('embedding') })) as unknown as typeof fetch)
    : fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input }),
      signal: AbortSignal.timeout(slotTimeoutMs('embedding', getModelSlots())),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Embedding endpoint unreachable (${cfg.baseUrl}): ${msg}`);
    throw new Error(
      `Could not reach embedding endpoint at ${cfg.baseUrl}. ` +
      `Make sure an embedding server (e.g. Ollama) is running and configured.`,
    );
  }
  if (!response.ok) {
    const body = await boundedErrorText(response);
    throw new EmbeddingHttpError(response.status, body, retryAfterMs(response));
  }
  const json = await boundedJson<{
    data?: { embedding?: number[] }[];
    error?: { message?: string };
  }>(response, 'embedding provider');
  if (json.error) throw new Error(`Embedding API error: ${json.error.message ?? JSON.stringify(json.error)}`);
  const vector = json.data?.[0]?.embedding;
  if (!vector || vector.length === 0) throw new Error('Embedding API returned empty vector');
  if (vector.length !== cfg.dimensions) {
    log.warn(`Embedding dimensions mismatch: expected ${cfg.dimensions}, got ${vector.length}.`);
  }
  return { vector, model: cfg.model, dimensions: vector.length };
}

/**
 * Pre-load the local ONNX embedding pipeline without running an actual embed.
 * Returns immediately if the model is already loaded.
 * No-op when an external HTTP embedding endpoint is configured.
 */
export async function warmEmbeddingModel(): Promise<void> {
  const cfg = getEmbeddingConfig();
  if (cfg.baseUrl) return; // External endpoint — nothing local to warm
  await getLocalPipeline(cfg.model);
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Generate an embedding vector for the given text.
 *
 * Uses the bundled local ONNX model (nomic-embed-text-v1.5) by default —
 * works out-of-the-box with no external services required.
 *
 * Set `embedding.baseUrl` in config.json to route through an OpenAI-compatible
 * HTTP endpoint instead (e.g. Ollama, OpenAI, etc.).
 *
 * @param task  'document' (default) marks the text as a stored passage; 'query' marks it as a search
 *              query. How that mark is applied depends on `embedding.prefixScheme` — see `prepareInput`.
 *              The prefix is applied ONCE here, before the local/HTTP branch, so both paths embed the
 *              same string. It used to be applied inside the local branch only.
 */
export async function embed(
  text: string,
  task: EmbeddingTask = 'document',
): Promise<EmbeddingResult> {
  const cfg = getEmbeddingConfig();
  const input = prepareInput(text, task, cfg);

  embeddingQueueDepth.inc();
  const end = embeddingDurationSeconds.startTimer();
  try {
    if (cfg.baseUrl) {
      // External HTTP endpoint configured — delegate entirely
      // Retried here rather than inside `embedViaHttp` so the whole request — including building it — is what
      // gets re-attempted, and so the local-pipeline path below is untouched: an in-process model does not
      // refuse you because it is busy.
      return await embedViaHttpWithRetry(() => embedViaHttp(input, cfg));
    }

    const pipe = await getLocalPipeline(cfg.model);
    // `truncation: true` is not a nicety — without it a long input cost GIGABYTES and produced a worse vector.
    //
    // Self-attention is quadratic in sequence length. A customer's 57 KB Markdown file chunked to two ~28 KB
    // chunks (the chunker had a minimum section size and no maximum, fixed in `section-chunker.ts`), which is
    // ~7,000 tokens: ~196 MiB of attention scores per head in fp32, ~2.35 GiB for one layer's twelve. Their pod
    // went 3.98 → 9.996 GiB inside a single 15-second scrape window, was OOMKilled at a 16 GiB limit, and then
    // sat at 15.40 GiB at idle because the ONNX arena allocator never returns its high-water mark. Reducing
    // embed concurrency had made it worse, because the peak is set by one chunk's size.
    //
    // It was also silently WRONG beyond the model's position count, so this is a correctness fix as much as a
    // fact one — and the chunker's cap does not make it redundant: this is the path every caller shares,
    // including `saveFact` with a large fact and a query nobody bounded.
    if (input.length > MAX_LOCAL_EMBED_CHARS) {
      log.warn(`Embedding input is ${input.length} chars; the local model truncates to its context window. `
        + 'A vector over this much text averages away everything specific in it — chunk the source instead.');
    }
    const output = await pipe(input, { pooling: 'mean', normalize: true, truncation: true });
    const vector = Array.from(output.data as Float32Array) as number[];

    if (vector.length !== cfg.dimensions) {
      log.warn(
        `Embedding dimensions mismatch: expected ${cfg.dimensions}, got ${vector.length}. ` +
        `Update embedding.dimensions in config.json.`,
      );
    }
    return { vector, model: cfg.model, dimensions: vector.length };
  } finally {
    end();
    embeddingQueueDepth.dec();
  }
}
