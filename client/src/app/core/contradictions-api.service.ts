import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { ContradictionRecord } from './api.types';

/**
 * What a resolve call reports back.
 *
 * `markedRecord` says the LOSING RECORD itself carries the mark. It is reported rather than assumed because
 * until 5.0 it was not true: the decision went onto the review finding and nowhere a search could see it, so
 * a reviewer settled a contradiction and both claims kept coming back ranked together.
 *
 * `note` NARROWED rather than went away. It used to mean "this pair is not two entities, so no edge" — for
 * facts and chrono entries, which is most of them. The server draws the edge for every kind that CAN be an
 * endpoint now, and `REF_KINDS` is where that is decided: an edge is not among them, because an edge
 * between two edges is nothing a walk could follow. So a pair of EDGES is the one case left, reachable only
 * on an instance that configured the scanner to cover them.
 *
 * Shown to the reviewer verbatim, not through a translation key. There is one such sentence, the server
 * owns its wording, and a key here would be a second place for it to be wrong.
 */
export interface ResolveResult {
  status: string;
  resolution: string;
  resolvedBy?: string;
  supersededId?: string;
  markedRecord?: boolean;
  edge?: { id: string; from: string; to: string; label: string };
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
    const params = new URLSearchParams({ status });
    if (space) params.set('space', space);
    return this.http.get<{ contradictions: ContradictionRecord[]; nliConfigured: boolean }>(`/api/contradictions?${params.toString()}`);
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
   * The reviewer picked a winner: the other record is marked superseded, and for an entity pair the server
   * draws the `supersedes` edge.
   *
   * Separate from `resolveContradiction` on purpose. The two calls hit one endpoint, but they are different
   * decisions — this one names a loser and can change the graph, and folding it into a `resolution` argument
   * would let a caller omit the winner and get a 400 that reads like a bug in the button.
   */
  keepSide(id: string, winner: 'a' | 'b'): Observable<ResolveResult> {
    return this.http.post<ResolveResult>(`/api/contradictions/${encodeURIComponent(id)}/resolve`,
      { resolution: 'superseded', winner });
  }

  scanContradictions(space?: string): Observable<{ scannedSpaces: number; scanned: number; found: number; nliStalled: boolean }> {
    return this.http.post<{ scannedSpaces: number; scanned: number; found: number; nliStalled: boolean }>(
      `/api/contradictions/scan${space ? `?space=${encodeURIComponent(space)}` : ''}`, {});
  }
}
