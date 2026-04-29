export interface TokenRecord {
  id: string;
  name: string;
  hash: string;         // bcrypt hash
  prefix: string;       // first 8 chars of the plaintext token — fast lookup hint
  createdAt: string;    // ISO8601
  lastUsed: string | null;
  expiresAt: string | null;
  spaces?: string[];    // allowlist of space IDs; omit = all spaces
  admin: boolean;       // true = may access admin-gated routes
  readOnly?: boolean;   // true = read-only access; all mutations blocked
  peerInstanceId?: string; // set on tokens created for network peers — links this PAT to the peer that uses it inbound
  schemaLibrary?: boolean; // true = only valid on GET /api/schema-library/public*; no space access
}

// ── Space meta / schema types ──────────────────────────────────────────────

/** Numeric merge functions available for `type: "number"` properties. */
export type NumericMergeFn = 'avg' | 'min' | 'max' | 'sum';

/** Boolean merge functions available for `type: "boolean"` properties. */
export type BooleanMergeFn = 'and' | 'or' | 'xor';

/** All merge functions (numeric + boolean). */
export type MergeFn = NumericMergeFn | BooleanMergeFn;

/** Subset of JSON Schema used for property value validation. */
export interface PropertySchema {
  /** Declared value type. 'date' is stored as ISO string; UI renders a date picker. */
  type?: 'string' | 'number' | 'boolean' | 'date';
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  /** Merge function applied when two entities are merged and both have this property.
   *  Numeric: avg, min, max, sum. Boolean: and, or, xor.
   *  Must be compatible with the declared `type`. */
  mergeFn?: MergeFn;
  /** When true, writes that omit this property are flagged as a schema violation. */
  required?: boolean;
  /** Default value applied on write when the property is absent. */
  default?: string | number | boolean;
}

/** Schema definition for a single entity type, edge label, memory type, or chrono type. */
export interface TypeSchema {
  /**
   * Reference to an instance-level schema library entry.
   * Format: `"library:<name>"` (e.g. `"library:service-v1"`).
   * When present, the library entry's schema is used for validation instead of any
   * inline fields.  Inline fields on the same object are ignored when `$ref` is set.
   */
  $ref?: string;
  /**
   * @internal Set by resolveMetaRefs() when a `$ref` cannot be resolved to a library entry.
   * Never present in stored config; only exists on in-memory resolved copies.
   * Causes validate* functions to emit a schema_ref_unresolved violation.
   */
  _unresolvedRef?: string;
  /** Regex pattern for entity.name validation (entity collection only). */
  namingPattern?: string;
  /** Non-enforced tag hints surfaced in UI autocomplete for items of this type. */
  tagSuggestions?: string[];
  /** Property key → JSON Schema subset for value validation and merge hints. */
  propertySchemas?: Record<string, PropertySchema>;
}

/** Validation mode for write operations against a space's schema. */
export type ValidationMode = 'off' | 'warn' | 'strict';

/** Knowledge type keys used in typeSchemas. */
export type KnowledgeType = 'entity' | 'memory' | 'edge' | 'chrono';

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

/** Structured schema and metadata for a space — all fields optional. */
export interface SpaceMeta {
  /** Version counter — auto-incremented on every meta change. */
  version?: number;
  /** Short directive injected into MCP instructions at handshake. Max 4 000 chars. */
  purpose?: string;
  /** Extended Markdown prose — naming conventions, examples, links. Shown in UI only. */
  usageNotes?: string;
  /** Validation enforcement level. Default: 'off'. */
  validationMode?: ValidationMode;
  /**
   * Per-type schemas for each knowledge collection.
   * Keys of typeSchemas.entity are the allowed entity type values (allowlist).
   * Keys of typeSchemas.edge are the allowed edge label values (allowlist).
   * Keys of typeSchemas.memory / .chrono are the allowed type values.
   * When a collection's map is empty, all type/label values are accepted.
   */
  typeSchemas?: Partial<Record<KnowledgeType, Record<string, TypeSchema>>>;
  /** Non-enforced global tag hints — fallback when no per-type tagSuggestions match. */
  tagSuggestions?: string[];
  /** When true, all reference fields (edge from/to, entityIds, memoryIds) must be
   *  valid UUID v4 values, and entity deletion is blocked while inbound backlinks exist. */
  strictLinkage?: boolean;
  /** ISO8601 timestamp of the last meta update. */
  updatedAt?: string;
  /** History of previous meta versions (most recent first, capped). */
  previousVersions?: Array<{ version: number; meta: Omit<SpaceMeta, 'previousVersions'>; updatedAt: string }>;
}

export interface SpaceConfig {
  id: string;
  label: string;
  builtIn: boolean;
  folders: string[];
  maxGiB?: number;
  flex?: number;
  description?: string; // shown to MCP clients as space-level instructions
  proxyFor?: string[];  // virtual proxy space — aggregates reads, routes writes to member spaces
  meta?: SpaceMeta;     // structured schema and metadata — all fields optional
}

export interface EmbeddingConfig {
  /** If set, route embedding requests to this OpenAI-compatible HTTP endpoint.
   *  If absent, the bundled local ONNX model is used (default, works out of the box). */
  baseUrl?: string;
  model: string;
  dimensions: number;
  similarity: 'cosine' | 'dotProduct' | 'euclidean';
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
  /** Model tag passed to the provider (e.g. `moondream2`, `gpt-4o-mini`,
   *  `whisper-1`, `base`). */
  model?: string;
  /** Optional API key for endpoints that require Authorization.
   *  When empty, no Authorization header is sent.
   *  Stored in config.json by the Settings UI; for production deployments
   *  prefer an env-var override (`VISION_API_KEY` / `STT_API_KEY`) which
   *  takes precedence and locks this field as read-only in the UI. */
  apiKey?: string;
}

/**
 * Media embedding pipeline configuration.
 *
 * Routes binary media (image / audio / video) through text-as-intermediate
 * captioning + STT so every embedding lands in the same vector space as
 * memories, entities and converted documents (`nomic-embed-text-v1.5`).
 *
 * Off by default — must be explicitly enabled in config.json or via
 * `MEDIA_EMBEDDING_ENABLED=true` once the config loader is implemented.
 *
 * ── Plugin model ────────────────────────────────────────────────────────────
 * Vision and STT are pluggable via the generic `vision` / `stt`
 * `MediaProviderConfig` blocks. Any OpenAI-compatible endpoint works
 * out-of-the-box; switching providers is a config edit, not a code change.
 *
 * ── Planned resolution order (high → low precedence; not yet active) ────────
 * When `getMediaEmbeddingConfig()` in the loader is implemented, it will apply:
 *   1. Env vars (`MEDIA_EMBEDDING_ENABLED`, `VISION_PROVIDER`, `OLLAMA_URL`,
 *      `VISION_MODEL`, `VISION_API_KEY`, `STT_PROVIDER`, `WHISPER_URL`,
 *      `WHISPER_MODEL`, `STT_API_KEY`, …)
 *   2. `config.json` `mediaEmbedding.*` (writable from the UI)
 *   3. Built-in defaults
 *
 * When an env var supplies a value, `lockedByInfra` will list that field so
 * the Settings UI can render it read-only (locked-by-infra).
 */
export interface MediaEmbeddingConfig {
  /** Master switch — when false, media files store with embeddingStatus="disabled". */
  enabled?: boolean;
  /** "local" → bundled cluster endpoint (Ollama); "external" → user-supplied API. */
  visionProvider?: 'local' | 'external';
  /** "local" → bundled cluster endpoint (faster-whisper-server); "external" → user-supplied API. */
  sttProvider?: 'local' | 'external';
  /** Pluggable vision provider settings (endpoint + model + optional API key). */
  vision?: MediaProviderConfig;
  /** Pluggable STT provider settings (endpoint + model + optional API key). */
  stt?: MediaProviderConfig;
  /** @deprecated Use `vision.baseUrl`. Kept for backward compatibility. */
  ollamaUrl?: string;
  /** @deprecated Use `vision.model`. Kept for backward compatibility. */
  visionModel?: string;
  /** @deprecated Use `stt.baseUrl`. Kept for backward compatibility. */
  whisperUrl?: string;
  /** @deprecated Use `stt.model`. Kept for backward compatibility. */
  whisperModel?: string;
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
   * Master switch. When false, face detection/embedding is skipped entirely.
   * Default: false (opt-in; requires local model files to be present).
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

export type NetworkType = 'closed' | 'democratic' | 'club' | 'braintree' | 'pubsub';
export type SyncDirection = 'both' | 'push' | 'pull';
export type VoteValue = 'yes' | 'veto';
export type VoteRoundType = 'join' | 'remove' | 'space_deletion' | 'meta_change';

export interface NetworkMember {
  instanceId: string;
  label: string;
  url: string;
  tokenHash: string;         // bcrypt of the token this instance uses to auth inbound from peer
  direction: SyncDirection;
  lastSyncAt?: string;       // ISO8601 — set only on successful sync
  lastSeqReceived?: Record<string, number>;  // spaceId → last seq ingested from this peer
  lastSeqPushed?: Record<string, number>;    // spaceId → last seq we confirmed pushed to this peer
  consecutiveFailures?: number;  // incremented on each failed sync; reset to 0 on success
  parentInstanceId?: string; // braintree only
  /** Set during a temporary reparent; stores the original parent so it can be restored. */
  originalParentInstanceId?: string;
  children?: string[];       // instanceIds of direct children (braintree)
  skipTlsVerify?: boolean;   // non-default; UI shows security warning when true
}

export interface VoteCast {
  instanceId: string;
  vote: VoteValue;
  castAt: string;            // ISO8601
}

export interface VoteRound {
  roundId: string;
  type: VoteRoundType;
  subjectInstanceId: string;
  subjectLabel: string;
  subjectUrl: string;
  deadline: string;          // ISO8601
  openedAt: string;          // ISO8601
  votes: VoteCast[];
  inviteKeyHash?: string;    // bcrypt of invite key (join rounds only)
  concluded?: boolean;
  passed?: boolean;          // true if concluded and the motion carried; false if vetoed/expired
  pendingMember?: NetworkMember;  // stored on join rounds; added to members when vote passes
  spaceId?: string;              // populated for space_deletion and meta_change rounds
  pendingMeta?: SpaceMeta;       // stored on meta_change rounds; applied when vote passes
  requiredVoters?: string[];     // braintree only: instanceIds that must ALL vote yes
}

export interface NetworkConfig {
  id: string;
  label: string;
  type: NetworkType;
  spaces: string[];          // space IDs scoped to this network
  /** Maps remote (peer-side) space IDs to local space IDs.
   *  Used when a local space was renamed after joining, or when the joiner chose
   *  a different local ID to avoid a collision.  The sync engine uses this to
   *  translate between peer space IDs on the wire and local collection/file IDs.
   *  Key = remote space ID, Value = local space ID. */
  spaceMap?: Record<string, string>;
  votingDeadlineHours: number;
  merkle?: boolean;
  members: NetworkMember[];
  pendingRounds: VoteRound[];
  syncSchedule?: string;     // cron expression; omit = manual only
  inviteKeyHash?: string;    // bcrypt of current active invite key
  createdAt: string;
  /** Braintree only: this instance's parent instanceId in the network tree.
   *  When unset this instance is treated as the root. */
  myParentInstanceId?: string;
  /** Set on THIS instance when it has been temporarily re-parented in a braintree.
   *  Cleared when the reparent is made permanent (`adopt`) or reverted. */
  temporaryReparent?: {
    newParentInstanceId: string;      // grandparent that adopted us
    originalParentInstanceId: string; // offline intermediate we bypassed
    reparentedAt: string;             // ISO8601
  };
}

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
  /** Maps IdP JWT claims to Ythril permission flags. */
  claimMapping?: OidcClaimMapping;
}

// ── Audit log types ────────────────────────────────────────────────────────

export interface AuditConfig {
  /** Log read operations (recall, query, list, etc.). Default: false. */
  logReads?: boolean;
  /** Number of days to retain audit entries (TTL). Default: 90. */
  retentionDays?: number;
}

export interface AuditLogEntry {
  _id: string;
  timestamp: string;       // ISO8601
  _expireAt?: Date;        // BSON Date for TTL index — set at write time
  tokenId: string | null;
  tokenLabel: string | null;
  authMethod: 'pat' | 'oidc' | null;
  oidcSubject: string | null;
  ip: string;
  method: string;          // HTTP method
  path: string;            // request path
  spaceId: string | null;
  operation: string;       // structured event name
  status: number;          // HTTP status code
  entryId: string | null;
  durationMs: number;
}

export interface Config {
  instanceId: string;
  instanceLabel: string;
  publicUrl?: string;         // optional canonical public URL for this brain instance
  tokens: TokenRecord[];
  spaces: SpaceConfig[];
  networks: NetworkConfig[];
  ejectedFromNetworks?: string[];  // network IDs this instance has been removed from via vote
  embedding?: EmbeddingConfig;
  storage?: StorageConfig;
  /** Optional media embedding pipeline (image / audio / video). Off by default. */
  mediaEmbedding?: MediaEmbeddingConfig;
  maxUploadBodyBytes?: number;
  allowInsecurePlaintext?: boolean;
  setup?: { completed: true };
  mongo?: { uri?: string };
  /** Optional OpenID Connect configuration for SSO login. */
  oidc?: OidcConfig;
  /** Optional external theming configuration. */
  theme?: {
    /** URL to an external CSS stylesheet that overrides Ythril's default CSS custom properties. */
    cssUrl?: string;
  };
  /** Optional audit log configuration. */
  audit?: AuditConfig;
}

export interface SecretsFile {
  peerTokens: Record<string, string>;
  totpSecret?: string;              // base32 TOTP secret; absent = MFA disabled
  webhookEncryptionKey?: string;    // hex-encoded AES-256 key for webhook secret encryption
  /**
   * Media embedding provider credentials. Stored here (0o600) instead of
   * config.json so API keys are never world-readable. Env vars
   * (`VISION_API_KEY` / `STT_API_KEY`) still take precedence.
   */
  mediaEmbedding?: {
    visionApiKey?: string;
    sttApiKey?: string;
  };
}

// ── MongoDB document shapes ────────────────────────────────────────────────

export interface AuthorRef {
  instanceId: string;
  instanceLabel: string;
}

export interface MemoryDoc {
  _id: string;
  spaceId: string;
  fact: string;
  /** Optional memory type — used to look up typeSchemas.memory for schema validation. */
  type?: string;
  embedding: number[];
  tags: string[];
  entityIds: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  /** Pre-embedding source text — the exact string fed to the embedding model. */
  matchedText?: string;
  author: AuthorRef;
  createdAt: string;
  updatedAt: string;
  seq: number;
  embeddingModel: string;
  forkOf?: string;
}

export interface EntityDoc {
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
}

export interface EdgeDoc {
  _id: string;
  spaceId: string;
  from: string;
  to: string;
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
}

export type ChronoType = 'event' | 'deadline' | 'plan' | 'prediction' | 'milestone';
/** @deprecated Use ChronoType */
export type ChronoKind = ChronoType;
export type ChronoStatus = 'upcoming' | 'active' | 'completed' | 'overdue' | 'cancelled';

export interface ChronoEntry {
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
  entityIds: string[];
  memoryIds: string[];
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
}

export interface TombstoneDoc {
  _id: string;
  type: 'memory' | 'entity' | 'edge' | 'chrono';
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
  path: string;        // relative path (same convention as ManifestEntry.path)
  deletedAt: string;   // ISO8601 — used by peers to prune expired tombstones
}

export interface FileMetaDoc {
  _id: string;          // space-relative path, normalised to forward slashes
  spaceId: string;
  path: string;         // same as _id — carried as a queryable field
  description?: string; // human-readable summary (optional)
  tags: string[];       // tags for filtering and recall scoping
  entityIds?: string[];  // linked entity IDs
  chronoIds?: string[];  // linked chrono entry IDs
  memoryIds?: string[];  // linked memory IDs
  properties?: Record<string, string | number | boolean>; // structured metadata (optional)
  /** Pre-embedding source text — the exact string fed to the embedding model. */
  matchedText?: string;
  createdAt: string;    // ISO8601 — first write timestamp
  updatedAt: string;    // ISO8601 — last write timestamp
  sizeBytes: number;    // file size in bytes at last write
  author: AuthorRef;    // writer: instanceId + instanceLabel
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
   *   "complete"   → all chunk records produced
   *   "failed"     → exhausted retries; mediaJobError carries the reason
   *   "skipped"    → file too large (> maxFileSizeBytes) — original kept, no embedding
   *   "disabled"   → mediaEmbedding.enabled=false at upload time
   */
  embeddingStatus?: 'pending' | 'processing' | 'complete' | 'failed' | 'skipped' | 'disabled';
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
  docId: string;          // ID of the violating document (entity/edge/memory/chrono)
  docType: 'entity' | 'edge' | 'memory' | 'chrono';
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
 * Background job record for asynchronous media embedding (caption/STT + chunking).
 * Stored in the per-space `<spaceId>_media_jobs` collection and claimed by the
 * MediaEmbeddingWorker. The corresponding filemeta record's `embeddingStatus`
 * mirrors `status` (pending/processing/complete/failed).
 */
export interface MediaJobDoc {
  _id: string;                // file _id (normalised path) — one job per file
  spaceId: string;
  filePath: string;           // normalised path on disk
  mimeType: string;           // raw upload MIME type
  mediaType: 'image' | 'audio' | 'video';
  status: 'pending' | 'processing' | 'complete' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  claimedAt: string | null;   // ISO8601 — set when a worker claims this job
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

