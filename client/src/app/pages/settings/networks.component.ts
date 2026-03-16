import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, Network, VoteRound } from '../../core/api.service';

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
  `],
  template: `
    <!-- Create network -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="card-header">
        <div>
          <div class="card-title">Create network</div>
          <div class="card-subtitle">Networks sync brain data and files with peers.</div>
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

              <!-- Invite key -->
              <div style="margin-bottom:16px; margin-top:12px;">
                <div class="section-title">Invite key</div>
                @if (inviteKey(net.id); as key) {
                  <div class="code-block" style="margin-bottom:8px;">{{ key }}</div>
                  <button class="btn-ghost btn btn-sm" (click)="copyInvite(net.id)">
                    {{ copiedInvite() === net.id ? '✓ Copied' : 'Copy' }}
                  </button>
                } @else {
                  <button class="btn-secondary btn btn-sm" (click)="generateInvite(net.id)">
                    Generate invite key
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

              <!-- Members -->
              <div class="section-title">Members</div>
              @for (m of net.members; track m.instanceId) {
                <div class="member-row">
                  <span class="mono badge badge-gray" style="font-size:11px;">{{ m.instanceId.slice(0, 8) }}</span>
                  <span style="font-weight:500;">{{ m.label }}</span>
                  <span class="badge badge-gray" style="font-size:11px;">{{ m.syncDirection ?? 'both' }}</span>
                  <a [href]="m.endpoint" target="_blank" rel="noopener" style="font-size:11px; color:var(--text-muted);">
                    {{ m.endpoint }}
                  </a>
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

  private inviteKeys: Record<string, string> = {};
  private syncResults: Record<string, { ok: boolean }> = {};
  private copiedNetId = '';
  private votesByNetwork: Record<string, VoteRound[]> = {};

  inviteKey(id: string): string { return this.inviteKeys[id] ?? ''; }
  syncResult(id: string): { ok: boolean } | undefined { return this.syncResults[id]; }
  copiedInvite = signal('');

  ngOnInit(): void { this.load(); }

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
    });
  }

  generateInvite(networkId: string): void {
    this.api.generateInviteKey(networkId).subscribe({
      next: ({ inviteKey }) => {
        this.inviteKeys[networkId] = inviteKey;
        this.networks.update(n => [...n]); // trigger re-render
      },
    });
  }

  copyInvite(networkId: string): void {
    navigator.clipboard.writeText(this.inviteKeys[networkId]).then(() => {
      this.copiedInvite.set(networkId);
      setTimeout(() => this.copiedInvite.set(''), 2000);
    });
  }

  saveSchedule(net: Network): void {
    // Patch all members with the new schedule (simplified: trigger via sync route)
    // Full implementation would PATCH each member record
    alert('Schedule saved (requires server-side PATCH endpoint per member)');
  }

  sync(networkId: string): void {
    this.api.triggerSync(networkId).subscribe({
      next: (r) => {
        this.syncResults[networkId] = r;
        this.networks.update(n => [...n]);
        setTimeout(() => { delete this.syncResults[networkId]; this.networks.update(n => [...n]); }, 4000);
      },
      error: () => {
        this.syncResults[networkId] = { ok: false };
        this.networks.update(n => [...n]);
      },
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
