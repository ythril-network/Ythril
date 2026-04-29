/**
 * Media embedding provider clients.
 *
 * Two provider families:
 *  - Vision (image captioning): Ollama-compatible `/api/chat` with base64 image payload,
 *    or any external OpenAI-compatible vision API.
 *  - STT (speech-to-text): faster-whisper-server `/v1/audio/transcriptions`
 *    (OpenAI-compatible), or the OpenAI Whisper API.
 *
 * All concrete providers implement the narrow `VisionProvider` / `SttProvider`
 * interfaces.  Callers use `MediaProviderFactory` and never import provider
 * classes directly.
 */

import type { MediaProviderConfig } from '../../config/types.js';
import { log } from '../../util/log.js';

// ── Bounded JSON response reader ──────────────────────────────────────────────────────
//
// fetch().json() reads the entire body without limit → a hostile or runaway
// upstream could exhaust heap. We cap by streaming the body and aborting once
// `maxBytes` is exceeded.
//
// Defaults are generous (100 MiB STT response, 50 MiB caption response) but
// finite — enough headroom for legitimate Whisper verbose_json responses on
// hour-long recordings, far below an OOM threshold.
async function boundedJson<T>(res: Response, maxBytes: number, label: string): Promise<T> {
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error(`${label} response too large: ${declared} bytes (max ${maxBytes})`);
  }
  if (!res.body) {
    // Some runtimes buffer bodies; fall back to text() with a post-hoc size check.
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`${label} response exceeded ${maxBytes} bytes`);
    }
    return JSON.parse(text) as T;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`${label} response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return JSON.parse(merged.toString('utf8')) as T;
}

const MAX_VISION_RESPONSE_BYTES = 50 * 1024 * 1024;  // 50 MiB — caption JSON is small
const MAX_STT_RESPONSE_BYTES    = 100 * 1024 * 1024; // 100 MiB — verbose_json with many segments

// ── Shared types ──────────────────────────────────────────────────────────

export interface SttSegment {
  start: number;  // seconds
  end: number;    // seconds
  text: string;
}

export interface SttResult {
  text: string;
  segments: SttSegment[];
}

// ── Provider interfaces ───────────────────────────────────────────────────

export interface VisionProvider {
  /** Generate a descriptive text caption for the given image bytes. */
  caption(imageBytes: Buffer, mimeType: string): Promise<string>;
}

export interface SttProvider {
  /**
   * Transcribe audio bytes to text.
   * Returns the full transcript and (if available) per-segment timing.
   */
  transcribe(audioBytes: Buffer, mimeType: string): Promise<SttResult>;
}

// ── Ollama vision ─────────────────────────────────────────────────────────

export class OllamaVisionProvider implements VisionProvider {
  constructor(private readonly cfg: MediaProviderConfig) {}

  async caption(imageBytes: Buffer, _mimeType: string): Promise<string> {
    const base = (this.cfg.baseUrl ?? 'http://ollama.ythril.svc.cluster.local:11434').replace(/\/$/, '');
    const model = this.cfg.model ?? 'moondream2';
    const url = `${base}/api/chat`;
    const b64 = imageBytes.toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            {
              role: 'user',
              content: 'Describe this image in detail. Focus on what is visually present.',
              images: [b64],
            },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new Error(`Ollama vision unreachable (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama vision HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await boundedJson<{ message?: { content?: string }; error?: string }>(
      res, MAX_VISION_RESPONSE_BYTES, 'Ollama vision',
    );
    if (json.error) throw new Error(`Ollama vision error: ${json.error}`);
    const caption = json.message?.content?.trim();
    if (!caption) throw new Error('Ollama vision returned empty caption');
    return caption;
  }
}

// ── External (OpenAI-compatible) vision ───────────────────────────────────

export class ExternalVisionProvider implements VisionProvider {
  constructor(private readonly cfg: MediaProviderConfig) {}

  async caption(imageBytes: Buffer, mimeType: string): Promise<string> {
    const base = (this.cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = this.cfg.model ?? 'gpt-4o-mini';
    const url = `${base}/chat/completions`;
    const b64 = imageBytes.toString('base64');
    const dataUrl = `data:${mimeType};base64,${b64}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this image in detail. Focus on what is visually present.' },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new Error(`External vision unreachable (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`External vision HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await boundedJson<{
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    }>(res, MAX_VISION_RESPONSE_BYTES, 'External vision');
    if (json.error) throw new Error(`External vision error: ${json.error.message}`);
    const caption = json.choices?.[0]?.message?.content?.trim();
    if (!caption) throw new Error('External vision returned empty caption');
    return caption;
  }
}

// ── Whisper (faster-whisper-server / OpenAI-compatible) ───────────────────

export class WhisperProvider implements SttProvider {
  constructor(private readonly cfg: MediaProviderConfig) {}

  async transcribe(audioBytes: Buffer, mimeType: string): Promise<SttResult> {
    const base = (this.cfg.baseUrl ?? 'http://whisper.ythril.svc.cluster.local:8000').replace(/\/$/, '');
    const model = this.cfg.model ?? 'base';
    const url = `${base}/v1/audio/transcriptions`;

    // Build multipart/form-data using FormData
    const ext = mimeType.split('/')[1]?.split(';')[0]?.trim() ?? 'wav';
    // Slice to a standalone ArrayBuffer so Blob ctor receives ArrayBuffer (not SharedArrayBuffer)
    const cleanBuffer = audioBytes.buffer.slice(
      audioBytes.byteOffset,
      audioBytes.byteOffset + audioBytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([cleanBuffer], { type: mimeType });
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', model);
    form.append('response_format', 'verbose_json');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(300_000), // 5 min — long audio
      });
    } catch (err) {
      throw new Error(`Whisper unreachable (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Whisper HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await boundedJson<{
      text?: string;
      segments?: { start?: number; end?: number; text?: string }[];
      error?: { message?: string };
    }>(res, MAX_STT_RESPONSE_BYTES, 'Whisper');
    if (json.error) throw new Error(`Whisper error: ${json.error.message}`);

    const text = json.text?.trim() ?? '';
    const segments: SttSegment[] = (json.segments ?? []).map(s => ({
      start: s.start ?? 0,
      end: s.end ?? 0,
      text: (s.text ?? '').trim(),
    })).filter(s => s.text.length > 0);

    return { text, segments };
  }
}

// ── External Whisper API ──────────────────────────────────────────────────

/** Delegates to the same WhisperProvider implementation — OpenAI Whisper API is compatible. */
export class ExternalWhisperProvider extends WhisperProvider {}

// ── Factory ───────────────────────────────────────────────────────────────

export interface MediaProviderBundle {
  vision: VisionProvider;
  stt: SttProvider;
}

/**
 * Build the active vision + STT provider pair from config.
 * When `fallbackToExternal` is true the returned providers automatically
 * retry with the external provider on non-200 / unreachable errors.
 */
export function createMediaProviders(
  visionCfg: MediaProviderConfig,
  sttCfg: MediaProviderConfig,
  visionProviderType: 'local' | 'external',
  sttProviderType: 'local' | 'external',
  fallbackToExternal: boolean,
): MediaProviderBundle {
  const localVision = new OllamaVisionProvider(visionCfg);
  const externalVision = new ExternalVisionProvider(visionCfg);
  const localStt = new WhisperProvider(sttCfg);
  const externalStt = new ExternalWhisperProvider(sttCfg);

  const vision: VisionProvider = (visionProviderType === 'external')
    ? externalVision
    : (fallbackToExternal
        ? new FallbackVisionProvider(localVision, externalVision)
        : localVision);

  const stt: SttProvider = (sttProviderType === 'external')
    ? externalStt
    : (fallbackToExternal
        ? new FallbackSttProvider(localStt, externalStt)
        : localStt);

  return { vision, stt };
}

// ── Fallback wrappers ────────────────────────────────────────────────────

class FallbackVisionProvider implements VisionProvider {
  constructor(
    private readonly primary: VisionProvider,
    private readonly fallback: VisionProvider,
  ) {}

  async caption(imageBytes: Buffer, mimeType: string): Promise<string> {
    try {
      return await this.primary.caption(imageBytes, mimeType);
    } catch (err) {
      log.warn(`Vision primary failed, falling back to external: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback.caption(imageBytes, mimeType);
    }
  }
}

class FallbackSttProvider implements SttProvider {
  constructor(
    private readonly primary: SttProvider,
    private readonly fallback: SttProvider,
  ) {}

  async transcribe(audioBytes: Buffer, mimeType: string): Promise<SttResult> {
    try {
      return await this.primary.transcribe(audioBytes, mimeType);
    } catch (err) {
      log.warn(`STT primary failed, falling back to external: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback.transcribe(audioBytes, mimeType);
    }
  }
}
