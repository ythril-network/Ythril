import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

// ── Shared types ─────────────────────────────────────────────────────────────

export interface Space {
  id: string;
  label: string;
  builtIn?: boolean;
  folders?: string[];
  minGiB?: number;
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
}

export interface Memory {
  _id: string;
  content?: string;
  fact?: string;
  tags?: string[];
  createdAt: string;
  seq: number;
  author?: { instanceId: string };
}

export interface Entity {
  _id: string;
  name: string;
  type?: string;
  createdAt: string;
}

export interface Edge {
  _id: string;
  from: string;
  to: string;
  label: string;
  weight?: number;
  createdAt: string;
}

export interface SpaceStats {
  spaceId: string;
  memories: number;
  entities: number;
  edges: number;
}

export interface FileEntry {
  name: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  modified: string;
}

export interface Network {
  id: string;
  label: string;
  type: 'closed' | 'democratic' | 'club' | 'braintree';
  spaces: string[];
  members: NetworkMember[];
  votingDeadlineHours?: number;
  syncSchedule?: string;
  merkle?: boolean;
}

export interface NetworkMember {
  instanceId: string;
  label: string;
  endpoint: string;
  syncDirection?: 'both' | 'push';
}

export interface InviteBundle {
  handshakeId: string;
  inviteUrl: string;
  rsaPublicKeyPem: string;
  networkId: string;
  expiresAt: string;
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

  createSpace(body: { label: string; id?: string; minGiB?: number }): Observable<{ space: Space }> {
    return this.http.post<{ space: Space }>('/api/spaces', body);
  }

  deleteSpace(id: string): Observable<void> {
    return this.http.delete<void>(`/api/spaces/${id}`, { body: { confirm: true } });
  }

  // ── Tokens ────────────────────────────────────────────────────────────────

  getMe(): Observable<TokenRecord> {
    return this.http.get<TokenRecord>('/api/tokens/me');
  }

  listTokens(): Observable<{ tokens: TokenRecord[] }> {
    return this.http.get<{ tokens: TokenRecord[] }>('/api/tokens');
  }

  createToken(body: { name: string; expiresAt?: string; spaces?: string[]; admin?: boolean }): Observable<{ token: TokenRecord; plaintext: string }> {
    return this.http.post<{ token: TokenRecord; plaintext: string }>('/api/tokens', body);
  }

  regenerateToken(id: string): Observable<{ plaintext: string }> {
    return this.http.post<{ plaintext: string }>(`/api/tokens/${id}/regenerate`, {});
  }

  revokeToken(id: string): Observable<void> {
    return this.http.delete<void>(`/api/tokens/${id}`);
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

  // ── Brain — memories ──────────────────────────────────────────────────────

  listMemories(spaceId: string, limit = 20, skip = 0): Observable<{ memories: Memory[]; limit: number; skip: number }> {
    const params = new HttpParams().set('limit', limit).set('skip', skip);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/memories`, { params });
  }

  deleteMemory(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/memories/${id}`);
  }

  // ── Brain — entities ──────────────────────────────────────────────────────

  listEntities(spaceId: string, limit = 50): Observable<{ entities: Entity[] }> {
    const params = new HttpParams().set('limit', limit);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/entities`, { params });
  }

  deleteEntity(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/entities/${id}`);
  }

  // ── Brain — edges ─────────────────────────────────────────────────────────

  listEdges(spaceId: string, limit = 50): Observable<{ edges: Edge[] }> {
    const params = new HttpParams().set('limit', limit);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/edges`, { params });
  }

  deleteEdge(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/edges/${id}`);
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  listFiles(spaceId: string, path = '/'): Observable<{ entries: FileEntry[] }> {
    const params = new HttpParams().set('path', path);
    return this.http.get<any>(`/api/files/${spaceId}`, { params });
  }

  deleteFile(spaceId: string, path: string): Observable<void> {
    return this.http.delete<void>(`/api/files/${spaceId}`, { body: { path, confirm: true } });
  }

  createDir(spaceId: string, path: string): Observable<void> {
    return this.http.post<void>(`/api/files/${spaceId}/mkdir`, { path });
  }

  moveFile(spaceId: string, from: string, to: string): Observable<void> {
    return this.http.post<void>(`/api/files/${spaceId}/move`, { from, to });
  }

  uploadFile(spaceId: string, path: string, formData: FormData): Observable<void> {
    const params = new HttpParams().set('path', path);
    return this.http.post<void>(`/api/files/${spaceId}/upload`, formData, { params });
  }

  getFileDownloadUrl(spaceId: string, path: string): string {
    return `/api/files/${spaceId}/download?path=${encodeURIComponent(path)}`;
  }

  // ── File conflicts ────────────────────────────────────────────────────────

  listConflicts(): Observable<{ conflicts: ConflictRecord[] }> {
    return this.http.get<any>('/api/conflicts');
  }

  resolveConflict(id: string): Observable<void> {
    return this.http.delete<void>(`/api/conflicts/${id}`);
  }

  // ── Networks ──────────────────────────────────────────────────────────────

  listNetworks(): Observable<{ networks: Network[] }> {
    return this.http.get<{ networks: Network[] }>('/api/networks');
  }

  getNetwork(id: string): Observable<Network> {
    return this.http.get<Network>(`/api/networks/${id}`);
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
  }): Observable<{ status: string; networkId: string; networkLabel: string; networkType: string; spaces: string[]; instanceId?: string; instanceLabel?: string }> {
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
}
