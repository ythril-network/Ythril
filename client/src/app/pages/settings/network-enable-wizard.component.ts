import { Component, inject, signal, output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NetworksApi } from '../../core/networks-api.service';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { refusalText, httpErrorReason } from '../../core/refusal-text';

/**
 * Enable-Networks wizard, extracted from the (large) NetworksComponent as the last of the three dialogs
 * (PR-U3). A 3-step flow that helps a locally-reachable brain get a public HTTPS URL (via a Cloudflare
 * tunnel) so it can join networks: (1) explain, (2) collect hostname + options and generate the OS
 * commands, (3) either run the setup automatically through the local-agent connector (bootstrapping it if
 * needed) or copy the commands to run by hand. On success it emits `enabled(url)` — the host adopts that
 * URL as this brain's own and drops the "enable networks" prompt. Behaviour matches the inline version;
 * the wizard characterization tests moved here with it.
 *
 * Rendered gated by the host (`@if (showEnableNetworksWizard()) { … }`), so it initialises fresh on each
 * open (ngOnInit) and needs no visibility state of its own.
 */
@Component({
  selector: 'app-network-enable-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective],
  styles: [`
    .dialog-backdrop {
      position: fixed; inset: 0; background: var(--bg-scrim);
      display: flex; align-items: center; justify-content: center; z-index: 100;
    }
    .dialog {
      background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: var(--radius-lg); padding: 24px; width: 90%; max-width: 600px;
      max-height: 90vh; overflow-y: auto;
    }
    .dialog-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .wizard-steps { display: flex; align-items: center; gap: 6px; margin: 0 0 14px; }
    .wizard-step-dot { width: 24px; height: 4px; border-radius: 2px; background: var(--border); transition: background var(--transition); }
    .wizard-step-dot.done { background: var(--accent-dim); }
    .wizard-step-dot.active { background: var(--accent); }
    .wizard-step-label { margin-left: auto; font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .wizard-note { font-size: 12px; color: var(--text-muted); margin: 0 0 10px; line-height: 1.45; }
    .wizard-list { margin: 0 0 12px; padding-left: 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
    .wizard-status {
      margin: 8px 0 12px; padding: 8px 10px; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: var(--bg-elevated); font-size: 12px; color: var(--text-secondary);
    }
  `],
  template: `
    <div class="dialog-backdrop">
      <div class="dialog" [appModal]="'networks.wizard.title' | transloco" (dismiss)="close.emit()" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <div class="card-title">{{ 'networks.wizard.title' | transloco }}</div>
          <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="close.emit()"><ph-icon name="x" [size]="14"/></button>
        </div>

        <div class="wizard-steps">
          @for (n of [1, 2, 3]; track n) {
            <span class="wizard-step-dot" [class.active]="enableWizardStep() === n" [class.done]="enableWizardStep() > n"></span>
          }
          <span class="wizard-step-label">{{ 'networks.wizard.stepLabel' | transloco: { current: enableWizardStep(), total: 3 } }}</span>
        </div>

        @if (enableWizardError()) { <div class="alert alert-error">{{ enableWizardError() }}</div> }

        @if (enableWizardStep() === 1) {
          <p class="wizard-note">{{ 'networks.wizard.step1.p1' | transloco }}</p>
          <p class="wizard-note">{{ 'networks.wizard.step1.p2' | transloco }}</p>
          <ul class="wizard-list">
            <li>{{ 'networks.wizard.step1.whyItem' | transloco }}</li>
            <li>{{ 'networks.wizard.step1.riskItem' | transloco }}</li>
            <li>{{ 'networks.wizard.step1.resultItem' | transloco }}</li>
          </ul>
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button class="btn-secondary btn" type="button" (click)="close.emit()">{{ 'common.cancel' | transloco }}</button>
            <button class="btn-primary btn" type="button" (click)="enableWizardStep.set(2)">{{ 'networks.wizard.continue' | transloco }}</button>
          </div>
        }

        @if (enableWizardStep() === 2) {
          @if (localAgentStatusMessage()) { <div class="wizard-status">{{ localAgentStatusMessage() }}</div> }
          <p class="wizard-note">{{ 'networks.wizard.step2.hostnameHint' | transloco }}</p>
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
            <div class="wizard-note" style="margin-top:6px;">{{ 'networks.wizard.step2.overwriteDnsHint' | transloco }}</div>
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
          @if (localAgentStatusMessage()) { <div class="wizard-status">{{ localAgentStatusMessage() }}</div> }
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
  `,
})
export class NetworkEnableWizardComponent implements OnInit {
  private networksApi = inject(NetworksApi);
  private transloco = inject(TranslocoService);
  private confirmDialog = inject(ConfirmDialogService);

  /** Emitted with this brain's now-public URL when setup succeeds — the host adopts it and drops the
   *  enable prompt. */
  readonly enabled = output<string>();
  /** Emitted when the user cancels/dismisses (or after the confirm-and-adopt finish). */
  readonly close = output<void>();

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

  ngOnInit(): void {
    this.enableOs = this.detectLocalOs();
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

  async completeEnableWizard(): Promise<void> {
    const host = this.enableHostname.trim();
    if (!host) return;
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('networks.wizard.confirm.verifyHealthTitle'),
      message: this.transloco.translate('networks.wizard.confirm.verifyHealth', { host }),
    });
    if (!ok) return;
    this.enabled.emit(`https://${host}`);
    this.close.emit();
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
      this.networksApi.bootstrapLocalAgent({ os: this.enableOs }).subscribe({
        next: () => this.executeEnableNetworks(host),
        error: (err) => {
          this.enableAutoRunning.set(false);
          this.enableWizardError.set(refusalText(this.transloco, err, 'networks.wizard.error.bootstrapFailed'));
        },
      });
      return;
    }
    this.executeEnableNetworks(host);
  }

  private executeEnableNetworks(host: string): void {
    this.networksApi.executeEnableNetworksViaLocalAgent({
      hostname: host,
      os: this.enableOs,
      autostart: this.enableAutostart,
      overwriteDns: this.enableOverwriteDns,
      acknowledgeCriticalChanges: this.enableAcknowledgeCritical,
    }).subscribe({
      next: (result) => {
        this.enableAutoRunning.set(false);
        this.localAgentStatusMessage.set(result.message ?? this.transloco.translate('networks.wizard.status.autoSetupFinished'));
        this.enabled.emit(result.publicUrl || `https://${host}`);
      },
      error: (err) => {
        this.enableAutoRunning.set(false);
        this.enableWizardError.set(refusalText(this.transloco, err, 'networks.wizard.error.autoSetupFailed'));
      },
    });
  }

  private bootstrapLocalAgent(): void {
    // Try status first — if the connector is already running (feature enabled via env var, or started
    // manually), automatic mode becomes available without bootstrap.
    this.networksApi.getLocalAgentStatus().subscribe({
      next: (status) => {
        if (status.canExecute) {
          this.localAgentCanExecute.set(true);
          this.localAgentChecking.set(false);
          this.localAgentStatusMessage.set(status.message ?? this.transloco.translate('networks.wizard.status.connectorReady'));
        } else {
          this.triggerBootstrap();
        }
      },
      error: () => this.triggerBootstrap(),
    });
  }

  private triggerBootstrap(): void {
    this.localAgentStatusMessage.set(this.transloco.translate('networks.wizard.status.startingConnector'));
    this.networksApi.bootstrapLocalAgent({ os: this.enableOs }).subscribe({
      next: (result) => {
        this.localAgentStatusMessage.set(result.message ?? this.transloco.translate('networks.wizard.status.connectorStarted'));
        this.refreshLocalAgentStatus();
      },
      error: (err) => {
        this.localAgentCanExecute.set(false);
        this.localAgentChecking.set(false);
        const detail = httpErrorReason(err) || `HTTP ${err?.status ?? 'unknown'}`;
        this.localAgentStatusMessage.set(this.transloco.translate('networks.wizard.status.connectorStartFailed', { detail }));
      },
    });
  }

  private refreshLocalAgentStatus(): void {
    this.networksApi.getLocalAgentStatus().subscribe({
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
      ? 'cloudflared service install\nStart-Service cloudflared'
      : 'cloudflared tunnel run ythril-local';
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

  private detectLocalOs(): 'windows' | 'linux' {
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();
    if (ua.includes('windows') || platform.includes('win')) return 'windows';
    return 'linux';
  }
}
