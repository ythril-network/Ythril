import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';

/**
 * Handles the redirect back from the IdP after the user authenticates.
 *
 * The IdP redirects to `/oidc-callback?code=…&state=…`.  This component:
 *  1. Reads the `code` and `state` query parameters.
 *  2. Calls AuthService.exchangeOidcCode() to exchange the code for an
 *     access_token (PKCE — all server-side exchange happens at the IdP).
 *  3. Verifies the token is accepted by Ythril's own API (/api/tokens/me).
 *  4. Stores the token (via loginOidc to enable silent refresh) and navigates.
 *
 * When loaded inside a hidden iframe for silent refresh the component detects
 * the iframe context and posts the authorization code back to the parent window
 * instead of completing the full login flow.
 */
@Component({
  selector: 'app-oidc-callback',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="auth-logo-dot"></span>
          ythril
        </div>

        @if (error()) {
          <div class="alert alert-error">{{ error() }}</div>
          <p style="margin-top: 16px; text-align: center;">
            <a href="/login">Back to login</a>
          </p>
        } @else {
          <p class="auth-subtitle">
            <span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:8px;"></span>
            Completing sign-in…
          </p>
        }
      </div>
    </div>
  `,
})
export class OidcCallbackComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);
  private http = inject(HttpClient);

  error = signal('');

  ngOnInit(): void {
    void this.handleCallback();
  }

  private async handleCallback(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const code = params.get('code');
    const state = params.get('state');
    const errorParam = params.get('error');
    const errorDescription = params.get('error_description');

    // ── Silent refresh: running inside a hidden iframe ──────────────────────
    // When the parent window performs a silent refresh it creates a hidden
    // iframe that navigates here.  Post the result back via postMessage so the
    // parent can exchange the code without any visible navigation.
    if (window.self !== window.top) {
      window.parent.postMessage(
        { type: 'oidc_silent_callback', code, state, error: errorParam ?? null },
        location.origin,
      );
      return;
    }

    // ── Normal (top-level) callback ─────────────────────────────────────────
    if (errorParam) {
      this.error.set(errorDescription ?? errorParam);
      return;
    }

    if (!code || !state) {
      this.error.set('Missing authorization code or state in callback URL.');
      return;
    }

    try {
      const { accessToken, issuerUrl, clientId, scopes } =
        await this.auth.exchangeOidcCode(code, state);

      // Verify the token is accepted by Ythril before storing it
      await new Promise<void>((resolve, reject) => {
        this.http
          .get('/api/tokens/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          .subscribe({ next: () => resolve(), error: reject });
      });

      // loginOidc persists the OIDC session params and schedules silent refresh
      this.auth.loginOidc(accessToken, issuerUrl, clientId, scopes);
      await this.router.navigate(['/']);
    } catch (err) {
      this.error.set(
        err instanceof Error ? err.message : 'SSO login failed. Please try again.',
      );
    }
  }
}
