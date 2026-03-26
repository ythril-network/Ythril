import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [FormsModule, CommonModule],
  template: `
    <div class="auth-page">
      <div class="auth-card" style="max-width: 460px;">
        <div class="auth-logo">
          <span class="auth-logo-dot"></span>
          ythril
        </div>
        <p class="auth-subtitle">First-run setup</p>

        @if (done()) {
          <div class="alert alert-success">
            Setup complete! Your admin token is shown below.
            <strong>Copy it now — it won't be shown again.</strong>
          </div>
          <div class="code-block" style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ firstToken() }}</span>
            <button class="btn-ghost btn btn-sm" type="button" (click)="copyToken()">
              {{ copied() ? '✓ Copied' : 'Copy' }}
            </button>
          </div>
          <button class="btn-primary btn" style="width:100%; justify-content:center;" (click)="proceed()">
            Continue to sign in
          </button>
        } @else {

          @if (error()) {
            <div class="alert alert-error">{{ error() }}</div>
          }

          <form (ngSubmit)="submit()" #f="ngForm">
            <div class="field">
              <label for="label">Instance label</label>
              <input
                id="label"
                type="text"
                name="label"
                [(ngModel)]="form.label"
                placeholder="My Brain"
                maxlength="100"
                required
                [disabled]="loading()"
              />
            </div>

            <div class="field">
              <label for="pw">Settings password</label>
              <input
                id="pw"
                type="password"
                name="pw"
                [(ngModel)]="form.settingsPassword"
                autocomplete="new-password"
                minlength="8"
                required
                [disabled]="loading()"
              />
              <span class="field-hint">Minimum 8 characters. Used for future admin access.</span>
            </div>

            <div class="field">
              <label for="pw2">Confirm password</label>
              <input
                id="pw2"
                type="password"
                name="pw2"
                [(ngModel)]="form.confirm"
                autocomplete="new-password"
                required
                [disabled]="loading()"
              />
              @if (form.confirm && form.confirm !== form.settingsPassword) {
                <span class="field-hint error">Passwords do not match</span>
              }
            </div>

            <button
              type="submit"
              class="btn-primary btn"
              style="width:100%; justify-content:center;"
              [disabled]="loading() || !canSubmit()"
            >
              @if (loading()) {
                <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
                Setting up…
              } @else {
                Complete setup
              }
            </button>
          </form>
        }
      </div>
    </div>
  `,
})
export class SetupComponent {
  private http = inject(HttpClient);
  private router = inject(Router);
  private auth = inject(AuthService);

  form = { label: '', settingsPassword: '', confirm: '' };
  loading = signal(false);
  error = signal('');
  done = signal(false);
  firstToken = signal('');
  copied = signal(false);

  canSubmit(): boolean {
    return !!(
      this.form.label.trim() &&
      this.form.settingsPassword.length >= 8 &&
      this.form.settingsPassword === this.form.confirm
    );
  }

  submit(): void {
    if (!this.canSubmit()) return;
    this.loading.set(true);
    this.error.set('');

    this.http
      .post<{ plaintext: string }>('/api/setup/json', {
        label: this.form.label.trim(),
        settingsPassword: this.form.settingsPassword,
      })
      .subscribe({
        next: (res) => {
          this.loading.set(false);
          this.firstToken.set(res.plaintext);
          this.done.set(true);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(
            err.error?.error ?? 'Setup failed. Check the server logs.',
          );
        },
      });
  }

  copyToken(): void {
    navigator.clipboard.writeText(this.firstToken()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  proceed(): void {
    this.auth.login(this.firstToken());
    this.router.navigate(['/']);
  }
}
