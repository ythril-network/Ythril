/**
 * Where the document VLM actually lives, and how to talk to it — resolved in ONE place.
 *
 * ## The bug this exists to make impossible
 *
 * The document-VLM endpoint was resolved twice, by two files that disagreed:
 *
 *   - `vlm-client.postChat()` hardcoded Ollama's `/api/chat` and used a bare `fetch`.
 *   - `pipeline-status.modelStages()` hardcoded `external: false` for `doc-vlm`, `doc-repair` and
 *     `doc-verify` — on a `baseUrl` that falls back to **the vision endpoint**, which the line directly
 *     above classifies with `visionProvider === 'external'`. Same URL, opposite verdicts.
 *
 * Both encoded the same stale assumption: *the document stages are local*. That was true while the VLM
 * was the bundled Ollama and `vlmBaseUrl` defaulted to it. `visionProvider: external` broke it and
 * neither site was revisited, which produced two failures at once:
 *
 *   1. **`vlmModel` could not work against any OpenAI-compatible server.** `/api/chat` is Ollama's route;
 *      llama.cpp, llama-swap, vLLM and LocalAI do not serve it, and no `baseUrl` fixes that — dropping
 *      `/v1` just yields `/api/chat`. doc-render rasterised pages that were then discarded.
 *   2. **Unguarded, unacknowledged egress.** Page images went out over a bare `fetch`: no SSRF guard, and
 *      none of the egress acknowledgement `repairMarkdownExternal` demands for the same class of
 *      destination. It failed safe only against OpenAI-compatible targets, which 404 `/api/chat`. A
 *      **remote Ollama** — a common setup — answers 200, so for those deployments page images were
 *      leaving silently while the pipeline reported success.
 *
 * A reporter found both. The integration guide already promised otherwise: its list of SSRF-guarded model
 * endpoints omits the document VLM, and it states that no document content leaves the instance by
 * default. The code was wrong, not the doc.
 *
 * ## The rule
 *
 * `external` is a property of **the endpoint**, not of the caller. It is resolved here, once, and both
 * the inference path and the status board read it from this function. A second opinion about the same
 * URL is the bug.
 */

import { getMediaEmbeddingConfig, getDocumentProcessingConfig } from '../../config/loader.js';

/** Which wire protocol an endpoint speaks. Selected by provider type, never guessed from the URL. */
export type VlmWire = 'ollama' | 'openai';

export interface VlmEndpoint {
  /** Empty when nothing is configured — callers must treat the VLM as unavailable. */
  baseUrl: string;
  model: string;
  wire: VlmWire;
  /**
   * True when this endpoint is NOT the bundled local model, and egress therefore has to be guarded.
   *
   * Derived from the provider the URL actually belongs to, not from whether the address looks private.
   * A private address is not evidence of being in-instance: the reporter's endpoint is a cluster-internal
   * hostname and is emphatically a separate service.
   */
  external: boolean;
  apiKey?: string;
}

/**
 * Ensure exactly one `/v1` on an OpenAI-compatible base.
 *
 * The convention is that the base *includes* it — `https://api.openai.com/v1`, and
 * `ExternalVisionProvider` appends only `/chat/completions`. But `repairMarkdownExternal` appended
 * `/v1/chat/completions`, so the same server needed two different base URLs to satisfy both callers, and
 * a reporter had to configure exactly that to keep vision and assist working simultaneously.
 *
 * Normalising means one URL works everywhere: `…:8080` and `…:8080/v1` both resolve to `…:8080/v1`.
 */
export function normalizeOpenAiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * ## Every OpenAI route is spelled HERE, once
 *
 * The four builders below are the only places an OpenAI-compatible route path appears in the server, and
 * a test enumerates the route literals to keep it that way. That is not tidiness — five slots had been
 * deriving their URLs independently and had arrived at three incompatible rules for the same server:
 *
 *   - vision appended `/chat/completions`, so its base HAD to carry `/v1`;
 *   - the assist model appended `/v1/chat/completions` and text embedding appended `/v1/embeddings`, so
 *     theirs had to NOT carry it;
 *   - the probe normalised, so it agreed with whichever half happened to match.
 *
 * An operator running one server for several slots therefore had no spelling that satisfied them all —
 * exactly the configuration a reporter had to invent, with two base URLs for one host. Worse, the probe's
 * agreement is what makes it dangerous rather than merely annoying: the dot goes green off a normalised
 * `/v1/models` while inference 404s on `/v1/v1/embeddings`, and the failure surfaces as recall that
 * silently returns nothing.
 */

/** The path a chat completion is POSTed to, for each wire. */
export function chatUrlFor(wire: VlmWire, baseUrl: string): string {
  return wire === 'ollama'
    ? `${baseUrl.replace(/\/+$/, '')}/api/chat`
    : `${normalizeOpenAiBase(baseUrl)}/chat/completions`;
}

/** The model-list URL for each wire — the same derivation the inference call uses, so a probe cannot
 *  disagree with the thing it is probing. */
export function listUrlFor(wire: VlmWire, baseUrl: string): string {
  return wire === 'ollama'
    ? `${baseUrl.replace(/\/+$/, '')}/api/tags`
    : `${normalizeOpenAiBase(baseUrl)}/models`;
}

/**
 * Where a System One evaluation is POSTed (`F-31`, the extractors' decision slot). Not an OpenAI route, but the
 * same `/v1` rule — TypeSafe documents `https://api.typesafe.ai/v1/systemone` — and spelled here so that an
 * operator typing the base with or without `/v1` lands on the one URL, like every other slot.
 */
export function systemOneUrlFor(baseUrl: string): string {
  return `${normalizeOpenAiBase(baseUrl)}/systemone`;
}

/** Where text embeddings are POSTed. OpenAI-compatible only — the bundled model is in-process. */
export function embeddingsUrlFor(baseUrl: string): string {
  return `${normalizeOpenAiBase(baseUrl)}/embeddings`;
}

/** Where audio is POSTed for transcription. Whisper webservices and the OpenAI API share this route. */
export function transcriptionsUrlFor(baseUrl: string): string {
  return `${normalizeOpenAiBase(baseUrl)}/audio/transcriptions`;
}

/**
 * Resolve one document-model slot.
 *
 * All three slots (`vlm`, `repair`, `verify`) fall back to the vision endpoint exactly as the pipeline
 * does, so the resolved endpoint is the one that would really be called — and crucially they inherit the
 * vision endpoint's **provider type** along with its URL. Inheriting the URL while asserting `external:
 * false` is precisely the defect this replaces.
 */
export function resolveVlmEndpoint(slot: 'vlm' | 'repair' | 'verify'): VlmEndpoint {
  const media = getMediaEmbeddingConfig();
  const doc = getDocumentProcessingConfig();

  const ownBase =
    slot === 'vlm' ? doc.vlmBaseUrl
      : slot === 'repair' ? (doc.repairBaseUrl || doc.vlmBaseUrl)
        : (doc.verifyBaseUrl || doc.vlmBaseUrl);

  const model =
    slot === 'vlm' ? (doc.vlmModel ?? '')
      : slot === 'repair' ? (doc.repairModel || doc.vlmModel || '')
        : (doc.verifyModel ?? '');

  // No dedicated URL ⇒ this slot IS the vision endpoint, provider type included.
  if (!ownBase) {
    const visionExternal = media.visionProvider === 'external';
    return {
      baseUrl: media.vision?.baseUrl ?? '',
      model,
      wire: visionExternal ? 'openai' : 'ollama',
      external: visionExternal,
      apiKey: media.vision?.apiKey,
    };
  }

  // A dedicated URL was set. It is a separate service by definition — the bundled model is reached
  // through the vision config, never through an override — so it is external and speaks OpenAI unless
  // the operator pointed it at an Ollama.
  //
  // `DOC_VLM_WIRE` exists because the URL cannot tell us: `http://host:11434` might be Ollama and might
  // be an OpenAI-compatible server on an arbitrary port. Defaulting to `openai` matches what
  // self-hosted inference servers overwhelmingly speak; an operator running a separate Ollama sets it.
  const wire: VlmWire = (process.env['DOC_VLM_WIRE'] === 'ollama') ? 'ollama' : 'openai';
  return { baseUrl: ownBase, model, wire, external: true, apiKey: media.vision?.apiKey };
}

/** True when this slot has both an endpoint and a model, i.e. it can actually run. */
export function vlmSlotUsable(e: VlmEndpoint): boolean {
  return e.baseUrl.length > 0 && e.model.length > 0;
}
