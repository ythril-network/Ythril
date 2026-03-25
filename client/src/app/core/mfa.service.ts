import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export interface MfaChallenge {
  resolve: (code: string | null) => void;
}

/**
 * Service that mediates between the MFA HTTP interceptor (which needs to
 * ask the user for a TOTP code) and the MFA prompt modal (which renders the
 * dialog).
 *
 * The interceptor calls `prompt()` and awaits the Promise.
 * The modal calls `respond()` when the user submits or cancels.
 *
 * Session cache: after a successful MFA check the code + timestamp are cached
 * for MFA_WINDOW_MS.  Within that window the interceptor re-uses the cached
 * code, so the user is only prompted once per session window.
 */
@Injectable({ providedIn: 'root' })
export class MfaService {
  /** Emits whenever the interceptor needs a TOTP code */
  readonly challenge$ = new Subject<MfaChallenge>();

  /** True while a prompt dialog is open */
  readonly prompting = signal(false);

  private _cachedCode: string | null = null;
  private _cachedAt = 0;
  private readonly MFA_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  /** Returns a cached code if it is still within the session window */
  getCached(): string | null {
    if (this._cachedCode && Date.now() - this._cachedAt < this.MFA_WINDOW_MS) {
      return this._cachedCode;
    }
    this._cachedCode = null;
    return null;
  }

  /** Store a verified code */
  cacheCode(code: string): void {
    this._cachedCode = code;
    this._cachedAt = Date.now();
  }

  /** Invalidate the session cache (e.g. on MFA_INVALID) */
  invalidate(): void {
    this._cachedCode = null;
    this._cachedAt = 0;
  }

  /**
   * Ask the user for a TOTP code.
   * Returns the entered code, or null if the user cancelled.
   */
  prompt(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.prompting.set(true);
      this.challenge$.next({ resolve });
    });
  }

  /** Called by the prompt component when the user submits or cancels */
  respond(code: string | null): void {
    this.prompting.set(false);
    // The Subject already delivered the resolve fn to the interceptor;
    // that fn is called directly by MfaPromptComponent — nothing to do here.
  }
}
