/**
 * Handing the user a file, and fetching bytes with the session — the ONE place either is written.
 *
 * ## Why this is a module
 *
 * Five pages saved a blob by hand before this existed, and two of them also fetched the bytes with a bearer
 * header they built themselves from `auth.token()`. Five copies had drifted: one revoked its object URL after
 * ten seconds and the rest at once, one attached the anchor to the document and the rest did not. Q-92 needed
 * a sixth (the query tab's spill download), which would have been a sixth variant. `one-authenticated-download
 * .spec.ts` holds the rule: exactly one source saves a blob, and nothing but this file and the HttpClient
 * interceptor puts the session token into a header.
 *
 * ## What a hand-written copy drops, and so what lives here
 *
 * - **The anchor is attached before the click and removed after it.** Some browsers ignore a click on a
 *   detached anchor, and one left attached accumulates with every download.
 * - **The object URL is always released.** Forgetting it leaks the whole blob for the life of the tab.
 * - **The bearer goes to the same origin only** (`tokenMayReach`, the rule the interceptor applies to
 *   HttpClient too). A URL that pointed somewhere else would otherwise carry the session token with it.
 * - **A failed response throws before its body is read**, as `HTTP <status>`, so an error page is never saved
 *   under the file's name and every caller reports the failure the same way.
 *
 * What the caller keeps is what differs by page and is not forgettable: the file name, and how a failure is
 * shown (a toast in the file manager, an inline line on the audit export, the pane on a preview).
 *
 * Bytes that come through `HttpClient` (the audit export, a spill) are fetched there, so the interceptor and
 * its 401 handling apply, and handed to `saveBlob`.
 */
import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { tokenMayReach } from './token-may-reach';

export interface SaveBlobOptions {
  /**
   * Release the object URL this many milliseconds after the click instead of straight after it.
   *
   * A parameter rather than one rule because both timings are in use and pinned by the pages' specs: a
   * fetched file (possibly large, possibly slow to hand over) waits, a document serialised in the page does
   * not. `0` or absent releases it synchronously after the click.
   */
  revokeAfterMs?: number;
}

/** Save `blob` to the user's disk as `filename`. */
export function saveBlob(blob: Blob, filename: string, opts: SaveBlobOptions = {}): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    const wait = opts.revokeAfterMs ?? 0;
    if (wait > 0) setTimeout(() => URL.revokeObjectURL(url), wait);
    else URL.revokeObjectURL(url);
  }
}


@Injectable({ providedIn: 'root' })
export class AuthenticatedDownload {
  private readonly auth = inject(AuthService);

  /**
   * `fetch` with the session's bearer, for bytes a browser-native `<a href>` / `<img src>` cannot fetch
   * because it cannot send the header, then `read` the OK response. A failed response rejects with
   * `HTTP <status>` and `read` never sees it.
   *
   * `read` runs in the SAME step as the status check rather than in a `.then` of its own, and the request
   * starts synchronously: the preview's staleness rules are pinned to that timing, and a wrapper that added
   * a turn would move them.
   */
  fetch<V>(url: string, read: (r: Response) => V | Promise<V>): Promise<V> {
    const token = this.auth.token();
    return fetch(url, {
      headers: token && tokenMayReach(url) ? { Authorization: `Bearer ${token}` } : {},
    }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return read(r); });
  }

  /** Fetch `url` with the session and save the response body as `filename`. Rejects as `fetch` does. */
  save(url: string, filename: string, opts?: SaveBlobOptions): Promise<void> {
    return this.fetch(url, r => r.blob()).then(blob => saveBlob(blob, filename, opts));
  }
}
