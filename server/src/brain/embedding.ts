import { boundedJson, boundedErrorText } from '../util/bounded-read.js';
import { getEmbeddingConfig, getModelSlots } from '../config/loader.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { allowPrivateForSlot } from '../config/model-egress-policy.js';
import { embeddingsUrlFor } from '../files/converters/vlm-endpoint.js';
import { log } from '../util/log.js';
import { withJitter } from '../util/backoff.js';
import { embeddingDurationSeconds, embeddingQueueDepth, embeddingRetryTotal } from '../metrics/registry.js';
import { slotTimeoutMs } from '../config/model-slots.js';
import { runLocalInference, warmLocalInference } from './local-inference.js';

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
      const delay = withJitter(asked !== null && asked > 0 ? Math.min(asked, base * 4) : base);
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
 * Start the local inference process and load the model into it, without running an actual embed.
 * Returns once the model is loaded (immediately if it already is).
 * No-op when an external HTTP embedding endpoint is configured.
 */
export async function warmEmbeddingModel(): Promise<void> {
  const cfg = getEmbeddingConfig();
  if (cfg.baseUrl) return; // External endpoint — nothing local to warm
  await warmLocalInference({ modelId: cfg.model });
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
  try {
    if (cfg.baseUrl) {
      // External HTTP endpoint configured — delegate entirely
      // Retried here rather than inside `embedViaHttp` so the whole request — including building it — is what
      // gets re-attempted, and so the local path below is untouched: a local model queues you rather than
      // refusing you because it is busy.
      const end = embeddingDurationSeconds.startTimer();
      try {
        return await embedViaHttpWithRetry(() => embedViaHttp(input, cfg));
      } finally {
        end();
      }
    }

    // A vector over this much text averages away everything specific in it. The model truncates to its context
    // window (in the inference process, `brain/embed-process.ts`, which owns why that matters), so this is not the
    // truncation threshold: it is the point past which something upstream produced an unchunked body.
    if (input.length > MAX_LOCAL_EMBED_CHARS) {
      log.warn(`Embedding input is ${input.length} chars; the local model truncates to its context window. `
        + 'A vector over this much text averages away everything specific in it — chunk the source instead.');
    }

    // The model runs in another process (`brain/local-inference.ts`): this thread stays free while it works. The
    // string handed over is the PREPARED one, and it is stamped with the model the process says it used, never
    // `cfg.model` read above: config can change while a request is queued, and `embed-record.ts` treats the stamp
    // as its "unchanged" fingerprint. A query goes ahead of queued documents.
    const result = await runLocalInference({ input, lane: task === 'query' ? 'query' : 'document', modelId: cfg.model });
    // The process's own timing, so the histogram keeps meaning "one embedding": around the round trip it would
    // absorb the wait behind other requests (that wait is `ythril_embed_wait_seconds`).
    embeddingDurationSeconds.observe(result.inferenceMs / 1000);
    const vector = result.vector;

    if (vector.length !== cfg.dimensions) {
      log.warn(
        `Embedding dimensions mismatch: expected ${cfg.dimensions}, got ${vector.length}. ` +
        `Update embedding.dimensions in config.json.`,
      );
    }
    return { vector, model: result.modelId, dimensions: vector.length };
  } finally {
    embeddingQueueDepth.dec();
  }
}
