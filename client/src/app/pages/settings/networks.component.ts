import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, InviteBundle, Network, Space, SyncHistoryRecord, VoteRound } from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
@Component({
  selector: 'app-networks',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
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
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: var(--bg-scrim);
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
      <div class="card-title">{{ 'networks.title' | transloco }}</div>
      <div style="display:flex; gap:8px;">
        @if (needsNetworkEnable()) {
          <button class="btn-primary btn btn-sm" (click)="openEnableNetworksWizard()">{{ 'networks.enableButton' | transloco }}</button>
        } @else {
          <button class="btn-primary btn btn-sm" (click)="showCreateDialog.set(true)">{{ 'networks.createButton' | transloco }}</button>
          <button class="btn-secondary btn btn-sm" (click)="showJoinDialog.set(true)">{{ 'networks.joinButton' | transloco }}</button>
        }
      </div>
    </div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (networks().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon">🔗</div>
        <h3>{{ 'networks.empty.title' | transloco }}</h3>
        <p>{{ 'networks.empty.body' | transloco }}</p>
      </div>
    } @else {
      @for (net of networks(); track net.id) {
        <div class="network-card">
          <div class="network-card-header" (click)="toggleNetwork(net.id)">
            <span class="network-name">{{ net.label }}</span>
            <span class="badge" [ngClass]="typeBadge(net.type)">{{ net.type }}</span>
            <span class="badge badge-gray">{{ net.members.length }} {{ net.members.length === 1 ? ('networks.memberBadge.singular' | transloco) : ('networks.memberBadge.plural' | transloco) }}</span>
            <span style="color:var(--text-muted); font-size:12px;">{{ expanded() === net.id ? '▲' : '▼' }}</span>
          </div>

          @if (expanded() === net.id) {
            <div class="network-body">

              <!-- Invite bundle -->
              <div style="margin-bottom:16px; margin-top:12px;">
                <div class="section-title">{{ 'networks.network.invite.title' | transloco }}</div>
                <p style="font-size:12px; color:var(--text-muted); margin:0 0 8px;">
                  @if (net.type === 'pubsub') {
                    {{ 'networks.network.invite.pubsubDescription' | transloco }}
                  } @else {
                    {{ 'networks.network.invite.description' | transloco }}
                  }
                </p>
                @if (inviteBundle(net.id); as bundle) {
                  <div class="code-block" style="margin-bottom:8px; font-size:11px; white-space:pre-wrap; word-break:break-all;">{{ bundleJson(bundle) }}</div>
                  <button class="btn-ghost btn btn-sm" (click)="copyInvite(net.id)">
                    {{ copiedInvite() === net.id ? ('common.copied' | transloco) : ('networks.network.invite.copyBundle' | transloco) }}
                  </button>
                } @else {
                  <button class="btn-secondary btn btn-sm" (click)="generateInvite(net.id)">
                    {{ 'networks.network.invite.generateButton' | transloco }}
                  </button>
                }
              </div>

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
                  <button class="btn-secondary btn btn-sm" (click)="saveSchedule(net)">{{ 'networks.network.sync.saveScheduleButton' | transloco }}</button>
                  <button class="btn-secondary btn btn-sm" (click)="sync(net.id)">{{ 'networks.network.sync.syncNowButton' | transloco }}</button>
                </div>
                @if (syncResult(net.id); as r) {
                  <div class="alert" [class.alert-success]="r.ok" [class.alert-error]="!r.ok" style="margin-top:8px;">
                    {{ r.ok ? ('networks.network.sync.success' | transloco) : ('networks.network.sync.failed' | transloco) }}
                  </div>
                }
              </div>

              <!-- Sync History -->
              <div style="margin-bottom:16px;">
                <div class="section-title" style="cursor:pointer;" (click)="toggleHistory(net.id)">
                  {{ 'networks.network.syncHistory.title' | transloco }} {{ historyExpanded() === net.id ? '▲' : '▼' }}
                </div>
                @if (historyExpanded() === net.id) {
                  @if (historyLoading()) {
                    <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">{{ 'networks.network.syncHistory.loading' | transloco }}</div>
                  } @else if (historyForNet(net.id).length === 0) {
                    <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">{{ 'networks.network.syncHistory.empty' | transloco }}</div>
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

              <!-- Members -->
              <div class="section-title">{{ 'networks.network.members.title' | transloco }}</div>
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
                    [attr.title]="'networks.network.members.removeTitle' | transloco"
                    [attr.aria-label]="'networks.network.members.removeAriaLabel' | transloco"
                  >×</button>
                </div>
              }

              <!-- Open votes -->
              @if (openVotes(net.id).length > 0) {
                <div style="margin-top:16px;">
                  <div class="section-title">{{ 'networks.network.votes.title' | transloco }}</div>
                  @for (round of openVotes(net.id); track round.id) {
                    <div class="vote-row">
                      <span style="flex:1;">{{ round.type }}: {{ round.subject }}</span>
                      <button class="btn-primary btn btn-sm" (click)="castVote(net.id, round.id, 'yes')">{{ 'networks.network.votes.yes' | transloco }}</button>
                      <button class="btn-danger btn btn-sm" (click)="castVote(net.id, round.id, 'no')">{{ 'networks.network.votes.no' | transloco }}</button>
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
      <div class="dialog-backdrop" (click)="showCreateDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">{{ 'networks.dialog.create.title' | transloco }}</div>
            <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="showCreateDialog.set(false)">✕</button>
          </div>

          @if (createError()) { <div class="alert alert-error">{{ createError() }}</div> }

          <form (ngSubmit)="createNetwork()" style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end;">
            <div class="field" style="margin-bottom:0;">
              <label>{{ 'networks.dialog.create.label' | transloco }}</label>
              <input type="text" [(ngModel)]="form.label" name="label" [placeholder]="'networks.dialog.create.labelPlaceholder' | transloco" required />
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>{{ 'networks.dialog.create.type' | transloco }}</label>
              <select [(ngModel)]="form.type" name="type">
                <option value="closed">{{ 'networks.type.closed' | transloco }}</option>
                <option value="democratic">{{ 'networks.type.democratic' | transloco }}</option>
                <option value="club">{{ 'networks.type.club' | transloco }}</option>
                <option value="braintree">{{ 'networks.type.braintree' | transloco }}</option>
                <option value="pubsub">{{ 'networks.type.pubsub' | transloco }}</option>
              </select>
            </div>
            <div class="field" style="margin-bottom:0; grid-column:span 2;">
              <label>{{ 'networks.dialog.create.spaces' | transloco }}</label>
              @if (spacesLoadFailed()) {
                <div class="alert alert-error" style="margin-bottom:6px; font-size:12px;">{{ 'networks.dialog.create.spacesLoadFailed' | transloco }}</div>
                <input type="text" [(ngModel)]="networkSpacesFallback" name="spaces" [placeholder]="'networks.dialog.create.spacesFallbackPlaceholder' | transloco" />
              } @else if (availableSpaces().length === 0) {
                <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">{{ 'networks.dialog.create.loadingSpaces' | transloco }}</div>
              } @else {
                <div class="table-wrapper" style="max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:var(--radius-sm);">
                  <table style="margin:0;">
                    <thead>
                      <tr>
                        <th style="width:40px; text-align:center;">
                          <input type="checkbox" [checked]="networkSelectAll" (change)="toggleNetworkSelectAll()" [attr.title]="'networks.dialog.create.allSpacesTitle' | transloco" />
                        </th>
                        <th>{{ 'spaces.table.column.label' | transloco }}</th>
                        <th>{{ 'spaces.table.column.id' | transloco }}</th>
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
                <label>{{ 'networks.dialog.create.votingDeadline' | transloco }}</label>
                <input type="number" [(ngModel)]="form.votingDeadlineHours" name="deadline" min="1" max="72" />
              </div>
            }
            <div style="grid-column:span 2; display:flex; gap:8px; justify-content:flex-end;">
              <button class="btn-secondary btn" type="button" (click)="showCreateDialog.set(false)">{{ 'common.cancel' | transloco }}</button>
              <button class="btn-primary btn" type="submit" [disabled]="creating() || !form.label.trim()">
                @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                {{ 'networks.dialog.create.submitButton' | transloco }}
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
            <div class="card-title">{{ 'networks.dialog.join.title' | transloco }}</div>
            <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="showJoinDialog.set(false)">✕</button>
          </div>

          @if (joinError()) { <div class="alert alert-error">{{ joinError() }}</div> }
          @if (joinSuccess()) { <div class="alert alert-success">{{ joinSuccess() }}</div> }

          <div class="field">
            <label>{{ 'networks.dialog.join.bundleLabel' | transloco }}</label>
            <textarea
              [(ngModel)]="joinBundle"
              name="joinBundle"
              rows="5"
              [placeholder]="'networks.dialog.join.bundlePlaceholder' | transloco"
              [attr.aria-label]="'networks.dialog.join.bundleAriaLabel' | transloco"
              style="font-family:var(--font-mono); font-size:12px; resize:vertical;"
            ></textarea>
          </div>

          @if (joinCollisionSpaces().length > 0) {
            <div style="margin:0 0 12px; padding:12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-elevated);">
              <div style="font-weight:600; font-size:13px; margin-bottom:8px;">{{ 'networks.dialog.join.collisions.title' | transloco }}</div>
              <p style="font-size:12px; color:var(--text-muted); margin:0 0 12px;">
                {{ 'networks.dialog.join.collisions.body' | transloco }}
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
                    <option value="merge">{{ 'networks.dialog.join.collision.merge' | transloco }}</option>
                    <option value="alias">{{ 'networks.dialog.join.collision.alias' | transloco }}</option>
                  </select>
                  @if (joinSpaceActions[remoteId] === 'alias') {
                    <input
                      type="text"
                      [(ngModel)]="joinSpaceAliases[remoteId]"
                      [name]="'alias-' + remoteId"
                      [placeholder]="'networks.dialog.join.aliasPlaceholder' | transloco"
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
            <button class="btn-secondary btn" type="button" (click)="showJoinDialog.set(false)">{{ 'common.cancel' | transloco }}</button>
            <button
              class="btn-primary btn"
              (click)="joinCollisionSpaces().length > 0 ? confirmJoin() : joinNetwork()"
              [disabled]="joining() || !joinBundle.trim() || !joinMyUrl.trim()"
            >
              @if (joining()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              {{ joinCollisionSpaces().length > 0 ? ('networks.dialog.join.confirmJoinButton' | transloco) : ('networks.dialog.join.submitButton' | transloco) }}
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
            <div class="card-title">{{ 'networks.wizard.title' | transloco }}</div>
            <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="showEnableNetworksWizard.set(false)">✕</button>
          </div>

          @if (enableWizardError()) { <div class="alert alert-error">{{ enableWizardError() }}</div> }

          @if (enableWizardStep() === 1) {
            <p class="wizard-note">
              {{ 'networks.wizard.step1.p1' | transloco }}
            </p>
            <p class="wizard-note">
              {{ 'networks.wizard.step1.p2' | transloco }}
            </p>
            <ul class="wizard-list">
              <li>{{ 'networks.wizard.step1.whyItem' | transloco }}</li>
              <li>{{ 'networks.wizard.step1.riskItem' | transloco }}</li>
              <li>{{ 'networks.wizard.step1.resultItem' | transloco }}</li>
            </ul>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
              <button class="btn-secondary btn" type="button" (click)="showEnableNetworksWizard.set(false)">{{ 'common.cancel' | transloco }}</button>
              <button class="btn-primary btn" type="button" (click)="enableWizardStep.set(2)">{{ 'networks.wizard.continue' | transloco }}</button>
            </div>
          }

          @if (enableWizardStep() === 2) {
            @if (localAgentStatusMessage()) {
              <div class="wizard-status">{{ localAgentStatusMessage() }}</div>
            }
            <p class="wizard-note">
              {{ 'networks.wizard.step2.hostnameHint' | transloco }}
            </p>
            <div class="field">
              <label>{{ 'networks.wizard.step2.publicHostnameLabel' | transloco }}</label>
              <input type="text" [(ngModel)]="enableHostname" name="enableHostname" [placeholder]="'networks.wizard.step2.publicHostnamePlaceholder' | transloco" />
            </div>
            <div class="field">
              <label>{{ 'networks.wizard.step2.osLabel' | transloco }}</label>
              <select [(ngModel)]="enableOs" name="enableOs">
                <option value="windows">{{ 'networks.wizard.step2.os.windows' | transloco }}</option>
                <option value="linux">{{ 'networks.wizard.step2.os.linux' | transloco }}</option>
              </select>
            </div>
            <div class="field">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" [(ngModel)]="enableAutostart" name="enableAutostart" />
                {{ 'networks.wizard.step2.autostart' | transloco }}
              </label>
            </div>
            <div class="field">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" [(ngModel)]="enableOverwriteDns" name="enableOverwriteDns" />
                {{ 'networks.wizard.step2.overwriteDns' | transloco }}
              </label>
              <div class="wizard-note" style="margin-top:6px;">
                {{ 'networks.wizard.step2.overwriteDnsHint' | transloco }}
              </div>
            </div>
            <div class="field">
              <label style="display:flex; align-items:flex-start; gap:8px;">
                <input type="checkbox" [(ngModel)]="enableAcknowledgeCritical" name="enableAcknowledgeCritical" style="margin-top:2px;" />
                <span>{{ 'networks.wizard.step2.ackCritical' | transloco }}</span>
              </label>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
              <button class="btn-secondary btn" type="button" (click)="enableWizardStep.set(1)">{{ 'networks.wizard.back' | transloco }}</button>
              <button class="btn-primary btn" type="button" (click)="prepareEnableWizardCommands()">{{ 'networks.wizard.continue' | transloco }}</button>
            </div>
          }

          @if (enableWizardStep() === 3) {
            @if (localAgentChecking()) {
              <p class="wizard-note">{{ 'networks.wizard.step3.checkingStatus' | transloco }}</p>
            } @else if (localAgentCanExecute()) {
              <p class="wizard-note">{{ 'networks.wizard.step3.autoReady' | transloco }}</p>
            } @else {
              <p class="wizard-note">{{ 'networks.wizard.step3.autoUnavailable' | transloco }}</p>
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
                  {{ 'networks.wizard.step3.runAutomatically' | transloco }}
                </button>
              }
              @if (!localAgentCanExecute() && !localAgentChecking()) {
                <button class="btn-ghost btn" type="button" (click)="copyEnableWizardCommands()">{{ 'networks.wizard.step3.copyCommands' | transloco }}</button>
              }
              <button class="btn-secondary btn" type="button" (click)="enableWizardStep.set(2)">{{ 'networks.wizard.back' | transloco }}</button>
              @if (!localAgentCanExecute() && !localAgentChecking()) {
                <button class="btn-primary btn" type="button" (click)="completeEnableWizard()">{{ 'networks.wizard.step3.finishedSetup' | transloco }}</button>
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
  private transloco = inject(TranslocoService);

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
      this.enableWizardError.set(this.transloco.translate('networks.wizard.error.invalidHostname'));
      return;
    }

    this.enableWindowsCommand.set(this.buildWindowsCloudflareCommands(host));
    this.enableLinuxCommand.set(this.buildLinuxCloudflareCommands(host));
    this.localAgentStatusMessage.set(this.transloco.translate('networks.wizard.status.checkingConnector'));
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
    if (!confirm(this.transloco.translate('networks.wizard.confirm.verifyHealth', { host }))) return;
    const url = `https://${host}`;
    this.joinMyUrl = url;
    this.joinMyUrlAutoFilled.set(true);
    this.needsNetworkEnable.set(false);
    this.showEnableNetworksWizard.set(false);
  }

  runEnableNetworksAutomatically(): void {
    const host = this.enableHostname.trim();
    if (!host) {
      this.enableWizardError.set(this.transloco.translate('networks.wizard.error.enterHostnameFirst'));
      return;
    }
    if (!this.enableAcknowledgeCritical) {
      this.enableWizardError.set(this.transloco.translate('networks.wizard.error.acknowledgeCritical'));
      return;
    }
    this.enableWizardError.set('');
    this.enableAutoRunning.set(true);
    if (!this.localAgentCanExecute()) {
      this.localAgentStatusMessage.set(this.transloco.translate('networks.wizard.status.bootstrappingConnector'));
      this.api.bootstrapLocalAgent({ os: this.enableOs }).subscribe({
        next: () => this.executeEnableNetworks(host),
        error: (err) => {
          this.enableAutoRunning.set(false);
          this.enableWizardError.set(err.error?.error ?? this.transloco.translate('networks.wizard.error.bootstrapFailed'));
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
        this.localAgentStatusMessage.set(result.message ?? this.transloco.translate('networks.wizard.status.autoSetupFinished'));
        const url = result.publicUrl || `https://${host}`;
        this.joinMyUrl = url;
        this.joinMyUrlAutoFilled.set(true);
        this.needsNetworkEnable.set(false);
      },
      error: (err) => {
        this.enableAutoRunning.set(false);
        this.enableWizardError.set(err.error?.error ?? this.transloco.translate('networks.wizard.error.autoSetupFailed'));
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
          this.localAgentStatusMessage.set(status.message ?? this.transloco.translate('networks.wizard.status.connectorReady'));
        } else {
          // Connector not ready — try to spawn it via bootstrap.
          this.triggerBootstrap();
        }
      },
      error: () => this.triggerBootstrap(),
    });
  }

  private triggerBootstrap(): void {
    this.localAgentStatusMessage.set(this.transloco.translate('networks.wizard.status.startingConnector'));
    this.api.bootstrapLocalAgent({ os: this.enableOs }).subscribe({
      next: (result) => {
        this.localAgentStatusMessage.set(result.message ?? this.transloco.translate('networks.wizard.status.connectorStarted'));
        this.refreshLocalAgentStatus();
      },
      error: (err) => {
        this.localAgentCanExecute.set(false);
        this.localAgentChecking.set(false);
        const detail = err?.error?.error ?? err?.message ?? `HTTP ${err?.status ?? 'unknown'}`;
        this.localAgentStatusMessage.set(this.transloco.translate('networks.wizard.status.connectorStartFailed', { detail }));
      },
    });
  }

  private refreshLocalAgentStatus(): void {
    this.api.getLocalAgentStatus().subscribe({
      next: (status) => {
        this.localAgentCanExecute.set(status.canExecute);
        this.localAgentChecking.set(false);
        this.localAgentStatusMessage.set(status.message ?? (status.canExecute ? this.transloco.translate('networks.wizard.status.connectorReady') : this.transloco.translate('networks.wizard.status.manualAvailable')));
      },
      error: () => {
        this.localAgentCanExecute.set(false);
        this.localAgentChecking.set(false);
        this.localAgentStatusMessage.set(this.transloco.translate('networks.wizard.status.statusEndpointUnreachable'));
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
        this.createError.set(err.error?.error ?? this.transloco.translate('networks.error.createFailed'));
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
    if (!confirm(this.transloco.translate('networks.confirm.leave', { label: net.label }))) return;
    this.api.leaveNetwork(net.id).subscribe({
      next: () => this.networks.update(list => list.filter(n => n.id !== net.id)),
      error: (err) => alert(err.error?.error ?? this.transloco.translate('networks.error.leaveFailed')),
    });
  }

  generateInvite(networkId: string): void {
    this.api.generateInvite(networkId).subscribe({
      next: (bundle) => {
        this.inviteBundles[networkId] = bundle;
        this.networks.update(n => [...n]);
      },
      error: (err) => alert(err.error?.error ?? this.transloco.translate('networks.error.generateInviteFailed')),
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
      error: (err) => alert(err.error?.error ?? this.transloco.translate('networks.error.saveScheduleFailed')),
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
      this.joinError.set(this.transloco.translate('networks.dialog.join.error.invalidJson'));
      return;
    }
    if (!bundle.handshakeId || !bundle.inviteUrl || !bundle.rsaPublicKeyPem || !bundle.networkId) {
      this.joinError.set(this.transloco.translate('networks.dialog.join.error.incompleteBundle'));
      return;
    }
    if (!this.joinMyUrl.trim()) {
      this.joinError.set(this.transloco.translate('networks.dialog.join.error.missingMyUrl'));
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
          this.joinError.set(this.transloco.translate('networks.dialog.join.error.aliasRequired', { remoteId }));
          return;
        }
        if (!/^[a-z0-9-]+$/.test(alias)) {
          this.joinError.set(this.transloco.translate('networks.dialog.join.error.aliasInvalid', { alias }));
          return;
        }
        const localIds = new Set(this.availableSpaces().map(s => s.id));
        if (localIds.has(alias)) {
          this.joinError.set(this.transloco.translate('networks.dialog.join.error.aliasExists', { alias }));
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
        let msg = this.transloco.translate('networks.dialog.join.success.joined', { networkLabel: result.networkLabel });
        if (result.createdSpaces?.length) {
          msg += ` ${this.transloco.translate('networks.dialog.join.success.createdSpaces', { spaces: result.createdSpaces.join(', ') })}`;
        }
        if (result.existingSpaces?.length) {
          msg += ` ${this.transloco.translate('networks.dialog.join.success.existingSpaces', { spaces: result.existingSpaces.join(', ') })}`;
        }
        if (result.spaceMap && Object.keys(result.spaceMap).length > 0) {
          const aliases = Object.entries(result.spaceMap).map(([r, l]) => `${r} → ${l}`).join(', ');
          msg += ` ${this.transloco.translate('networks.dialog.join.success.aliases', { aliases })}`;
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
        this.joinError.set(err.error?.error ?? this.transloco.translate('networks.error.joinFailed'));
      },
    });
  }

  removeMember(net: Network, instanceId: string, label: string): void {
    if (!confirm(this.transloco.translate('networks.confirm.removeMember', { label, networkLabel: net.label }))) return;
    const key = `${net.id}:${instanceId}`;
    this.removingMember[key] = true;
    this.api.removeMember(net.id, instanceId).subscribe({
      next: () => {
        delete this.removingMember[key];
        this.load();
      },
      error: (err) => {
        delete this.removingMember[key];
        alert(err.error?.error ?? this.transloco.translate('networks.error.removeMemberFailed'));
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
      error: (err) => alert(err.error?.error ?? this.transloco.translate('networks.error.castVoteFailed')),
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
