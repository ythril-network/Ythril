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
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-update timestamp. */
  updatedAt: string;
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
  createdAt: string;    // ISO8601 — first write timestamp
  updatedAt: string;    // ISO8601 — last write timestamp
  sizeBytes: number;    // file size in bytes at last write
  author: AuthorRef;    // writer: instanceId + instanceLabel
  embedding?: number[];
  embeddingModel?: string;
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

