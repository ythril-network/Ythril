import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { FORK_KINDS, type ForkCounts, type ForkKind, type ForkKindsFields, type ForkMarkedCounts, type ForkPage, type ForkResolveRequest, type ForkRow } from './forks.types';

/**
 * The forks of a space and their resolution: `GET /api/brain/spaces/:id/forks?kind=&skip=&limit=` (paged by `skip` and `limit` like the other brain
 * lists, `kind` optional) and `POST /api/brain/spaces/:id/forks/:forkId/resolve {kind, keep, ifMatchSeq, ifMatchParentSeq}`, all four required
 * (Q-624, design rev 4 section 10). The same two capabilities exist as the MCP tools `list_forks` and `resolve_fork`, with these parameters.
 *
 * The answer's envelope is read the way the server tests read it: the rows are the first array the body holds (`forks` when named), because
 * the plan fixes the rows and not the envelope around them.
 */
@Injectable({ providedIn: 'root' })
export class ForksApi {
  private readonly http = inject(HttpClient);

  /** One page of forks. Without `kind` the page holds every kind; the answer's `counts` always do. */
  listForks(spaceId: string, skip = 0, limit = 25, kind?: ForkKind): Observable<ForkPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (skip) params.set('skip', String(skip));
    if (kind) params.set('kind', kind);
    return this.http.get<unknown>(`/api/brain/spaces/${encodeURIComponent(spaceId)}/forks?${params.toString()}`).pipe(
      map(body => pageOf(body, skip, limit)),
    );
  }

  /** Keep one version and delete the fork; what pointed at the fork is repointed to the parent. */
  resolveFork(spaceId: string, forkId: string, request: ForkResolveRequest): Observable<unknown> {
    return this.http.post<unknown>(`/api/brain/spaces/${encodeURIComponent(spaceId)}/forks/${encodeURIComponent(forkId)}/resolve`, request);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The per-kind counts an answer carries: every kind a number, or none at all (an answer that does not say, says nothing). */
function countsOf(value: unknown): ForkCounts | undefined {
  if (!isRecord(value)) return undefined;
  const out = {} as ForkCounts;
  for (const kind of FORK_KINDS) {
    const n = value[kind];
    if (typeof n !== 'number') return undefined;
    out[kind] = n;
  }
  return out;
}

/** The per-kind counts of forks another instance already decided: `counts.resolvedElsewhere`, or the answer's own `resolvedElsewhere`. */
function markedOf(counts: unknown, answer: Record<string, unknown>): ForkMarkedCounts | undefined {
  const source = isRecord(counts) && isRecord(counts['resolvedElsewhere']) ? counts['resolvedElsewhere'] : answer['resolvedElsewhere'];
  if (!isRecord(source)) return undefined;
  const out: ForkMarkedCounts = {};
  for (const kind of FORK_KINDS) if (typeof source[kind] === 'number') out[kind] = source[kind] as number;
  return Object.keys(out).length ? out : undefined;
}

/** The fields each kind compares, as the answer states them; a kind with no usable entry makes the whole answer say nothing, never half. */
function kindsOf(value: unknown): ForkKindsFields | undefined {
  if (!isRecord(value)) return undefined;
  const out = {} as ForkKindsFields;
  for (const kind of FORK_KINDS) {
    const entry = value[kind];
    if (!isRecord(entry) || !Array.isArray(entry['fields']) || typeof entry['mainField'] !== 'string') return undefined;
    out[kind] = { fields: (entry['fields'] as unknown[]).filter((f): f is string => typeof f === 'string'), mainField: entry['mainField'] };
  }
  return out;
}

/** The page a list answer holds: its rows, and the total, counts, kinds, skip and limit when it says them. */
export function pageOf(body: unknown, skip: number, limit: number): ForkPage {
  const record = (isRecord(body) ? body : {}) as Record<string, unknown>;
  const rows = Array.isArray(body) ? body : Array.isArray(record['forks']) ? record['forks'] : Object.values(record).find(Array.isArray) ?? [];
  const total = record['total'];
  const counts = countsOf(record['counts']);
  const marked = markedOf(record['counts'], record);
  const kinds = kindsOf(record['kinds']);
  return {
    forks: rows as ForkRow[],
    ...(typeof total === 'number' ? { total } : {}),
    skip: typeof record['skip'] === 'number' ? record['skip'] : skip,
    limit: typeof record['limit'] === 'number' ? record['limit'] : limit,
    ...(counts ? { counts } : {}),
    ...(marked ? { resolvedElsewhere: marked } : {}),
    ...(kinds ? { kinds } : {}),
    ...(typeof record['maxForksPerRecord'] === 'number' ? { maxForksPerRecord: record['maxForksPerRecord'] } : {}),
  };
}
