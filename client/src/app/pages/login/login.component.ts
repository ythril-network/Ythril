import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import type { OidcInfo } from '../../core/auth.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, CommonModule, RouterLink],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="auth-logo-dot"></span>
          ythril
        </div>
        <p class="auth-subtitle">Sign in with your access token.</p>

        @if (reason() === 'session_expired') {
          <div class="alert alert-warning" style="margin-bottom: 20px;">
            Your session expired. Please sign in again.
          </div>
        }

        @if (error()) {
          <div class="alert alert-error">{{ error() }}</div>
        }

        <form (ngSubmit)="login()" #f="ngForm">
          <div class="field">
            <label for="token">Access token</label>
            <input
              id="token"
              type="password"
              name="token"
              [(ngModel)]="tokenInput"
              placeholder="yt_…"
              autocomplete="current-password"
              required
              [disabled]="loading()"
            />
            <span class="field-hint">
              Paste your API token. Created during setup or via Settings → Tokens.
            </span>
          </div>

          <button
            type="submit"
            class="btn-primary btn"
            style="width: 100%; justify-content: center; margin-top: 4px;"
            [disabled]="loading() || !tokenInput"
          >
            @if (loading()) {
              <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
              Verifying…
            } @else {
              Sign in
            }
          </button>
        </form>

        @if (oidcInfo()?.enabled) {
          <div class="auth-divider">
            <span>or</span>
          </div>

          <button
            type="button"
            class="btn btn-secondary"
            style="width: 100%; justify-content: center;"
            [disabled]="loading()"
            (click)="loginWithOidc()"
          >
            Sign in with SSO
          </button>
        }

        <p style="margin-top: 20px; font-size: 12px; color: var(--text-muted); text-align: center;">
          No token yet?
          <a routerLink="/setup">Run first-time setup</a>
        </p>
      </div>
    </div>
  `,
  styles: [`
    .auth-divider {
      display: flex;
      align-items: center;
      text-align: center;
      margin: 16px 0;
      color: var(--text-muted);
      font-size: 12px;
    }
    .auth-divider::before,
    .auth-divider::after {
      content: '';
      flex: 1;
      border-bottom: 1px solid var(--border);
    }
    .auth-divider span {
      padding: 0 8px;
    }
  `],
})
export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);

  tokenInput = '';
  loading = signal(false);
  error = signal('');
  reason = signal(this.route.snapshot.queryParamMap.get('reason') ?? '');
  oidcInfo = signal<OidcInfo | null>(null);

  ngOnInit(): void {
    this.auth.getOidcInfo().then(info => this.oidcInfo.set(info));
  }

  login(): void {
    if (!this.tokenInput.trim()) return;
    this.loading.set(true);
    this.error.set('');

    // Verify the supplied token by calling /api/tokens/me
    this.http
      .get('/api/tokens/me', {
        headers: { Authorization: `Bearer ${this.tokenInput.trim()}` },
      })
      .subscribe({
        next: () => {
          this.auth.login(this.tokenInput.trim());
          this.router.navigate(['/']);
        },
        error: (err) => {
          this.loading.set(false);
          if (err.status === 401) {
            this.error.set('Invalid or expired token.');
          } else {
            this.error.set('Could not reach the server. Check your connection.');
          }
        },
      });
  }

  async loginWithOidc(): Promise<void> {
    const info = this.oidcInfo();
    if (!info?.enabled) return;
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.startOidcLogin(info);
      // Browser will redirect to IdP — no further action needed here
    } catch (err) {
      this.loading.set(false);
      this.error.set(
        err instanceof Error ? err.message : 'Failed to start SSO login.',
      );
    }
  }
}
