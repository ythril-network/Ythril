import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, InviteBundle, Network, SyncHistoryRecord, VoteRound } from '../../core/api.service';
@Component({
  selector: 'app-networks',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .network-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: 16px;
      overflow: hidden;
    }

    .network-card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      cursor: pointer;
      user-select: none;
    }

    .network-card-header:hover { background: var(--bg-elevated); }

    .network-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      flex: 1;
    }

    .network-body {
      padding: 0 20px 16px;
      border-top: 1px solid var(--border-muted);
    }

    .member-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border-muted);
      font-size: 13px;
    }

    .member-row:last-child { border-bottom: none; }

    .vote-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      margin-bottom: 8px;
      font-size: 13px;
    }

    .history-row {
      display: grid;
      grid-template-columns: 140px 70px 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--border-muted);
      font-size: 12px;
    }

    .history-row:last-child { border-bottom: none; }

    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }

    .status-success { background: var(--green-bg, #e6f9e6); color: var(--green-fg, #1a7a1a); }
    .status-partial { background: var(--yellow-bg, #fff8e1); color: var(--yellow-fg, #b5850a); }
    .status-failed  { background: var(--red-bg, #fde8e8); color: var(--red-fg, #b91c1c); }
  `],
  template: `
    <!-- Create network -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="card-header">
        <div>
          <div class="card-title">Create network</div>
          <div class="card-subtitle">A network syncs selected spaces between brain instances.</div>
        </div>
      </div>

      @if (createError()) { <div class="alert alert-error">{{ createError() }}</div> }

      <form (ngSubmit)="createNetwork()" style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end;">
        <div class="field" style="margin-bottom:0;">
          <label>Network label</label>
          <input type="text" [(ngModel)]="form.label" name="label" placeholder="Team Brain" required />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Type</label>
          <select [(ngModel)]="form.type" name="type">
            <option value="closed">Closed (invite only)</option>
            <option value="democratic">Democratic (majority vote)</option>
            <option value="club">Club (supermajority)</option>
            <option value="braintree">Braintree (hierarchical)</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Spaces (comma-separated IDs)</label>
          <input type="text" [(ngModel)]="form.spaces" name="spaces" placeholder="general" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Voting deadline (hours)</label>
          <input type="number" [(ngModel)]="form.votingDeadlineHours" name="deadline" min="1" max="72" />
        </div>
        <button
          class="btn-primary btn"
          type="submit"
          style="grid-column:span 2;"
          [disabled]="creating() || !form.label.trim()"
        >
          @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
          Create network
        </button>
      </form>
    </div>

    <!-- Join existing network -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="card-header">
        <div>
          <div class="card-title">Join an existing network</div>
          <div class="card-subtitle">
            Paste the invite bundle from another brain to sync spaces with it.
          </div>
        </div>
      </div>

      @if (joinError()) { <div class="alert alert-error">{{ joinError() }}</div> }
      @if (joinSuccess()) { <div class="alert alert-success">{{ joinSuccess() }}</div> }

      <div class="field">
        <label>Invite bundle (JSON)</label>
        <textarea
          [(ngModel)]="joinBundle"
          name="joinBundle"
          rows="5"
          placeholder='Paste the invite bundle generated by the other brain here...'
          aria-label="Invite bundle JSON"
          style="font-family:var(--font-mono); font-size:12px; resize:vertical;"
        ></textarea>
      </div>
      <div class="field">
        <label>This brain's URL</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <input
            type="url"
            [(ngModel)]="joinMyUrl"
            name="joinMyUrl"
            placeholder="https://brain-b.example.com"
            style="flex:1;"
            [attr.aria-description]="'URL the peer brain will use to reach this brain for sync. Auto-filled from current origin.'"
          />
          @if (joinMyUrlAutoFilled()) {
            <span class="badge badge-gray" style="white-space:nowrap; font-size:11px;">auto-filled</span>
          }
        </div>
        <div class="field-hint">The URL the other brain will use to reach this brain for sync.</div>
      </div>
      <button
        class="btn-primary btn"
        (click)="joinNetwork()"
        [disabled]="joining() || !joinBundle.trim() || !joinMyUrl.trim()"
      >
        @if (joining()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
        Join network
      </button>
    </div>

    <!-- Network list -->
    <div class="card-title" style="margin-bottom:12px;">Networks</div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (networks().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon">🔗</div>
        <h3>No networks</h3>
        <p>Create a network to start syncing with peers.</p>
      </div>
    } @else {
      @for (net of networks(); track net.id) {
        <div class="network-card">
          <div class="network-card-header" (click)="toggleNetwork(net.id)">
            <span class="network-name">{{ net.label }}</span>
            <span class="badge" [ngClass]="typeBadge(net.type)">{{ net.type }}</span>
            <span class="badge badge-gray">{{ net.members.length }} member{{ net.members.length === 1 ? '' : 's' }}</span>
            <span style="color:var(--text-muted); font-size:12px;">{{ expanded() === net.id ? '▲' : '▼' }}</span>
          </div>

          @if (expanded() === net.id) {
            <div class="network-body">

              <!-- Invite bundle -->
              <div style="margin-bottom:16px; margin-top:12px;">
                <div class="section-title">Invite</div>
                <p style="font-size:12px; color:var(--text-muted); margin:0 0 8px;">
                  Generate a one-time invite bundle and share it with the brain you want to connect to.
                  The invite expires after 24 hours.
                </p>
                @if (inviteBundle(net.id); as bundle) {
                  <div class="code-block" style="margin-bottom:8px; font-size:11px; white-space:pre-wrap; word-break:break-all;">{{ bundleJson(bundle) }}</div>
                  <button class="btn-ghost btn btn-sm" (click)="copyInvite(net.id)">
                    {{ copiedInvite() === net.id ? '✓ Copied' : 'Copy bundle' }}
                  </button>
                } @else {
                  <button class="btn-secondary btn btn-sm" (click)="generateInvite(net.id)">
                    Generate invite
                  </button>
                }
              </div>

              <!-- Sync -->
              <div style="margin-bottom:16px;">
                <div class="section-title">Sync</div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <input
                    type="text"
                    [ngModel]="net.syncSchedule ?? ''"
                    (ngModelChange)="netSchedule[net.id] = $event"
                    [name]="'sched-' + net.id"
                    placeholder="0 * * * * (cron) — leave empty for manual only"
                    aria-label="Sync schedule (cron)"
                    style="flex:1; min-width:220px;"
                  />
                  <button class="btn-secondary btn btn-sm" (click)="saveSchedule(net)">Save schedule</button>
                  <button class="btn-secondary btn btn-sm" (click)="sync(net.id)">Sync now</button>
                </div>
                @if (syncResult(net.id); as r) {
                  <div class="alert" [class.alert-success]="r.ok" [class.alert-error]="!r.ok" style="margin-top:8px;">
                    {{ r.ok ? 'Sync triggered' : 'Sync failed' }}
                  </div>
                }
              </div>

              <!-- Sync History -->
              <div style="margin-bottom:16px;">
                <div class="section-title" style="cursor:pointer;" (click)="toggleHistory(net.id)">
                  Sync History {{ historyExpanded() === net.id ? '▲' : '▼' }}
                </div>
                @if (historyExpanded() === net.id) {
                  @if (historyLoading()) {
                    <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">Loading…</div>
                  } @else if (historyForNet(net.id).length === 0) {
                    <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">No sync history yet.</div>
                  } @else {
                    @for (rec of historyForNet(net.id); track rec._id) {
                      <div class="history-row">
                        <span style="color:var(--text-muted);">{{ rec.completedAt | date:'short' }}</span>
                        <span class="status-badge" [ngClass]="'status-' + rec.status">{{ rec.status }}</span>
                        <span>
                          ↓ {{ rec.pulled.memories + rec.pulled.entities + rec.pulled.edges }}
                          + {{ rec.pulled.files }} files &nbsp;
                          ↑ {{ rec.pushed.memories + rec.pushed.entities + rec.pushed.edges }}
                          + {{ rec.pushed.files }} files
                        </span>
                        @if (rec.errors?.length) {
                          <button class="btn-ghost btn btn-sm" style="font-size:11px;"
                            (click)="toggleHistoryErrors(rec._id)">
                            {{ expandedError() === rec._id ? 'Hide errors' : rec.errors!.length + ' error(s)' }}
                          </button>
                        }
                      </div>
                      @if (expandedError() === rec._id && rec.errors) {
                        <div style="padding:4px 0 8px 8px; font-size:11px; color:var(--red-fg, #b91c1c);">
                          @for (e of rec.errors; track e) {
                            <div>{{ e }}</div>
                          }
                        </div>
                      }
                    }
                  }
                }
              </div>

              <!-- Members -->
              <div class="section-title">Members</div>
              @for (m of net.members; track m.instanceId) {
                <div class="member-row">
                  <span class="mono badge badge-gray" style="font-size:11px;">{{ m.instanceId.slice(0, 8) }}</span>
                  <span style="font-weight:500; flex:1;">{{ m.label }}</span>
                  <span class="badge badge-gray" style="font-size:11px;">{{ m.syncDirection ?? 'both' }}</span>
                  <a [href]="m.endpoint" target="_blank" rel="noopener" style="font-size:11px; color:var(--text-muted);">
                    {{ m.endpoint }}
                  </a>
                  <button
                    class="btn-danger btn btn-sm"
                    style="padding:2px 8px;"
                    [disabled]="removingMember[net.id + ':' + m.instanceId]"
                    (click)="removeMember(net, m.instanceId, m.label)"
                    title="Remove member"
                    aria-label="Remove member"
                  >×</button>
                </div>
              }

              <!-- Open votes -->
              @if (openVotes(net.id).length > 0) {
                <div style="margin-top:16px;">
                  <div class="section-title">Open votes</div>
                  @for (round of openVotes(net.id); track round.id) {
                    <div class="vote-row">
                      <span style="flex:1;">{{ round.type }}: {{ round.subject }}</span>
                      <button class="btn-primary btn btn-sm" (click)="castVote(net.id, round.id, 'yes')">✓ Yes</button>
                      <button class="btn-danger btn btn-sm" (click)="castVote(net.id, round.id, 'no')">✗ No</button>
                    </div>
                  }
                </div>
              }

              <!-- Leave -->
              <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border-muted);">
                <button class="btn-danger btn btn-sm" (click)="leaveNetwork(net)">Leave network</button>
              </div>
            </div>
          }
        </div>
      }
    }
  `,
})
export class NetworksComponent implements OnInit {
  private api = inject(ApiService);

  networks = signal<Network[]>([]);
  loading = signal(true);
  creating = signal(false);
  createError = signal('');
  expanded = signal('');

  form = { label: '', type: 'closed', spaces: 'general', votingDeadlineHours: 48 };
  netSchedule: Record<string, string> = {};

  private inviteBundles: Record<string, InviteBundle> = {};
  private syncResults: Record<string, { ok: boolean }> = {};
  private votesByNetwork: Record<string, VoteRound[]> = {};

  copiedInvite = signal('');
  joinBundle = '';
  joinMyUrl = '';
  joinMyUrlAutoFilled = signal(false);
  joining = signal(false);
  joinError = signal('');
  joinSuccess = signal('');
  removingMember: Record<string, boolean> = {};

  // Sync history state
  historyExpanded = signal('');
  historyLoading = signal(false);
  expandedError = signal('');
  private historyByNetwork: Record<string, SyncHistoryRecord[]> = {};

  inviteBundle(id: string): InviteBundle | undefined { return this.inviteBundles[id]; }
  bundleJson(bundle: InviteBundle): string { return JSON.stringify(bundle, null, 2); }
  syncResult(id: string): { ok: boolean } | undefined { return this.syncResults[id]; }

  ngOnInit(): void {
    this.load();
    // Auto-fill this brain's URL: prefer the server-configured publicUrl, fall
    // back to the current browser origin (works for most single-brain deployments).
    this.api.getAbout().subscribe({
      next: (info) => {
        // Prefer server-configured publicUrl; fall back to current browser origin.
        // window.location.origin returns the string 'null' in sandboxed/restricted contexts.
        const url = info.publicUrl || window.location.origin;
        if (url && url !== 'null') {
          this.joinMyUrl = url;
          this.joinMyUrlAutoFilled.set(true);
        }
      },
      error: () => {
        // window.location.origin can be the string 'null' in sandboxed/file:// contexts
        const origin = window.location.origin;
        if (origin && origin !== 'null') {
          this.joinMyUrl = origin;
          this.joinMyUrlAutoFilled.set(true);
        }
      },
    });
  }

  load(): void {
    this.loading.set(true);
    this.api.listNetworks().subscribe({
      next: ({ networks }) => {
        this.networks.set(networks);
        this.loading.set(false);
        // Load votes for each network
        for (const net of networks) this.loadVotes(net.id);
      },
      error: () => this.loading.set(false),
    });
  }

  toggleNetwork(id: string): void {
    this.expanded.update(v => v === id ? '' : id);
  }

  createNetwork(): void {
    if (!this.form.label.trim()) return;
    this.creating.set(true);
    this.createError.set('');
    const spaces = this.form.spaces.split(',').map(s => s.trim()).filter(Boolean);

    this.api.createNetwork({
      label: this.form.label.trim(),
      type: this.form.type,
      spaces,
      votingDeadlineHours: this.form.votingDeadlineHours,
    }).subscribe({
      next: (net) => {
        this.creating.set(false);
        this.networks.update(list => [...list, net]);
        this.form = { label: '', type: 'closed', spaces: 'general', votingDeadlineHours: 48 };
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err.error?.error ?? 'Failed to create network');
      },
    });
  }

  leaveNetwork(net: Network): void {
    if (!confirm(`Leave network "${net.label}"? You will stop syncing with its members.`)) return;
    this.api.leaveNetwork(net.id).subscribe({
      next: () => this.networks.update(list => list.filter(n => n.id !== net.id)),
      error: (err) => alert(err.error?.error ?? 'Failed to leave network.'),
    });
  }

  generateInvite(networkId: string): void {
    this.api.generateInvite(networkId).subscribe({
      next: (bundle) => {
        this.inviteBundles[networkId] = bundle;
        this.networks.update(n => [...n]);
      },
      error: (err) => alert(err.error?.error ?? 'Failed to generate invite.'),
    });
  }

  copyInvite(networkId: string): void {
    const bundle = this.inviteBundles[networkId];
    if (!bundle) return;
    navigator.clipboard.writeText(JSON.stringify(bundle, null, 2)).then(() => {
      this.copiedInvite.set(networkId);
      setTimeout(() => this.copiedInvite.set(''), 2000);
    });
  }

  saveSchedule(net: Network): void {
    const schedule = this.netSchedule[net.id] ?? net.syncSchedule ?? '';
    this.api.updateNetworkSchedule(net.id, schedule).subscribe({
      next: () => {
        this.networks.update(list =>
          list.map(n => n.id === net.id ? { ...n, syncSchedule: schedule || undefined } : n)
        );
      },
      error: (err) => alert(err.error?.error ?? 'Failed to save schedule'),
    });
  }

  joinNetwork(): void {
    this.joinError.set('');
    this.joinSuccess.set('');
    let bundle: any;
    try {
      bundle = JSON.parse(this.joinBundle);
    } catch {
      this.joinError.set('Invalid invite bundle — must be valid JSON.');
      return;
    }
    if (!bundle.handshakeId || !bundle.inviteUrl || !bundle.rsaPublicKeyPem || !bundle.networkId) {
      this.joinError.set('Incomplete invite bundle — missing required fields.');
      return;
    }
    if (!this.joinMyUrl.trim()) {
      this.joinError.set('Enter this brain\'s publicly reachable URL.');
      return;
    }
    this.joining.set(true);
    this.api.joinRemote({
      handshakeId: bundle.handshakeId,
      inviteUrl:   bundle.inviteUrl,
      rsaPublicKeyPem: bundle.rsaPublicKeyPem,
      networkId:   bundle.networkId,
      myUrl:       this.joinMyUrl.trim(),
      expiresAt:   bundle.expiresAt,
    }).subscribe({
      next: (result) => {
        this.joining.set(false);
        this.joinSuccess.set(`Joined network "${result.networkLabel}" successfully.`);
        this.joinBundle = '';
        this.joinMyUrl  = '';
        this.joinMyUrlAutoFilled.set(false);
        this.load();
      },
      error: (err) => {
        this.joining.set(false);
        this.joinError.set(err.error?.error ?? 'Failed to join network.');
      },
    });
  }

  removeMember(net: Network, instanceId: string, label: string): void {
    if (!confirm(`Remove "${label}" from network "${net.label}"?\n\nThis will stop syncing with that peer.`)) return;
    const key = `${net.id}:${instanceId}`;
    this.removingMember[key] = true;
    this.api.removeMember(net.id, instanceId).subscribe({
      next: () => {
        delete this.removingMember[key];
        this.load();
      },
      error: (err) => {
        delete this.removingMember[key];
        alert(err.error?.error ?? 'Failed to remove member');
      },
    });
  }

  sync(networkId: string): void {
    this.api.triggerSync(networkId).subscribe({
      next: (r) => {
        this.syncResults[networkId] = r;
        this.networks.update(n => [...n]);
        setTimeout(() => { delete this.syncResults[networkId]; this.networks.update(n => [...n]); }, 4000);
        // Auto-refresh history after sync completes (give it a moment)
        if (this.historyExpanded() === networkId) {
          setTimeout(() => this.loadHistory(networkId), 3000);
        }
      },
      error: () => {
        this.syncResults[networkId] = { ok: false };
        this.networks.update(n => [...n]);
      },
    });
  }

  toggleHistory(networkId: string): void {
    if (this.historyExpanded() === networkId) {
      this.historyExpanded.set('');
    } else {
      this.historyExpanded.set(networkId);
      this.loadHistory(networkId);
    }
  }

  historyForNet(networkId: string): SyncHistoryRecord[] {
    return this.historyByNetwork[networkId] ?? [];
  }

  toggleHistoryErrors(recordId: string): void {
    this.expandedError.update(v => v === recordId ? '' : recordId);
  }

  private loadHistory(networkId: string): void {
    this.historyLoading.set(true);
    this.api.getSyncHistory(networkId).subscribe({
      next: ({ history }) => {
        this.historyByNetwork[networkId] = history;
        this.historyLoading.set(false);
        this.networks.update(n => [...n]);
      },
      error: () => this.historyLoading.set(false),
    });
  }

  private loadVotes(networkId: string): void {
    this.api.listVotes(networkId).subscribe({
      next: ({ rounds }) => {
        this.votesByNetwork[networkId] = rounds.filter(r => r.status === 'open');
        this.networks.update(n => [...n]);
      },
      error: () => {},
    });
  }

  openVotes(networkId: string): VoteRound[] {
    return this.votesByNetwork[networkId] ?? [];
  }

  castVote(networkId: string, roundId: string, vote: 'yes' | 'no'): void {
    this.api.castVote(networkId, roundId, vote).subscribe({
      next: () => this.loadVotes(networkId),
      error: (err) => alert(err.error?.error ?? 'Failed to cast vote.'),
    });
  }

  typeBadge(type: string): string {
    const map: Record<string, string> = {
      closed: 'badge-gray',
      democratic: 'badge-green',
      club: 'badge-blue',
      braintree: 'badge-purple',
    };
    return map[type] ?? 'badge-gray';
  }
}
