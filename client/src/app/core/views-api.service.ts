import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { refusalText, type RefusalSource, type RefusalTranslator } from './refusal-text';

/** The translation family for what a refused views act says (`views.refusal.<code>`); a code names a sentence only inside its own family. */
export const VIEW_REFUSAL_PREFIX = 'views.refusal';

/**
 * What a refused views act (create, rename, delete, copy, claim, purge) says, in the viewer's language: the sentence for the server's code,
 * else the server's own prose, else the generic "could not be saved". One function so no screen spells the family or the fallback itself.
 */
export function viewRefusalText(transloco: RefusalTranslator, err: unknown): string {
  return refusalText(transloco, err as RefusalSource, `${VIEW_REFUSAL_PREFIX}.failed`, VIEW_REFUSAL_PREFIX);
}

/**
 * A personal view as `GET /api/views` answers it (Q-531): a name the caller gave, the spaces it lists, and which of those the caller can
 * read NOW. A view belongs to exactly one owner and is never a space; its id is `@<name>`.
 *
 * `readable` is what a read through the view really reads (rights are judged at read time, so a member the caller lost drops out and a
 * later grant brings it back). `members` is what the view lists, `'*'` for "every space the caller reads, including later ones".
 */
export interface PersonalView {
  id: string;
  name: string;
  members: readonly string[] | '*';
  readable: readonly string[];
  createdAt?: string;
}

/** What the create door takes: a name (lower-case letters, digits and hyphens) and the spaces to read. */
export interface ViewCreateBody {
  name: string;
  members: readonly string[] | '*';
}

/** One definition the upgrade could not give to a live admin token, waiting for an instance admin to claim it (`unclaimedViews`). */
export interface UnclaimedView {
  name: string;
  members?: readonly string[] | '*';
}

/** `GET /api/admin/views/orphans`: views nobody owns any more, counted by kind of owner (never named), and the definitions to claim. */
export interface ViewOrphans {
  orphans?: { ownerKind: string; count: number }[];
  unclaimed?: UnclaimedView[];
}

/** `GET /api/admin/views/migration`: what the 6.0 upgrade did with the proxy spaces, kept for the admin to read after the boot log is gone. */
export interface ViewsMigrationReport {
  /** The proxy ids the upgrade turned into views (the server answers the ids, not a count). */
  migrated?: string[];
  /** Networks that lost a member id, so their peers see this instance as having left that network space. */
  networksLostIds?: { networkId: string; label?: string; spaceIds: string[] }[];
  /** The ids still reserved (`GET /api/spaces` serves the same list to an admin). */
  retiredSpaceIds?: string[];
  unclaimed?: UnclaimedView[];
}

/**
 * The personal-views doors: the caller's own views, the copy to a token the caller manages, and the instance admin's orphan, claim, purge
 * and migration doors. A view id starts with `@`, so it is URL-encoded in a path.
 */
@Injectable({ providedIn: 'root' })
export class ViewsApi {
  private http = inject(HttpClient);

  private path(id: string): string { return `/api/views/${encodeURIComponent(id)}`; }

  list(): Observable<{ views: PersonalView[] }> {
    return this.http.get<{ views: PersonalView[] }>('/api/views');
  }

  create(body: ViewCreateBody): Observable<{ view: PersonalView }> {
    return this.http.post<{ view: PersonalView }>('/api/views', body);
  }

  rename(id: string, name: string): Observable<{ view: PersonalView }> {
    return this.http.patch<{ view: PersonalView }>(this.path(id), { name });
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(this.path(id));
  }

  /** A copy owned by the receiving token. The answer's `view.id` differs from `id` when the receiver already had that name. */
  copy(id: string, toTokenId: string): Observable<{ view: PersonalView }> {
    return this.http.post<{ view: PersonalView }>(`${this.path(id)}/copy`, { toTokenId });
  }

  orphans(): Observable<ViewOrphans> {
    return this.http.get<ViewOrphans>('/api/admin/views/orphans');
  }

  /** Give the unclaimed definition called `name` to the calling admin. */
  claim(name: string): Observable<{ view: PersonalView }> {
    return this.http.post<{ view: PersonalView }>('/api/admin/views/claim', { name });
  }

  /** Drop the rows still held under a retired id and release it. `confirmOidcClaims` is the admin's word that an OIDC claim naming the id is understood. */
  purgeRetired(id: string, confirmOidcClaims: boolean): Observable<unknown> {
    return this.http.post(`/api/admin/views/retired/${encodeURIComponent(id)}/purge`, { confirmOidcClaims });
  }

  migration(): Observable<ViewsMigrationReport> {
    return this.http.get<ViewsMigrationReport>('/api/admin/views/migration');
  }
}
