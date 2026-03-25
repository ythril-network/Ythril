/**
 * MFA prompt modal — shown by the mfaInterceptor when a request returns
 * 403 MFA_REQUIRED or MFA_INVALID.
 *
 * Add <app-mfa-prompt /> once at the top-level layout (app shell).
 * It is invisible until the MfaService emits a challenge.
 */
import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MfaService, MfaChallenge } from '../core/mfa.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-mfa-prompt',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.65);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
    }
    .dialog {
      background: var(--bg-card, #1a1a1a);
      border: 1px solid var(--border, #333);
      border-radius: 10px;
      padding: 2rem;
      width: 100%; max-width: 360px;
    }
    h2 { margin: 0 0 0.4rem; font-size: 1.1rem; }
    p  { margin: 0 0 1.25rem; color: var(--text-muted, #888); font-size: 0.88rem; }
    input {
      width: 100%; padding: 0.55rem 0.75rem;
      border: 1px solid var(--border, #444); border-radius: 6px;
      background: var(--bg-primary, #111); color: var(--text, #eee);
      font-size: 1.3rem; letter-spacing: 0.25em; text-align: center;
      font-family: var(--font-mono, monospace);
      margin-bottom: 1rem;
    }
    input:focus { outline: none; border-color: #6060f0; }
    .actions { display: flex; gap: 10px; }
    .actions button { flex: 1; }
    .error { color: #f66; font-size: 0.82rem; margin: -0.5rem 0 0.75rem; }
  `],
  template: `
    @if (active()) {
      <div class="overlay" (click)="cancel()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h2>Two-factor authentication</h2>
          <p>Enter the 6-digit code from your authenticator app to continue.</p>
          <input
            #codeInput
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            [(ngModel)]="code"
            (keyup.enter)="submit()"
            autofocus
          />
          @if (error()) {
            <p class="error">{{ error() }}</p>
          }
          <div class="actions">
            <button class="btn btn-secondary btn-sm" (click)="cancel()">Cancel</button>
            <button class="btn btn-primary btn-sm" (click)="submit()" [disabled]="code.length < 6">Verify</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class MfaPromptComponent implements OnInit, OnDestroy {
  private mfa = inject(MfaService);

  active = signal(false);
  error = signal('');
  code = '';

  private _resolve: ((code: string | null) => void) | null = null;
  private _sub!: Subscription;

  ngOnInit(): void {
    this._sub = this.mfa.challenge$.subscribe((challenge: MfaChallenge) => {
      this._resolve = challenge.resolve;
      this.code = '';
      this.error.set('');
      this.active.set(true);
    });
  }

  ngOnDestroy(): void { this._sub.unsubscribe(); }

  submit(): void {
    if (this.code.length < 6) return;
    this.active.set(false);
    this._resolve?.(this.code);
    this._resolve = null;
  }

  cancel(): void {
    this.active.set(false);
    this._resolve?.(null);
    this._resolve = null;
  }
}
