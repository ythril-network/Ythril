import type { TokenRights } from './rights-shape.js';
import type { ModelSlotsConfig } from './model-slots.js';
export interface TokenRecord {
  id: string;
  name: string;
  hash: string;         // bcrypt hash
  prefix: string;       // first 8 chars of the plaintext token — fast lookup hint
  createdAt: string;    // ISO8601
  lastUsed: string | null;
  expiresAt: string | null;
  // `spaces` was REMOVED in 3.1 (D-8d), the last of the pre-3.0 triple. Nothing consults it first any more:
  // every scoping decision reads `rights` — `reachesSpace`, `editorScopeFor`, `spacesWhereTokenMay` — and
  // three separate holes were closed on the way, each one a check written `if (token.spaces)` that meant
  // "unrestricted" on a token whose scope lived only in the matrix.
  //
  // It survives where it is still MEANINGFUL: as an INPUT to `migrateToken`, which derives a matrix for a
  // token minted before the matrix existed, and on `OidcTokenRecord`, which is built per request from a
  // claim mapping and carries no matrix at all. Every fallback that reads it now reads it from there.
  // `admin` was REMOVED in 3.1 (D-8d), the second of the pre-3.0 triple. Nothing decides on it any more:
  // `isInstanceAdmin` reads `rights.instanceAdmin`, and the seven places that each asked the question their
  // own way were unified onto that one predicate first, in its own change, against evidence that the two
  // answered identically for every storable token shape.
  //
  // It survives where it is still MEANINGFUL: as an INPUT to `migrateToken`, which derives a matrix for a
  // token minted before the matrix existed, and on `OidcTokenRecord`, which is built per request from a
  // claim mapping and carries no matrix at all. What is gone is the stored field.
  // `readOnly` was REMOVED in 3.1 (D-8d). It was the second of the pre-3.0 triple and the first to go,
  // because nothing decided on it any more: `toolIsVisible` asks `canWriteAnywhere(rights)`, every REST
  // guard asks `effectiveRung`, and the `ToolContext.readOnly` that was threaded through four layers to
  // reach the tools was read by none of them.
  //
  // It survives where it is still MEANINGFUL: as an INPUT to `migrateToken`, which derives a matrix for a
  // token minted before the matrix existed. That reads `LegacyToken`, its own interface over raw stored
  // config, so a pre-3.1 record keeps its scope. What is gone is the runtime field — nothing writes it and
  // nothing can start deciding on it again.
  peerInstanceId?: string; // set on tokens created for network peers — links this PAT to the peer that uses it inbound
  schemaLibrary?: boolean; // true = only valid on GET /api/schema-library/public*; no space access
  oauthClientId?: string;  // set on PATs minted by the MCP OAuth flow — links this token to the connector client that created it (for rotation, capping, and UI attribution)
  /**
   * This token's relationship to the second factor. Absent = `inherit`.
   *
   * ## Why this is per-token at all
   *
   * `/api/mfa` is a single instance-wide `{ enabled }`, so turning MFA on makes every admin route demand a
   * TOTP code from every PAT — including the ones a scheduler holds. An operator reported the consequence:
   * **MFA is mutually exclusive with automation, and the deployments most likely to want MFA are exactly the
   * ones that have automation.** Their ask was to make it a token property, as read-only and space scoping
   * already are.
   *
   * ## Why three states and not a boolean
   *
   *   `inherit`   (default, and what every existing token gets) — follow the instance switch. Absent means
   *               this, so nothing about a current deployment changes.
   *   `exempt`    skip MFA even when the instance switch is ON. This is the automation case, and it is a
   *               deliberate hole in an instance-wide control: it may only be set by an admin who has
   *               already satisfied MFA, it is reported on the token list, and it is audited.
   *   `required`  demand MFA even when the instance switch is OFF. The mirror case, and the reason a plain
   *               `mfaExempt` boolean was rejected: an operator who wants a second factor on the two human
   *               admin tokens and nothing else currently has to turn it on for everything, which is the
   *               same all-or-nothing trap from the other side.
   */
  mfa?: 'inherit' | 'exempt' | 'required';
  /**
   * This token's own request quota, in requests per minute. Absent = inherit the instance value.
   *
   * Owner request, 2026-08-20. Resolution is `record > instance > default`, the same order `ttlDays` and
   * `suppressEmbeddings` use: this field, then `YTHRIL_RATE_LIMIT_PER_MINUTE`, then the 300/minute the global
   * limiter has always allowed — so an instance that configures nothing behaves exactly as it does today.
   *
   * **Set by an instance admin; bounded by infra.** When `YTHRIL_RATE_LIMIT_PER_MINUTE` is set it is a CEILING
   * and not merely a default: a write above it is refused naming the ceiling, because a ceiling an admin can
   * exceed is decorative. See `rate-limit/per-token.ts` for the resolution and the refusal, which the REST
   * route and the MCP tool share rather than each implementing.
   *
   * Enforced AFTER authentication, by a second limiter. The existing pre-auth limiter cannot be made
   * token-aware: it must throttle requests carrying no valid credential, so identifying which token a request
   * holds would mean a bcrypt compare against every stored token, per request.
   */
  rateLimitPerMinute?: number;
  /**
   * The per-space rights matrix, derived from `admin`/`readOnly`/`spaces` by `migrateToken()` at load.
   *
   * **Not authoritative yet.** Enforcement still reads the legacy fields; this is written and compared
   * first, so a defect in the derivation shows up as a mismatch rather than as access somebody has and
   * nobody granted. Shape is `MigratedRights` in `auth/rights-migration.ts` — typed loosely here because
   * `config/types.ts` must not import from `auth/`, which imports this file.
   */
  rights?: TokenRights;

}

// ── Space meta / schema types ──────────────────────────────────────────────
//
// Moved to `types-knowledge.ts` — a LEAF that imports nothing, so it cannot become half of a cycle. See that
// file for why that matters. Imported as well as re-exported, because `export ... from` does not bring a name
// into local scope and `TtlBucket` below is built from `KnowledgeType`.
import type { MergeFn, NumericMergeFn, BooleanMergeFn, PropertySchema, TypeSchema, ValidationMode, KnowledgeType, RecordType, TombstoneType, RefKind, SpaceMeta, StampSkewable } from './types-knowledge.js';
export type { MergeFn, NumericMergeFn, BooleanMergeFn, PropertySchema, TypeSchema, ValidationMode, KnowledgeType, SpaceMeta };
// A VALUE, so it needs its own import and re-export: everything else above is a type. Re-exported from here
// rather than importing the leaf directly, because `config/types.js` is the one path this codebase's modules
// already reach for, and a second path to the same tuple is how a second copy of it starts.
import { KNOWLEDGE_TYPES, RECORD_TYPES, COLLECTION_SUFFIX, RECORD_COLLECTION, BRAIN_COLLECTIONS, TOMBSTONE_TYPES, TOMBSTONE_COLLECTION, TOMBSTONE_TYPE_OF } from './types-knowledge.js';
export { KNOWLEDGE_TYPES, RECORD_TYPES, COLLECTION_SUFFIX, RECORD_COLLECTION, BRAIN_COLLECTIONS, TOMBSTONE_TYPES, TOMBSTONE_COLLECTION, TOMBSTONE_TYPE_OF };
export type { RecordType, BrainCollection, TombstoneType } from './types-knowledge.js';

/**
 * What kind of thing a record is, for the purpose of the SPACE retention tier.
 *
 * `KnowledgeType` plus `file`, because files share the space-wide default but have no type and therefore no
 * schema tier — the one asymmetry between the two concepts, and the reason they are separate names.
 */
/**
 * The retention buckets: {@link RecordType} under the name the retention code reads.
 *
 * It was `KnowledgeType | 'file'` — already derived, and the model the other four aliases should have
 * followed. Spelled as `RecordType` now so all five names resolve to one tuple rather than to two
 * equivalent-but-separate definitions.
 */
export type TtlBucket = RecordType;

/**
 * The space-wide retention window per bucket. Absent or `null` means no window for that bucket.
 *
 * `null` is accepted and means exactly what absent means. It exists because it is how an operator writes "not
 * this one" explicitly in a JSON patch that sets the others, and rejecting it would make the obvious payload a
 * 400.
 */
export interface RecordTtlWindows {
  entity?: number | null;
  fact?: number | null;
  edge?:   number | null;
  chrono?: number | null;
  file?:   number | null;
}

// ── Schema library ─────────────────────────────────────────────────────────

/**
 * A named, versioned TypeSchema definition stored in the instance-level schema
 * library.  Spaces can reference an entry via `$ref: "library:<name>"` instead
 * of duplicating the schema inline.
 */
export interface SchemaLibraryEntry {
  /** Unique identifier for this library entry (e.g. `"service-v1"`). */
  name: string;
  /** The knowledge-type collection this schema applies to. */
  knowledgeType: KnowledgeType;
  /**
   * The type name within that collection (e.g. `"service"` for entity type).
   * This is informational — it does not restrict which type name a referencing
   * space uses.
   */
  typeName: string;
  /** The actual schema definition (inline only — no `$ref` nesting allowed). */
  schema: Omit<TypeSchema, '$ref'>;
  /** Optional human-readable description for the library entry. */
  description?: string;
  /**
   * Optional group identifier for organizing related entries into a named set
   * (e.g. `"design-system"` or `"platform-base"`).  Purely organizational —
   * entries remain individually importable regardless of their group tag.
   * Any string is accepted; multiple entries can share the same group name.
   */
  schemaGroup?: string;
  /**
   * When true the entry is exposed on the unauthenticated public endpoint.
   * Default: false (private).
   */
  published?: boolean;
  /**
   * URL of the foreign catalog this entry was imported from, if any.
   * Informational only — used to show "imported from" label and to support
   * manual refresh.
   */
  sourceUrl?: string;
  /**
   * Local catalog name (key in schema-catalogs.json) this entry was imported
   * from, if applicable.
   */
  sourceCatalog?: string;
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * A named link to a foreign Ythril instance's public schema library.
 * The server proxies browse/import requests through this record to avoid
 * browser CORS issues and to apply SSRF validation server-side.
 */
export interface SchemaCatalog {
  /** Unique local name for this catalog link (e.g. `"team-b"`). */
  name: string;
  /** Validated HTTPS URL of the foreign public library index endpoint. */
  url: string;
  /** Optional human-readable description. */
  description?: string;
  /**
   * Optional Bearer token forwarded by the catalog proxy when fetching from
   * the remote instance.  Required when the remote is behind a reverse proxy
   * that demands authentication (e.g. Cloudflare Access).
   * Never returned to the client — stored server-side only.
   */
  accessToken?: string;
  /** ISO8601 creation timestamp. */
  createdAt: string;
}

// ── Space meta ─────────────────────────────────────────────────────────────
//
// `SpaceMeta` moved to `types-knowledge.ts` with the schema vocabulary it carries, and is re-exported below.


export interface SpaceConfig {
  id: string;
  label: string;
  builtIn: boolean;
  folders: string[];
  maxGiB?: number;
  /**
   * The width of this space's face descriptors, fixed when the space is created.
   *
   * Absent means the built-in default. **Create-only**: the face gallery's vectors are written at this width
   * and nothing re-derives them, so changing it later would leave stored vectors indexed as if they were a
   * different size — a cosine search that ranks nothing correctly and reports no error. The index build
   * refuses such a change; this field simply never offers it.
   *
   * Exists because every top-tier open face recogniser emits 512 dimensions while the bundled one emits 128,
   * so the external-provider hook admitted only models in the bundled model's weight class.
   */
  faceDescriptorDims?: number;
  flex?: number;
  /**
   * Legacy ON-DISK field only — removed from every API surface in 3.0, and no longer accepted, stored or
   * emitted. It survives on this type because `migrateSpaceDescriptionToPurpose` still has to RECOGNISE it
   * in a config written by an older build, and a boot migration cannot read a field the type denies.
   *
   * Delete this with the migration (`_DEPRECATIONS.md` row 3.1) once the version floor 3.0 upgrades from is
   * fixed — not before, or upgrading from 2.x silently drops the operator's directive.
   */
  description?: string;
  proxyFor?: string[];  // virtual proxy space — aggregates reads, routes writes to member spaces
  meta?: SpaceMeta;     // structured schema and metadata — all fields optional
  /** Local duplicate-action policy (not governed/synced — operational, per-instance).
   *  Rules are evaluated highest-minScore first; the first match decides the action. */
  dupeRules?: DupeActionRule[];
  /** Which record survives an automerge. Default 'older' (lower seq). */
  dupeMergeSurvivor?: 'older' | 'newer';
  /** Also evaluate dupeRules in real time when a record is inserted, not only on
   *  the scheduled scan. Default false (scan-time only). Applies to all inserts,
   *  including bulk. */
  dupeRulesOnInsert?: boolean;
  /**
   * Every link in this space is a link RECORD, not just an array entry — set by the conversion script when it
   * has finished walking `fact.entityIds`, the two chrono arrays and the three file arrays.
   *
   * **Local/operational, like `dupeRules` and `recordTtlDays`, and that placement is the whole point.** The
   * flag one word away, `strictLinkage`, lives on `SpaceMeta` because it states what the space MEANS and a
   * network should agree on it — so a meta change opens a `meta_change` vote and applies on every peer. This
   * one states what has happened on ONE disk. Voted, the first instance to run the script would arm it
   * everywhere, and the refusal it gates would then reject array writes on peers holding no link records at
   * all: writes refused, reads empty, and a correctly-passed vote in every log.
   *
   * Absent means false. It arms nothing yet — the refusal is 2b, because refusing an array write is only
   * honest once the readers prefer the records.
   */
  completeLinkage?: boolean;
  /** Per-space document-extraction mode override (F11-c). Local/operational (not governed or synced,
   *  like dupeRules): when set, documents uploaded to THIS space use this mode instead of the
   *  instance-wide `documentProcessing.mode`. Absent = inherit the instance default. */
  documentExtraction?: DocExtractionMode;
  /** Per-space level for images / audio / video, capped by the matching instance ceiling in
   *  `mediaEmbedding.levels`. Same contract as `documentExtraction`: local/operational, never governed
   *  or synced, and absent means "follow the instance". See `media-level.ts` for the ladders. */
  imageAnalysis?: ImageLevel;
  audioAnalysis?: AudioLevel;
  videoAnalysis?: VideoLevel;
  textAnalysis?: TextLevel;
  /**
   * Auto-TTL (F10): the SPACE tier of `record > schema > space`. A record with no `ttlDays` of its own and no
   * window on its type is stamped `createdAt + <this>` and deleted by the TTL sweep once it lapses — through the
   * normal delete path, so it tombstones and syncs. Absent = no auto-TTL.
   *
   * **Two accepted shapes, and the object is the current one.** A space does not hold one kind of thing: a
   * `tickets` space holds ticket *entities* that must outlive their status-change *chronos*, and a scalar cannot
   * express that. The schema tier does not help — it keys on a type NAME, while this is about a whole collection.
   *
   *     recordTtlDays: 90                                   // legacy scalar: all five buckets
   *     recordTtlDays: { chrono: 90, file: 30 }              // per bucket; absent/null = no window
   *
   * **FIVE buckets, not four.** `files` share this default (see `04-brain-api.md`), so splitting it four ways
   * would silently attach uploads to whichever bucket was picked — and they are the largest and most obviously
   * disposable of the five.
   *
   * The scalar is accepted **forever** on read (`spaceTtlDays()` widens it), because this is local,
   * non-synced config: a lazy read-side widening is enough and no boot migration is needed. See
   * `_REFERENCE.md → migration-strategy`.
   */
  recordTtlDays?: number | RecordTtlWindows;
  /** Vector-search index lifecycle for a newly created space (B1). Creation now
   *  returns immediately with 'building' and the (slow, up-to-minutes) Atlas index
   *  builds finish asynchronously — flipping this to 'ready', or 'failed' if a build
   *  errored. Absent on spaces created before B1 and on proxy spaces (no indexes);
   *  treat absent as 'ready'. The space is writable while 'building'; only semantic
   *  recall waits for READY. */
  indexStatus?: 'building' | 'ready' | 'failed';
}

export interface EmbeddingConfig {
  /** If set, route embedding requests to this OpenAI-compatible HTTP endpoint.
   *  If absent, the bundled local ONNX model is used (default, works out of the box). */
  baseUrl?: string;
  /**
   * How many chunk embeds may run at once while converting one document. Absent = per-embedder default:
   * low for the bundled in-process model (CPU-bound, and it shares the event loop that answers `/health`),
   * higher for an HTTP endpoint (network-bound, the work is elsewhere). See `embed-concurrency.ts` for the
   * measurements. Raise it only with CPU headroom to spare; clamped to 1…32.
   */
  embedConcurrency?: number;
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

export interface StorageConfig {
  total?: { softLimitGiB: number; hardLimitGiB: number };
  files?: { softLimitGiB: number; hardLimitGiB: number };
  brain?: { softLimitGiB: number; hardLimitGiB: number };
}

/**
 * A single pluggable media-embedding provider entry — vision or STT.
 *
 * The shape is deliberately generic so any OpenAI-compatible vision
 * (Ollama `/api/chat`, OpenAI GPT-4o, Anthropic Claude, etc.) or STT
 * (faster-whisper-server `/v1/audio/transcriptions`, OpenAI Whisper, etc.)
 * endpoint can be plugged in by editing config.json or the Settings → Models
 * page in the UI — no code changes required.
 *
 * `apiKey` is optional and only used when the endpoint requires
 * Authorization (i.e. external providers). Local cluster endpoints (Ollama,
 * faster-whisper-server) leave it empty.
 */
export interface MediaProviderConfig {
  /** Human-readable label shown in the Settings UI. */
  label?: string;
  /** Base URL of the provider (e.g. `http://ollama.ythril.svc.cluster.local:11434`
   *  or `https://api.openai.com/v1`). The provider client appends the route. */
  baseUrl?: string;
  /** Model tag passed to the provider (e.g. `moondream`, `gpt-4o-mini`,
   *  `whisper-1`, `base`). */
  model?: string;
  /**
   * Optional API key for endpoints that require Authorization. When empty, no Authorization header is
   * sent.
   *
   * **Never stored in `config.json`.** It lives in `secrets.json` (`0o600`), which is what the Settings
   * UI writes and the only place the loader reads it from; an env-var override
   * (`VISION_API_KEY` / `STT_API_KEY` / …) takes precedence over both and locks the field read-only in
   * the UI. This field is on the RESOLVED shape, which is why it is still here — a key present on a
   * stored block is a pre-3.0 leftover and is lifted out at boot.
   */
  apiKey?: string;
}

/**
 * Media embedding pipeline configuration.
 *
 * Routes binary media (image / audio / video) through text-as-intermediate
 * captioning + STT so every embedding lands in the same vector space as
 * facts, entities and converted documents (`nomic-embed-text-v1.5`).
 *
 * Always on — there is no master on/off switch. Each media class is controlled by its `levels` entry
 * (`off` takes that class offline instance-wide); the removed `MEDIA_EMBEDDING_ENABLED` /
 * `mediaEmbedding.enabled` master switch is migrated to `levels` on upgrade.
 *
 * ── Plugin model ────────────────────────────────────────────────────────────
 * Vision and STT are pluggable via the generic `vision` / `stt`
 * `MediaProviderConfig` blocks. Any OpenAI-compatible endpoint works
 * out-of-the-box; switching providers is a config edit, not a code change.
 *
 * ── Resolution order (high → low precedence) ────────────────────────────────
 * `getMediaEmbeddingConfig()` in the loader applies:
 *   1. Env vars (`VISION_PROVIDER`, `VISION_BASE_URL`, `VISION_MODEL`, `VISION_API_KEY`,
 *      `STT_PROVIDER`, `STT_BASE_URL`, `STT_MODEL`, `STT_API_KEY`, …)
 *      The legacy spellings `OLLAMA_URL`, `WHISPER_URL` and `WHISPER_MODEL` were REMOVED in 4.0 and now
 *      refuse the boot rather than resolving, because a name that is set and configures nothing would let
 *      the built-in default take its place silently. They named the product that happened to be first
 *      rather than the field they configure — `OLLAMA_URL` applied even when the provider was `external`.
 *   2. `config.json` `mediaEmbedding.*` (writable from the UI)
 *   3. Built-in defaults
 *
 * When an env var supplies a value, `lockedByInfra` will list that field so
 * the Settings UI can render it read-only (locked-by-infra).
 */

/**
 * Reranker settings — a provider block plus the one retrieval knob that is specific to reranking.
 */
export interface RerankConfig extends MediaProviderConfig {
  /**
   * How many candidates to fetch per requested result before reranking, as a multiple of `topK`.
   *
   * A reranker can only re-order what the vector search already found, so this is the whole reason it
   * helps: over-fetch a wider net, then let the cross-encoder pick. Too low and there is nothing to
   * rescue (a multiplier of 1 reranks exactly the results you would have got anyway); too high and every
   * search pays for passages that were never plausible.
   *
   * Default 4, clamped to 2..10. The absolute candidate count is capped as well, so a large `topK`
   * cannot turn one search into a thousand-passage rerank.
   */
  candidateMultiplier?: number;
}

export interface MediaEmbeddingConfig {
  /** Instance CEILINGS per media class — the most a space is allowed to do, not a default a space
   *  inherits. Absent = `auto` (no policy limit). A class set to `off` here takes it offline instance-
   *  wide — this is the ONLY media on/off control (the old `enabled` master switch was removed; a legacy
   *  `enabled:false` is migrated to images/audio/video = `off`). Documents have their own under
   *  `documentProcessing.mode`, which predates this block. */
  levels?: MediaLevelCeilings;
  /** "local" → bundled cluster endpoint (Ollama); "external" → user-supplied API. */
  visionProvider?: 'local' | 'external';
  /** "local" → bundled cluster endpoint (faster-whisper-server); "external" → user-supplied API. */
  sttProvider?: 'local' | 'external';
  /** Pluggable vision provider settings (endpoint + model + optional API key). */
  vision?: MediaProviderConfig;
  /**
   * NLI (natural-language-inference) provider — the contradiction judge (F-REVIEW).
   *
   * An encoder classifier (roberta/deberta-MNLI class, ~100-400M) that labels a premise/hypothesis pair
   * as entailment / neutral / contradiction. Configured exactly like `vision` and `stt`: a local sidecar
   * or an external endpoint, per-field env pins, key in secrets.json.
   *
   * Deliberately NOT an embedding model. Similarity is not contradiction — two opposite claims about the
   * same subject are usually MORE embedding-similar, not less. Embeddings only pick the candidate PAIRS
   * (same subject); this decides whether they agree or oppose.
   */
  nli?: MediaProviderConfig;
  /**
   * Reranker — an optional cross-encoder that re-scores the vector search's candidates before they are
   * cut to `topK` (e.g. `bge-reranker-v2-m3`, self-hosted).
   *
   * **Why it is a separate model and not a better embedding.** A bi-encoder embeds the query and the
   * passage independently, so it can only ever compare two summaries of meaning. A cross-encoder reads
   * the pair together and scores the actual match. That is why reranking lifts precision on the top few
   * results, which is exactly the region a caller sees — and why it cannot replace the vector search:
   * it has no index, so it can only re-order candidates something else already found.
   *
   * **Self-hosting is the point.** A reranker sees the query AND the retrieved passages together, which
   * is the most revealing pairing in the system — more so than either alone. A hosted reranker egresses
   * it on every search. So this ships unconfigured, and when it is configured the same local/external
   * split as every other provider applies.
   *
   * Configured (`baseUrl` + `model`) = on. There is no separate master toggle, matching `nli` and the
   * decision that removed the media-embedding one.
   */
  rerank?: RerankConfig;
  /** Pluggable STT provider settings (endpoint + model + optional API key). */
  stt?: MediaProviderConfig;
  /** Max concurrent jobs processed per worker tick. */
  workerConcurrency?: number;
  /** Base poll interval — doubles on empty result up to workerMaxPollIntervalMs. */
  workerPollIntervalMs?: number;
  /** Idle backoff cap. */
  workerMaxPollIntervalMs?: number;
  /** When true and the local provider returns non-200, fall back to external. */
  fallbackToExternal?: boolean;
  /** Files larger than this skip embedding (embeddingStatus="skipped"). */
  maxFileSizeBytes?: number;
  /** Stalled "processing" jobs older than this are reset to "pending" on startup. */
  stalledJobTimeoutMs?: number;
  /**
   * Names of fields whose value is currently being supplied by an env var
   * (and is therefore read-only in the Settings UI). Populated by the loader
   * at runtime; never persisted to config.json.
   *
   * Examples: `["enabled", "vision.apiKey", "stt.baseUrl"]`.
   */
  lockedByInfra?: string[];
  /**
   * Entries of `YTHRIL_PINNED_FIELDS` that name no real field, so they pinned NOTHING.
   *
   * Surfaced rather than only logged, because the failure this whole mechanism exists to avoid is a control that
   * looks fixed and is not — and an operator checking whether their pin took effect looks at the settings screen,
   * not at the server log. Absent when there are none, so it is not a field that is empty on every healthy
   * instance. Runtime only; never persisted to `config.json`.
   */
  pinnedUnknown?: string[];
  /**
   * F11 — when true, the entire media/model configuration is **infra-managed**: it is set through
   * `config.json` / environment and the admin API refuses to mutate it (like `YTHRIL_MONGO_INFRA_MANAGED`
   * for the database). The Settings → Models page renders read-only. Also settable via the
   * `YTHRIL_MEDIA_INFRA_MANAGED=true` env var. Default false. Surfaced (read-only) in the admin GET.
   */
  infraManaged?: boolean;
  /** Face recognition settings — requires @vladmandic/human WASM backend. */
  faceRecognition?: FaceRecognitionConfig;
  /** Document processing settings — controls the unstructured sidecar behaviour. */
  documentProcessing?: DocumentProcessingConfig;
}

/**
 * Configuration for the document processing pipeline (PDF, DOCX, EPUB conversion).
 * Uses the unstructured-api sidecar for partition extraction.
 */
export interface DocumentProcessingConfig {
  /**
   * Unstructured partition strategy passed to the sidecar.
   *
   * - `"hi_res"` (default): full OCR + layout detection. Slower but extracts
   *   images, recognises tables from scanned PDFs, and handles complex layouts.
   *   Required for embedded-image extraction.
   * - `"auto"`: unstructured picks the fastest strategy that still produces
   *   reasonable text. No guaranteed image extraction.
   * - `"fast"`: text-layer extraction only (pdfminer). Fastest but no OCR, no
   *   image extraction.
   * - `"ocr_only"`: full OCR on every page regardless of whether a text layer
   *   exists. Useful for scanned documents but redundant for born-digital PDFs.
   */
  strategy?: 'hi_res' | 'auto' | 'fast' | 'ocr_only';
  /**
   * When true (default), embedded images found during hi_res conversion are
   * extracted as `_extracted/{originalId}/image-{N}.{ext}` subfiles and
   * re-enqueued for the full media pipeline (caption + face recognition).
   *
   * Has no effect when strategy is not `hi_res`.
   */
  extractImages?: boolean;
  /**
   * F11 — document-extraction mode. `auto` (default) uses the VLM when one is configured and reachable,
   * otherwise falls back to OCR — so with no `vlmModel` set it is byte-for-byte the OCR-only path. `ocr`
   * forces OCR-only; `vlm`/`max` opt further into the VLM precision pipeline
   * (render → OCR-grounded VLM → validate → repair/consensus). The router falls back to OCR whenever a
   * needed capability is absent, so it is never worse than plain OCR. See `todo/F11-PLAN.md`.
   */
  mode?: DocExtractionMode;
  /** F11 — DPI for page rasterization in VLM modes. Default 150. */
  renderDpi?: number;
  /**
   * F11 — max pages rasterized per RENDER CALL (fact/latency bound on one sidecar round trip).
   * Default 50.
   *
   * This is no longer how much of a document gets read: long documents are walked in windows of this size
   * via the sidecars' `startPage`. Use `maxTotalPages` to bound the whole job.
   */
  maxPages?: number;
  /**
   * F11 — max pages read from ONE document across all windows. Default 200. Beyond this the extraction
   * stops and says so, in the log and in the stored markdown.
   *
   * Deliberately separate from `maxPages`, because they bound different things: `maxPages` is one round
   * trip's fact, this is the job's total cost. Every page is a VLM call, so an unbounded walk over a
   * 600-page scan means 600 model calls and — with an external endpoint — 600 pages of content leaving the
   * instance, on an upload nobody is watching. Raise it deliberately.
   */
  maxTotalPages?: number;
  /** F11 — per-page model-call timeout in ms (VLM/repair). Default 60000. */
  pageTimeoutMs?: number;
  /** F11 — max concurrent per-page model calls within one document. Default 2. */
  concurrency?: number;
  /**
   * F11 — timeout (ms) for a single OCR-sidecar (unstructured) call. Default 120000 (2 min). Applies to ALL
   * modes: OCR is both the sole engine in `ocr` mode and the grounding-evidence + fallback floor in the VLM
   * modes, so a large/complex scanned document can exceed a fixed ceiling — raise this to let it finish
   * (trading latency for completeness) especially under `max`. Env: `DOC_OCR_TIMEOUT_MS`.
   */
  ocrTimeoutMs?: number;
  /**
   * Timeout (ms) for the one call that describes a converted document. Default 30000.
   *
   * Separate from `pageTimeoutMs` because the constraint is different: this is a single call at the end of a
   * job, and its failure costs only the generated description — the document's own opening text is kept
   * instead. 30 s suits a model that is already resident.
   *
   * It does not suit a **single-GPU host that swaps models per request**: the describe call arrives right
   * after the transcription pass, so the backend unloads the vision model and loads the chat model first,
   * and the load alone can exceed the budget. Every document then falls back to extractive text with one
   * `warn` about a timeout — the capability looks broken while working correctly on the next host along.
   * Env: `DOC_DESCRIBE_TIMEOUT_MS`.
   */
  describeTimeoutMs?: number;
  /**
   * F11 — the document-transcription VLM model tag (e.g. a small Qwen2-VL / MiniCPM-V on the bundled
   * Ollama). Empty (default) means no VLM is configured, so `vlm`/`auto`/`max` modes fall back to OCR.
   * Env: `DOC_VLM_MODEL`.
   */
  vlmModel?: string;
  /**
   * F11 — base URL of the VLM endpoint. Empty (default) reuses the media `vision` provider's Ollama URL
   * (the bundled local path, no egress). Env: `DOC_VLM_URL`.
   */
  vlmBaseUrl?: string;
  /**
   * F11 — optional heavyweight "review/repair" model tag used **only in `max` mode** when a page's VLM
   * output fails OCR-evidence validation: it reconciles the draft against the OCR text in one extra pass.
   * Empty (default) reuses `vlmModel` for the repair pass (self-contained). Set this to wire in a stronger
   * model you host yourself. Env: `DOC_REPAIR_MODEL`.
   */
  repairModel?: string;
  /**
   * F11 — base URL for the repair model. Empty (default) reuses `vlmBaseUrl` (then the vision URL).
   * Env: `DOC_REPAIR_URL`.
   */
  repairBaseUrl?: string;
  /**
   * F11-d — optional **second** document VLM for the `max`-mode **consensus** pass. When set, `max` mode runs
   * this model as an independent second transcription of each page, reconciles it with the primary draft
   * against the OCR evidence, and keeps the highest-OCR-coverage result — so consensus is **never worse**
   * than the primary. Empty (default) ⇒ no consensus pass. Best paired with a *different* model than
   * `vlmModel` (two identical deterministic passes agree trivially). Env: `DOC_VERIFY_MODEL`.
   */
  verifyModel?: string;
  /**
   * F11-d — base URL for the consensus/verify model. Empty (default) reuses `vlmBaseUrl` (then the vision
   * URL). Env: `DOC_VERIFY_URL`.
   */
  verifyBaseUrl?: string;
  /**
   * F11-b — an **external** "assist model" (a bigger, hosted LLM the operator points Ythril at) and what
   * it is used for. Distinct from the bundled local VLM: this is the only place document content is sent
   * OFF the instance, so it is opt-in and gated by an explicit acknowledgment. `apiKey` is NOT stored here
   * — it lives in `secrets.json` (`mediaEmbedding.docAssistApiKey`). Absent = no external assist model.
   */
  assistModel?: DocAssistModelConfig;
}

/** F11-b — external assist-model configuration. OpenAI-compatible endpoint reached via `ssrfSafeFetch`. */
export interface DocAssistModelConfig {
  /** External OpenAI-compatible base URL (e.g. `https://api.example.com`). SSRF-validated on save. */
  baseUrl?: string;
  /** Model tag to request (e.g. `gpt-4o`, a hosted Llama, …). */
  model?: string;
  /** What the external model powers. `repair` (the max-mode reconciliation pass) today; more TBD. */
  /** The host (`new URL(baseUrl).host`) the operator acknowledged document egress to. Must match `baseUrl`'s
   *  host while `uses` is non-empty — re-acknowledged when the endpoint host changes. Records consent. */
  acknowledgedHost?: string;
}

/** F11-b — tasks an external assist model can be assigned to. Extensible (transcribe / verify are later). */

/**
 * F11 — how thoroughly documents are read, low to high:
 *
 *   off     nothing is extracted; the file is stored but never analysed
 *   ocr     the OCR sidecar reads text and tables — fully local, no vision model
 *   vlm     pages are rendered and transcribed by the vision model, grounded on the OCR text
 *   repair  vlm plus a repair pass reconciling the draft against the OCR evidence
 *           (and a second-model consensus pass when a verify model is configured)
 *   auto    whatever is the most this instance can actually do — resolved at runtime
 *
 * `auto` is not a rung, it is "the highest rung available": it degrades to `vlm` without a repair
 * model and to `ocr` without a vision model, so an instance never advertises a stage it cannot run.
 *
 * `max` is the previous name for `repair` and is still accepted when read — it is a stored value in
 * config.json, and dropping it would silently reset an instance to a different level on load. See
 * `normalizeDocExtractionMode`.
 */
export type DocExtractionMode = 'off' | 'ocr' | 'vlm' | 'repair' | 'auto';

/**
 * Every value accepted on input. Identical to `DocExtractionMode` since 3.0 removed the legacy `max`
 * spelling of `repair` — there is deliberately no longer a difference between what the API takes and what
 * the type means, because a one-element gap between two lists is exactly what nobody can explain later.
 *
 * It stays a separate `as const` only because zod needs a runtime array; the `satisfies` clause is what
 * keeps the two from drifting apart again — re-adding `max` here stops the build.
 */
export const DOC_EXTRACTION_MODES_IN = ['off', 'ocr', 'vlm', 'repair', 'auto'] as const satisfies readonly DocExtractionMode[];

/**
 * Fold a STORED legacy `max` into `repair`.
 *
 * 3.0 stopped ACCEPTING `max` — a request sending it is now refused by the enum. This normaliser is not
 * that surface and does not go with it: `config.json` and space records written by an older build still
 * carry `max`, and both readers below go through here. Dropping it would silently move an instance or a
 * space to a different extraction level on load, which is the quietest possible way to change what a
 * document search can find.
 *
 * Same shape as `normalizeVisionModel`: an ongoing self-healing read, not a one-time upgrade path.
 */
export function normalizeDocExtractionMode(mode: string | undefined | null): DocExtractionMode | undefined {
  if (mode === null || mode === undefined) return undefined;
  return (mode === 'max' ? 'repair' : mode) as DocExtractionMode;
}

/**
 * The other media ladders, same shape as documents: low to high, plus `auto` meaning "as much as this
 * instance can do". `off` always means the file is stored but never analysed — not "analysed cheaply".
 *
 *   images   caption      describe the image for search
 *            recognition  caption plus face detection/embedding (opt-in, privacy-weighted)
 *   audio    on           transcribe
 *   video    audio        pull the audio track and transcribe it
 *            full         keyframes as images as well — NOT BUILT YET; reserved so the ladder reads
 *                         complete, and rejected rather than silently treated as `audio`
 */
export type ImageLevel = 'off' | 'caption' | 'recognition' | 'auto';
export type AudioLevel = 'off' | 'on' | 'auto';
export type VideoLevel = 'off' | 'audio' | 'full' | 'auto';
export type TextLevel = 'off' | 'embed' | 'chunk' | 'auto';

export const IMAGE_LEVELS = ['off', 'caption', 'recognition', 'auto'] as const;
export const AUDIO_LEVELS = ['off', 'on', 'auto'] as const;
export const VIDEO_LEVELS = ['off', 'audio', 'full', 'auto'] as const;
export const TEXT_LEVELS = ['off', 'embed', 'chunk', 'auto'] as const;

/** Instance ceilings for the media classes. Absent = `auto` (no policy limit of its own). */
export interface MediaLevelCeilings {
  images?: ImageLevel;
  audio?: AudioLevel;
  video?: VideoLevel;
  text?: TextLevel;
}

/**
 * Configuration for the face recognition pipeline.
 * Uses @vladmandic/human with the WASM backend (CPU-only, no Python/CUDA).
 * Models: BlazeFace (detect, ~0.5 MB) + FaceRes (embed, 128d, ~6.7 MB).
 *
 * Face embeddings are stored in a separate Atlas vector index (path: faceEmbedding)
 * on the {spaceId}_files collection. When a new image is processed:
 *   1. All faces are detected and embedded.
 *   2. Each face embedding is searched against the gallery (face-chunk records
 *      that have a faceEntityId) via $vectorSearch.
 *   3. If the top match exceeds `confidenceThreshold`, the file is auto-labeled
 *      with that entity (updateFileMeta({ entityIds })).
 *   4. Face-chunk records (one per detected face) are stored as
 *      `{fileId}#face-chunk{N}` with parentFileId, faceEmbedding, and optionally
 *      faceEntityId when auto-labeled or manually labeled.
 */
export interface FaceRecognitionConfig {
  /**
   * **Infra pin, not a user switch. Defaults to TRUE.**
   *
   * Whether faces run is decided by the image LEVEL (`recognition`, or `auto` resolving to it) — this
   * field only lets an operator hard-disable the pipeline regardless of any level, via
   * `FACE_RECOGNITION_ENABLED=false`, for deployments where biometric processing must be impossible
   * rather than merely switched off. Setting it `true` enables nothing by itself.
   *
   * It used to be the opt-in master switch with a checkbox and a `false` default. That was removed
   * because two controls meant an image level of `recognition` could silently do nothing; the ladder is
   * now the single gate, and images default to `caption` so faces stay off until a level is raised.
   */
  enabled?: boolean;
  /**
   * Cosine similarity threshold (0–1) above which an auto-label is applied.
   * Below this threshold the face is embedded but left unlabeled.
   * Default: 0.6 (conservative — tune up as gallery grows).
   */
  confidenceThreshold?: number;
  /**
   * Minimum face bounding box size as a fraction of the image's shorter side (0–1).
   * Faces smaller than this are skipped (avoids noise from crowd shots).
   * Default: 0.05 (5% of shorter side).
   */
  minFaceSizeFraction?: number;
  /**
   * OPTIONAL external face-recognition endpoint.
   *
   * Detection/embedding normally runs IN-PROCESS (BlazeFace + FaceRes from `modelPath`), which is why
   * this is absent by default and why the pipeline never had an endpoint to configure. Setting one lets
   * an operator point at a stronger model; in-process remains the FALLBACK, so an unreachable endpoint
   * degrades rather than failing the pipeline.
   *
   * **This egresses biometric data.** Face crops leave the instance, which is more sensitive than the
   * document text the assist model sends. `acknowledgedHost` records the operator's explicit consent for
   * a specific host and is enforced exactly as `documentProcessing.assistModel` enforces it: the consent
   * must match the host whenever the endpoint can actually be reached. `apiKey` is split into
   * `secrets.json` like every other provider key and is never echoed back.
   */
  externalModel?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    /** Host the operator acknowledged for biometric egress. Must match `baseUrl`'s host to be usable. */
    acknowledgedHost?: string;
    /**
     * Whether a configured-but-failing external provider may fall back to the bundled in-process model.
     *
     * **Defaults to `false`, and that is a deliberate behaviour change** (owner decision 2026-08-08:
     * *"disable by default and enable consciously. its a silent pollution."*). The fallback used to be
     * unconditional, so an unreachable or malformed endpoint quietly wrote a DIFFERENT embedder's vectors
     * into the same gallery. Both models emit the same width today, so nothing detects the mixture — the
     * vectors are simply wrong, and every similarity score computed against them is wrong with them.
     *
     * Skipping is the better failure: the media job retries later and the faces get embedded by the model
     * the operator chose, instead of being permanently embedded by one they did not.
     *
     * **This only applies when an external provider is configured AND consented.** An instance with no
     * external provider is not falling back to anything — in-process is its only path — and it keeps
     * running exactly as before regardless of this flag.
     */
    allowInProcessFallback?: boolean;
  };
  /**
   * Directory (relative to DATA_ROOT) where the @vladmandic/human WASM model
   * files are stored. Defaults to "human-models".
   */
  modelPath?: string;
  /**
   * Entity type names that represent people. Only entities whose `type` is in
   * this list are eligible to be stored in the face gallery.
   *
   * Linking a "location" or "object" entity to a photo will never poison the
   * gallery regardless of how many faces are in the image.
   *
   * Default: ["person"]. Add your own type names if you use a different
   * convention (e.g. ["person", "contact", "employee"]).
   */
  personEntityTypes?: string[];
  /**
   * When true, image files downloaded during a sync cycle (or any image whose
   * entity links are manually updated) are automatically re-enqueued for media
   * embedding if they have not yet been processed by the face recognizer.
   *
   * This allows a secondary instance to build its own face gallery from images
   * that arrived via sync rather than direct upload.
   *
   * Default: true (opt-out with false to keep gallery processing local-origin only).
   */
  reprocessSyncedImages?: boolean;
}

// ── Network types ──────────────────────────────────────────────────────────
//
// Moved to `types-networks.ts`. It imports `SpaceMeta` from the `types-knowledge.ts` LEAF rather than from
// here — importing it back from this file would be a cycle, which is what made the first attempt at this split
// degrade `NetworkConfig` to `any` in `api/invite.ts`. See that file for the full account.
//
// Imported as well as re-exported: `export ... from` does not bring a name into local scope, and types below
// this line are built from these.
import type { NetworkType, SyncDirection, VoteValue, VoteRoundType, NetworkMember, VoteCast, VoteRound, NetworkConfig } from './types-networks.js';
export type { NetworkType, SyncDirection, VoteValue, VoteRoundType, NetworkMember, VoteCast, VoteRound, NetworkConfig };


// ── OIDC types ─────────────────────────────────────────────────────────────

/** Maps a single IdP claim to an Ythril permission.
 *  `claim` supports dot-notation for nested objects (e.g. "realm_access.roles"). */
export interface OidcClaimRule {
  /** Dot-notated path to the claim value in the JWT payload. */
  claim: string;
  /** When present, the claim must equal this value (or be an array containing it).
   *  When absent, the claim merely needs to be truthy. */
  value?: string;
}

export interface OidcClaimMapping {
  /** When matched, the user is granted admin access. */
  admin?: OidcClaimRule;
  /** When matched, the user is restricted to read-only access. */
  readOnly?: OidcClaimRule;
  /** When matched, the claim value is treated as the list of allowed space IDs.
   *  The claim itself must be a JSON array of strings. */
  spaces?: OidcClaimRule;
  /**
   * When true, any OIDC token that does not match the `admin` or `readOnly`
   * rule is rejected with 401.  PAT tokens are unaffected.
   * Default: false (unmatched tokens are accepted with no special permissions).
   */
  requireMatch?: boolean;
}

export interface OidcConfig {
  /** Set to true to enable OIDC authentication. Default: false. */
  enabled: boolean;
  /** Base URL of the IdP realm, e.g. https://keycloak.example.com/realms/my-realm.
   *  The well-known discovery URL is derived by appending
   *  /.well-known/openid-configuration */
  issuerUrl: string;
  /** OAuth2 client ID registered at the IdP. */
  clientId: string;
  /** Expected `aud` claim value in issued JWTs.
   *  Defaults to `clientId` when omitted. */
  audience?: string;
  /** Scopes to request during the authorization code flow.
   *  Defaults to ["openid", "profile", "email"]. */
  scopes?: string[];
  /** JWS algorithms accepted when verifying ID tokens. Defaults to the
   *  asymmetric set in `DEFAULT_OIDC_ALGORITHMS` (RS/PS/ES/EdDSA). Override only
   *  to NARROW it (e.g. ["RS256"]); adding an HMAC alg would let anyone holding
   *  the shared secret mint tokens. */
  allowedAlgorithms?: string[];
  /** Maps IdP JWT claims to Ythril permission flags. */
  claimMapping?: OidcClaimMapping;
  /**
   * When true, the browser SPA rejects cached PAT (Personal Access Token)
   * sessions and forces re-authentication through the IdP.  PATs continue to
   * work for programmatic access (API / MCP via Authorization: ******;
   * only the browser localStorage session path is gated.
   * Default: false.  The API endpoint (`/api/auth/oidc-info`) normalises an
   * absent value to `false` so clients always receive a boolean.
   */
  enforceForBrowser?: boolean;
  /**
   * URI the IdP should redirect to after a successful end-session request.
   * Passed as `post_logout_redirect_uri` to the IdP's end_session_endpoint.
   * Defaults to the instance origin (i.e. the login page).
   */
  postLogoutRedirectUri?: string;
  /**
   * Allow the issuer — and the endpoints its discovery document names — to live on a
   * private/reserved address. An internal IdP is a normal deployment (Keycloak on
   * `http://keycloak.internal:8080`, Authentik on a cluster service, Dex on `10.x`), and the
   * default is public-only, so **that deployment needs this flag or nobody can sign in**.
   *
   * Enabling it does NOT drop the egress guard: discovery and JWKS still go through
   * `ssrfSafeFetch`, which DNS-resolves, pins the resolved IP for the connection and re-validates
   * every redirect — only the private-address rejection relaxes. Crown-jewel addresses (loopback,
   * link-local / cloud IMDS, unspecified) stay blocked either way, including when a hostname
   * resolves to one.
   *
   * The allowance is scoped to the issuer's own address class: a PUBLIC issuer may never hand back
   * a private `jwks_uri`, flag or no flag. Mirrors `allowPrivateModelEndpoints`.
   * Overridable via YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER.
   */
  allowPrivateIssuer?: boolean;
}

// ── Audit log types ────────────────────────────────────────────────────────

export interface AuditConfig {
  /** Log read operations (recall, query, list, etc.). Default: false. */
  logReads?: boolean;
  /** Number of days to retain audit entries (TTL). Default: 90. */
  retentionDays?: number;
  /**
   * Days a brain record edit's `changes` payload survives before being redacted. Default: 14.
   *
   * Separate from `retentionDays` on purpose. Record-edit changes carry USER CONTENT — a fact's old
   * text, an entity's old description — so they get a short life, while the entry itself (who, when,
   * which route) keeps the full retention. A sweep unsets the payload and marks `changesRedacted`;
   * the audit trail is never shortened, only the content inside it.
   *
   * Admin/config changes (`space.update`, `network.update`, …) are unaffected — a label or a boolean
   * an operator set is not user content, and is the audit log's core value.
   */
  recordChangeRetentionDays?: number;
}

/** Knowledge types the background duplicate scanner can sweep (same values as RecallKnowledgeType). */
/** One of the five names this repo had for {@link RecordType}. Kept as an alias so call sites read well. */
export type DupeScanType = RecordType;

/**
 * Optional background semantic-duplicate scanner. Off by default (opt-in). When
 * enabled, a cron-scheduled sweep walks each space by `seq` (so it covers every
 * record — including those inserted with the interactive checkDuplicates turned
 * off — and re-scans edited records, since updates advance `seq`), finds
 * near-duplicate pairs via stored embeddings, and records them as reviewable
 * candidates. It never modifies data — consolidation is a separate manual action.
 */
export interface DupeScannerConfig {
  /** Master switch. Default: false. */
  enabled?: boolean;
  /** Cron schedule for the nightly sweep. Default: '0 3 * * *' (03:00 daily). */
  schedule?: string;
  /** Cosine-similarity threshold at/above which a pair is recorded. Default: 0.92. */
  threshold?: number;
  /** Records fetched per DB batch during a sweep. Default: 200. */
  batchSize?: number;
  /** Max records scanned per space per run (bounds resource use; the rest is picked up next run). Default: 5000. */
  maxPerRun?: number;
  /** Knowledge types to scan. Default: ['fact', 'entity', 'chrono']. */
  types?: DupeScanType[];
}

/**
 * Background contradiction scanner (F-REVIEW).
 *
 * Separate from `dupeScanner` rather than a flag on it, because the two answer different questions and
 * cost differently: a duplicate is a cosine score that always answers and costs nothing, while a
 * contradiction may need an entailment (NLI) model — a call per candidate pair, and with an external
 * endpoint that means record text leaving the instance. Sharing one switch would make enabling duplicate
 * detection silently start paying for model inference.
 *
 * **Off by default**, like the duplicate scanner. Until it is enabled, contradictions are only found when
 * an admin runs `POST /api/contradictions/scan` by hand.
 */
export interface ContradictionScannerConfig {
  /** Master switch. Default: false. */
  enabled?: boolean;
  /** Cron schedule for the sweep. Default: '30 3 * * *' (03:30 daily). */
  schedule?: string;
  /**
   * Similarity floor for the STRUCTURED pass. Default: 0.85.
   *
   * **NOT raw cosine.** `$vectorSearch` normalises cosine to `(1 + cos) / 2`, so 0.85 here means cosine
   * ≈ 0.70, and the previous 0.92 meant cosine ≈ 0.84. Reading these as cosine makes them sound roughly
   * twice as strict as they are — and setting 0.7 "so the records are at least related" would really mean
   * cosine 0.4, where plenty of unrelated text lands.
   *
   * Loosened from the inherited duplicate threshold because 0.92 asks "are these the same record?", which
   * is the right question for de-duplication and the wrong one here: two records can contradict without
   * being near-identical. The structured judge is deterministic and free per pair, so a somewhat wider net
   * costs nothing but review attention.
   */
  structuredThreshold?: number;
  /**
   * Similarity floor for the NLI pass. Default: **0.85 when the judge is local, 0.92 when it is remote**.
   *
   * Same normalised scale as `structuredThreshold`. The gap is not about speed — an MNLI encoder is one
   * forward pass either way — but about egress: every pair judged remotely is record text leaving the
   * instance, and no amount of hardware makes that cheaper. A local sidecar can afford the same net as the
   * free pass.
   */
  nliThreshold?: number;
  /**
   * Cap on how many pairs the NLI pass may judge in one run. Default: **unlimited when local, 2000 when
   * remote**. 0 means unlimited.
   *
   * Hitting the cap is an ORDERLY stop, not a stall: the pairs it did judge are settled and the cursor
   * advances past them, so the next run resumes where it left off. Only an unavailable judge parks the
   * cursor. Conflating the two would either re-judge the same pairs forever or silently skip them.
   */
  maxJudgedPairsPerRun?: number;
  /** Records fetched per DB batch during a sweep. Default: 200. */
  batchSize?: number;
  /** Max records scanned per space per run. Default: 5000. */
  maxPerRun?: number;
}

/**
 * A per-space duplicate-action rule. When the scanner finds a pair whose score
 * is at or above `minScore` (and whose type is in `types`, if set), the rule's
 * `action` decides what happens. Rules are evaluated highest-`minScore` first;
 * the first match wins; no match falls back to `flag`.
 */
export interface DupeActionRule {
  /** Apply this rule when the pair's cosine score is ≥ this. */
  minScore: number;
  /**
   * - `flag`     — record a reviewable candidate (default, non-destructive).
   * - `automerge`— entities only: merge losslessly when there is no value
   *                conflict, else fall back to `flag`. Uses the existing entity merge.
   * - `notify`   — emit a `duplicate.detected` webhook (both records + score).
   */
  action: 'flag' | 'automerge' | 'notify';
  /** Restrict this rule to these knowledge types (default: any scanned type). */
  types?: DupeScanType[];
  /**
   * `notify` only: POST directly to this URL (SSRF-validated) instead of the
   * webhook-subscription system. Omit to use subscriptions (the default).
   */
  webhookUrl?: string;
}

// `AuditLogEntry` moved to `audit/entry.ts`. An audit row is not configuration — it was here only
// because this file was where types went, which is the god-file failure the ratchet describes: every
// change lands in the same place because that is where the code already is.


export interface Config {
  instanceId: string;
  instanceLabel: string;
  publicUrl?: string;         // optional canonical public URL for this brain instance
  /** Ed25519 public signing key (SPKI PEM) for this instance. Published to peers
   *  so they can verify our signed governance vote casts. Private half is in
   *  secrets.json. Generated on first startup after setup. */
  signingPublicKey?: string;
  /** Present after a signing-key rotation: a proof (signed by the previous key)
   *  that the current `signingPublicKey` supersedes it. Advertised to peers via
   *  gossip so they can safely re-pin. */
  signingKeyRotation?: { previousPublicKey: string; proof: string };
  tokens: TokenRecord[];
  spaces: SpaceConfig[];
  networks: NetworkConfig[];
  ejectedFromNetworks?: string[];  // network IDs this instance has been removed from via vote
  embedding?: EmbeddingConfig;
  storage?: StorageConfig;
  /** Optional media embedding pipeline (image / audio / video). Off by default. */
  mediaEmbedding?: MediaEmbeddingConfig;
  /**
   * When true, deleting a file flags its metadata record as deleted
   * (`deletedAt = <now>`) instead of removing it, keeping an audit trail. Flagged
   * records stay listed and searchable but are marked "deleted" in the UI, and only
   * a flagged/orphaned record (one whose file no longer exists) may be purged — a
   * metadata record whose file is still present cannot be deleted directly.
   * Default false (delete the metadata record immediately, the historical behavior).
   * Derived records (conversion chunks / `_converted` / `_extracted`) are always
   * hard-removed regardless of this setting.
   */
  softDeleteFileMeta?: boolean;
  maxUploadBodyBytes?: number;
  /** Max total size (bytes) a chunked upload may declare via Content-Range.
   *  Default 10 GiB. The storage quota (if configured) applies on top. */
  maxChunkedUploadBytes?: number;
  /** Max input size (bytes) accepted by the document conversion pipeline
   *  (pdf/docx/epub/html/md/txt → markdown chunks). Default 100 MiB; HTML is
   *  additionally capped at 25 MiB because jsdom parses it in-process. */
  maxDocumentConversionBytes?: number;
  /**
   * **RETIRED — read by no code path.** Kept so a config that sets it still loads, and so the security
   * posture can tell the operator it does nothing rather than leaving them to assume it does.
   *
   * In the first prototype this opted the instance IN to a boot warning when `allowInsecurePlaintext` was
   * true and the host had a non-loopback interface — "all traffic including tokens is unencrypted". That
   * warning was superseded by the posture block (#276), and the flag was left behind with no reader. The
   * posture line written for it then inverted its meaning, reporting that "the plaintext-exposure guard
   * is disabled" — a guard that has never existed under that name.
   *
   * **The control that actually rejects plaintext requests is {@link requireEncryptedTransport}.** Not
   * deleted outright: silently dropping a key an operator has in their config is a worse trade than
   * leaving a documented retirement behind. (`SpaceMeta.tagSuggestions` was the other field kept on
   * this reasoning; it was removed in 3.0 once the deprecation had a major to land in. This one has
   * no such announcement, so it stays.)
   */
  allowInsecurePlaintext?: boolean;
  /**
   * Require the on-disk state files (config/secrets/schema-library/schema-catalogs) to be encrypted
   * at rest. Default false. When true, the instance refuses to boot unless a master secret is
   * configured (`YTHRIL_MASTER_KEY` or `YTHRIL_MASTER_PASSPHRASE`). Also settable via the
   * YTHRIL_REQUIRE_ENCRYPTED_AT_REST env var (checkable before config is even read).
   */
  requireEncryptedAtRest?: boolean;
  /**
   * Security posture: when `strict` is true (or env `YTHRIL_SECURITY_STRICT`), any FAIL-level finding in
   * the startup posture check aborts boot (WARN findings stay advisory). Default false — the individual
   * `require*` flags remain the authoritative enforcement; this is the aggregate "don't start if
   * misconfigured" switch.
   */
  security?: { strict?: boolean };
  /**
   * Express `trust proxy` setting. Default `false` — the out-of-the-box compose
   * deployment is exposed directly, so `req.ip` must come from the socket, not a
   * client-supplied X-Forwarded-For (which would let an attacker spoof the IP
   * that rate limiting and the audit log key on). Set to the exact number of
   * proxy hops (NOT `true`) only when a known reverse proxy terminates client
   * connections. Accepts Express's native values: boolean | hop count |
   * 'loopback' | a comma-separated CIDR/IP list. Overridable via the
   * TRUST_PROXY environment variable.
   */
  trustProxy?: boolean | number | string | string[];
  /** Max redirect hops followed (and re-validated) during webhook delivery.
   *  Default 3; clamped to [0, 20]. Env var WEBHOOK_MAX_REDIRECTS overrides. */
  webhookMaxRedirects?: number;
  setup?: { completed: true };
  mongo?: { uri?: string };
  /** Optional OpenID Connect configuration for SSO login. */
  oidc?: OidcConfig;
  /** Optional external theming configuration. */
  theme?: {
    /** URL to an external CSS stylesheet that overrides Ythril's default CSS custom properties. */
    cssUrl?: string;
  };
  /**
   * Optional embedding configuration for portal-style deployments.
   *
   * SECURITY — opt-in, and the integrator explicitly accepts the risk. By default
   * this is absent and Ythril behaves exactly as before: only same-origin pages may
   * frame it (`frame-ancestors 'self'`) and only same-origin `ythril:theme`
   * postMessages are honoured.
   *
   * Listing an origin here grants that origin BOTH rights at once:
   *  - it may embed Ythril in an iframe (added to CSP `frame-ancestors`), and
   *  - it may push runtime theme tokens via `postMessage`.
   *
   * Entries must be exact, scheme-qualified origins with no path/query/fragment —
   * e.g. `https://portal.example.com`. `https:` is required (except http on
   * localhost/127.0.0.1 for development). Wildcards (`*`) are never accepted.
   * Framing a page is a clickjacking primitive and theming it can be used to spoof
   * UI, so only list hosts you control.
   */
  embed?: {
    /** Origins allowed to iframe Ythril and to push theme tokens. Empty/absent = same-origin only. */
    allowedOrigins?: string[];
  };
  /** Optional audit log configuration. */
  audit?: AuditConfig;
  /** Optional background semantic-duplicate scanner. Off by default. */
  dupeScanner?: DupeScannerConfig;
  /** Optional background contradiction scanner. Off by default. */
  contradictionScanner?: ContradictionScannerConfig;
  /**
   * Allow sync peers to live on private/reserved addresses (RFC-1918, CGNAT,
   * IPv6 ULA) — for same-host or LAN deployments. Default false (public peers
   * only). Even when true, crown-jewel addresses (loopback, link-local/IMDS,
   * unspecified) stay blocked. Overridable via SYNC_ALLOW_PRIVATE_PEERS.
   */
  allowPrivatePeers?: boolean;
  /**
   * Allow sync peers to be reached over plaintext `http://`. Default false —
   * peer URLs must use `https://`, so sync traffic (which carries record data and
   * bearer tokens) is encrypted in transit. Set true only to permit `http://`
   * peers on a trusted private network you fully control. Overridable via
   * SYNC_ALLOW_INSECURE_PEERS. Ignored (forced false) when
   * `requireEncryptedTransport` is set. See [[transport-security]].
   */
  allowInsecurePeers?: boolean;
  /**
   * Instance-wide "encrypted transport only" switch. Default false. When true:
   *  - every inbound request must arrive over HTTPS (`req.secure`) — plaintext
   *    requests are rejected 403 (loopback is exempted for health checks);
   *  - `http://` sync peers are hard-blocked at admission AND connection time,
   *    overriding `allowInsecurePeers`.
   * Requires `trustProxy` to be set correctly when a reverse proxy terminates TLS
   * (otherwise `req.secure` is always false behind the proxy). Overridable via
   * REQUIRE_ENCRYPTED_TRANSPORT.
   */
  requireEncryptedTransport?: boolean;
  /**
   * Allow the **external** model/media provider endpoints (vision, STT, embedding, document assist) to
   * live on private/reserved addresses — a self-hosted OpenAI-compatible inference service behind a
   * cluster address, e.g. `http://vllm.models.svc.cluster.local:8080`.
   *
   * Why this exists: `external` selects the OpenAI wire protocol and `local` selects Ollama's, so an
   * operator running llama.cpp/vLLM/LocalAI on a private address had NO usable shape — `local` speaks a
   * protocol their server does not implement, and `external` rejected the address at save time.
   *
   * Enabling it does NOT drop the egress guard: those calls still go through `ssrfSafeFetch`, which
   * DNS-resolves, pins the resolved IP for the connection and re-validates every redirect — only the
   * private-address rejection relaxes. A declared-private external endpoint is therefore *better*
   * protected than a `local` provider, which uses a plain `fetch`. Crown-jewel addresses (loopback,
   * link-local / cloud IMDS, unspecified) stay blocked either way.
   *
   * Env/config only, deliberately NOT settable through `PATCH /api/admin/media-config`: an endpoint that
   * becomes an egress target must never be widenable from the admin API. Mirrors `allowPrivatePeers`.
   * Overridable via YTHRIL_ALLOW_PRIVATE_MODEL_ENDPOINTS.
   */
  allowPrivateModelEndpoints?: boolean;
  /**
   * Per-endpoint override of {@link allowPrivateModelEndpoints}, keyed by model slot
   * (`vision`, `stt`, `embedding`, `rerank`, `nli`, `assist`, `docVlm`, `docRepair`, `docVerify`,
   * `faceExternal`).
   *
   * The global flag is all-or-nothing, which is wrong for the common deployment: everything on the
   * operator's own infra except one model that genuinely lives on the public internet. Turning the global
   * flag on to reach the internal ones also relaxes the guard on that one external endpoint — the single
   * place where a private-address resolution means "something is wrong", not "this is my cluster".
   *
   * A value here **wins over the global in both directions**, so `{ "assist": false }` alongside
   * `allowPrivateModelEndpoints: true` keeps the external slot strict. Slots left out inherit the global.
   * Env override per slot: `YTHRIL_ALLOW_PRIVATE_<SLOT>` (`YTHRIL_ALLOW_PRIVATE_DOC_VLM`, …), accepting
   * `true` **or** `false` — a `false` is meaningful here, unlike on the global flag.
   *
   * Same admin-surface exclusion as the global flag, and the crown-jewel ranges stay blocked regardless.
   */
  allowPrivateModelEndpointsBySlot?: Partial<Record<
    'vision' | 'stt' | 'embedding' | 'rerank' | 'nli'
    | 'assist' | 'docVlm' | 'docRepair' | 'docVerify' | 'faceExternal',
    boolean
  >>;
  /**
   * Per-slot model tuning — how long ONE call to each model slot may take.
   *
   * Top-level, beside `allowPrivateModelEndpointsBySlot`, and for the same reason: the ten slots live in three
   * different config homes (`mediaEmbedding.vision/stt/nli/rerank`, top-level `embedding`, and
   * `mediaEmbedding.documentProcessing.*`), so anything nested under one of them would be the wrong home for
   * the others. Keyed by slot, every slot is reached the same way.
   *
   * Absent slots, and absent fields within a slot, take the built-in default — see
   * `config/model-slots.ts`, which owns both the vocabulary and the defaults. Settable through
   * `PATCH /api/admin/media-config` and pinnable per slot via `YTHRIL_PINNED_FIELDS`.
   */
  modelSlots?: ModelSlotsConfig;
  /** Dynamically-registered OAuth clients (RFC 7591) for the MCP browser
   *  authorization flow. Populated automatically when a client registers; not
   *  meant to be hand-edited. See mcp/oauth.ts. */
  oauthClients?: OAuthClientRecord[];
  /** Write-ahead marker for a multi-step space operation (rename/delete) that
   *  spans config + MongoDB + the filesystem and therefore cannot be atomic.
   *  Written (and persisted) BEFORE the physical steps and cleared once the op
   *  commits, so a crash mid-operation is detected on the next boot and completed
   *  idempotently (see reconcilePendingSpaceOp in spaces.ts). Not hand-edited. */
  pendingSpaceOp?: PendingSpaceOp;
}

/** Records an in-flight space rename/delete so it survives a crash. See the
 *  `pendingSpaceOp` field on {@link Config}. */
export interface PendingSpaceOp {
  type: 'rename' | 'delete';
  /** The space being operated on (its current, pre-commit id). */
  spaceId: string;
  /** Target id for a rename. Absent for a delete. */
  newId?: string;
  /** ISO timestamp the operation began, for diagnostics. */
  startedAt: string;
}

/** A dynamically-registered OAuth client for the MCP OAuth flow.
 *  Mirrors the subset of RFC 7591 client metadata Ythril persists; additional
 *  fields returned by the client registration are retained via the index signature. */
export interface OAuthClientRecord {
  client_id: string;
  client_id_issued_at?: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface SecretsFile {
  peerTokens: Record<string, string>;
  totpSecret?: string;              // base32 TOTP secret; absent = MFA disabled
  /** Highest TOTP step counter already consumed. A code is accepted only for a
   *  step strictly greater than this, so a code observed in transit cannot be
   *  replayed within its ±1-step validity window. Reset when MFA is re-enrolled. */
  totpLastStep?: number;
  webhookEncryptionKey?: string;    // hex-encoded AES-256 key for webhook secret encryption
  signingPrivateKey?: string;       // Ed25519 private key (PKCS8 PEM) for signing governance votes
  /**
   * Media embedding provider credentials. Stored here (0o600) instead of
   * config.json so API keys are never world-readable. Env vars
   * (`VISION_API_KEY` / `STT_API_KEY`) still take precedence.
   */
  mediaEmbedding?: {
    visionApiKey?: string;
    sttApiKey?: string;
    nliApiKey?: string;
    rerankApiKey?: string;
  };
}

// ── MongoDB document shapes ────────────────────────────────────────────────

export interface AuthorRef {
  instanceId: string;
  instanceLabel: string;
}

export interface FactDoc extends StampSkewable {
  /**
   * Keep this record stored, but stop it being EMBEDDED — the top tier of the switch a type schema and the
   * space also carry under this same name, resolving `record > schema > space`.
   *
   * Implemented by having NO embedding rather than by a query filter: a vectorless record cannot be
   * returned by $vectorSearch at all, at zero query cost, and it also drops out of the lexical channel
   * because `introduceLexicalOnly` skips what it cannot score. A filter was the obvious design and does
   * not work — `ne` is not natively pushable (`brain/filter.ts:74`), so it would force every recall onto
   * an exhaustive scan, and the positive form would need a backfill of a synced collection.
   *
   * Because it is the absence of a vector rather than a filter, everything that does not RANK still reaches
   * the record in full: `query`, `list`, `get`, the `traverse` tool, and recall's own `traverse` expansion.
   *
   * Absent means included, so no existing record changes. Clearing the flag re-queues an embedding. `false`
   * is "not stated" and falls through to the tiers below rather than overriding them.
   */
  suppressEmbeddings?: boolean;
  /**
   * This record is no longer true.
   *
   * It does NOT affect embedding: a superseded record keeps its vector, keeps ranking, and comes back
   * marked — because hiding it would make *"where did Ada work?"* unanswerable to fix *"where does Ada
   * work?"*. Which record replaced it, if any did, is a `supersedes` edge; see
   * `RECORD_SUPERSEDED_FIELD` in `brain/record-flag.ts` for why those are two facts and not one.
   *
   * Hashed and replicated like any other authored field.
   */
  superseded?: boolean;
  /**
   * The pre-3.1.0 spelling of {@link suppressEmbeddings}, still read and still written beside it.
   *
   * Never offered on either API door. It stays on the document because these collections replicate by
   * whole-document replace, so a peer on an older build must keep finding the key it knows — see
   * `brain/suppress-embeddings.ts` for why dropping it would un-suppress records across a mixed-version
   * network. `_DEPRECATIONS.md` carries its removal.
   */
  _id: string;
  spaceId: string;
  fact: string;
  /** Optional fact type — used to look up typeSchemas.fact for schema validation. */
  type?: string;
  /**
   * Optional since the embedding queue landed — and it is the reason `saveFact` used to be the one
   * creator of four whose write FAILED when the embedder was down. `EntityDoc`, `EdgeDoc` and
   * `ChronoEntry` have always declared this optional and stored the record regardless; only this type
   * demanded a vector, so only this path had no choice but to throw. The asymmetry was in the type.
   */
  embedding?: number[];
  tags: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  /** Pre-embedding source text — the exact string fed to the embedding model. */
  matchedText?: string;
  author: AuthorRef;
  createdAt: string;
  updatedAt: string;
  seq: number;
  embeddingModel?: string;
  forkOf?: string;
  /** Absolute expiry (F10). Set when a per-record `ttlDays` or the space's `recordTtlDays` applies;
   *  the TTL sweep deletes the record (through the normal delete path) once it passes. */
  _expireAt?: Date;
}

export interface EntityDoc extends StampSkewable {
  /**
   * Keep this record stored, but stop it being EMBEDDED — the top tier of the switch a type schema and the
   * space also carry under this same name, resolving `record > schema > space`.
   *
   * Implemented by having NO embedding rather than by a query filter: a vectorless record cannot be
   * returned by $vectorSearch at all, at zero query cost, and it also drops out of the lexical channel
   * because `introduceLexicalOnly` skips what it cannot score. A filter was the obvious design and does
   * not work — `ne` is not natively pushable (`brain/filter.ts:74`), so it would force every recall onto
   * an exhaustive scan, and the positive form would need a backfill of a synced collection.
   *
   * Because it is the absence of a vector rather than a filter, everything that does not RANK still reaches
   * the record in full: `query`, `list`, `get`, the `traverse` tool, and recall's own `traverse` expansion.
   *
   * Absent means included, so no existing record changes. Clearing the flag re-queues an embedding. `false`
   * is "not stated" and falls through to the tiers below rather than overriding them.
   */
  suppressEmbeddings?: boolean;
  /**
   * This record is no longer true.
   *
   * It does NOT affect embedding: a superseded record keeps its vector, keeps ranking, and comes back
   * marked — because hiding it would make *"where did Ada work?"* unanswerable to fix *"where does Ada
   * work?"*. Which record replaced it, if any did, is a `supersedes` edge; see
   * `RECORD_SUPERSEDED_FIELD` in `brain/record-flag.ts` for why those are two facts and not one.
   *
   * Hashed and replicated like any other authored field.
   */
  superseded?: boolean;
  /**
   * The pre-3.1.0 spelling of {@link suppressEmbeddings}, still read and still written beside it.
   *
   * Never offered on either API door. It stays on the document because these collections replicate by
   * whole-document replace, so a peer on an older build must keep finding the key it knows — see
   * `brain/suppress-embeddings.ts` for why dropping it would un-suppress records across a mixed-version
   * network. `_DEPRECATIONS.md` carries its removal.
   */
  _id: string;
  spaceId: string;
  name: string;
  type: string;
  tags: string[];
  description?: string;
  properties: Record<string, string | number | boolean>;
  /** Pre-embedding source text — the exact string fed to the embedding model. */
  matchedText?: string;
  author: AuthorRef;
  createdAt: string;
  updatedAt: string;
  seq: number;
  embedding?: number[];
  embeddingModel?: string;
  /** Absolute expiry (F10) — see FactDoc._expireAt. */
  _expireAt?: Date;
}

export interface EdgeDoc extends StampSkewable {
  /**
   * Keep this record stored, but stop it being EMBEDDED — the top tier of the switch a type schema and the
   * space also carry under this same name, resolving `record > schema > space`.
   *
   * Implemented by having NO embedding rather than by a query filter: a vectorless record cannot be
   * returned by $vectorSearch at all, at zero query cost, and it also drops out of the lexical channel
   * because `introduceLexicalOnly` skips what it cannot score. A filter was the obvious design and does
   * not work — `ne` is not natively pushable (`brain/filter.ts:74`), so it would force every recall onto
   * an exhaustive scan, and the positive form would need a backfill of a synced collection.
   *
   * Because it is the absence of a vector rather than a filter, everything that does not RANK still reaches
   * the record in full: `query`, `list`, `get`, the `traverse` tool, and recall's own `traverse` expansion.
   *
   * Absent means included, so no existing record changes. Clearing the flag re-queues an embedding. `false`
   * is "not stated" and falls through to the tiers below rather than overriding them.
   */
  suppressEmbeddings?: boolean;
  /**
   * This record is no longer true.
   *
   * It does NOT affect embedding: a superseded record keeps its vector, keeps ranking, and comes back
   * marked — because hiding it would make *"where did Ada work?"* unanswerable to fix *"where does Ada
   * work?"*. Which record replaced it, if any did, is a `supersedes` edge; see
   * `RECORD_SUPERSEDED_FIELD` in `brain/record-flag.ts` for why those are two facts and not one.
   *
   * Hashed and replicated like any other authored field.
   */
  superseded?: boolean;
  /**
   * The pre-3.1.0 spelling of {@link suppressEmbeddings}, still read and still written beside it.
   *
   * Never offered on either API door. It stays on the document because these collections replicate by
   * whole-document replace, so a peer on an older build must keep finding the key it knows — see
   * `brain/suppress-embeddings.ts` for why dropping it would un-suppress records across a mixed-version
   * network. `_DEPRECATIONS.md` carries its removal.
   */
  _id: string;
  spaceId: string;
  from: string;
  to: string;
  /**
   * What kind of record each endpoint is — because `from: "abc"` is only unambiguous while every endpoint is
   * an entity, and that stopped being true the moment a file's meta record could be one end of a link.
   *
   * The case that forced it: a photo taken at a party. Its file meta wants to link to the people in it
   * (entities), to the party itself (a chrono event), and to what happened there (a fact). Three
   * collections, and `to` carries a bare id, so nothing in the edge says which one to look in. Guessing by
   * trying each collection in turn is not a fix — two records in different collections may legitimately share
   * an id, and then the answer depends on the order the code happened to try them.
   *
   * **Absent means `entity`.** Not a default written on write — genuinely absent, and read as entity wherever
   * it is consumed. Every edge in every existing space means exactly that, and a synced collection must not
   * be backfilled: a data migration that rewrites replicated documents ships a whole space's worth of edges
   * to every peer as changes. Lazy and self-healing is the standing rule for anything that syncs, and here
   * the lazy reading costs nothing because it is a two-line coalesce at the point of use.
   *
   * A kind that is *stated* and wrong is a different matter from one that is absent, and it is refused:
   * `assertRefsResolve` looks the endpoint up in the collection the kind names, so an edge whose `toKind` says
   * `chrono` and whose `to` is an entity id is rejected at the write rather than stored as a dead link.
   */
  fromKind?: RefKind;
  toKind?: RefKind;
  label: string;
  type?: string;
  weight?: number;
  tags?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  /** Pre-embedding source text — the exact string fed to the embedding model. */
  matchedText?: string;
  author: AuthorRef;
  createdAt: string;
  updatedAt: string;
  seq: number;
  embedding?: number[];
  embeddingModel?: string;
  /** Absolute expiry (F10) — see FactDoc._expireAt. */
  _expireAt?: Date;
}

/**
 * A link record: one record concerns another, and nothing else.
 *
 * ## Why this is not an `EdgeDoc`, and not in `_edges`
 *
 * Owner's design, 2026-08-29: *"make all edges on 'index cards' and make everyone look there from now on"*.
 * Six public array fields say that a record concerns others — `fact.entityIds`, `chrono.entityIds`,
 * `chrono.memoryIds`, and `file.entityIds`/`memoryIds`/`chronoIds` — and each was scanned by a different
 * subset of five disagreeing adjacency readers. They become records, so there is one place to look.
 *
 * They are NOT edges, and the ruling is that `GET /edges` must not see them: an edge is a MODELLED
 * relationship with a label an operator chose, a schema that can govern it, and content of its own to rank.
 * A link is derived from a field and asserts nothing beyond "these two are connected". Mixing them would
 * mean every edge listing suddenly returns thousands of rows nobody wrote.
 *
 * ## The two kinds ARE the class, so nothing here stores which one it is
 *
 * The six classes are `fact→entity`, `chrono→entity`, `chrono→fact`, `file→entity`, `file→fact`,
 * `file→chrono` — six distinct `(fromKind, toKind)` pairs, one per class. So the label a traverse shows
 * stays DERIVED, exactly as `LINK_CLASSES` prints it today (`chrono.entityIds`). Storing it would add a
 * degree of freedom the arrays never had, and two spellings of one fact is the defect shape this codebase
 * produces most.
 *
 * ## What it deliberately has none of
 *
 * No `label`, `type`, `weight`, `properties` or `description`: a link carries no meaning of its own to
 * describe. No `embedding` or `matchedText`, and no `suppressEmbeddings` either — a record with nothing to
 * embed needs no way to say so, and `VECTOR_INDEXED_COLLECTIONS` states in its own comment why this
 * collection must never get a vector index.
 *
 * No `_expireAt`. A link's lifetime is its endpoints' — it is meaningless once either end is gone, and a
 * window of its own could outlive or predecease both. The cascade belongs with the readers, not here.
 */
export interface LinkDoc extends StampSkewable {
  _id: string;
  spaceId: string;
  /** The record that HELD the array — a fact, a chrono entry or a file's meta record. */
  from: string;
  /**
   * What kind of record `from` is.
   *
   * Required here where `EdgeDoc` leaves both kinds optional, and the difference is not an inconsistency.
   * An edge's absent kind means `entity`, which is what every edge in every existing space is; a link has
   * no such default, because three of the six classes have a non-entity at each end. Absent would mean
   * "unknown", and an unknown endpoint kind is a link that cannot be resolved at all.
   */
  fromKind: RefKind;
  /** The record it names. */
  to: string;
  /** What kind of record `to` is. Required, for the reason on {@link LinkDoc.fromKind}. */
  toKind: RefKind;
  author: AuthorRef;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export type ChronoType = 'event' | 'deadline' | 'plan' | 'prediction' | 'milestone';
/**
 * The statuses a chrono entry may carry.
 *
 * A TUPLE, and the type below derives from it — because the five names were also written out as a `Set` in
 * `api/brain/chrono.ts` and again in `brain/bulk.ts`, and a fourth copy in the shared write-shape table got
 * two of them wrong. A union type cannot be iterated at run time, so every door that had to CHECK a status
 * built its own list from the same five words, and nothing compared them.
 */
export const CHRONO_STATUSES = ['upcoming', 'active', 'completed', 'overdue', 'cancelled'] as const;

/** @see CHRONO_STATUSES — derived, never written out a second time. */
export type ChronoStatus = typeof CHRONO_STATUSES[number];

export interface ChronoEntry extends StampSkewable {
  /**
   * Keep this record stored, but stop it being EMBEDDED — the top tier of the switch a type schema and the
   * space also carry under this same name, resolving `record > schema > space`.
   *
   * Implemented by having NO embedding rather than by a query filter: a vectorless record cannot be
   * returned by $vectorSearch at all, at zero query cost, and it also drops out of the lexical channel
   * because `introduceLexicalOnly` skips what it cannot score. A filter was the obvious design and does
   * not work — `ne` is not natively pushable (`brain/filter.ts:74`), so it would force every recall onto
   * an exhaustive scan, and the positive form would need a backfill of a synced collection.
   *
   * Because it is the absence of a vector rather than a filter, everything that does not RANK still reaches
   * the record in full: `query`, `list`, `get`, the `traverse` tool, and recall's own `traverse` expansion.
   *
   * Absent means included, so no existing record changes. Clearing the flag re-queues an embedding. `false`
   * is "not stated" and falls through to the tiers below rather than overriding them.
   */
  suppressEmbeddings?: boolean;
  /**
   * This record is no longer true.
   *
   * It does NOT affect embedding: a superseded record keeps its vector, keeps ranking, and comes back
   * marked — because hiding it would make *"where did Ada work?"* unanswerable to fix *"where does Ada
   * work?"*. Which record replaced it, if any did, is a `supersedes` edge; see
   * `RECORD_SUPERSEDED_FIELD` in `brain/record-flag.ts` for why those are two facts and not one.
   *
   * Hashed and replicated like any other authored field.
   */
  superseded?: boolean;
  /**
   * The pre-3.1.0 spelling of {@link suppressEmbeddings}, still read and still written beside it.
   *
   * Never offered on either API door. It stays on the document because these collections replicate by
   * whole-document replace, so a peer on an older build must keep finding the key it knows — see
   * `brain/suppress-embeddings.ts` for why dropping it would un-suppress records across a mixed-version
   * network. `_DEPRECATIONS.md` carries its removal.
   */
  _id: string;
  spaceId: string;
  title: string;
  description?: string;
  type: ChronoType;
  startsAt: string;
  endsAt?: string;
  status: ChronoStatus;
  confidence?: number;
  tags: string[];
  properties?: Record<string, string | number | boolean>;
  recurrence?: {
    freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval: number;
    until?: string;
  };
  /** Pre-embedding source text — the exact string fed to the embedding model. */
  matchedText?: string;
  author: AuthorRef;
  createdAt: string;
  updatedAt: string;
  seq: number;
  embedding?: number[];
  embeddingModel?: string;
  /** Absolute expiry (F10) — see FactDoc._expireAt. */
  _expireAt?: Date;
  /** When this entry's CONTENT should be dropped while the entry itself stays. Set from the type schema's
   *  `retention.contentDays` (see `TypeSchema.retention`); absent means never. */
  _contentExpireAt?: Date;
  /** True once the content window lapsed and the detail was dropped. Present so a reader can tell
   *  "this record never had a description" from "it did, and it expired" — the same distinction
   *  `changesRedacted` draws in the audit log. */
  contentRedacted?: boolean;
  /** ISO8601 — when the redaction happened. */
  contentRedactedAt?: string;
}

export interface TombstoneDoc {
  _id: string;
  /**
   * `TombstoneType` and not `KnowledgeType`: the four knowledge types plus `link`, never `file`.
   *
   * It read `KnowledgeType`, and `asFilter` casts — so a query for a link tombstone typechecked while the
   * field could not hold the value it was looking for. The declaration is the only place that catches it.
   */
  type: TombstoneType;
  spaceId: string;
  deletedAt: string;
  instanceId: string;
  seq: number;
  /** Seq of the document at the time it was deleted — used to filter tombstones
   *  from pagination pages that already returned the live document. */
  originalSeq?: number;
}

export interface FileTombstoneDoc {
  _id: string;         // UUID
  spaceId: string;
  /** Relative path (same convention as ManifestEntry.path). NOTE: a path is often personal in itself, so this
   *  record outliving the file means the file's NAME survives its deletion. That is the reason retention here
   *  matters, and it is not bounded yet — see below. */
  path: string;
  /** ISO8601. **Nothing prunes on this today.** It used to be documented as "used by peers to prune expired
   *  tombstones", which was never true: the peer pull (`GET /api/sync/file-tombstones`) is called with no
   *  `since` at all, so the full set goes over the wire every cycle and none of it is ever removed. Record
   *  tombstones ARE bounded, by a served-seq floor (`sync/served-watermark.ts`); the file half needs the
   *  equivalent built from push acknowledgement, because its wire protocol has no seq. Until then, treat this
   *  field as provenance only — a comment describing behaviour that does not exist is worse than none,
   *  because it stops the next reader looking. */
  deletedAt: string;
}

export interface FileMetaDoc {
  _id: string;          // space-relative path, normalised to forward slashes
  spaceId: string;
  path: string;         // same as _id — carried as a queryable field
  description?: string; // human-readable summary (optional)
  /**
   * Where `description` came from, when the instance wrote it rather than a person.
   *
   * `generated` = a model answered "what is this file?"; `extracted` = the document's own opening prose,
   * taken verbatim, which is what an instance with no model configured produces. Absent for a description
   * a human wrote, and for records written before the field existed.
   *
   * It exists because "generated" is a claim about provenance: the release note said generated while the
   * value was a truncation of the first paragraph, and nothing in the record could tell the two apart.
   */
  descriptionSource?: 'generated' | 'extracted';
  /**
   * The document's own opening prose — never invented, and an embedding input in its own right.
   *
   * Kept alongside a generated `description` because the two are wanted for different things: the
   * description answers what the file IS, the excerpt is what makes a remembered phrase from the document
   * find the parent record. Only present on converted documents.
   */
  excerpt?: string;
  tags: string[];       // tags for filtering and recall scoping
  properties?: Record<string, string | number | boolean>; // structured metadata (optional)
  /** Pre-embedding source text — the exact string fed to the embedding model. */
  matchedText?: string;
  createdAt: string;    // ISO8601 — first write timestamp
  updatedAt: string;    // ISO8601 — last write timestamp
  sizeBytes: number;    // file size in bytes at last write
  /**
   * SHA-256 of the bytes as last written, when the writer supplied it.
   *
   * Optional and self-healing: absent means "unknown", which the media dispatcher treats as "process it". It is
   * filled by the next write, so nothing has to migrate — which matters because file records SYNC, and a synced
   * data migration has to be lazy rather than a boot step.
   *
   * It exists so re-uploading identical bytes does not re-run vision or speech-to-text over them. See
   * `files/dispatch.ts`.
   */
  sha256?: string;
  author: AuthorRef;    // writer: instanceId + instanceLabel
  /**
   * The space counter at the last AUTHORED write — the ordering primitive replication runs on.
   *
   * ## Why it did not exist before, and what its absence cost
   *
   * A file's metadata did not replicate, so it needed no place in the seq order. `P-32` made it replicate,
   * and every part of the sync mechanism is seq-based: the page cursor, the watermark, and last-writer-wins.
   *
   * Its absence was also a live defect independent of sync. Two writers appending to a file's `entityIds`
   * read, modified and wrote with nothing to order them, so one append could silently drop the other — the
   * only lost-update race in the brain collections, and the only one whose record type had no seq.
   *
   * ## OPTIONAL, and only an AUTHORED write bumps it
   *
   * Optional because a boot migration over synced data is forbidden — see `_REFERENCE.md →
   * migration-strategy`. A record written before 4.0 has none, so it does not page to a peer until it is
   * next written, and `npm run links:convert` stamps the ones already stored.
   *
   * **Derived writes must NOT bump it.** The embedding status, the chunk count, the conversion result and
   * the face labels are computed from the local blob and are neither hashed nor replicated. Bumping on
   * those would page a record to every peer each time one instance finished embedding it, carrying nothing
   * that had changed for them.
   */
  seq?: number;
  /** Set when the file was deleted while `softDeleteFileMeta` is enabled: ISO8601
   *  timestamp of the deletion. The record is retained (still listed/searchable, shown
   *  as "deleted" in the UI) until purged. Absent for live files. */
  deletedAt?: string;
  embedding?: number[];
  embeddingModel?: string;
  // ── Conversion pipeline fields ────────────────────────────────────────────
  /** For chunk records: ID of the parent file's filemeta record (_id = normalised path). */
  parentFileId?: string;
  /** 0-based position of this chunk within the document. */
  chunkIndex?: number;
  /** The H2/H3 heading that opened this chunk (null for paragraph-chunked txt files). */
  headingText?: string | null;
  /** The chunk body text (Markdown). Used as embedding source alongside headingText. */
  content?: string;
  /** For the original file: _id of the converted Markdown file record (binary formats only). */
  convertedFileId?: string;
  /** For the original file: total number of chunk records produced. */
  chunkCount?: number;
  /** Set when conversion failed: human-readable error message. */
  conversionError?: string;
  // ── Media embedding fields ────────────────────────────────────────────────
  /** Detected media class for the original file. Set on image/audio/video uploads. */
  mediaType?: 'image' | 'audio' | 'video';
  /** Async embedding lifecycle for binary media:
   *   "pending"    → enqueued, not yet processed
   *   "processing" → claimed by a worker
   *   "complete"   → all chunk records produced AND embedded
   *   "partial"    → chunks produced but some failed to embed; searchable but incomplete.
   *                  Re-runnable via POST /api/files/:spaceId/retry_embedding.
   *   "failed"     → exhausted retries; mediaJobError carries the reason
   *   "skipped"    → not analysed — file too large (> maxFileSizeBytes), or this media class is `off`
   *                  for the space (its `levels` entry) — original kept, no embedding
   *   "disabled"   → LEGACY: set at upload when the removed media-embedding master switch was off. No
   *                  longer produced (a class turned off now lands as "skipped"); kept so pre-migration
   *                  records still render.
   */
  embeddingStatus?: 'pending' | 'processing' | 'complete' | 'partial' | 'failed' | 'skipped' | 'disabled';
  /** For audio/video chunk records: start offset within the parent media file. */
  chunkOffsetMs?: number;
  /** For audio/video chunk records: duration covered by this chunk. */
  chunkDurationMs?: number;
  /** Last error message from a failed media embedding job, when embeddingStatus="failed". */
  mediaJobError?: string;
  // ── Face recognition fields ───────────────────────────────────────────────
  /**
   * For face-chunk records: 128d face descriptor from @vladmandic/human FaceRes.
   * Stored on separate chunk records ({fileId}#face-chunkN) alongside faceEntityId.
   * Searched via a separate Atlas vector index (path: faceEmbedding).
   */
  faceEmbedding?: number[];
  /** Entity ID matched at embedding time (auto or manual label). */
  faceEntityId?: string;
  /** Bounding box of the detected face within the original image [x,y,w,h] as 0–1 fractions. */
  faceBbox?: [number, number, number, number];
  /** Recognition confidence score (cosine similarity to gallery match, 0–1). */
  faceScore?: number;
}

export interface ConflictDoc {
  _id: string;
  spaceId: string;
  originalPath: string;   // relative path of the local file (version kept)
  conflictPath: string;   // relative path of the conflict copy (incoming version renamed)
  peerInstanceId: string;
  peerInstanceLabel: string;
  detectedAt: string;     // ISO8601
}

/**
 * Recorded when a sync-ingested document violates strict linkage rules.
 * The document is still accepted (sync must not be blocked), but the
 * violation surfaces in the conflicts/warnings API so the user can
 * remediate (fix the document, disable strictLinkage, or leave network).
 */
export interface LinkViolationDoc {
  _id: string;            // UUID v4
  spaceId: string;
  docId: string;          // ID of the violating document — an id, or a path when docType is 'file'
  /*
   * `RecordType` rather than `KnowledgeType`, since `Q-39`: a FILE's links are checked too, and a violation
   * it causes has to be able to say so. The union is the knowledge types plus `file` and is derived from
   * `RECORD_TYPES`, so it cannot drift from the kinds that actually exist.
   */
  docType: RecordType;
  field: string;          // field name that violated (e.g. "from", "to", "entityIds")
  reason: string;         // human-readable explanation
  peerInstanceId: string; // which peer sent the document
  detectedAt: string;     // ISO8601
}

export interface SpaceCounterDoc {
  _id: string;  // spaceId
  seq: number;
}

/**
 * A semantically-duplicate pair recorded by the background scanner, stored in
 * `${spaceId}_dupe_candidates`. The `_id` is a canonical pair key so the same
 * pair is only ever recorded once regardless of which member is scanned first.
 */
/**
 * One contradiction candidate — a pair of records in a space that appear to DISAGREE (F-REVIEW).
 *
 * Shaped after `DupeCandidateDoc` on purpose: same identity scheme, same sticky-dismissal contract, so the
 * Review tab's two sub-views share one vocabulary and `decideDismissed` serves both.
 *
 * The difference that matters is `basis`. A duplicate has a similarity SCORE; a contradiction has a REASON,
 * and the two reasons are not equally strong. `structured-field` is deterministic — the records literally
 * set the same single-valued property to different values. `nli` is a model's opinion, so it carries a
 * confidence and deserves to be labelled as such in the UI: a reviewer should be able to tell "these two
 * disagree on `port`" from "a model thinks these disagree".
 *
 * There is deliberately NO record for an *unjudged* pair. When the judge cannot answer (no endpoint,
 * outage, low confidence), nothing is written and the scan cursor does not treat the pair as settled — so
 * it is re-examined later. Writing an "unjudged" row would be worse than useless: it would look like a
 * reviewed-and-clean pair to every query that filters on status.
 */
export interface ContradictionCandidateDoc {
  _id: string;            // canonical `${aId}:${bId}` with aId < bId
  spaceId: string;
  /** Which collection the pair lives in — contradictions are judged within one kind of record. */
  type: DupeScanType;
  aId: string;
  aSummary: string;
  aSeq: number;
  bId: string;
  bSummary: string;
  bSeq: number;
  /** How the disagreement was established. */
  basis: 'structured-field' | 'nli';
  /** 1 for a deterministic structured conflict; the model's confidence for an `nli` verdict. */
  confidence: number;
  /** The disagreeing single-valued properties — present only when `basis` is `structured-field`. */
  fields?: { key: string; aValue: string | number | boolean; bValue: string | number | boolean }[];
  /**
   * The judged text was long enough that the model's window probably cut it — so this verdict may describe
   * the OPENING of a record rather than the record. A proxy, never a measurement: we do not truncate, the
   * encoder does, invisibly and without changing the confidence. Absent means "not long enough to worry
   * about", not "the whole text was read". See `NLI_LIKELY_TRUNCATED_CHARS`.
   */
  truncated?: true;
  status: 'open' | 'dismissed' | 'resolved';
  /**
   * How a resolved candidate was actioned.
   *
   *   `edited`      a record was corrected.
   *   `linked`      a contradicts/supersedes edge was drawn by hand instead of changing either record.
   *   `superseded`  the reviewer picked a winner. Distinct from `linked` because the SYSTEM acted on it:
   *                 `supersededId` names the loser, and for an entity pair a `supersedes` edge was drawn.
   *                 Not a merge — neither record is deleted or absorbed; both are still real, and one is now
   *                 marked as having been overtaken by the other.
   */
  resolution?: 'edited' | 'linked' | 'superseded';
  /** The record the reviewer decided is out of date. Present only for `superseded`. */
  supersededId?: string;
  /**
   * Who decided, as the token's NAME — never the token itself.
   *
   * A resolution is a judgement call between two real records, so "someone settled this" is not enough for
   * the next reviewer to act on: they need to know whether to ask, and whom. The audit log records the actor
   * too, but a reviewer reading the Review tab is not reading the audit log.
   */
  resolvedBy?: string;
  /** Same sticky-dismissal contract as duplicates — see `decideDismissed`. */
  dismissedContentHash?: string;
  detectedAt: string;
  updatedAt: string;
}

export interface DupeCandidateDoc {
  _id: string;            // canonical `${type}:${aId}:${bId}` with aId < bId
  spaceId: string;
  type: DupeScanType;
  aId: string;            // lexicographically smaller record id
  aSummary: string;       // short human summary of record a
  aSeq: number;           // record a's seq at last detection (change → re-detect)
  bId: string;            // lexicographically larger record id
  bSummary: string;       // short human summary of record b
  bSeq: number;           // record b's seq at last detection
  score: number;          // cosine similarity at last detection
  /** open = awaiting review; dismissed = reviewed/not-a-dup; resolved = auto-actioned (merged/notified). */
  status: 'open' | 'dismissed' | 'resolved';
  /** How a resolved candidate was actioned (present only when status = 'resolved'). */
  resolution?: 'merged' | 'notified';
  /**
   * Content fingerprint of the pair (both records' embedded text) captured when it was dismissed.
   * A dismissed pair is sticky against seq bumps that DON'T change content — a re-embed, a peer
   * re-sync, an index rebuild — but re-opens automatically when the content materially changes
   * (this hash no longer matches). Present only while `status = 'dismissed'`; undefined on a legacy
   * dismissal (pre-this-feature), which is treated as sticky and back-filled on the next scan.
   */
  dismissedContentHash?: string;
  detectedAt: string;     // ISO8601 — first detection
  updatedAt: string;      // ISO8601 — last re-detection
}

/**
 * Per-(space, type) scan cursor for the duplicate scanner, stored in the global
 * `ythril_dupe_scan_state` collection. `cursorSeq` is the highest `seq` already
 * swept — the next run scans records with a greater `seq` (new or edited).
 */
export interface DupeScanStateDoc {
  _id: string;            // `${spaceId}:${type}`
  spaceId: string;
  type: DupeScanType;
  cursorSeq: number;
  updatedAt: string;      // ISO8601
}

/**
 * Background job record for asynchronous media embedding (caption/STT + chunking)
 * and text document embedding (chunking + vector embedding).
 * Stored in the per-space `<spaceId>_media_jobs` collection and claimed by the
 * MediaEmbeddingWorker. The corresponding filemeta record's `embeddingStatus`
 * mirrors `status` (pending/processing/complete/failed).
 */
export interface MediaJobDoc {
  _id: string;                // file _id (normalised path) — one job per file
  spaceId: string;
  filePath: string;           // normalised path on disk
  mimeType: string;           // raw upload MIME type
  mediaType: 'image' | 'audio' | 'video' | 'text';
  /** For text jobs: the resolved document format (md, txt, html, pdf, docx, epub). */
  resolvedFormat?: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  claimedAt: string | null;   // ISO8601 — set when a worker claims this job
  /**
   * ISO8601 — last time this job did something. Set when claimed, then advanced by the worker every
   * time a unit of work completes (a page rendered, a page transcribed, a stage finished).
   *
   * Stall detection reads THIS, not `claimedAt`. A wall-clock deadline measured from the claim
   * cannot tell "wedged" from "slow", so a genuinely long job — a 400-page PDF being transcribed a
   * page at a time — was requeued mid-flight for the crime of taking a while, then re-claimed and
   * killed again at the same point: an infinite loop that burns the model budget and never finishes.
   * Measuring from the last sign of life means the timeout fires only when nothing is happening.
   */
  progressAt?: string | null;
  /**
   * The last step report from the worker: which stage is running, the full route this document
   * takes, and how far through the current stage it is. Written in the same update as the
   * heartbeat, so surfacing progress costs no extra writes.
   */
  progress?: { step: string; steps: string[]; done?: number; total?: number };
  /**
   * Identifies the RUN that holds this job, not the job. Set on claim, cleared by stall recovery.
   *
   * Every heartbeat matches on it, so a run whose job was recovered while it was still working discovers
   * that on its next tick and abandons — instead of embedding the same file alongside the new claimant,
   * writing the same chunk ids, and possibly reporting `complete` on a job the queue has re-queued.
   * Absent on jobs claimed by a build that predates the field; the heartbeat then behaves as it used to.
   */
  claimToken?: string | null;
  /**
   * ISO8601 — when set on a `pending` job, the worker MUST NOT claim it
   * until this timestamp has passed. Used for exponential retry backoff so
   * a fast-failing "poison pill" job can’t monopolise the queue and starve
   * sibling jobs that would otherwise succeed. Cleared on success/manual retry.
   */
  claimableAfter?: string | null;
  createdAt: string;          // ISO8601
  updatedAt: string;          // ISO8601
}


/**
 * The brain record types that carry their own embedding and therefore their own embedding job.
 *
 * `file` is deliberately absent: file and media embedding already has its own queue
 * (`files/media/job-queue.ts`) with a richer job shape — per-page progress, chunking, a provider
 * signature. Folding it in here would replace a working, more capable mechanism with a simpler one.
 */
/**
 * `file` joined the four brain types on 2026-08-07, and for a correctness reason rather than tidiness.
 *
 * `updateFileMeta` used to compute the vector itself from the record as it had READ it, while every content
 * field it wrote was guarded by `opts.X !== undefined` and the embedding was not. Two concurrent writes to
 * different fields therefore both landed, lost no field, and left the stored vector describing a record that
 * existed nowhere. The four brain updates had the identical defect and were fixed by handing the work to this
 * queue, whose `embedStoredRecord` re-reads the document after the write; files needed to be IN the queue
 * before the same fix could apply to them.
 *
 * The alternative — a second re-embed mechanism just for files — is what produced the bug in the first place:
 * the update path had its own copy of the embed-text builder while the queue had `buildEmbedText`.
 */
/** One of the five names this repo had for {@link RecordType}. Kept as an alias so call sites read well. */
export type BrainEmbedRecordType = RecordType;

/**
 * One queued embedding job. `_id` is `<recordType>:<recordId>`, so a record rewritten five times has
 * ONE job holding its latest content rather than five queued deep.
 *
 * A completed job is deleted rather than kept — the record itself carries `embeddingStatus`, so a
 * retained job would be a second copy of one fact, and brain records outnumber files by orders of
 * magnitude.
 */
export interface BrainEmbedJobDoc {
  /** `<recordType>:<recordId>` — see `embedJobId`. */
  _id: string;
  spaceId: string;
  recordType: BrainEmbedRecordType;
  recordId: string;
  status: 'pending' | 'processing' | 'failed';
  /**
   * The PERMANENT-failure budget. Spent only on errors that a retry cannot fix — a malformed input, a 400
   * from a reachable embedder. See `transientFailures` for the other kind.
   */
  attempts: number;
  maxAttempts: number;
  /**
   * How many times this job has failed for a reason that is not its own: the embedder unreachable, a 503, a
   * rate limit. Absent on every job written before this existed, which reads as 0.
   *
   * It is separate from `attempts` because the two answer different questions and one counter cannot do
   * both. `attempts` decides when to give up; this decides how long to wait. Counting an outage against the
   * budget is what took every queued job in every space terminal at once during an upgrade — five attempts
   * over twelve and a half minutes, spent on a sidecar that was restarting.
   */
  transientFailures?: number;
  lastError: string | null;
  /** ISO8601 — set when a worker claims this job. */
  claimedAt: string | null;
  /**
   * ISO8601 — last sign of life. Stall detection reads THIS, not `claimedAt`: a deadline measured from
   * the claim cannot tell "wedged" from "slow", and a cold model load is slow.
   */
  progressAt?: string | null;
  /** ISO8601 — retry backoff; the job is `pending` but not claimable until this passes. */
  claimableAfter?: string | null;
  /** Identifies THIS run of THIS job, so a recovered job's old holder learns it was replaced. */
  claimToken?: string | null;
  /**
   * The server version this job was last revived FOR — see `reviveFailedEmbedJobs`.
   *
   * A terminal `failed` job is never claimed again, so a systemic outage during an upgrade could take every
   * job in every space terminal and nothing would ever run them. This field is what makes the repair
   * bounded: one clean attempt per version, absent meaning "never revived", so a restart on the same
   * version cannot churn a genuinely-bad record.
   */
  revivedForVersion?: string | null;
  createdAt: string;
  updatedAt: string;
}
