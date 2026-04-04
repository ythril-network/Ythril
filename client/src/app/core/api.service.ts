import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpHeaders } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';

// ── Shared types ─────────────────────────────────────────────────────────────

export interface Space {
  id: string;
  label: string;
  builtIn?: boolean;
  folders?: string[];
  minGiB?: number;
  description?: string;
  proxyFor?: string[];
}

export interface SpacesResponse {
  spaces: Space[];
  storage?: {
    usageGiB: { files: number; brain: number; total: number };
    limits?: StorageLimits;
  };
}

export interface StorageLimits {
  totalLimitGiB?: number;
  warnAtPercent?: number;
}

export interface TokenRecord {
  id: string;
  name: string;
  createdAt: string;
  lastUsed?: string;
  expiresAt?: string;
  spaces?: string[];
  admin: boolean;
  readOnly?: boolean;
}

export interface Memory {
  _id: string;
  fact: string;
  tags?: string[];
  entityIds?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  createdAt: string;
  seq: number;
  author?: { instanceId: string };
}

export interface Entity {
  _id: string;
  name: string;
  type?: string;
  tags?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface Edge {
  _id: string;
  from: string;
  to: string;
  label: string;
  type?: string;
  weight?: number;
  tags?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  createdAt: string;
}

export type ChronoKind = 'event' | 'deadline' | 'plan' | 'prediction' | 'milestone';
export type ChronoStatus = 'upcoming' | 'active' | 'completed' | 'overdue' | 'cancelled';

export interface ChronoEntry {
  _id: string;
  spaceId: string;
  title: string;
  description?: string;
  kind: ChronoKind;
  startsAt: string;
  endsAt?: string;
  status: ChronoStatus;
  confidence?: number;
  tags: string[];
  entityIds: string[];
  memoryIds: string[];
  recurrence?: { freq: string; interval?: number; until?: string };
  author: { instanceId: string; instanceLabel: string };
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface SpaceStats {
  spaceId: string;
  memories: number;
  entities: number;
  edges: number;
  chrono: number;
  files: number;
  needsReindex?: boolean;
}

export type WipeCollectionType = 'memories' | 'entities' | 'edges' | 'chrono' | 'files';

export interface WipeResult {
  memories: number;
  entities: number;
  edges: number;
  chrono: number;
  files: number;
}

export interface FileEntry {
  name: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  modified: string;
}

export interface UploadProgress {
  percent: number;
  done: boolean;
}

export interface Network {
  id: string;
  label: string;
  type: 'closed' | 'democratic' | 'club' | 'braintree' | 'pubsub';
  spaces: string[];
  spaceMap?: Record<string, string>;
  members: NetworkMember[];
  votingDeadlineHours?: number;
  syncSchedule?: string;
  merkle?: boolean;
}

export interface NetworkMember {
  instanceId: string;
  label: string;
  endpoint: string;
  syncDirection?: 'both' | 'push' | 'pull';
}

export interface InviteBundle {
  handshakeId: string;
  inviteUrl: string;
  rsaPublicKeyPem: string;
  networkId: string;
  expiresAt: string;
  spaces?: string[];
}

export interface VoteRound {
  id: string;
  networkId: string;
  type: string;
  subject: string;
  openedAt: string;
  deadline: string;
  status: 'open' | 'passed' | 'failed';
  votes: { instanceId: string; vote: 'yes' | 'no'; }[];
}

export interface ConflictRecord {
  id: string;
  spaceId: string;
  originalPath: string;
  conflictPath: string;
  detectedAt: string;
  peerInstanceId: string;
  peerInstanceLabel: string;
}

export interface SyncHistoryRecord {
  _id: string;
  networkId: string;
  triggeredAt: string;
  completedAt: string;
  status: 'success' | 'partial' | 'failed';
  pulled: { memories: number; entities: number; edges: number; files: number };
  pushed: { memories: number; entities: number; edges: number; files: number };
  errors?: string[];
}

export interface AboutInfo {
  instanceId: string;
  instanceLabel: string;
  version: string;
  uptime: string;
  mongoVersion: string;
  diskInfo: { total: number; used: number; available: number };
  publicUrl?: string;
}

// ── API service ───────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  // ── Auth ──────────────────────────────────────────────────────────────────

  /** Verify the supplied PAT is valid and return its metadata */
  verifyToken(): Observable<{ id: string; name: string; spaces?: string[] }> {
    return this.http.get<any>('/api/tokens/me');
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  getSetupStatus(): Observable<{ configured: boolean }> {
    return this.http.get<{ configured: boolean }>('/api/setup/status');
  }

  completeSetup(body: {
    code: string;
    label: string;
    settingsPassword: string;
  }): Observable<{ plaintext: string }> {
    return this.http.post<{ plaintext: string }>('/api/setup', body);
  }

  // ── Spaces ────────────────────────────────────────────────────────────────

  listSpaces(): Observable<SpacesResponse> {
    return this.http.get<SpacesResponse>('/api/spaces');
  }

  createSpace(body: { label: string; id?: string; minGiB?: number; description?: string; proxyFor?: string[] }): Observable<{ space: Space }> {
    return this.http.post<{ space: Space }>('/api/spaces', body);
  }

  updateSpace(id: string, body: { label?: string; description?: string }): Observable<{ space: Space }> {
    return this.http.patch<{ space: Space }>(`/api/spaces/${id}`, body);
  }

  deleteSpace(id: string): Observable<void> {
    return this.http.delete<void>(`/api/spaces/${id}`, { body: { confirm: true } });
  }

  renameSpace(oldId: string, newId: string): Observable<{ space: Space }> {
    return this.http.patch<{ space: Space }>(`/api/spaces/${oldId}/rename`, { newId });
  }

  // ── Tokens ────────────────────────────────────────────────────────────────

  getMe(): Observable<TokenRecord> {
    return this.http.get<TokenRecord>('/api/tokens/me');
  }

  listTokens(): Observable<{ tokens: TokenRecord[] }> {
    return this.http.get<{ tokens: TokenRecord[] }>('/api/tokens');
  }

  createToken(body: { name: string; expiresAt?: string; spaces?: string[]; admin?: boolean; readOnly?: boolean }): Observable<{ token: TokenRecord; plaintext: string }> {
    return this.http.post<{ token: TokenRecord; plaintext: string }>('/api/tokens', body);
  }

  regenerateToken(id: string): Observable<{ plaintext: string }> {
    return this.http.post<{ plaintext: string }>(`/api/tokens/${id}/regenerate`, {});
  }

  revokeToken(id: string): Observable<void> {
    return this.http.delete<void>(`/api/tokens/${id}`);
  }

  wipeSpace(spaceId: string, types?: WipeCollectionType[]): Observable<{ deleted: WipeResult }> {
    const body: { types?: WipeCollectionType[] } = types && types.length > 0 ? { types } : {};
    return this.http.post<{ deleted: WipeResult }>(`/api/admin/spaces/${spaceId}/wipe`, body);
  }

  // ── MFA ───────────────────────────────────────────────────────────────────

  getMfaStatus(): Observable<{ enabled: boolean }> {
    return this.http.get<{ enabled: boolean }>('/api/mfa/status');
  }

  setupMfa(): Observable<{ secret: string; otpauth: string }> {
    return this.http.post<{ secret: string; otpauth: string }>('/api/mfa/setup', {});
  }

  verifyMfaCode(code: string): Observable<{ valid: boolean }> {
    return this.http.post<{ valid: boolean }>('/api/mfa/verify', { code });
  }

  disableMfa(): Observable<void> {
    return this.http.delete<void>('/api/mfa');
  }

  getSpaceStats(spaceId: string): Observable<SpaceStats> {
    return this.http.get<SpaceStats>(`/api/brain/spaces/${spaceId}/stats`);
  }

  getReindexStatus(spaceId: string): Observable<{ spaceId: string; needsReindex: boolean }> {
    return this.http.get<{ spaceId: string; needsReindex: boolean }>(`/api/brain/spaces/${spaceId}/reindex-status`);
  }

  reindex(spaceId: string): Observable<Record<string, number>> {
    return this.http.post<Record<string, number>>(`/api/brain/spaces/${spaceId}/reindex`, {});
  }

  // ── Brain — memories ──────────────────────────────────────────────────────

  listMemories(spaceId: string, limit = 20, skip = 0, filters?: { tag?: string; entity?: string }): Observable<{ memories: Memory[]; limit: number; skip: number }> {
    let params = new HttpParams().set('limit', limit).set('skip', skip);
    if (filters?.tag) params = params.set('tag', filters.tag);
    if (filters?.entity) params = params.set('entity', filters.entity);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/memories`, { params });
  }

  deleteMemory(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/memories/${id}`);
  }

  createMemory(spaceId: string, body: { fact: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<Memory> {
    return this.http.post<Memory>(`/api/brain/${spaceId}/memories`, body);
  }

  wipeMemories(spaceId: string): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/brain/spaces/${spaceId}/memories`, {
      body: { confirm: true },
    });
  }

  // ── Brain — entities ──────────────────────────────────────────────────────

  listEntities(spaceId: string, limit = 50, skip = 0, search?: string): Observable<{ entities: Entity[] }> {
    let params = new HttpParams().set('limit', limit).set('skip', skip);
    if (search) params = params.set('name', search);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/entities`, { params });
  }

  deleteEntity(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/entities/${id}`);
  }

  createEntity(spaceId: string, body: { name: string; type?: string; tags?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<Entity> {
    return this.http.post<Entity>(`/api/brain/spaces/${spaceId}/entities`, body);
  }

  // ── Brain — edges ─────────────────────────────────────────────────────────

  listEdges(spaceId: string, limit = 50, skip = 0): Observable<{ edges: Edge[] }> {
    const params = new HttpParams().set('limit', limit).set('skip', skip);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/edges`, { params });
  }

  deleteEdge(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/edges/${id}`);
  }

  createEdge(spaceId: string, body: { from: string; to: string; label: string; weight?: number; type?: string; tags?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<Edge> {
    return this.http.post<Edge>(`/api/brain/spaces/${spaceId}/edges`, body);
  }

  // ── Brain — chrono ──────────────────────────────────────────────────────

  listChrono(spaceId: string, limit = 50, skip = 0, filters?: { tags?: string; kind?: string; status?: string }): Observable<{ chrono: ChronoEntry[] }> {
    let params = new HttpParams().set('limit', limit).set('skip', skip);
    if (filters?.tags) params = params.set('tags', filters.tags);
    if (filters?.kind) params = params.set('kind', filters.kind);
    if (filters?.status) params = params.set('status', filters.status);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/chrono`, { params });
  }

  createChrono(spaceId: string, body: { title: string; kind: ChronoKind; startsAt: string; endsAt?: string; status?: ChronoStatus; confidence?: number; tags?: string[]; entityIds?: string[]; memoryIds?: string[]; description?: string }): Observable<ChronoEntry> {
    return this.http.post<ChronoEntry>(`/api/brain/spaces/${spaceId}/chrono`, body);
  }

  updateChrono(spaceId: string, id: string, body: Partial<{ title: string; kind: ChronoKind; startsAt: string; endsAt: string; status: ChronoStatus; confidence: number; tags: string[]; entityIds: string[]; memoryIds: string[]; description: string }>): Observable<ChronoEntry> {
    return this.http.post<ChronoEntry>(`/api/brain/spaces/${spaceId}/chrono/${id}`, body);
  }

  deleteChrono(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/chrono/${id}`);
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  listFiles(spaceId: string, path = '/'): Observable<{ entries: FileEntry[] }> {
    const params = new HttpParams().set('path', path);
    return this.http.get<any>(`/api/files/${spaceId}`, { params });
  }

  deleteFile(spaceId: string, path: string): Observable<void> {
    const params = new HttpParams().set('path', path);
    return this.http.delete<void>(`/api/files/${spaceId}`, { params, body: { confirm: true } });
  }

  createDir(spaceId: string, path: string): Observable<void> {
    const params = new HttpParams().set('path', path);
    return this.http.post<void>(`/api/files/${spaceId}/mkdir`, null, { params });
  }

  moveFile(spaceId: string, from: string, to: string): Observable<void> {
    const params = new HttpParams().set('path', from);
    return this.http.patch<void>(`/api/files/${spaceId}`, { destination: to }, { params });
  }

  /**
   * Upload a file with automatic chunking for files > 10 MB.
   * Emits progress events ({ percent, done }) for UI updates.
   * Retries each chunk up to 3 times on failure.
   */
  uploadFileChunked(spaceId: string, dirPath: string, file: File): Observable<UploadProgress> {
    const CHUNK_THRESHOLD = 10 * 1024 * 1024; // 10 MB
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
    const MAX_RETRIES = 3;
    const filePath = dirPath.endsWith('/') ? `${dirPath}${file.name}` : `${dirPath}/${file.name}`;

    const subject = new Subject<UploadProgress>();

    if (file.size <= CHUNK_THRESHOLD) {
      // Small file: single upload
      file.arrayBuffer().then(ab => {
        const headers = new HttpHeaders({ 'Content-Type': 'application/octet-stream' });
        const params = new HttpParams().set('path', filePath);
        this.http.post<void>(`/api/files/${spaceId}`, ab, { headers, params }).subscribe({
          next: () => {
            subject.next({ percent: 100, done: true });
            subject.complete();
          },
          error: err => subject.error(err),
        });
      });
      return subject.asObservable();
    }

    // Chunked upload
    const total = file.size;
    let offset = 0;

    const sendNextChunk = (): void => {
      if (offset >= total) return;
      const end = Math.min(offset + CHUNK_SIZE, total);
      const slice = file.slice(offset, end);
      const start = offset;
      const byteEnd = end - 1;

      slice.arrayBuffer().then(ab => {
        const sendChunk = (retriesLeft: number): void => {
          const headers = new HttpHeaders({
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${start}-${byteEnd}/${total}`,
          });
          const params = new HttpParams().set('path', filePath);
          this.http.post<any>(`/api/files/${spaceId}`, ab, { headers, params }).subscribe({
            next: () => {
              offset = end;
              const percent = Math.round((offset / total) * 100);
              if (offset >= total) {
                subject.next({ percent: 100, done: true });
                subject.complete();
              } else {
                subject.next({ percent, done: false });
                sendNextChunk();
              }
            },
            error: err => {
              if (retriesLeft > 0) {
                sendChunk(retriesLeft - 1);
              } else {
                subject.error(err);
              }
            },
          });
        };
        sendChunk(MAX_RETRIES);
      });
    };

    // Start uploading
    subject.next({ percent: 0, done: false });
    sendNextChunk();

    return subject.asObservable();
  }

  getFileDownloadUrl(spaceId: string, path: string): string {
    return `/api/files/${spaceId}?path=${encodeURIComponent(path)}`;
  }

  // ── File conflicts ────────────────────────────────────────────────────────

  listConflicts(): Observable<{ conflicts: ConflictRecord[] }> {
    return this.http.get<any>('/api/conflicts');
  }

  resolveConflict(id: string, action: string = 'keep-local', opts?: { rename?: string; targetSpaceId?: string }): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(`/api/conflicts/${id}/resolve`, { action, ...opts });
  }

  bulkResolveConflicts(ids: string[], action: string, opts?: { rename?: string; targetSpaceId?: string }): Observable<{ resolved: number; failed: { id: string; error: string }[] }> {
    return this.http.post<any>('/api/conflicts/bulk-resolve', { ids, action, ...opts });
  }

  dismissConflict(id: string): Observable<void> {
    return this.http.delete<void>(`/api/conflicts/${id}`);
  }

  // ── Networks ──────────────────────────────────────────────────────────────

  listNetworks(): Observable<{ networks: Network[] }> {
    return this.http.get<{ networks: Network[] }>('/api/networks');
  }

  getNetwork(id: string): Observable<Network> {
    return this.http.get<Network>(`/api/networks/${id}`);
  }

  getSyncHistory(networkId: string, limit: number = 20): Observable<{ history: SyncHistoryRecord[] }> {
    return this.http.get<{ history: SyncHistoryRecord[] }>(`/api/networks/${networkId}/sync-history?limit=${limit}`);
  }

  createNetwork(body: {
    label: string;
    type: string;
    spaces: string[];
    votingDeadlineHours?: number;
    syncSchedule?: string;
    merkle?: boolean;
  }): Observable<Network> {
    return this.http.post<Network>('/api/networks', body);
  }

  leaveNetwork(id: string): Observable<void> {
    return this.http.delete<void>(`/api/networks/${id}`, { body: { confirm: true } });
  }

  generateInvite(networkId: string): Observable<InviteBundle> {
    return this.http.post<InviteBundle>('/api/invite/generate', { networkId });
  }

  joinRemote(body: {
    handshakeId: string;
    inviteUrl: string;
    rsaPublicKeyPem: string;
    networkId: string;
    myUrl: string;
    expiresAt?: string;
    spaceMap?: Record<string, string>;
  }): Observable<{ status: string; networkId: string; networkLabel: string; networkType: string; spaces: string[]; existingSpaces?: string[]; createdSpaces?: string[]; spaceMap?: Record<string, string>; instanceId?: string; instanceLabel?: string }> {
    return this.http.post<any>('/api/networks/join-remote', body);
  }

  removeMember(networkId: string, instanceId: string): Observable<void> {
    return this.http.delete<void>(`/api/networks/${networkId}/members/${instanceId}`);
  }

  updateNetworkSchedule(networkId: string, syncSchedule: string): Observable<any> {
    return this.http.patch<any>(`/api/networks/${networkId}`, { syncSchedule });
  }

  updateSyncSchedule(networkId: string, memberId: string, schedule: string): Observable<void> {
    return this.http.patch<void>(`/api/networks/${networkId}/members/${memberId}`, { syncSchedule: schedule });
  }

  triggerSync(networkId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/networks/${networkId}/sync`, {});
  }

  castVote(networkId: string, roundId: string, vote: 'yes' | 'no'): Observable<void> {
    return this.http.post<void>(`/api/networks/${networkId}/votes/${roundId}`, { vote });
  }

  listVotes(networkId: string): Observable<{ rounds: VoteRound[] }> {
    return this.http.get<any>(`/api/networks/${networkId}/votes`);
  }

  // ── About ───────────────────────────────────────────────────────────────

  getAbout(): Observable<AboutInfo> {
    return this.http.get<AboutInfo>('/api/about');
  }

  getAboutLogs(lines: number = 200): Observable<{ lines: string[] }> {
    return this.http.get<{ lines: string[] }>(`/api/about/logs?lines=${lines}`);
  }
}
