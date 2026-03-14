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

export interface Config {
  instanceId: string;
  instanceLabel: string;
  tokens: TokenRecord[];
  spaces: SpaceConfig[];
  networks: unknown[];
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
