export interface TokenRecord {
  id: string;
  name: string;
  hash: string;         // bcrypt hash
  createdAt: string;    // ISO8601
  lastUsed: string | null;
  expiresAt: string | null;
  spaces?: string[];    // allowlist of space IDs; omit = all spaces
}

export interface SpaceConfig {
  id: string;
  label: string;
  builtIn: boolean;
  folders: string[];
  minGiB?: number;
  flex?: number;
}

export interface EmbeddingConfig {
  baseUrl: string;
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

export type NetworkType = 'closed' | 'democratic' | 'club' | 'braintree';
export type SyncDirection = 'both' | 'push';
export type VoteValue = 'yes' | 'veto';
export type VoteRoundType = 'join' | 'remove';

export interface NetworkMember {
  instanceId: string;
  label: string;
  url: string;
  tokenHash: string;         // bcrypt of the token this instance uses to auth inbound from peer
  direction: SyncDirection;
  lastSyncAt?: string;       // ISO8601
  lastSeqReceived?: Record<string, number>;  // spaceId → last seq ingested from this peer
  parentInstanceId?: string; // braintree only
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
  pendingMember?: NetworkMember;  // stored on join rounds; added to members when vote passes
}

export interface NetworkConfig {
  id: string;
  label: string;
  type: NetworkType;
  spaces: string[];          // space IDs scoped to this network
  votingDeadlineHours: number;
  merkle?: boolean;
  members: NetworkMember[];
  pendingRounds: VoteRound[];
  syncSchedule?: string;     // cron expression; omit = manual only
  inviteKeyHash?: string;    // bcrypt of current active invite key
  createdAt: string;
}

export interface Config {
  instanceId: string;
  instanceLabel: string;
  tokens: TokenRecord[];
  spaces: SpaceConfig[];
  networks: NetworkConfig[];
  embedding?: EmbeddingConfig;
  storage?: StorageConfig;
  maxUploadBodyBytes?: number;
  allowInsecurePlaintext?: boolean;
  setup?: { completed: true };
  mongo?: { uri?: string };
}

export interface SecretsFile {
  settingsPasswordHash: string;   // bcrypt hash of the settings UI password
  peerTokens: Record<string, string>;
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
  embedding: number[];
  tags: string[];
  entityIds: string[];
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
  author: AuthorRef;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface EdgeDoc {
  _id: string;
  spaceId: string;
  from: string;
  to: string;
  label: string;
  weight?: number;
  author: AuthorRef;
  createdAt: string;
  seq: number;
}

export interface TombstoneDoc {
  _id: string;
  type: 'memory' | 'entity' | 'edge';
  spaceId: string;
  deletedAt: string;
  instanceId: string;
  seq: number;
}

export interface SpaceCounterDoc {
  _id: string;  // spaceId
  seq: number;
}

// ── Conflict document (stored in ythril_conflicts collection) ──────────────

export type ConflictKind = 'file' | 'memory' | 'entity' | 'edge';

export interface ConflictDoc {
  _id: string;
  kind: ConflictKind;
  spaceId: string;
  networkId: string;
  path?: string;                // file conflicts only
  docId?: string;               // brain conflicts only
  localVersion: { seq?: number; hash?: string; modifiedAt: string; instanceLabel: string };
  incomingVersion: { seq?: number; hash?: string; modifiedAt: string; instanceLabel: string; content?: unknown };
  detectedAt: string;
  resolvedAt?: string;
  resolution?: 'keep-local' | 'keep-incoming' | 'keep-both' | 'discard-incoming';
}
