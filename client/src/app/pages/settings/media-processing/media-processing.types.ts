/**
 * Shared types for Settings → Models & Pipelines.
 *
 * Lifted out of the single 656-line `mediaProcessing.component.ts` so the three tabs and the provider card can
 * agree on one shape. They previously existed once, inside the component that also rendered them —
 * which is why four provider cards written in that one file each ended up with their own field order.
 */

export interface ProviderCfg { label?: string; baseUrl?: string; model?: string; apiKey?: string; }

/** Result of probing a model endpoint (reachability + whether the model is present). F11-PR5b. */
export interface TestResult {
  ok: boolean; reachable: boolean; status?: number; models?: string[];
  /**
   * What the probe ESTABLISHED — the field to render from. `reachable` cannot separate "answered with a
   * 404 on the list path" from "did not answer", and treating those alike is what showed a working
   * speech-to-text endpoint as unreachable. Optional only because an older server may not send it.
   */
  verdict?: 'listed' | 'not-enumerable' | 'auth-rejected' | 'erroring' | 'unreachable';
  /** Whether the endpoint LISTED the model — not whether it serves it. See `classifyStage` on the server. */
  modelEnumerated?: boolean; detail?: string; latencyMs: number;
}

/** Targets that can be verified with a real request. Fewer than `TestTarget`: each needs a payload. */
export type VerifyTarget = 'vision' | 'stt' | 'embedding' | 'assist' | 'assist-fallback';

/**
 * The result of one real request against a configured model.
 *
 * `still-loading` is a first-class outcome, not a failure. A cold model load on a swapping backend was
 * measured at ~35s in the field; reporting that as broken is the false negative Verify exists to remove.
 */
export interface VerifyResult {
  target: string;
  outcome: 'ok' | 'failed' | 'still-loading' | 'unconfigured';
  latencyMs: number;
  /** What the model actually said, truncated — evidence it really answered. */
  sample?: string;
  detail?: string;
}

export type TestTarget = 'vision' | 'stt' | 'assist' | 'assist-fallback' | 'embedding' | 'rerank' | 'nli';

/** Text-embedding config (top-level `config.embedding`, surfaced on this page). Changing
 *  model/dimensions/similarity/prefixScheme re-indexes every vector — the save gates those behind a
 *  confirmation. */
export interface EmbeddingCfg {
  provider?: 'local' | 'external';
  baseUrl?: string | null; model?: string; dimensions?: number;
  similarity?: 'cosine' | 'dotProduct' | 'euclidean';
  /** Task-prefix convention the model expects. `auto` = what the instance did before the setting
   *  existed (nomic prefixes locally, none over HTTP) — a compatibility default, not a good one. */
  prefixScheme?: 'auto' | 'none' | 'nomic' | 'qwen';
  apiKey?: string;
}

/** Reranker — a cross-encoder that re-scores retrieval candidates. Configured (endpoint + model) = on;
 *  there is no master toggle, matching the server. */
export interface RerankCfg {
  baseUrl?: string | null; model?: string | null; apiKey?: string;
  /** Candidates fetched per requested result before reranking, as a multiple of topK. 2..10. */
  candidateMultiplier?: number;
}

/** NLI — the contradiction judge. Same shape and same "configured = on" rule as the reranker: there is
 *  no master toggle, so clearing the endpoint is how it is switched off. */
export interface NliCfg {
  baseUrl?: string | null; model?: string | null; apiKey?: string;
}

export type DocMode = 'off' | 'ocr' | 'vlm' | 'repair' | 'auto';

/** F11-b — external "assist model": a bigger, hosted LLM (own endpoint). Each USE is consented on its own
 *  (`F-35`): `acknowledgedHost` for documents (the repair pass), `acknowledgedHostForConversations` for
 *  ingest. Both must match the endpoint's host, so changing the endpoint withdraws both. */
export interface DocAssistCfg {
  baseUrl?: string; model?: string; apiKey?: string; acknowledgedHost?: string;
  acknowledgedHostForConversations?: string | null;
  /** `F-33.1`: the API the endpoint speaks — OpenAI-compatible (the default) or the Claude API, with an API key. */
  api?: AssistApi;
  /** `F-33`: `tokens` over a rolling `perHours`; spent, calls go to the fallback. */
  budget?: AssistBudgetCfg | null;
  /** `F-33`: the endpoint that answers when the primary may not — usually a local LLM. */
  fallback?: AssistFallbackCfg | null;
}

export type AssistApi = 'openai' | 'anthropic';
export interface AssistBudgetCfg { tokens: number; perHours: number }
export interface AssistFallbackCfg {
  api?: AssistApi; baseUrl?: string; model?: string; apiKey?: string;
  acknowledgedHost?: string; acknowledgedHostForConversations?: string;
}

/**
 * `F-31` — the extractors' decision model, as the Models tab edits it. The server's GET also carries `locked`
 * and `inUse`; those are facts about the stored config and are read into the state service's flags, never
 * kept here, because this block is what gets sent back and the PATCH is `.strict()`.
 */
export interface DecisionModelCfg {
  baseUrl?: string; model?: string; acknowledgedHost?: string; apiKey?: string;
}

export interface DocProcCfg {
  mode?: DocMode;
  renderDpi?: number; maxPages?: number; pageTimeoutMs?: number; concurrency?: number; ocrTimeoutMs?: number;
  // read-only (env/config-file only — never PATCHed from here)
  vlmModel?: string; vlmBaseUrl?: string; repairModel?: string; repairBaseUrl?: string;
  verifyModel?: string; verifyBaseUrl?: string;
  assistModel?: DocAssistCfg;
}

/**
 * Instance CEILINGS per media class (#356) — the most a space is allowed to do, not a default it
 * inherits. Returned by GET and rendered read-only: `PATCH /api/admin/media-config` has no schema for
 * them, so they are config/env-owned today. Making them editable is deliberately its own change —
 * lowering a ceiling silently caps every space above it, and `off` takes a class offline everywhere.
 */
export interface MediaLevelCeilings {
  images?: string; audio?: string; video?: string; text?: string;
}

/** The four classes that have their own ladder. Documents has its own control (`documentProcessing.mode`). */
export type MediaClass = 'images' | 'audio' | 'video' | 'text';

/**
 * The ladders, low → high, mirroring `server/src/config/types.ts`.
 *
 * `auto` is listed FIRST in each because it is the default and means "as much as is possible" — it
 * does not rank, so putting it at the top of a list ordered by capability would be a lie about where
 * it sits. The server validates against its own copy; these only drive the pickers.
 */
export const IMAGE_LEVELS = ['auto', 'off', 'caption', 'recognition'] as const;
export const AUDIO_LEVELS = ['auto', 'off', 'on'] as const;
export const VIDEO_LEVELS = ['auto', 'off', 'audio', 'full'] as const;
export const TEXT_LEVELS = ['auto', 'off', 'embed', 'chunk'] as const;

/**
 * Face recognition (#345 env half, operator control added later).
 *
 * `modelPath` and `reprocessSyncedImages` are deliberately absent: both are infra-shaped and stay
 * env/config-only, so the admin API cannot set them and this block does not carry them.
 */
export interface FaceRecognitionCfg {
  enabled?: boolean;
  confidenceThreshold?: number;
  minFaceSizeFraction?: number;
  personEntityTypes?: string[];
  /** Optional external provider. Configuring one egresses BIOMETRIC data — see `acknowledgedHost`. */
  externalModel?: FaceExternalCfg;
}

export interface FaceExternalCfg {
  baseUrl?: string;
  model?: string;
  /** Masked by the server on read; only a newly typed key is ever sent back. */
  apiKey?: string;
  /** Host the operator consented to. Must match `baseUrl`'s host or the endpoint stays unused. */
  acknowledgedHost?: string;
}

/**
 * The values a slot's tuning may take, mirrored from the server's `REASONING_EFFORTS`.
 *
 * A copy, and it has to be: the client does not import from `server/`. `a-slot-can-ask-for-less-thinking`
 * asserts the two lists agree, because a control offering a value the server rejects is worse than no control
 * — the operator picks it, the save succeeds, and every call to that slot fails afterwards.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** One slot's tuning. Both fields optional: absent means the built-in default, and for the effort, send nothing. */
export interface SlotTuningCfg {
  timeoutMs?: number | null;
  reasoningEffort?: ReasoningEffort | null;
}

/**
 * Which slots a card may tune, and whether the effort is one of them.
 *
 * **Effort is offered only where the request actually carries it.** The server sends `reasoning_effort` on the
 * OpenAI-shaped bodies — external vision, the assist model and the three document slots — and nowhere else.
 * Embedding, rerank, NLI, speech and the face detector are not chat calls, so a control there would be a
 * switch wired to nothing, which is the failure this product keeps writing rules about.
 *
 * **Every slot the server declares has a row here, and a gate holds it to that.** The three document slots
 * had none: reported by the canary operator 2026-09-06 §6(c), and `05b-media-embedding.md` states there is
 * deliberately no environment variable for these, so this screen is the only door there is. Their model and
 * endpoint stay read-only — those genuinely are env-only — but a budget and an effort are not, and the two
 * questions were being answered by one `[infra]` flag.
 */
export const CARD_SLOT: Record<string, { slot: string; effort: boolean }> = {
  embedding: { slot: 'embedding', effort: false },
  rerank: { slot: 'rerank', effort: false },
  nli: { slot: 'nli', effort: false },
  vision: { slot: 'vision', effort: true },
  stt: { slot: 'stt', effort: false },
  assist: { slot: 'assist', effort: true },
  face: { slot: 'faceExternal', effort: false },
  'doc-vlm': { slot: 'docVlm', effort: true },
  'doc-repair': { slot: 'docRepair', effort: true },
  'doc-verify': { slot: 'docVerify', effort: true },
  // No reasoning effort: a System One endpoint takes no such field, and the assist fallback has its own card.
  decision: { slot: 'decision', effort: false },
};

/**
 * Each slot's built-in budget, shown as the placeholder so an empty box reads as "the default" rather than
 * "no limit". Mirrored from the server's `MODEL_SLOT_DEFAULT_MS`, and asserted equal by a gate — a placeholder
 * that lies about the default is worse than none, because it is the number an operator reasons from.
 */
export const SLOT_DEFAULT_MS: Record<string, number> = {
  vision: 120_000, stt: 300_000, embedding: 30_000, rerank: 20_000, nli: 20_000,
  assist: 60_000, docVlm: 60_000, docRepair: 60_000, docVerify: 60_000, faceExternal: 30_000,
  decision: 60_000,
};

export interface MediaCfg {
  // No master `enabled` switch — media embedding is always on; each class is gated by `levels`.
  levels?: MediaLevelCeilings;
  faceRecognition?: FaceRecognitionCfg;
  visionProvider?: 'local' | 'external';
  sttProvider?: 'local' | 'external';
  vision?: ProviderCfg;
  stt?: ProviderCfg;
  embedding?: EmbeddingCfg;
  rerank?: RerankCfg;
  nli?: NliCfg;
  documentProcessing?: DocProcCfg;
  modelSlots?: Record<string, SlotTuningCfg | undefined>;
  decisionModel?: DecisionModelCfg;
  workerConcurrency?: number;
  fallbackToExternal?: boolean;
  maxFileSizeBytes?: number;
  lockedByInfra?: string[];
  /**
   * Entries of `YTHRIL_PINNED_FIELDS` that name nothing, so they pinned NOTHING.
   *
   * Absent when there are none. Surfaced here because the failure that variable exists to prevent is a control
   * that looks fixed and is not — and an operator checking whether their pin took effect looks at this screen,
   * not at the server log.
   */
  pinnedUnknown?: string[];
  infraManaged?: boolean;
}

export const MODE_DESC: Record<DocMode, string> = {
  off:    'Documents are stored but never read. No text is extracted, so nothing from them can be recalled.',
  ocr:    'The OCR sidecar (Tesseract) reads text and tables from each page. Fast, fully local, no vision model needed.',
  vlm:    'Render each page and transcribe it with the vision model, grounded on the OCR text.',
  repair: 'VLM, plus a repair pass that reconciles the draft against the OCR text — and a second-model consensus pass when a verify model is set.',
  auto:   'As much as this instance can do: the repair pass when a repair model is configured, otherwise the vision model, otherwise OCR.',
};

/** Which pipeline stages are active per mode (drives the diagram). */
export const MODE_STAGES: Record<DocMode, Set<string>> = {
  off:    new Set([]),
  ocr:    new Set(['ocr']),
  vlm:    new Set(['ocr', 'render', 'vlm', 'validate']),
  repair: new Set(['ocr', 'render', 'vlm', 'validate', 'repair', 'verify']),
  // 'auto' resolves to the top rung the instance can run, so it shows the full chain — the stages it
  // cannot run are the same ones the missing-model warning already calls out.
  auto:   new Set(['ocr', 'render', 'vlm', 'validate', 'repair', 'verify']),
};

export const STAGES = [
  { key: 'ocr', nm: 'OCR', sub: 'evidence' },
  { key: 'render', nm: 'Render', sub: 'page → PNG' },
  { key: 'vlm', nm: 'VLM', sub: 'vision' },
  { key: 'validate', nm: 'Validate', sub: 'coverage' },
  { key: 'repair', nm: 'Repair', sub: 'reconcile' },
  { key: 'verify', nm: 'Verify', sub: 'consensus' },
];

// ── Pipeline status (GET /api/admin/pipeline-status, shipped in #360) ─────────

export type HealthState = 'ok' | 'degraded' | 'down' | 'blocked' | 'off' | 'unconfigured';

export interface SidecarStatus {
  key: string; label: string; envVar: string; url: string;
  state: HealthState; latencyMs?: number; detail?: string;
}

export interface ModelStageStatus {
  key: string; label: string; model: string | null; endpoint: string | null; external: boolean;
  state: HealthState; latencyMs?: number; detail?: string;
}

export interface CollectionIndexStatus {
  collection: string; indexName: string; status: string | null;
  /** An index the space's search does not depend on (the face gallery). Excluded from `live`. */
  optional?: boolean;
}

export interface SpaceIndexStatus {
  id: string; label: string;
  stored: 'building' | 'ready' | 'failed' | 'unknown';
  live: 'ready' | 'building' | 'missing' | 'unknown';
  collections: CollectionIndexStatus[];
  /** Config claims ready and the database disagrees — the silent index-loss signature. */
  drifted: boolean;
}

export interface PipelineStatus {
  checkedAt: string;
  sidecars: SidecarStatus[];
  models: ModelStageStatus[];
  index: { spaces: SpaceIndexStatus[]; unavailable?: string };
  faceRecognition: { state: HealthState };
  /** `F-33`: who answers each assist use now, and what the budget has spent; absent with no assist model. */
  assist?: {
    answeredBy: { repair: 'primary' | 'fallback' | null; conversations: 'primary' | 'fallback' | null };
    spent: number; budget?: AssistBudgetCfg; primaryCoolingDown: boolean;
  };
}
