import path from 'node:path';
import { getDataRoot, getEmbeddingConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { embeddingDurationSeconds, embeddingQueueDepth } from '../metrics/registry.js';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

// Task prefixes required by nomic-embed-text-v1.5 for best retrieval quality
const TASK_PREFIX: Record<'document' | 'query', string> = {
  document: 'search_document: ',
  query:    'search_query: ',
};

// ── Local ONNX pipeline singleton ─────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LocalPipeline = (text: string, opts: Record<string, unknown>) => Promise<any>;

let _pipelineInit: Promise<LocalPipeline> | null = null;
let _pipelineModelId: string | null = null;

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
    log.info(`Loading embedding model ${modelId} (cache: ${cacheDir})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipe = await pipeline('feature-extraction', modelId) as any;
    log.info(`Embedding model ready: ${modelId}`);
    return pipe as LocalPipeline;
  })();
  return _pipelineInit;
}

// ── HTTP endpoint fallback ─────────────────────────────────────────────────
async function embedViaHttp(
  text: string,
  cfg: ReturnType<typeof getEmbeddingConfig>,
): Promise<EmbeddingResult> {
  const url = `${cfg.baseUrl!.replace(/\/$/, '')}/v1/embeddings`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, input: text }),
      signal: AbortSignal.timeout(30_000),
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
    const body = await response.text().catch(() => '');
    throw new Error(`Embedding request failed (HTTP ${response.status}): ${body}`);
  }
  const json = await response.json() as {
    data?: { embedding?: number[] }[];
    error?: { message?: string };
  };
  if (json.error) throw new Error(`Embedding API error: ${json.error.message ?? JSON.stringify(json.error)}`);
  const vector = json.data?.[0]?.embedding;
  if (!vector || vector.length === 0) throw new Error('Embedding API returned empty vector');
  if (vector.length !== cfg.dimensions) {
    log.warn(`Embedding dimensions mismatch: expected ${cfg.dimensions}, got ${vector.length}.`);
  }
  return { vector, model: cfg.model, dimensions: vector.length };
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
 * @param task  'document' (default) prepends "search_document:" for storage;
 *              'query' prepends "search_query:" for similarity searches.
 */
export async function embed(
  text: string,
  task: 'document' | 'query' = 'document',
): Promise<EmbeddingResult> {
  const cfg = getEmbeddingConfig();

  embeddingQueueDepth.inc();
  const end = embeddingDurationSeconds.startTimer();
  try {
    if (cfg.baseUrl) {
      // External HTTP endpoint configured — delegate entirely
      return await embedViaHttp(text, cfg);
    }

    const prefixed = TASK_PREFIX[task] + text;
    const pipe = await getLocalPipeline(cfg.model);
    const output = await pipe(prefixed, { pooling: 'mean', normalize: true });
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
