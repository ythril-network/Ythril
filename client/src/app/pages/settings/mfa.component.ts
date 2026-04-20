import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import QRCode from 'qrcode';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';

type MfaState = 'idle' | 'enrolling' | 'disabling';

@Component({
  selector: 'app-mfa',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  styles: [`
    .qr-wrap { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
    .secret-box {
      background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 8px 12px;
      font-family: var(--font-mono); font-size: 13px; letter-spacing: 0.05em;
      word-break: break-all;
    }
    .code-input {
      width: 160px; padding: 0.55rem 0.75rem;
      border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg-primary); color: var(--text);
      font-size: 1.3rem; letter-spacing: 0.25em; text-align: center;
      font-family: var(--font-mono);
    }
    .code-input:focus { outline: none; border-color: var(--accent); }
    .status-row { display: flex; align-items: center; gap: 12px; }
    img { border-radius: 8px; background: #fff; padding: 8px; }
  `],
  template: `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">{{ 'mfa.title' | transloco }}</div>
          <div class="card-subtitle">
            {{ 'mfa.subtitle' | transloco }}
          </div>
        </div>
      </div>

      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (state() === 'idle') {

        <div class="status-row">
          @if (enabled()) {
            <span class="badge badge-green">{{ 'mfa.status.enabled' | transloco }}</span>
            <button class="btn btn-secondary btn-sm" (click)="startDisable()">{{ 'mfa.disableButton' | transloco }}</button>
          } @else {
            <span class="badge badge-gray">{{ 'mfa.status.disabled' | transloco }}</span>
            <button class="btn btn-primary btn-sm" (click)="startEnroll()">{{ 'mfa.enableButton' | transloco }}</button>
          }
        </div>

      } @else if (state() === 'enrolling') {

        <p style="font-size:0.88rem;color:var(--text-muted);margin:0 0 1rem;">
          {{ 'mfa.enroll.instructions' | transloco }}
        </p>
        <div class="qr-wrap">
          @if (qrUrl()) {
            <img [src]="qrUrl()" [attr.alt]="'mfa.enroll.qrAlt' | transloco" width="200" height="200" />
          }
          <div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">{{ 'mfa.enroll.manualKey' | transloco }}</div>
            <div class="secret-box">{{ secret() }}</div>
          </div>
          <div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:6px;">{{ 'mfa.enroll.enterCode' | transloco }}</div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <input class="code-input" type="text" inputmode="numeric"
                autocomplete="one-time-code" maxlength="6" [placeholder]="'mfa.enroll.codePlaceholder' | transloco"
                     [attr.aria-label]="'mfa.enroll.codeAriaLabel' | transloco"
                     [(ngModel)]="confirmCode" (keyup.enter)="confirmEnroll()" />
              <button class="btn btn-primary btn-sm" (click)="confirmEnroll()"
                      [disabled]="confirming() || confirmCode.length < 6">
                @if (confirming()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                {{ 'mfa.enroll.confirmButton' | transloco }}
              </button>
              <button class="btn btn-secondary btn-sm" (click)="cancel()">{{ 'common.cancel' | transloco }}</button>
            </div>
          </div>
        </div>
        @if (enrollError()) {
          <div class="alert alert-error" style="margin-top:12px;">{{ enrollError() }}</div>
        }

      } @else if (state() === 'disabling') {

        <div class="alert alert-error" style="margin-bottom:12px;">
          {{ 'mfa.disable.warning' | transloco }}
        </div>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-secondary btn-sm" (click)="cancel()">{{ 'common.cancel' | transloco }}</button>
          <button class="btn btn-primary btn-sm danger" (click)="confirmDisable()" [disabled]="disabling()">
            @if (disabling()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
            {{ 'mfa.disable.confirmButton' | transloco }}
          </button>
        </div>

      }

      @if (successMsg()) {
        <div class="alert alert-success" style="margin-top:12px;">{{ successMsg() }}</div>
      }
    </div>
  `,
})
export class MfaComponent implements OnInit {
  private api = inject(ApiService);
  private transloco = inject(TranslocoService);

  loading = signal(true);
  enabled = signal(false);
  state = signal<MfaState>('idle');

  secret = signal('');
  qrUrl = signal('');
  confirmCode = '';
  confirming = signal(false);
  enrollError = signal('');

  disabling = signal(false);
  successMsg = signal('');

  ngOnInit(): void { this.refresh(); }

  refresh(): void {
    this.loading.set(true);
    this.api.getMfaStatus().subscribe({
      next: ({ enabled }) => { this.enabled.set(enabled); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  startEnroll(): void {
    this.successMsg.set('');
    this.api.setupMfa().subscribe({
      next: ({ secret, otpauth }) => {
        this.secret.set(secret);
        // Generate QR code entirely client-side — the TOTP secret never
        // leaves the browser (avoids leaking it to external chart services).
        QRCode.toDataURL(otpauth, { width: 200, margin: 1 }).then(dataUrl => {
          this.qrUrl.set(dataUrl);
        });
        this.confirmCode = '';
        this.enrollError.set('');
        this.state.set('enrolling');
      },
      error: (err) => this.enrollError.set(err.error?.error ?? this.transloco.translate('mfa.error.setupFailed')),
    });
  }

  confirmEnroll(): void {
    if (this.confirmCode.length < 6) return;
    this.confirming.set(true);
    this.enrollError.set('');
    this.api.verifyMfaCode(this.confirmCode).subscribe({
      next: ({ valid }) => {
        this.confirming.set(false);
        if (valid) {
          this.enabled.set(true);
          this.state.set('idle');
          this.successMsg.set(this.transloco.translate('mfa.success.enabled'));
        } else {
          this.enrollError.set(this.transloco.translate('mfa.error.invalidCode'));
        }
      },
      error: () => {
        this.confirming.set(false);
        this.enrollError.set(this.transloco.translate('mfa.error.verifyFailed'));
      },
    });
  }

  startDisable(): void {
    this.successMsg.set('');
    this.state.set('disabling');
  }

  confirmDisable(): void {
    this.disabling.set(true);
    this.api.disableMfa().subscribe({
      next: () => {
        this.disabling.set(false);
        this.enabled.set(false);
        this.state.set('idle');
        this.successMsg.set(this.transloco.translate('mfa.success.disabled'));
      },
      error: () => this.disabling.set(false),
    });
  }

  cancel(): void { this.state.set('idle'); }
}
