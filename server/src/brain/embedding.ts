import { getEmbeddingConfig } from '../config/loader.js';
import { log } from '../util/log.js';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

/**
 * Embed a single text string using the configured OpenAI-compatible endpoint.
 * Throws on network/HTTP errors so callers can surface them to the MCP client.
 */
export async function embed(text: string): Promise<EmbeddingResult> {
  const cfg = getEmbeddingConfig();

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/embeddings`;

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

  const json = (await response.json()) as {
    data?: { embedding?: number[] }[];
    error?: { message?: string };
  };

  if (json.error) {
    throw new Error(`Embedding API error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  const vector = json.data?.[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error('Embedding API returned empty vector');
  }
  if (vector.length !== cfg.dimensions) {
    log.warn(
      `Embedding dimensions mismatch: expected ${cfg.dimensions}, got ${vector.length}. ` +
        `Update embedding.dimensions in config.json.`,
    );
  }

  return { vector, model: cfg.model, dimensions: vector.length };
}
