import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { voteRoundFromServer, type ServerVoteRound } from './vote-round-view';
import type {
  Network, InviteBundle, VoteRound, SyncHistoryRecord,
  LocalAgentStatus, LocalAgentBootstrapResult, LocalAgentEnableNetworksResult,
} from './api.types';

/** Networks, sync scheduling/triggering, governance votes, invites, and the local agent. */
@Injectable({ providedIn: 'root' })
export class NetworksApi {
  private http = inject(HttpClient);

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

  /** Accept or dismiss a space an upstream announced (S-9). `mapTo` carries it under a different local id. */
  resolvePendingSpace(networkId: string, body: { spaceId: string; action: 'accept' | 'dismiss'; mapTo?: string }): Observable<Network> {
    return this.http.post<Network>(`/api/networks/${networkId}/pending-spaces`, body);
  }

  /** Join a pub/sub with its publisher's URL and published invite key; no admission (F-41). */
  joinByKey(body: { publisherUrl: string; inviteKey: string; myUrl: string; spaceMap?: Record<string, string> }): Observable<{ status: string; networkId: string; networkLabel: string; networkType: string; spaces: string[]; existingSpaces?: string[]; createdSpaces?: string[]; spaceMap?: Record<string, string> }> {
    return this.http.post<any>('/api/networks/join-by-key', body);
  }

  removeMember(networkId: string, instanceId: string): Observable<void> {
    return this.http.delete<void>(`/api/networks/${networkId}/members/${instanceId}`);
  }

  /** Add one of this instance's spaces to a network (F-38.3, F-38.4): the network as it now is, or the vote it opened. */
  addNetworkSpace(networkId: string, spaceId: string): Observable<Network | { status: 'vote_pending'; round: unknown }> {
    return this.http.post<Network | { status: 'vote_pending'; round: unknown }>(`/api/networks/${networkId}/spaces`, { spaceId });
  }

  updateNetworkSchedule(networkId: string, syncSchedule: string): Observable<any> {
    return this.http.patch<any>(`/api/networks/${networkId}`, { syncSchedule });
  }

  triggerSync(networkId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/networks/${networkId}/sync`, {});
  }

  castVote(networkId: string, roundId: string, vote: 'yes' | 'veto'): Observable<void> {
    return this.http.post<void>(`/api/networks/${networkId}/votes/${roundId}`, { vote });
  }

  /** The rounds in the pages' shape — see `vote-round-view.ts` for why the translation cannot live anywhere else. */
  listVotes(networkId: string): Observable<{ rounds: VoteRound[] }> {
    return this.http.get<{ rounds: ServerVoteRound[] }>(`/api/networks/${networkId}/votes`).pipe(
      map(({ rounds }) => ({ rounds: (rounds ?? []).map(r => voteRoundFromServer(networkId, r)) })),
    );
  }

  // ── Local agent ─────────────────────────────────────────────────────────

  getLocalAgentStatus(): Observable<LocalAgentStatus> {
    return this.http.get<LocalAgentStatus>('/api/admin/local-agent/status');
  }

  bootstrapLocalAgent(body: {
    os: 'windows' | 'linux';
  }): Observable<LocalAgentBootstrapResult> {
    return this.http.post<LocalAgentBootstrapResult>('/api/admin/local-agent/bootstrap', body);
  }

  executeEnableNetworksViaLocalAgent(body: {
    hostname: string;
    os: 'windows' | 'linux';
    autostart: boolean;
    overwriteDns: boolean;
    acknowledgeCriticalChanges: boolean;
  }): Observable<LocalAgentEnableNetworksResult> {
    return this.http.post<LocalAgentEnableNetworksResult>('/api/admin/local-agent/enable-networks/execute', body);
  }
}
