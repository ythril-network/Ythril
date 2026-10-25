import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ForkKeep, ForkPage, ForkRow } from './forks.types';

/**
 * The forks of a space and their resolution: `GET /api/brain/spaces/:id/forks` (paged by `skip` and `limit` like the other brain lists) and
 * `POST /api/brain/spaces/:id/forks/:forkId/resolve {keep}`. The same two capabilities exist as the MCP tools `list_forks` and `resolve_fork`,
 * with these parameters.
 *
 * The answer's envelope is read the way the server tests read it: the rows are the first array the body holds (`forks` when named), because
 * the plan fixes the rows and not the envelope around them.
 */
@Injectable({ providedIn: 'root' })
export class ForksApi {
  private readonly http = inject(HttpClient);

  listForks(spaceId: string, skip = 0, limit = 25): Observable<ForkPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (skip) params.set('skip', String(skip));
    return this.http.get<unknown>(`/api/brain/spaces/${encodeURIComponent(spaceId)}/forks?${params.toString()}`).pipe(
      map(body => pageOf(body, skip, limit)),
    );
  }

  /** Keep one version and delete the fork; what pointed at the fork is repointed to the parent. */
  resolveFork(spaceId: string, forkId: string, keep: ForkKeep): Observable<unknown> {
    return this.http.post<unknown>(`/api/brain/spaces/${encodeURIComponent(spaceId)}/forks/${encodeURIComponent(forkId)}/resolve`, { keep });
  }
}

/** The page a list answer holds: its rows, and the total, skip and limit when it says them. */
export function pageOf(body: unknown, skip: number, limit: number): ForkPage {
  const record = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const rows = Array.isArray(body) ? body : Array.isArray(record['forks']) ? record['forks'] : Object.values(record).find(Array.isArray) ?? [];
  const total = record['total'];
  return {
    forks: rows as ForkRow[],
    ...(typeof total === 'number' ? { total } : {}),
    skip: typeof record['skip'] === 'number' ? record['skip'] : skip,
    limit: typeof record['limit'] === 'number' ? record['limit'] : limit,
    ...(typeof record['maxForksPerRecord'] === 'number' ? { maxForksPerRecord: record['maxForksPerRecord'] } : {}),
  };
}
