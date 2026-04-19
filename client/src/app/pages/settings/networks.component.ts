import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, InviteBundle, Network, Space, SyncHistoryRecord, VoteRound } from '../../core/api.service';
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
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .dialog {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      width: 90%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
    }
    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .wizard-note {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0 0 10px;
      line-height: 1.45;
    }
    .wizard-list {
      margin: 0 0 12px;
      padding-left: 18px;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.45;
    }
    .wizard-status {
      margin: 8px 0 12px;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      font-size: 12px;
      color: var(--text-secondary);
    }
  `],
  template: `
    <!-- Network list (shown first) -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
      <div class="card-title">Networks</div>
      <div style="display:flex; gap:8px;">
        @if (needsNetworkEnable()) {
          <button class="btn-primary btn btn-sm" (click)="openEnableNetworksWizard()">Enable Networks</button>
        } @else {
          <button class="btn-primary btn btn-sm" (click)="showCreateDialog.set(true)">Create Network</button>
          <button class="btn-secondary btn btn-sm" (click)="showJoinDialog.set(true)">Join Network</button>
        }
      </div>
    </div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (networks().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon">🔗</div>
        <h3>No networks</h3>
        <p>Create a network or join an existing one to start syncing with peers.</p>
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
                  @if (net.type === 'pubsub') {
                    Generate a reusable invite bundle. Share it in documentation,
                    QR codes, or anywhere — subscribers can join without approval.
                    Regenerating a new bundle revokes the previous one.
                  } @else {
                    Generate a one-time invite bundle and share it with the brain you want to connect to.
                    The invite expires after 24 hours.
                  }
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
                        <span style="color:var(--text-muted);">{{ rec.completedAt | date:'dd.MM.yyyy HH:mm' }}</span>
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

    <!-- Create Network dialog -->
    @if (showCreateDialog()) {
      <div class="dialog-backdrop" (click)="showCreateDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">Create network</div>
            <button class="icon-btn" aria-label="Close dialog" (click)="showCreateDialog.set(false)">✕</button>
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
                <option value="pubsub">Pub/Sub (publisher → subscribers)</option>
              </select>
            </div>
            <div class="field" style="margin-bottom:0; grid-column:span 2;">
              <label>Spaces</label>
              @if (spacesLoadFailed()) {
                <div class="alert alert-error" style="margin-bottom:6px; font-size:12px;">⚠️ Could not load spaces — enter IDs manually.</div>
                <input type="text" [(ngModel)]="networkSpacesFallback" name="spaces" placeholder="general" />
              } @else if (availableSpaces().length === 0) {
                <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">Loading spaces…</div>
              } @else {
                <div class="table-wrapper" style="max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:var(--radius-sm);">
                  <table style="margin:0;">
                    <thead>
                      <tr>
                        <th style="width:40px; text-align:center;">
                          <input type="checkbox" [checked]="networkSelectAll" (change)="toggleNetworkSelectAll()" title="All spaces" />
                        </th>
                        <th>Space</th>
                        <th>ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (s of availableSpaces(); track s.id) {
                        <tr style="cursor:pointer;" (click)="toggleNetworkSpace(s.id)">
                          <td style="text-align:center;">
                            <input type="checkbox" [checked]="isNetworkSpaceSelected(s.id)" (click)="$event.stopPropagation()" (change)="toggleNetworkSpace(s.id)" />
                          </td>
                          <td>{{ s.label }}</td>
                          <td><span class="badge badge-gray mono" style="font-size:11px;">{{ s.id }}</span></td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </div>
            @if (form.type !== 'pubsub') {
              <div class="field" style="margin-bottom:0; grid-column:span 2;">
                <label>Voting deadline (hours)</label>
                <input type="number" [(ngModel)]="form.votingDeadlineHours" name="deadline" min="1" max="72" />
              </div>
            }
            <div style="grid-column:span 2; display:flex; gap:8px; justify-content:flex-end;">
              <button class="btn-secondary btn" type="button" (click)="showCreateDialog.set(false)">Cancel</button>
              <button class="btn-primary btn" type="submit" [disabled]="creating() || !form.label.trim()">
                @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Create network
              </button>
            </div>
          </form>
        </div>
      </div>
    }

    <!-- Join Network dialog -->
    @if (showJoinDialog()) {
      <div class="dialog-backdrop" (click)="showJoinDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">Join an existing network</div>
            <button class="icon-btn" aria-label="Close dialog" (click)="showJoinDialog.set(false)">✕</button>
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

          @if (joinCollisionSpaces().length > 0) {
            <div style="margin:0 0 12px; padding:12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-elevated);">
              <div style="font-weight:600; font-size:13px; margin-bottom:8px;">⚠ Space name collisions</div>
              <p style="font-size:12px; color:var(--text-muted); margin:0 0 12px;">
                The remote network includes spaces that already exist locally.
                Choose to merge into the existing space or create a new local alias.
              </p>
              @for (remoteId of joinCollisionSpaces(); track remoteId) {
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                  <span class="badge badge-gray mono" style="min-width:80px;">{{ remoteId }}</span>
                  <select
                    [ngModel]="joinSpaceActions[remoteId]"
                    (ngModelChange)="onCollisionActionChange(remoteId, $event)"
                    [name]="'collision-' + remoteId"
                    style="width:140px;"
                  >
                    <option value="merge">Merge into existing</option>
                    <option value="alias">Create alias</option>
                  </select>
                  @if (joinSpaceActions[remoteId] === 'alias') {
                    <input
                      type="text"
                      [(ngModel)]="joinSpaceAliases[remoteId]"
                      [name]="'alias-' + remoteId"
                      placeholder="local-id"
                      pattern="[a-z0-9-]+"
                      maxlength="40"
                      style="width:140px; padding:4px 8px; font-size:12px;"
                      required
                    />
                  }
                </div>
              }
            </div>
          }

          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button class="btn-secondary btn" type="button" (click)="showJoinDialog.set(false)">Cancel</button>
            <button
              class="btn-primary btn"
              (click)="joinCollisionSpaces().length > 0 ? confirmJoin() : joinNetwork()"
              [disabled]="joining() || !joinBundle.trim() || !joinMyUrl.trim()"
            >
              @if (joining()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              {{ joinCollisionSpaces().length > 0 ? 'Confirm and join' : 'Join network' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Enable Networks wizard -->
    @if (showEnableNetworksWizard()) {
      <div class="dialog-backdrop" (click)="showEnableNetworksWizard.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">Enable Networks</div>
            <button class="icon-btn" aria-label="Close dialog" (click)="showEnableNetworksWizard.set(false)">✕</button>
          </div>

          @if (enableWizardError()) { <div class="alert alert-error">{{ enableWizardError() }}</div> }

          @if (enableWizardStep() === 1) {
            <p class="wizard-note">
              This instance currently resolves to a local/private URL. Network peers cannot join or sync with local/private URLs because peer URL validation blocks SSRF targets.
            </p>
            <p class="wizard-note">
              The recommended path is exposing this instance with a stable public HTTPS hostname via Cloudflare Tunnel.
            </p>
            <ul class="wizard-list">
              <li>Why: dynamic home IPs and CGNAT are handled automatically.</li>
              <li>Risk model: the endpoint is internet-reachable, so keep strong tokens and monitor logs.</li>
              <li>Result: use the public hostname as myUrl/instanceUrl in join flows.</li>
            </ul>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
              <button class="btn-secondary btn" type="button" (click)="showEnableNetworksWizard.set(false)">Cancel</button>
              <button class="btn-primary btn" type="button" (click)="enableWizardStep.set(2)">Continue</button>
            </div>
          }

          @if (enableWizardStep() === 2) {
            @if (localAgentStatusMessage()) {
              <div class="wizard-status">{{ localAgentStatusMessage() }}</div>
            }
            <p class="wizard-note">
              You must use a hostname inside a DNS zone you control in Cloudflare (for example
              <span class="mono">ythril-desktop.example.com</span>). Random domains you do not control will fail.
            </p>
            <div class="field">
              <label>Public hostname (required)</label>
              <input type="text" [(ngModel)]="enableHostname" name="enableHostname" placeholder="ythril-desktop.example.com" />
            </div>
            <div class="field">
              <label>Operating system (auto-detected)</label>
              <select [(ngModel)]="enableOs" name="enableOs">
                <option value="windows">Windows</option>
                <option value="linux">Linux</option>
              </select>
            </div>
            <div class="field">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" [(ngModel)]="enableAutostart" name="enableAutostart" />
                Enable cloudflared autostart service
              </label>
            </div>
            <div class="field">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" [(ngModel)]="enableOverwriteDns" name="enableOverwriteDns" />
                Allow overwriting an existing DNS record for this hostname
              </label>
              <div class="wizard-note" style="margin-top:6px;">
                Keep this off to avoid unexpected DNS changes. Turn it on only if you intentionally want this wizard to replace an existing record.
              </div>
            </div>
            <div class="field">
              <label style="display:flex; align-items:flex-start; gap:8px;">
                <input type="checkbox" [(ngModel)]="enableAcknowledgeCritical" name="enableAcknowledgeCritical" style="margin-top:2px;" />
                <span>I understand this can install software, open Cloudflare login, create/update tunnel and DNS records, and start a background tunnel process/service on this machine.</span>
              </label>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
              <button class="btn-secondary btn" type="button" (click)="enableWizardStep.set(1)">Back</button>
              <button class="btn-primary btn" type="button" (click)="prepareEnableWizardCommands()">Continue</button>
            </div>
          }

          @if (enableWizardStep() === 3) {
            @if (localAgentChecking()) {
              <p class="wizard-note">Checking local connector status...</p>
            } @else if (localAgentCanExecute()) {
              <p class="wizard-note">One-click mode is ready. Click <strong>Run automatically</strong>. Use manual commands only if automatic mode fails.</p>
            } @else {
              <p class="wizard-note">Automatic mode is unavailable. Use manual commands on this host, then click <strong>I finished setup</strong>.</p>
            }
            @if (localAgentStatusMessage()) {
              <div class="wizard-status">{{ localAgentStatusMessage() }}</div>
            }
            @if (!localAgentCanExecute() && !localAgentChecking()) {
              @if (enableOs === 'windows') {
                <div class="code-block" style="white-space:pre-wrap; word-break:break-word; font-size:11px;">{{ enableWindowsCommand() }}</div>
              } @else {
                <div class="code-block" style="white-space:pre-wrap; word-break:break-word; font-size:11px;">{{ enableLinuxCommand() }}</div>
              }
            }
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
              @if (localAgentCanExecute()) {
                <button class="btn-primary btn" type="button" [disabled]="enableAutoRunning() || !enableAcknowledgeCritical" (click)="runEnableNetworksAutomatically()">
                  @if (enableAutoRunning()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                  Run automatically
                </button>
              }
              @if (!localAgentCanExecute() && !localAgentChecking()) {
                <button class="btn-ghost btn" type="button" (click)="copyEnableWizardCommands()">Copy commands</button>
              }
              <button class="btn-secondary btn" type="button" (click)="enableWizardStep.set(2)">Back</button>
              @if (!localAgentCanExecute() && !localAgentChecking()) {
                <button class="btn-primary btn" type="button" (click)="completeEnableWizard()">I finished setup</button>
              }
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class NetworksComponent implements OnInit {
  private api = inject(ApiService);

  networks = signal<Network[]>([]);
  loading = signal(true);
  creating = signal(false);
  createError = signal('');
  showCreateDialog = signal(false);
  showJoinDialog = signal(false);
  expanded = signal('');

  form = { label: '', type: 'closed', votingDeadlineHours: 48 };
  netSchedule: Record<string, string> = {};

  availableSpaces = signal<Space[]>([]);
  spacesLoadFailed = signal(false);
  networkSelectedSpaces: string[] = [];
  networkSpacesFallback = '';
  networkSelectAll = false;

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
  joinCollisionSpaces = signal<string[]>([]);
  joinSpaceActions: Record<string, 'merge' | 'alias'> = {};
  joinSpaceAliases: Record<string, string> = {};
  private joinParsedBundle: any = null;
  removingMember: Record<string, boolean> = {};

  // Sync history state
  historyExpanded = signal('');
  historyLoading = signal(false);
  expandedError = signal('');
  private historyByNetwork: Record<string, SyncHistoryRecord[]> = {};

  needsNetworkEnable = signal(false);
  showEnableNetworksWizard = signal(false);
  enableWizardStep = signal(1);
  enableWizardError = signal('');
  enableHostname = '';
  enableOs: 'windows' | 'linux' = 'windows';
  enableAutostart = true;
  enableOverwriteDns = false;
  enableAcknowledgeCritical = false;
  enableWindowsCommand = signal('');
  enableLinuxCommand = signal('');
  localAgentCanExecute = signal(false);
  localAgentChecking = signal(false);
  localAgentStatusMessage = signal('');
  enableAutoRunning = signal(false);

  inviteBundle(id: string): InviteBundle | undefined { return this.inviteBundles[id]; }
  bundleJson(bundle: InviteBundle): string { return JSON.stringify(bundle, null, 2); }
  syncResult(id: string): { ok: boolean } | undefined { return this.syncResults[id]; }

  ngOnInit(): void {
    this.enableOs = this.detectLocalOs();
    this.load();
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => this.availableSpaces.set(spaces),
      error: () => this.spacesLoadFailed.set(true),
    });
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

  openEnableNetworksWizard(): void {
    this.enableWizardError.set('');
    this.enableWizardStep.set(1);
    this.enableHostname = '';
    this.enableWindowsCommand.set('');
    this.enableLinuxCommand.set('');
    this.enableOverwriteDns = false;
    this.enableAcknowledgeCritical = false;
    this.localAgentCanExecute.set(false);
    this.localAgentChecking.set(false);
    this.localAgentStatusMessage.set('');
    this.showEnableNetworksWizard.set(true);
  }

  prepareEnableWizardCommands(): void {
    this.enableWizardError.set('');
    const host = this.enableHostname.trim();
    if (!/^(?=.{4,253}$)(?!-)([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}$/.test(host)) {
      this.enableWizardError.set('Enter a valid public hostname (for example ythril-desktop.example.com).');
      return;
    }

    this.enableWindowsCommand.set(this.buildWindowsCloudflareCommands(host));
    this.enableLinuxCommand.set(this.buildLinuxCloudflareCommands(host));
    this.localAgentStatusMessage.set('Checking local connector...');
    this.localAgentChecking.set(true);
    this.bootstrapLocalAgent();
    this.enableWizardStep.set(3);
  }

  copyEnableWizardCommands(): void {
    const text = this.enableOs === 'windows' ? this.enableWindowsCommand() : this.enableLinuxCommand();
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {});
  }

  completeEnableWizard(): void {
    const host = this.enableHostname.trim();
    if (!host) return;
    if (!confirm(`Did you verify that https://${host}/health returns status ok from another machine/browser?`)) return;
    const url = `https://${host}`;
    this.joinMyUrl = url;
    this.joinMyUrlAutoFilled.set(true);
    this.needsNetworkEnable.set(false);
    this.showEnableNetworksWizard.set(false);
  }

  runEnableNetworksAutomatically(): void {
    const host = this.enableHostname.trim();
    if (!host) {
      this.enableWizardError.set('Enter a public hostname first.');
      return;
    }
    if (!this.enableAcknowledgeCritical) {
      this.enableWizardError.set('Please acknowledge critical system changes before running automatically.');
      return;
    }
    this.enableWizardError.set('');
    this.enableAutoRunning.set(true);
    if (!this.localAgentCanExecute()) {
      this.localAgentStatusMessage.set('Bootstrapping local connector...');
      this.api.bootstrapLocalAgent({ os: this.enableOs }).subscribe({
        next: () => this.executeEnableNetworks(host),
        error: (err) => {
          this.enableAutoRunning.set(false);
          this.enableWizardError.set(err.error?.error ?? 'Automatic bootstrap failed. Use manual commands as fallback.');
        },
      });
      return;
    }

    this.executeEnableNetworks(host);
  }

  private executeEnableNetworks(host: string): void {
    this.api.executeEnableNetworksViaLocalAgent({
      hostname: host,
      os: this.enableOs,
      autostart: this.enableAutostart,
      overwriteDns: this.enableOverwriteDns,
      acknowledgeCriticalChanges: this.enableAcknowledgeCritical,
    }).subscribe({
      next: (result) => {
        this.enableAutoRunning.set(false);
        this.localAgentStatusMessage.set(result.message ?? 'Automatic setup finished via local connector.');
        const url = result.publicUrl || `https://${host}`;
        this.joinMyUrl = url;
        this.joinMyUrlAutoFilled.set(true);
        this.needsNetworkEnable.set(false);
      },
      error: (err) => {
        this.enableAutoRunning.set(false);
        this.enableWizardError.set(err.error?.error ?? 'Automatic setup failed. Use manual commands as fallback.');
      },
    });
  }

  private bootstrapLocalAgent(): void {
    // Try status first — if the connector is already running (e.g. feature enabled via env var,
    // or connector was started manually), automatic mode becomes available without bootstrap.
    this.api.getLocalAgentStatus().subscribe({
      next: (status) => {
        if (status.canExecute) {
          this.localAgentCanExecute.set(true);
          this.localAgentChecking.set(false);
          this.localAgentStatusMessage.set(status.message ?? 'Local connector is ready for one-click execution.');
        } else {
          // Connector not ready — try to spawn it via bootstrap.
          this.triggerBootstrap();
        }
      },
      error: () => this.triggerBootstrap(),
    });
  }

  private triggerBootstrap(): void {
    this.localAgentStatusMessage.set('Starting local connector...');
    this.api.bootstrapLocalAgent({ os: this.enableOs }).subscribe({
      next: (result) => {
        this.localAgentStatusMessage.set(result.message ?? 'Local connector started.');
        this.refreshLocalAgentStatus();
      },
      error: (err) => {
        this.localAgentCanExecute.set(false);
        this.localAgentChecking.set(false);
        const detail = err?.error?.error ?? err?.message ?? `HTTP ${err?.status ?? 'unknown'}`;
        this.localAgentStatusMessage.set(`Could not start the local connector (${detail}). Manual commands are still available.`);
      },
    });
  }

  private refreshLocalAgentStatus(): void {
    this.api.getLocalAgentStatus().subscribe({
      next: (status) => {
        this.localAgentCanExecute.set(status.canExecute);
        this.localAgentChecking.set(false);
        this.localAgentStatusMessage.set(status.message ?? (status.canExecute ? 'Local connector is ready for one-click execution.' : 'Manual commands are available below.'));
      },
      error: () => {
        this.localAgentCanExecute.set(false);
        this.localAgentChecking.set(false);
        this.localAgentStatusMessage.set('Could not reach the local connector status endpoint. Manual commands are still available.');
      },
    });
  }

  private buildWindowsCloudflareCommands(host: string): string {
    const serviceBlock = this.enableAutostart
      ? "cloudflared service install\nStart-Service cloudflared"
      : "cloudflared tunnel run ythril-local";
    const routeCmd = this.enableOverwriteDns
      ? `cloudflared tunnel route dns --overwrite-dns ythril-local ${host}`
      : `cloudflared tunnel route dns ythril-local ${host}`;
    return [
      'winget install --id Cloudflare.cloudflared -e',
      'cloudflared tunnel login',
      'cloudflared tunnel create ythril-local',
      routeCmd,
      '$env:USERPROFILE',
      '# create %USERPROFILE%\\.cloudflared\\config.yml with hostname and localhost:3200 origin',
      serviceBlock,
      `curl https://${host}/health`,
    ].join('\n');
  }

  private buildLinuxCloudflareCommands(host: string): string {
    const serviceBlock = this.enableAutostart
      ? 'sudo cloudflared service install\nsudo systemctl enable --now cloudflared'
      : 'cloudflared tunnel run ythril-local';
    const routeCmd = this.enableOverwriteDns
      ? `cloudflared tunnel route dns --overwrite-dns ythril-local ${host}`
      : `cloudflared tunnel route dns ythril-local ${host}`;
    return [
      'curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb',
      'sudo dpkg -i /tmp/cloudflared.deb',
      'cloudflared tunnel login',
      'cloudflared tunnel create ythril-local',
      routeCmd,
      '# create ~/.cloudflared/config.yml with hostname and localhost:3200 origin',
      serviceBlock,
      `curl https://${host}/health`,
    ].join('\n');
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

  private detectLocalOs(): 'windows' | 'linux' {
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();
    if (ua.includes('windows') || platform.includes('win')) return 'windows';
    return 'linux';
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

    let spaces: string[];
    if (this.spacesLoadFailed()) {
      spaces = this.networkSpacesFallback.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      spaces = [...this.networkSelectedSpaces];
    }

    this.api.createNetwork({
      label: this.form.label.trim(),
      type: this.form.type,
      spaces,
      votingDeadlineHours: this.form.votingDeadlineHours,
    }).subscribe({
      next: (net) => {
        this.creating.set(false);
        this.showCreateDialog.set(false);
        this.networks.update(list => [...list, net]);
        this.form = { label: '', type: 'closed', votingDeadlineHours: 48 };
        this.networkSelectedSpaces = [];
        this.networkSpacesFallback = '';
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err.error?.error ?? 'Failed to create network');
      },
    });
  }

  isNetworkSpaceSelected(id: string): boolean {
    return this.networkSelectedSpaces.includes(id);
  }

  toggleNetworkSpace(id: string): void {
    if (this.networkSelectedSpaces.includes(id)) {
      this.networkSelectedSpaces = this.networkSelectedSpaces.filter(s => s !== id);
    } else {
      this.networkSelectedSpaces = [...this.networkSelectedSpaces, id];
    }
    this.networkSelectAll = this.networkSelectedSpaces.length === this.availableSpaces().length;
  }

  toggleNetworkSelectAll(): void {
    this.networkSelectAll = !this.networkSelectAll;
    if (this.networkSelectAll) {
      this.networkSelectedSpaces = this.availableSpaces().map(s => s.id);
    } else {
      this.networkSelectedSpaces = [];
    }
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
    this.joinCollisionSpaces.set([]);
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

    // Detect space name collisions — show resolution UI if any overlap
    if (bundle.spaces?.length) {
      const localIds = new Set(this.availableSpaces().map(s => s.id));
      const overlap = (bundle.spaces as string[]).filter((s: string) => localIds.has(s));
      if (overlap.length > 0) {
        this.joinParsedBundle = bundle;
        this.joinSpaceActions = {};
        this.joinSpaceAliases = {};
        for (const id of overlap) {
          this.joinSpaceActions[id] = 'merge';
          this.joinSpaceAliases[id] = '';
        }
        this.joinCollisionSpaces.set(overlap);
        return; // wait for user to resolve collisions
      }
    }

    this.joinParsedBundle = bundle;
    this.executeJoin();
  }

  onCollisionActionChange(remoteId: string, action: 'merge' | 'alias'): void {
    this.joinSpaceActions[remoteId] = action;
    if (action === 'alias' && !this.joinSpaceAliases[remoteId]) {
      this.joinSpaceAliases[remoteId] = remoteId + '-local';
    }
  }

  confirmJoin(): void {
    // Validate alias inputs
    for (const remoteId of this.joinCollisionSpaces()) {
      if (this.joinSpaceActions[remoteId] === 'alias') {
        const alias = this.joinSpaceAliases[remoteId]?.trim();
        if (!alias) {
          this.joinError.set(`Enter a local alias ID for space "${remoteId}".`);
          return;
        }
        if (!/^[a-z0-9-]+$/.test(alias)) {
          this.joinError.set(`Alias "${alias}" is invalid — use lowercase letters, numbers, and hyphens only.`);
          return;
        }
        const localIds = new Set(this.availableSpaces().map(s => s.id));
        if (localIds.has(alias)) {
          this.joinError.set(`Alias "${alias}" already exists as a local space — choose a different name.`);
          return;
        }
      }
    }
    this.executeJoin();
  }

  private executeJoin(): void {
    const bundle = this.joinParsedBundle;
    if (!bundle) return;

    // Build spaceMap from collision resolutions
    const spaceMap: Record<string, string> = {};
    for (const remoteId of this.joinCollisionSpaces()) {
      if (this.joinSpaceActions[remoteId] === 'alias') {
        spaceMap[remoteId] = this.joinSpaceAliases[remoteId].trim();
      }
    }

    this.joining.set(true);
    this.api.joinRemote({
      handshakeId: bundle.handshakeId,
      inviteUrl:   bundle.inviteUrl,
      rsaPublicKeyPem: bundle.rsaPublicKeyPem,
      networkId:   bundle.networkId,
      myUrl:       this.joinMyUrl.trim(),
      expiresAt:   bundle.expiresAt,
      ...(Object.keys(spaceMap).length > 0 ? { spaceMap } : {}),
    }).subscribe({
      next: (result) => {
        this.joining.set(false);
        let msg = `Joined network "${result.networkLabel}" successfully.`;
        if (result.createdSpaces?.length) {
          msg += ` Created new spaces: ${result.createdSpaces.join(', ')}.`;
        }
        if (result.existingSpaces?.length) {
          msg += ` ⚠️ Existing spaces merged into sync: ${result.existingSpaces.join(', ')} — data from the remote brain will be synced into these spaces.`;
        }
        if (result.spaceMap && Object.keys(result.spaceMap).length > 0) {
          const aliases = Object.entries(result.spaceMap).map(([r, l]) => `${r} → ${l}`).join(', ');
          msg += ` Aliases: ${aliases}.`;
        }
        this.joinSuccess.set(msg);
        this.joinBundle = '';
        this.joinMyUrl  = '';
        this.joinMyUrlAutoFilled.set(false);
        this.joinParsedBundle = null;
        this.joinCollisionSpaces.set([]);
        this.joinSpaceActions = {};
        this.joinSpaceAliases = {};
        this.load();
        // Refresh spaces list to include newly created spaces
        this.api.listSpaces().subscribe({
          next: ({ spaces }) => this.availableSpaces.set(spaces),
          error: () => {},
        });
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
      pubsub: 'badge-orange',
    };
    return map[type] ?? 'badge-gray';
  }
}
