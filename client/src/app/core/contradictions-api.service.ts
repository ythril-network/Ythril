import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { readEveryPage } from './read-every-page';
import type { ContradictionRecord, ContradictionResolveNote } from './api.types';

/**
 * What a resolve call reports back.
 *
 * `markedRecord` says the LOSING RECORD itself carries the mark. It is reported rather than assumed because
 * until 5.0 it was not true: the decision went onto the review finding and nowhere a search could see it, so
 * a reviewer settled a contradiction and both claims kept coming back ranked together.
 *
 * `notes` (`Q-442`) are the outcomes a reviewer must not be left to assume, one per code: the `supersedes`
 * link refused by the space's own rules (the decision is KEPT and the loser marked, D-25), a record of the
 * pair that is gone, a pair of edges that no edge can join. The review tab says each in the reviewer's
 * language from its code; the server's `detail` is a disclosure, never the toast.
 *
 * `note` is the notes' sentences in one string, kept for a client older than `notes`. It used to be the one
 * server sentence the card toasted verbatim, which is how a German reviewer was told in English.
 *
 * A failed resolve carries a `code` too: `409 resolvedOtherwise` when the finding is already being resolved,
 * or was resolved, with a different choice (nothing was written by the refused request), and a `503` with
 * `written: {edge, markedRecord, closed}` when the store failed part-way, which a retry of the same choice
 * finishes without a second edge.
 */
export interface ResolveResult {
  status: string;
  resolution: string;
  resolvedBy?: string;
  supersededId?: string;
  markedRecord?: boolean;
  edge?: { id: string; from: string; to: string; label: string };
  notes?: ContradictionResolveNote[];
  note?: string;
}

/** Contradiction candidates: list, dismiss, re-open, resolve, and rescan. Mirrors DuplicatesApi. */
@Injectable({ providedIn: 'root' })
export class ContradictionsApi {
  private http = inject(HttpClient);

  /**
   * `nliConfigured` comes back with the list because an empty list has more than one meaning, and the
   * view cannot tell them apart on its own — see the note on the server route.
   */
  listContradictions(status: 'open' | 'dismissed' | 'resolved' | 'all' = 'open', space?: string): Observable<{ contradictions: ContradictionRecord[]; nliConfigured: boolean }> {
    // The WHOLE list, every page (Q-127): the review tab filters and sorts it in the browser.
    return readEveryPage(skip => {
      const params = new URLSearchParams({ status });
      if (space) params.set('space', space);
      if (skip) params.set('skip', String(skip));
      return this.http.get<{ contradictions: ContradictionRecord[]; nliConfigured: boolean; nextSkip?: number }>(`/api/contradictions?${params.toString()}`);
    }).pipe(map(pages => ({ contradictions: pages.flatMap(p => p.contradictions), nliConfigured: pages[0]!.nliConfigured })));
  }

  dismissContradiction(id: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(`/api/contradictions/${encodeURIComponent(id)}/dismiss`, {});
  }

  reopenContradiction(id: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(`/api/contradictions/${encodeURIComponent(id)}/reopen`, {});
  }

  /** Contradictions are never merged — this records HOW a human settled it. */
  resolveContradiction(id: string, resolution: 'edited' | 'linked'): Observable<ResolveResult> {
    return this.http.post<ResolveResult>(`/api/contradictions/${encodeURIComponent(id)}/resolve`, { resolution });
  }

  /**
   * The reviewer picked a winner: the other record is marked superseded, and the server draws the
   * `supersedes` edge when the space's rules let it (`notes` says when they did not).
   *
   * Separate from `resolveContradiction` on purpose. The two calls hit one endpoint, but they are different
   * decisions — this one names a loser and can change the graph, and folding it into a `resolution` argument
   * would let a caller omit the winner and get a 400 that reads like a bug in the button.
   */
  keepSide(id: string, winner: 'a' | 'b'): Observable<ResolveResult> {
    return this.http.post<ResolveResult>(`/api/contradictions/${encodeURIComponent(id)}/resolve`,
      { resolution: 'superseded', winner });
  }

  /** `failedSpaces`: the spaces the scan could not scan, each with a reason in the server's words (Q-381); optional only because an older server omits it. */
  scanContradictions(space?: string): Observable<{ scannedSpaces: number; scanned: number; found: number; nliStalled: boolean; failedSpaces?: { spaceId: string; reason: string }[] }> {
    return this.http.post<{ scannedSpaces: number; scanned: number; found: number; nliStalled: boolean; failedSpaces?: { spaceId: string; reason: string }[] }>(
      `/api/contradictions/scan${space ? `?space=${encodeURIComponent(space)}` : ''}`, {});
  }
}
