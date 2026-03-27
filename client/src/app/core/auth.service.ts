import { Injectable, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

const TOKEN_KEY = 'ythril_token';

/** Shape of the response from GET /api/auth/oidc-info */
export interface OidcInfo {
  enabled: boolean;
  issuerUrl?: string;
  clientId?: string;
  scopes?: string[];
}

export interface AuthState {
  token: string | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);

  private readonly _token = signal<string | null>(
    localStorage.getItem(TOKEN_KEY),
  );

  readonly token = this._token.asReadonly();
  readonly isAuthenticated = computed(() => !!this._token());

  /** Store token in localStorage and memory */
  login(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    this._token.set(token);
  }

  /** Clear token from storage */
  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    this._token.set(null);
  }

  // ── OIDC ──────────────────────────────────────────────────────────────────

  /** Fetch the OIDC configuration from the server. */
  async getOidcInfo(): Promise<OidcInfo> {
    try {
      return await firstValueFrom(this.http.get<OidcInfo>('/api/auth/oidc-info'));
    } catch {
      return { enabled: false };
    }
  }

  /**
   * Initiate the OIDC Authorization Code + PKCE login flow.
   *
   * 1. Fetches the IdP discovery document to get the authorization_endpoint.
   * 2. Generates a PKCE code_verifier and code_challenge.
   * 3. Stores state + code_verifier in sessionStorage.
   * 4. Redirects the browser to the IdP.
   */
  async startOidcLogin(info: OidcInfo): Promise<void> {
    if (!info.enabled || !info.issuerUrl || !info.clientId) return;

    // Fetch OIDC discovery document
    const discoveryUrl =
      info.issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
    const discovery = await firstValueFrom(
      this.http.get<{ authorization_endpoint: string }>(discoveryUrl),
    );

    // Generate PKCE code_verifier (96 random bytes → base64url, produces a 128-char verifier)
    const verifierBytes = crypto.getRandomValues(new Uint8Array(96));
    const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // Compute code_challenge = BASE64URL(SHA-256(code_verifier))
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // Generate random state
    const stateBytes = crypto.getRandomValues(new Uint8Array(16));
    const state = btoa(String.fromCharCode(...stateBytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // Persist PKCE state for the callback
    sessionStorage.setItem('oidc_state', state);
    sessionStorage.setItem('oidc_code_verifier', codeVerifier);
    sessionStorage.setItem('oidc_token_endpoint_hint', info.issuerUrl);
    sessionStorage.setItem('oidc_client_id', info.clientId);

    const redirectUri = `${location.origin}/oidc-callback`;
    const scopes = (info.scopes ?? ['openid', 'profile', 'email']).join(' ');

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', info.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    location.href = authUrl.toString();
  }

  /**
   * Complete the OIDC callback: exchange the authorization code for tokens.
   *
   * Called from the OidcCallbackComponent when the IdP redirects back with
   * `?code=…&state=…`.
   *
   * Returns the access_token on success, throws on failure.
   */
  async exchangeOidcCode(code: string, returnedState: string): Promise<string> {
    const storedState = sessionStorage.getItem('oidc_state');
    const codeVerifier = sessionStorage.getItem('oidc_code_verifier');
    const issuerUrl = sessionStorage.getItem('oidc_token_endpoint_hint');
    const clientId = sessionStorage.getItem('oidc_client_id');

    // Clear PKCE state immediately regardless of outcome
    sessionStorage.removeItem('oidc_state');
    sessionStorage.removeItem('oidc_code_verifier');
    sessionStorage.removeItem('oidc_token_endpoint_hint');
    sessionStorage.removeItem('oidc_client_id');

    if (returnedState !== storedState) {
      throw new Error('OIDC state mismatch — possible CSRF attack');
    }
    if (!codeVerifier || !issuerUrl || !clientId) {
      throw new Error('Missing OIDC session data');
    }

    // Fetch token endpoint from discovery
    const discoveryUrl =
      issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
    const discovery = await firstValueFrom(
      this.http.get<{ token_endpoint: string }>(discoveryUrl),
    );

    // Exchange code for tokens at the IdP token endpoint
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: `${location.origin}/oidc-callback`,
      code_verifier: codeVerifier,
    });

    const tokenRes = await firstValueFrom(
      this.http.post<{ access_token: string }>(
        discovery.token_endpoint,
        body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      ),
    );

    return tokenRes.access_token;
  }
}
