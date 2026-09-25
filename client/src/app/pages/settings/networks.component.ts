import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Network, NetworkMember, NetworkRole, Space, SyncHistoryRecord, VoteRound } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { NetworkInvitePanelComponent } from './network-invite-panel.component';
import { SpacesApi } from '../../core/spaces-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { SummaryStripComponent, type SummaryItem } from '../../shared/summary-strip.component';
import { RelativeTimeComponent } from '../../shared/relative-time.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
import { NetworkMemberRowComponent } from './network-member-row.component';
import { NetworkCreateDialogComponent } from './network-create-dialog.component';
import { NetworkJoinDialogComponent } from './network-join-dialog.component';
import { NetworkEnableWizardComponent } from './network-enable-wizard.component';
@Component({
  selector: 'app-networks',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, StatusPillComponent, SummaryStripComponent, RelativeTimeComponent, ErrorStateComponent, NetworkCreateDialogComponent, NetworkJoinDialogComponent, NetworkEnableWizardComponent, NetworkMemberRowComponent, NetworkInvitePanelComponent],
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

    /* This instance's role (F-38.1): outlined, so it never reads as one more network TYPE colour beside it. */
    .badge-role {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-primary);
      font-weight: 600;
    }
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

    /*
     * The member-row, member-endpoint, member-sync and member-failing rules moved to
     * network-member-row.component.ts with the markup that used them (N-2). No backticks in this
     * comment: it lives inside a template literal, which one would terminate.
     *
     * Kept as a note because leaving them here is the failure that looks like nothing: the child renders
     * correctly from its own styles while the parent carries dead rules for markup it no longer holds,
     * and the next person to touch either copy has two.
     */
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
    .history-row > span:nth-child(3) { min-width: 0; } /* let the counts cell shrink instead of overflowing */
    /* Narrow iframe: drop the fixed grid and let the cells wrap. */
    @media (max-width: 680px) {
      .history-row { display: flex; flex-wrap: wrap; }
    }

    .history-row:last-child { border-bottom: none; }

    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }

    .status-success { background: var(--status-success-bg); color: var(--status-success-fg); }
    .status-partial { background: var(--status-warning-bg); color: var(--status-warning-fg); }
    .status-failed  { background: var(--status-error-bg);   color: var(--status-error-fg); }
    .create-join-row { display: flex; gap: 24px; margin-bottom: 24px; }
    .create-join-row > .card { flex: 1; min-width: 0; margin-bottom: 0; }
    @media (max-width: 900px) { .create-join-row { flex-direction: column; } }
    .spaces-toggle-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .space-toggle-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      background: var(--bg-surface);
      transition: background var(--transition), border-color var(--transition);
      user-select: none;
    }
    .space-toggle-item:hover { background: var(--bg-elevated); }
    .space-toggle-item input[type=checkbox] { width: 13px; height: 13px; margin: 0; flex-shrink: 0; }
    .space-toggle-item .space-id { color: var(--text-muted); font-size: 11px; font-family: var(--font-mono); }
  `],
  template: `
    <!-- Network list (shown first) -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
      <div class="card-title">{{ 'networks.title' | transloco }}</div>
      <div style="display:flex; gap:8px;">
        @if (needsNetworkEnable()) {
          <button class="btn-primary btn btn-sm" (click)="showEnableNetworksWizard.set(true)">{{ 'networks.enableButton' | transloco }}</button>
        } @else {
          <button class="btn-primary btn btn-sm" (click)="showCreateDialog.set(true)">{{ 'networks.createButton' | transloco }}</button>
          <button class="btn-secondary btn btn-sm" (click)="showJoinDialog.set(true)">{{ 'networks.joinButton' | transloco }}</button>
        }
      </div>
    </div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (loadError() !== null) {
      <app-error-state [message]="'networks.loadError' | transloco" [reason]="loadError() ?? ''" (retry)="load()" />
    } @else if (networks().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon">🔗</div>
        <h3>{{ 'networks.empty.title' | transloco }}</h3>
        <p>{{ 'networks.empty.body' | transloco }}</p>
      </div>
    } @else {
      <app-summary-strip [items]="summaryItems()" style="display:block; margin-bottom:16px;" />
      @for (net of networks(); track net.id) {
        <div class="network-card">
          <div class="network-card-header" (click)="toggleNetwork(net.id)">
            <span class="network-name">{{ net.label }}</span>
            <span class="badge" [ngClass]="typeBadge(net.type)">{{ net.type }}</span>
            @if (net.myRole; as r) {
              <span class="badge badge-role" [attr.aria-label]="'networks.role.ariaLabel' | transloco">{{ ('networks.role.' + r.role) | transloco }}</span>
              @if (roleCountKey(r); as key) {
                <span class="badge badge-gray">{{ key | transloco: { count: r.members.length } }}</span>
              }
            } @else {
              <span class="badge badge-gray">{{ net.members.length }} {{ net.members.length === 1 ? ('networks.memberBadge.singular' | transloco) : ('networks.memberBadge.plural' | transloco) }}</span>
            }
            @if (openVotes(net.id).length > 0) {
              <app-status-pill variant="warn" [dot]="true">{{ openVotes(net.id).length }} {{ 'networks.header.pendingVote' | transloco }}</app-status-pill>
            }
            <span style="flex:1;"></span>
            <span style="color:var(--text-muted); display:inline-flex;"><ph-icon [name]="expanded() === net.id ? 'caret-up' : 'caret-down'" [size]="14" /></span>
          </div>

          @if (expanded() === net.id) {
            <div class="network-body">

              <!-- Invite bundle — not for a pub/sub subscriber: only the publisher invites (F-38.1). -->
              @if (net.myRole?.role !== 'subscriber') {
                <app-network-invite-panel [networkId]="net.id" [networkType]="net.type" />
              }

              <!-- Sync -->
              <div style="margin-bottom:16px;">
                <div class="section-title">{{ 'networks.network.sync.title' | transloco }}</div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <input
                    type="text"
                    [ngModel]="net.syncSchedule ?? ''"
                    (ngModelChange)="netSchedule[net.id] = $event"
                    [name]="'sched-' + net.id"
                    [placeholder]="'networks.network.sync.schedulePlaceholder' | transloco"
                    [attr.aria-label]="'networks.network.sync.scheduleAriaLabel' | transloco"
                    style="flex:1; min-width:220px;"
                  />
                  <button class="btn-secondary btn btn-sm" [disabled]="savingSchedule[net.id]" (click)="saveSchedule(net)">
                    @if (savingSchedule[net.id]) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    {{ 'networks.network.sync.saveScheduleButton' | transloco }}
                  </button>
                  <button class="btn-secondary btn btn-sm" [disabled]="syncingNet[net.id]" (click)="sync(net.id)">
                    @if (syncingNet[net.id]) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    {{ 'networks.network.sync.syncNowButton' | transloco }}
                  </button>
                </div>
                @if (syncResult(net.id); as r) {
                  <div class="alert" [class.alert-success]="r.ok" [class.alert-error]="!r.ok" style="margin-top:8px;">
                    {{ r.ok ? ('networks.network.sync.success' | transloco) : ('networks.network.sync.failed' | transloco) }}
                  </div>
                }
              </div>

              <!-- Sync History -->
              <div style="margin-bottom:16px;">
                <div class="section-title" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px;" (click)="toggleHistory(net.id)">
                  {{ 'networks.network.syncHistory.title' | transloco }} <ph-icon [name]="historyExpanded() === net.id ? 'caret-up' : 'caret-down'" [size]="12" />
                </div>
                @if (historyExpanded() === net.id) {
                  @if (historyLoading()) {
                    <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">{{ 'networks.network.syncHistory.loading' | transloco }}</div>
                  } @else if (historyError() !== null) {
                    <app-error-state [message]="'networks.network.syncHistory.loadError' | transloco"
                                     [reason]="historyError() ?? ''" [icon]="28" (retry)="retryHistory(net.id)" />
                  } @else if (historyForNet(net.id).length === 0) {
                    <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">{{ 'networks.network.syncHistory.empty' | transloco }}</div>
                  } @else {
                    @for (rec of historyForNet(net.id); track rec._id) {
                      <div class="history-row">
                        <span style="color:var(--text-muted);">{{ rec.completedAt | date:'dd.MM.yyyy HH:mm' }}</span>
                        <span class="status-badge" [ngClass]="'status-' + rec.status">{{ rec.status }}</span>
                        <span>
                          ↓ {{ rec.pulled.facts + rec.pulled.entities + rec.pulled.edges }}
                          + {{ rec.pulled.files }} files &nbsp;
                          ↑ {{ rec.pushed.facts + rec.pushed.entities + rec.pushed.edges }}
                          + {{ rec.pushed.files }} files
                        </span>
                        @if (rec.errors?.length) {
                          <button class="btn-ghost btn btn-sm" style="font-size:11px;"
                            (click)="toggleHistoryErrors(rec._id)">
                            {{ expandedError() === rec._id ? ('networks.network.syncHistory.hideErrors' | transloco) : (rec.errors!.length + ' ' + ('networks.network.syncHistory.errorCountSuffix' | transloco)) }}
                          </button>
                        }
                      </div>
                      @if (expandedError() === rec._id && rec.errors) {
                        <div style="padding:4px 0 8px 8px; font-size:11px; color:var(--error);">
                          @for (e of rec.errors; track e) {
                            <div>{{ e }}</div>
                          }
                        </div>
                      }
                    }
                  }
                }
              </div>

              <!-- Spaces the network carries (F-38.1) -->
              <div style="margin-bottom:16px;">
                <div class="section-title">{{ 'networks.network.spaces.title' | transloco }}</div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  @for (s of net.spaces; track s) {
                    <span class="badge badge-gray">{{ s }}@if (remoteOf(net, s); as remote) { <span style="color:var(--text-muted);"> · {{ 'networks.network.spaces.mappedFrom' | transloco: { remote } }}</span> }</span>
                  }
                </div>
              </div>

              <!-- Members, as this instance's role sees them (F-38.1) -->
              @for (group of memberGroups(net); track group.titleKey) {
                <div class="section-title">{{ group.titleKey | transloco }}</div>
                @if (group.members.length === 0 && group.emptyKey) {
                  <div style="padding:4px 0 8px; color:var(--text-muted); font-size:12px;">{{ group.emptyKey | transloco }}</div>
                }
                @for (m of group.members; track m.instanceId) {
                  <app-network-member-row
                    [member]="m"
                    [removable]="net.myRole?.role !== 'subscriber'"
                    [removing]="!!removingMember[net.id + ':' + m.instanceId]"
                    (remove)="removeMember(net, m.instanceId, m.label)" />
                }
              }
              <!-- Open votes -->
              @if (openVotes(net.id).length > 0) {
                <div style="margin-top:16px;">
                  <div class="section-title">{{ 'networks.network.votes.title' | transloco }}</div>
                  @for (round of openVotes(net.id); track round.id) {
                    <div class="vote-row">
                      <span style="flex:1;">{{ round.type }}: {{ round.subject }}</span>
                      <span style="font-size:11px; color:var(--text-muted); white-space:nowrap;">
                        {{ 'networks.network.votes.deadline' | transloco }} <app-relative-time [value]="round.deadline" />
                      </span>
                      <span class="num" style="font-size:11px; color:var(--text-muted); white-space:nowrap;">
                        {{ 'networks.network.votes.tally' | transloco: { yes: voteTally(round).yes, veto: voteTally(round).veto } }}
                      </span>
                      <button class="btn-primary btn btn-sm" [disabled]="votingRound[round.id]" (click)="castVote(net.id, round.id, 'yes')">
                        @if (votingRound[round.id]) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                        {{ 'networks.network.votes.yes' | transloco }}
                      </button>
                      <button class="btn-danger btn btn-sm" [disabled]="votingRound[round.id]" (click)="castVote(net.id, round.id, 'veto')">{{ 'networks.network.votes.veto' | transloco }}</button>
                    </div>
                  }
                </div>
              }

              <!-- Leave -->
              <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border-muted);">
                <button class="btn-danger btn btn-sm" (click)="leaveNetwork(net)">{{ 'networks.network.leaveButton' | transloco }}</button>
              </div>
            </div>
          }
        </div>
      }
    }

    <!-- Create Network dialog -->
    @if (showCreateDialog()) {
      <app-network-create-dialog
        [availableSpaces]="availableSpaces()"
        [spacesLoadFailed]="spacesLoadFailed()"
        (created)="onNetworkCreated($event)"
        (close)="showCreateDialog.set(false)"
      />
    }

    <!-- Join Network dialog -->
    @if (showJoinDialog()) {
      <app-network-join-dialog
        [availableSpaces]="availableSpaces()"
        [myUrl]="joinMyUrl"
        (joined)="onJoined()"
        (close)="showJoinDialog.set(false)"
      />
    }

    <!-- Enable Networks wizard -->
    @if (showEnableNetworksWizard()) {
      <app-network-enable-wizard
        (enabled)="onEnabled($event)"
        (close)="showEnableNetworksWizard.set(false)"
      />
    }
  `,
})
export class NetworksComponent implements OnInit {
  private networksApi = inject(NetworksApi);
  private spacesApi = inject(SpacesApi);
  private adminApi = inject(AdminApi);
  private transloco = inject(TranslocoService);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);

  networks = signal<Network[]>([]);
  loading = signal(true);
  /** Null until the last load failed — checked before the empty state, so a failure never reads as "no networks". */
  loadError = signal<string | null>(null);
  showCreateDialog = signal(false);
  showJoinDialog = signal(false);
  expanded = signal('');

  netSchedule: Record<string, string> = {};

  availableSpaces = signal<Space[]>([]);
  spacesLoadFailed = signal(false);

  private syncResults: Record<string, { ok: boolean }> = {};
  private votesByNetwork: Record<string, VoteRound[]> = {};

  // This brain's own URL — computed in ngOnInit (and the enable-networks flow) and passed to the join
  // dialog as its `myUrl`; also gates whether the enable-networks wizard is offered.
  joinMyUrl = '';
  joinMyUrlAutoFilled = signal(false);
  removingMember: Record<string, boolean> = {};
  // Per-network / per-round in-flight flags so each async action shows a spinner and disables its button
  // (default change detection re-renders on the settling HTTP response).
  savingSchedule: Record<string, boolean> = {};
  syncingNet: Record<string, boolean> = {};
  votingRound: Record<string, boolean> = {};

  // Sync history state
  historyExpanded = signal('');
  historyLoading = signal(false);
  /** Null until the sync history failed to load — else "no sync history yet" claims the sync never ran. */
  historyError = signal<string | null>(null);
  expandedError = signal('');
  private historyByNetwork: Record<string, SyncHistoryRecord[]> = {};

  // Whether this brain looks locally-reachable (so it needs the enable-networks wizard to get a public
  // URL before it can join). Derived from its own URL in ngOnInit; cleared when the wizard reports success.
  needsNetworkEnable = signal(false);
  showEnableNetworksWizard = signal(false);

  syncResult(id: string): { ok: boolean } | undefined { return this.syncResults[id]; }

  /** At-a-glance rollup atop the page. Recomputes when `networks` changes — and `loadVotes` always
   *  bumps `networks` after updating the vote cache, so the "need your vote" count stays live. */
  readonly summaryItems = computed<SummaryItem[]>(() => {
    const tr = (k: string) => this.transloco.translate(k);
    const nets = this.networks();
    const needVote = nets.filter(n => this.openVotes(n.id).length > 0).length;
    const members = nets.reduce((sum, n) => sum + (n.members?.length ?? 0), 0);
    return [
      { label: tr('networks.summary.networks'), value: nets.length },
      { label: tr('networks.summary.needVote'), value: needVote, variant: needVote ? 'warn' : undefined },
      { label: tr('networks.summary.members'), value: members },
    ];
  });

  /** Yes/veto counts for an open vote round (for the row tally). */
  voteTally(round: VoteRound): { yes: number; veto: number } {
    return {
      yes: round.votes.filter(v => v.vote === 'yes').length,
      veto: round.votes.filter(v => v.vote === 'veto').length,
    };
  }

  ngOnInit(): void {
    this.load();
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces }) => this.availableSpaces.set(spaces),
      error: () => this.spacesLoadFailed.set(true),
    });
    // Auto-fill this brain's URL: prefer the server-configured publicUrl, fall
    // back to the current browser origin (works for most single-brain deployments).
    this.adminApi.getAbout().subscribe({
      next: (info) => {
        // Prefer server-configured publicUrl; fall back to current browser origin.
        // window.location.origin returns the string 'null' in sandboxed/restricted contexts.
        const url = info.publicUrl || window.location.origin;
        if (url && url !== 'null') {
          this.joinMyUrl = url;
          this.joinMyUrlAutoFilled.set(true);
          this.needsNetworkEnable.set(this.isLocalOrPrivateUrl(url));
        }
      },
      error: () => {
        // window.location.origin can be the string 'null' in sandboxed/file:// contexts
        const origin = window.location.origin;
        if (origin && origin !== 'null') {
          this.joinMyUrl = origin;
          this.joinMyUrlAutoFilled.set(true);
          this.needsNetworkEnable.set(this.isLocalOrPrivateUrl(origin));
        }
      },
    });
  }

  /** The enable-networks wizard (child) reports success with this brain's now-public URL; adopt it and
   *  drop the enable prompt. */
  onEnabled(url: string): void {
    this.joinMyUrl = url;
    this.joinMyUrlAutoFilled.set(true);
    this.needsNetworkEnable.set(false);
  }

  private isLocalOrPrivateUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '::1') return true;
      if (/^127\./.test(host)) return true;
      if (/^10\./.test(host)) return true;
      if (/^192\.168\./.test(host)) return true;
      if (/^169\.254\./.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
      if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return true;
      if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
      return false;
    } catch {
      return true;
    }
  }


  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.networksApi.listNetworks().subscribe({
      next: ({ networks }) => {
        this.networks.set(networks);
        this.loading.set(false);
        // Load votes for each network
        for (const net of networks) this.loadVotes(net.id);
      },
      error: (err) => { this.loadError.set(httpErrorReason(err)); this.loading.set(false); },
    });
  }

  toggleNetwork(id: string): void {
    this.expanded.update(v => v === id ? '' : id);
  }

  /** The create dialog (child component) emits the new network; append it and close. */
  onNetworkCreated(net: Network): void {
    this.networks.update(list => [...list, net]);
    this.showCreateDialog.set(false);
  }

  async leaveNetwork(net: Network): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('networks.confirm.leaveTitle'),
      message: this.transloco.translate('networks.confirm.leave', { label: net.label }),
      confirmLabel: this.transloco.translate('networks.leaveButton'),
      danger: true,
    });
    if (!ok) return;
    this.networksApi.leaveNetwork(net.id).subscribe({
      next: () => this.networks.update(list => list.filter(n => n.id !== net.id)),
      error: (err) => this.toast.error(err.error?.error ?? this.transloco.translate('networks.error.leaveFailed')),
    });
  }

  saveSchedule(net: Network): void {
    const schedule = this.netSchedule[net.id] ?? net.syncSchedule ?? '';
    this.savingSchedule[net.id] = true;
    this.networksApi.updateNetworkSchedule(net.id, schedule).subscribe({
      next: () => {
        delete this.savingSchedule[net.id];
        this.networks.update(list =>
          list.map(n => n.id === net.id ? { ...n, syncSchedule: schedule || undefined } : n)
        );
      },
      error: (err) => {
        delete this.savingSchedule[net.id];
        this.toast.error(err.error?.error ?? this.transloco.translate('networks.error.saveScheduleFailed'));
      },
    });
  }

  /** The join dialog (child) emits after a successful join; reload networks and refresh the spaces list
   *  (a join can create new local spaces). */
  onJoined(): void {
    this.load();
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces }) => this.availableSpaces.set(spaces),
      error: () => {},
    });
  }

  async removeMember(net: Network, instanceId: string, label: string): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('networks.confirm.removeMemberTitle'),
      message: this.transloco.translate('networks.confirm.removeMember', { label, networkLabel: net.label }),
      confirmLabel: this.transloco.translate('common.remove'),
      danger: true,
    });
    if (!ok) return;
    const key = `${net.id}:${instanceId}`;
    this.removingMember[key] = true;
    this.networksApi.removeMember(net.id, instanceId).subscribe({
      next: () => {
        delete this.removingMember[key];
        this.load();
      },
      error: (err) => {
        delete this.removingMember[key];
        this.toast.error(err.error?.error ?? this.transloco.translate('networks.error.removeMemberFailed'));
      },
    });
  }

  sync(networkId: string): void {
    this.syncingNet[networkId] = true;
    this.networksApi.triggerSync(networkId).subscribe({
      next: (r) => {
        delete this.syncingNet[networkId];
        this.syncResults[networkId] = r;
        this.networks.update(n => [...n]);
        setTimeout(() => { delete this.syncResults[networkId]; this.networks.update(n => [...n]); }, 4000);
        // Auto-refresh history after sync completes (give it a moment)
        if (this.historyExpanded() === networkId) {
          setTimeout(() => this.loadHistory(networkId), 3000);
        }
      },
      error: () => {
        delete this.syncingNet[networkId];
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

  /** Public so the history panel's error state can retry the one network it belongs to. */
  retryHistory(networkId: string): void {
    this.loadHistory(networkId);
  }

  private loadHistory(networkId: string): void {
    this.historyLoading.set(true);
    this.historyError.set(null);
    this.networksApi.getSyncHistory(networkId).subscribe({
      next: ({ history }) => {
        this.historyByNetwork[networkId] = history;
        this.historyLoading.set(false);
        this.networks.update(n => [...n]);
      },
      error: (err) => { this.historyError.set(httpErrorReason(err)); this.historyLoading.set(false); },
    });
  }

  private loadVotes(networkId: string): void {
    this.networksApi.listVotes(networkId).subscribe({
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

  async castVote(networkId: string, roundId: string, vote: 'yes' | 'veto'): Promise<void> {
    // A veto is destructive — it blocks a pending join/governance round — so confirm it first. A "yes"
    // is safe and stays one click.
    if (vote === 'veto') {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('networks.confirm.vetoTitle'),
        message: this.transloco.translate('networks.confirm.veto'),
        confirmLabel: this.transloco.translate('networks.network.votes.veto'),
        danger: true,
      });
      if (!ok) return;
    }
    this.votingRound[roundId] = true;
    this.networksApi.castVote(networkId, roundId, vote).subscribe({
      next: () => { delete this.votingRound[roundId]; this.loadVotes(networkId); },
      error: (err) => {
        delete this.votingRound[roundId];
        this.toast.error(err.error?.error ?? this.transloco.translate('networks.error.castVoteFailed'));
      },
    });
  }

  /** The count the header shows for this role, or null when the role shows none (a subscriber, a lone root). */
  roleCountKey(r: NetworkRole): string | null {
    if (r.role === 'publisher') return 'networks.role.count.subscribers';
    if (r.role === 'subscriber') return null;
    if (r.role === 'root' || r.role === 'node' || r.role === 'leaf') return r.members.length ? 'networks.role.count.below' : null;
    return 'networks.role.count.peers';
  }

  /** The network space a local space was mapped from on join, when it differs from the local id. */
  remoteOf(net: Network, local: string): string | null {
    const hit = Object.entries(net.spaceMap ?? {}).find(([remote, l]) => l === local && remote !== local);
    return hit ? hit[0] : null;
  }

  /**
   * The member lists this instance's role acts on (F-38.1). A publisher sees its subscribers, a subscriber only its
   * publisher, a club or voted network its peers, a tree node the path to the root and what is below it. Without a
   * role (an older server) it falls back to every member, as before.
   */
  memberGroups(net: Network): { titleKey: string; members: NetworkMember[]; emptyKey?: string }[] {
    const r = net.myRole;
    const pick = (ids: string[] | undefined) =>
      (ids ?? []).map(id => net.members.find(m => m.instanceId === id)).filter((m): m is NetworkMember => !!m);
    if (!r) return [{ titleKey: 'networks.network.members.title', members: net.members }];
    switch (r.role) {
      case 'publisher': return [{ titleKey: 'networks.network.members.subscribers', members: pick(r.members), emptyKey: 'networks.network.members.noSubscribers' }];
      case 'subscriber': return [{ titleKey: 'networks.network.members.publisher', members: pick(r.publisher ? [r.publisher] : []) }];
      case 'root': case 'node': case 'leaf': return [
        { titleKey: 'networks.network.members.pathToRoot', members: pick(r.pathToRoot), emptyKey: 'networks.network.members.isRoot' },
        { titleKey: 'networks.network.members.subtree', members: pick(r.subtree), emptyKey: 'networks.network.members.noneBelow' },
      ];
      default: return [{ titleKey: 'networks.network.members.peers', members: pick(r.members) }];
    }
  }

  typeBadge(type: string): string {
    const map: Record<string, string> = {
      closed: 'badge-gray',
      democratic: 'badge-green',
      club: 'badge-blue',
      braintree: 'badge-purple',
      pubsub: 'badge-orange',
    };
    return map[type] ?? 'badge-gray';
  }
}
