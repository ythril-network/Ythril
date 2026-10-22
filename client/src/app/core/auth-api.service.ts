import type { TokenRights } from '../pages/settings/rights-glyph.component';
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { TokenRecord } from './api.types';

/** Auth, first-run setup, personal access tokens, and MFA. */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private http = inject(HttpClient);

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Verify the supplied PAT is valid and return its metadata.
   *
   * `rights` is declared because the route has always RETURNED it — `/api/tokens/me` responds with the whole
   * record minus its hash. Typed as `{ id, name, spaces? }`, the matrix was discarded on arrival, so nothing
   * could show a caller the rights they hold. That is the same shape as three other gaps closed this week: the
   * capability exists on the API and the client's own type is what withholds it.
   */
  verifyToken(): Observable<{ id: string; name: string; spaces?: string[] | null; admin?: boolean; rights?: TokenRights }> {
    return this.http.get<any>('/api/tokens/me');
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  getSetupStatus(): Observable<{ configured: boolean }> {
    return this.http.get<{ configured: boolean }>('/api/setup/status');
  }

  // ── Tokens ────────────────────────────────────────────────────────────────

  getMe(): Observable<TokenRecord> {
    return this.http.get<TokenRecord>('/api/tokens/me');
  }

  listTokens(): Observable<{ tokens: TokenRecord[] }> {
    return this.http.get<{ tokens: TokenRecord[] }>('/api/tokens');
  }

  createToken(body: { name: string; expiresAt?: string; spaces?: string[]; admin?: boolean; readOnly?: boolean; schemaLibrary?: boolean; mfa?: 'exempt' | 'required'; rateLimitPerMinute?: number }): Observable<{ token: TokenRecord; plaintext: string }> {
    return this.http.post<{ token: TokenRecord; plaintext: string }>('/api/tokens', body);
  }

  regenerateToken(id: string): Observable<{ plaintext: string }> {
    return this.http.post<{ plaintext: string }>(`/api/tokens/${id}/regenerate`, {});
  }

  /**
   * Replace a token's rights matrix.
   *
   * Separate call from `renameToken` rather than one method with two optional fields: the server guards them
   * differently — a rights edit is capped at the caller's own and refused outright if it would raise the
   * caller's floor — and a single method would let a caller believe it renamed while it changed permissions.
   */
  setTokenRights(id: string, rights: TokenRights): Observable<{ token: TokenRecord }> {
    return this.http.patch<{ token: TokenRecord }>(`/api/tokens/${id}`, { rights });
  }

  /**
   * Edit a token's label and rights in ONE request.
   *
   * The route has always taken both; the UI sent them separately, and only ever sent `rights` — so a token's
   * name was write-once in practice. Two requests would also mean a rename that lands while the rights change
   * 403s on the mint cap, leaving the operator with half of what they asked for and one audit entry for it.
   */
  updateToken(
    id: string,
    patch: { name?: string; rights?: TokenRights; mfa?: 'inherit' | 'exempt' | 'required' },
    totpCode?: string,
  ): Observable<{ token: TokenRecord }> {
    // Granting an MFA exemption costs a live TOTP code on this request, even from a token that is itself
    // exempt — otherwise one exemption grants the next. The header goes only when there is a code to send:
    // an empty one turns the server's "you need a code" into "your code is wrong".
    return this.http.patch<{ token: TokenRecord }>(`/api/tokens/${id}`, patch,
      totpCode ? { headers: { 'x-totp-code': totpCode } } : {});
  }

  renameToken(id: string, name: string): Observable<{ token: TokenRecord }> {
    return this.http.patch<{ token: TokenRecord }>(`/api/tokens/${id}`, { name });
  }

  revokeToken(id: string): Observable<void> {
    return this.http.delete<void>(`/api/tokens/${id}`);
  }

  // ── MFA ───────────────────────────────────────────────────────────────────

  getMfaStatus(): Observable<{ enabled: boolean }> {
    return this.http.get<{ enabled: boolean }>('/api/mfa/status');
  }

  setupMfa(): Observable<{ secret: string; otpauth: string }> {
    return this.http.post<{ secret: string; otpauth: string }>('/api/mfa/setup', {});
  }

  verifyMfaCode(code: string): Observable<{ valid: boolean }> {
    return this.http.post<{ valid: boolean }>('/api/mfa/verify', { code });
  }

  disableMfa(): Observable<void> {
    return this.http.delete<void>('/api/mfa');
  }
}
