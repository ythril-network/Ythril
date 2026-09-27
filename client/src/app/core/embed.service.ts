import { Injectable, signal } from '@angular/core';

const TRUTHY = new Set(['1', 'true', 'yes']);
const FALSY = new Set(['0', 'false', 'no']);
/** Per tab and per origin, so a framed brain keeps the flag and a direct visit in another tab never inherits it. */
const STORAGE_KEY = 'ythril.embedded';

/**
 * Read `?embedded=1` from the current URL, remembering it for this tab.
 *
 * **The URL alone is not enough.** A sign-in inside the frame leaves for the identity provider and comes back to the
 * callback URL, a new document whose query is `code` and `state`, so the flag was gone after the first sign-in and
 * the full shell (topbar, Sign out) came back for the rest of that frame's life. Reported by the portal team,
 * 2026-09-26. So the flag is written to `sessionStorage` when the URL carries it and read from there when it does
 * not; an explicit `?embedded=0` clears it.
 */
function readEmbeddedFlag(): boolean {
  let raw: string | null = null;
  try { raw = new URLSearchParams(window.location.search).get('embedded'); } catch { /* malformed URL */ }
  const store = (() => { try { return window.sessionStorage; } catch { return null; } })();
  if (raw !== null) {
    const v = raw.toLowerCase();
    if (TRUTHY.has(v)) { try { store?.setItem(STORAGE_KEY, '1'); } catch { /* storage blocked */ } return true; }
    if (FALSY.has(v)) { try { store?.removeItem(STORAGE_KEY); } catch { /* storage blocked */ } return false; }
  }
  try { return store?.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

/**
 * EmbedService — "chrome-less" mode for portal-style embedding.
 *
 * When Ythril is embedded as an iframe inside a host portal, the shell topbar
 * (logo + Sign out) duplicates the host's own chrome, and the in-frame Sign out is
 * actively misleading: it ends only the Ythril session, not the portal's.
 *
 * Passing `?embedded=1` on the app URL hides the topbar. Navigation is unaffected —
 * it lives in the sidebar, not the topbar.
 *
 * The flag is read ONCE at construction and cached, because Angular's router drops
 * unknown query params on navigation; re-reading `location.search` later would flip
 * the app back out of embedded mode on the first route change. It also survives a
 * new document in the same tab (a sign-in round trip), through `readEmbeddedFlag`.
 */
@Injectable({ providedIn: 'root' })
export class EmbedService {
  private readonly _embedded = signal(readEmbeddedFlag());

  /** True when the app was loaded with `?embedded=1` in this tab — host chrome should be hidden. */
  readonly embedded = this._embedded.asReadonly();
}
