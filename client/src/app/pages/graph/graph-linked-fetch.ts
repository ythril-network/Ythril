/**
 * Which memories and chrono entries does the side panel list for a selected node, or a selected edge?
 *
 * Split out of `graph.component.ts` when it exceeded its size limit (`Q-162`). The node and edge panels each
 * carried their own copy of the same two-request fetch, differing only in what the edge did afterwards — so the
 * edge's answer is now the node's answer for its `from` end, narrowed.
 *
 * A failed request lists nothing rather than failing the panel: each half falls back to an empty list on its own,
 * so a chrono lookup that errors still leaves the memories on screen. That fallback is the part a hand-written
 * copy would drop, which is why it lives here and not at the call.
 *
 * The edge narrowing is ASYMMETRIC and preserved as found, not endorsed: memories are kept when they reference
 * `to`, chrono only when it references both `from` AND `to`. `graph.component.characterization.spec.ts` pins it,
 * so making the two agree is a visible decision rather than a tidy-up.
 */
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import type { Fact, ChronoEntry } from '../../core/api.types';
import type { BrainApi } from '../../core/brain-api.service';

export interface LinkedRecords {
  facts: Fact[];
  chrono: ChronoEntry[];
}

type LinkedSource = Pick<BrainApi, 'listFacts' | 'chronoLinkedTo'>;

/** The records linked to one entity, each half empty when its own request fails. */
export function linkedToNode(api: LinkedSource, spaceId: string, entityId: string): Observable<LinkedRecords> {
  return forkJoin({
    facts: api.listFacts(spaceId, 100, 0, { entity: entityId }).pipe(
      map(r => r.facts),
      catchError(() => of([] as Fact[])),
    ),
    chrono: api.chronoLinkedTo(spaceId, entityId).pipe(
      catchError(() => of([] as ChronoEntry[])),
    ),
  });
}

/** What an edge between `from` and `to` lists, from what is linked to `from` — see the asymmetry above. */
export function narrowToEdge(linked: LinkedRecords, from: string, to: string): LinkedRecords {
  return {
    facts: linked.facts.filter(m => Array.isArray(m.linkEntities) && m.linkEntities.includes(to)),
    chrono: linked.chrono.filter(c =>
      Array.isArray(c.linkEntities) && c.linkEntities.includes(from) && c.linkEntities.includes(to)),
  };
}

/** The records an edge's panel lists. */
export function linkedToEdge(api: LinkedSource, spaceId: string, from: string, to: string): Observable<LinkedRecords> {
  return linkedToNode(api, spaceId, from).pipe(map(linked => narrowToEdge(linked, from, to)));
}
