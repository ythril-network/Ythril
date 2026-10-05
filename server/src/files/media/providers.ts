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
import { boundedJson, boundedErrorText } from '../../util/bounded-read.js';
import { log, peerText } from '../../util/log.js';
import { ssrfSafeFetch } from '../../util/ssrf.js';
import { allowPrivateForSlot, type EgressSlot } from '../../config/model-egress-policy.js';
import { slotTimeoutMs, reasoningEffortBody } from '../../config/model-slots.js';
import { getModelSlots } from '../../config/loader.js';
import { extForMimeType, isInformativeMimeType, sniffImageMimeType } from '../mime.js';
import { chatUrlFor, transcriptionsUrlFor } from '../converters/vlm-endpoint.js';

/**
 * Per-call budgets, now RESOLVED per call rather than fixed at module load.
 *
 * They began as inline literals, which made them invisible to `hopBudgets()` — a hop longer than
 * `stalledJobTimeoutMs` reports no progress while it runs (nothing beats from inside a single `fetch`), so the
 * sweep re-queues the job mid-call and the replacement reaches the same call again. Naming them as constants
 * fixed that half. This is the other half: the operator could see the number in the source and still not
 * change it.
 *
 * Read through `slotTimeoutMs()` at the call site, never hoisted to a module constant — a resolved-once
 * constant would ignore a config reload, and `hopBudgets()` would then feed the stall floor a number the calls
 * no longer use. `STT` is the sharp one: at **exactly** the stall default, a five-minute transcription can be
 * re-queued in the same instant it would legitimately have finished, which is the indistinguishability
 * `STALL_FLOOR_FACTOR` exists to prevent. Pinned by `stall-floor-covers-every-hop.test.js` and
 * `a-model-slot-timeout-is-settable.test.js`.
 *
 * The local and external vision defaults differ (120 s vs 60 s) because a cold local model is slower than a
 * hosted API. An operator who sets `modelSlots.vision.timeoutMs` has overridden that reasoning deliberately,
 * so both legs take their configured value.
 */
const visionTimeout = () => slotTimeoutMs('vision', getModelSlots());
const sttTimeout = () => slotTimeoutMs('stt', getModelSlots());

/**
 * What ONE hop can actually cost — which is not the larger of the two legs when a fallback is configured.
 *
 * ## The hole this closes
 *
 * `FallbackVisionProvider` and `FallbackSttProvider` call the primary, catch, and then call the fallback —
 * **inside one hop, with nothing beating between them**. `hopBudgets()` reported the two legs as two separate
 * entries and `effectiveStallTimeoutMs` takes the MAXIMUM of what it is given, so the floor was computed from
 * one leg while a hop could cost both:
 *
 *     STT with fallbackToExternal on:  300 000 + 300 000  =  600 000 ms real
 *     floor from max(300 000) x 1.5                       =  450 000 ms
 *
 * 150 000 ms short. The sweep re-queues the job mid-call, the replacement reaches the same call, and it is
 * re-queued at the same point — the loop `stall-floor.ts` exists to prevent, reachable by turning on a
 * documented, pinnable option. Vision is the same shape and lands exactly ON the floor
 * (120 000 + 60 000 = 180 000 = 120 000 x 1.5), which is the indistinguishability `STALL_FLOOR_FACTOR` is
 * there to buy head-room against.
 *
 * ## Why it is a function and not four more entries
 *
 * The existing gate enumerates timeout CALL SITES and checks each budget is one the floor knows. Every leg
 * passed that check individually — the blind spot is not an unknown budget, it is **two known budgets in one
 * step**, which no list of names can express. `createMediaProviders` is the only thing that knows whether a
 * chain was built, so the rule has to take the same three inputs it does and stay next to it.
 */
export function providerHopMs(
  localMs: number,
  externalMs: number,
  providerType: 'local' | 'external',
  fallbackToExternal: boolean,
): number {
  // Mirrors `createMediaProviders` exactly: pointing a slot at `external` returns the external provider
  // ALONE, so `fallbackToExternal` builds no chain there and adding the legs would raise the floor for a
  // hop that cannot happen.
  if (providerType === 'external') return externalMs;
  return fallbackToExternal ? localMs + externalMs : localMs;
}

/**
 * Runtime egress guard. **External** (operator-supplied, public) provider endpoints go through
 * `ssrfSafeFetch` — DNS-resolve + IP-pin + redirect re-validation — closing the save-time-only URL check
 * against DNS-rebinding / redirect-to-internal. **Local** providers (bundled Ollama / Whisper on the trusted
 * internal network) keep a plain `fetch`: their addresses are private, which `ssrfSafeFetch` would (rightly)
 * reject. The provider CLASS already encodes which is which (Ollama/Whisper = local; External* = external).
 */
const egressFetch = (external: boolean, slot: EgressSlot): typeof fetch => {
  if (!external) return fetch;
  // An operator running a self-hosted OpenAI-compatible server on a cluster address needs the EXTERNAL
  // protocol at a PRIVATE address. Note what this relaxes and what it does not: ssrfSafeFetch still
  // resolves DNS, pins the resolved IP for the connection and re-validates redirects — only the
  // private-address rejection lifts, and crown-jewel ranges (loopback, link-local/IMDS) stay blocked
  // either way. This path therefore stays better guarded than a `local` provider, which uses plain fetch.
  //
  // Resolved per SLOT, not globally: vision on the cluster and STT at a vendor is a normal split, and the
  // global flag would have to be on for the first — relaxing the guard on the second, where a private
  // resolution is exactly the anomaly worth refusing.
  const allowPrivate = allowPrivateForSlot(slot);
  return ((url: string, init?: RequestInit) =>
    ssrfSafeFetch(url, init ?? {}, { allowPrivate })) as unknown as typeof fetch;
};

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
    const model = this.cfg.model ?? 'moondream';  // `moondream2` is not a valid Ollama registry name
    // Same builder as every other slot, on the Ollama wire. Nothing was wrong with this one — it is here
    // so the rule has no exceptions to remember: a slot names its wire, not its route.
    const url = chatUrlFor('ollama', base);
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
        signal: AbortSignal.timeout(visionTimeout()),
      });
    } catch (err) {
      throw new Error(`Ollama vision unreachable (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await boundedErrorText(res);
      throw new Error(`Ollama vision HTTP ${res.status}: ${body}`);
    }

    const json = await boundedJson<{ message?: { content?: string }; error?: string }>(res, 'Ollama vision', MAX_VISION_RESPONSE_BYTES);
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
    // Normalised: this appended `/chat/completions` bare, so vision was the one slot whose base HAD to
    // carry `/v1` — while the assist model and text embedding appended it themselves and so required the
    // opposite. One server, two base URLs, and a reporter configuring exactly that to keep both working.
    const url = chatUrlFor('openai', base);
    const b64 = imageBytes.toString('base64');
    // A data URI must carry a real media type. `data:application/octet-stream;base64,…` is what a
    // strict OpenAI-compatible server (llama.cpp's llama-server among them) rejects outright:
    //
    //     500 {"error":{"message":"Invalid uri format: data:application/octet-stream;base64", …}}
    //
    // The type is now correct upstream, but this path takes no chances: a job row queued by an older
    // build still carries the old value, and the bytes settle it either way.
    const resolved = isInformativeMimeType(mimeType)
      ? mimeType
      : sniffImageMimeType(imageBytes) ?? 'image/jpeg';
    const dataUrl = `data:${resolved};base64,${b64}`;

    let res: Response;
    try {
      // External endpoint → SSRF-guarded egress.
      res = await egressFetch(true, 'vision')(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          // Only when the operator set one for this slot. The OLLAMA body above deliberately does not get
          // this: its wire has no `reasoning_effort`, and a field a server does not know is either ignored
          // silently or rejected — neither of which is a control.
          ...reasoningEffortBody('vision', getModelSlots()),
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
        signal: AbortSignal.timeout(visionTimeout()),
      });
    } catch (err) {
      throw new Error(`External vision unreachable (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await boundedErrorText(res);
      throw new Error(`External vision HTTP ${res.status}: ${body}`);
    }

    const json = await boundedJson<{
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    }>(res, 'External vision', MAX_VISION_RESPONSE_BYTES);
    if (json.error) throw new Error(`External vision error: ${json.error.message}`);
    const caption = json.choices?.[0]?.message?.content?.trim();
    if (!caption) throw new Error('External vision returned empty caption');
    return caption;
  }
}

// ── Whisper (faster-whisper-server / OpenAI-compatible) ───────────────────

export class WhisperProvider implements SttProvider {
  constructor(private readonly cfg: MediaProviderConfig) {}

  /** Local (bundled Whisper) by default → plain fetch. `ExternalWhisperProvider` flips this so its egress
   *  is routed through `ssrfSafeFetch`. */
  protected readonly external: boolean = false;

  async transcribe(audioBytes: Buffer, mimeType: string): Promise<SttResult> {
    const base = (this.cfg.baseUrl ?? 'http://whisper.ythril.svc.cluster.local:8000').replace(/\/$/, '');
    const model = this.cfg.model ?? 'base';
    // Normalised, not concatenated. `${base}/v1/audio/transcriptions` is correct for a bare host and wrong
    // for the documented OpenAI base — `https://api.openai.com/v1` became `/v1/v1/audio/transcriptions`
    // and 404'd, while the list probe normalises and reported the endpoint fine. That is #562's
    // probe-disagrees-with-inference defect; the route now comes from the one module that spells it.
    const url = transcriptionsUrlFor(base);

    // Build multipart/form-data using FormData.
    //
    // The filename matters: OpenAI's transcription endpoint validates the extension against a
    // whitelist (flac/m4a/mp3/mp4/mpeg/mpga/oga/ogg/wav/webm) and rejects anything else. The old
    // `mimeType.split('/')[1]` was not an extension derivation — it produced `x-wav` for the
    // `audio/x-wav` several recorders emit, and `octet-stream` for anything that reached here
    // untyped. Both are rejected. The shared table folds aliases onto the canonical extension.
    const ext = extForMimeType(mimeType, 'wav');
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
      // Local Whisper → plain fetch (private address); external → SSRF-guarded egress.
      res = await egressFetch(this.external, 'stt')(url, {
        method: 'POST',
        headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(sttTimeout()),
      });
    } catch (err) {
      throw new Error(`Whisper unreachable (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await boundedErrorText(res);
      throw new Error(`Whisper HTTP ${res.status}: ${body}`);
    }

    const json = await boundedJson<{
      text?: string;
      segments?: { start?: number; end?: number; text?: string }[];
      error?: { message?: string };
    }>(res, 'Whisper', MAX_STT_RESPONSE_BYTES);
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

/** Delegates to the same WhisperProvider implementation — OpenAI Whisper API is compatible — but marks the
 *  egress external so it is routed through `ssrfSafeFetch`. */
export class ExternalWhisperProvider extends WhisperProvider {
  protected override readonly external = true;
}

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
      log.warn(`Vision primary failed, falling back to external: ${peerText(err)}`);
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
      log.warn(`STT primary failed, falling back to external: ${peerText(err)}`);
      return this.fallback.transcribe(audioBytes, mimeType);
    }
  }
}
