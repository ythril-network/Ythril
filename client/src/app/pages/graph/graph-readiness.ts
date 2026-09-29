/**
 * Why a space may be slow to answer right now, in words a user can read (`Q-155`).
 *
 * Owner, 2026-09-29: *"maybe index or embedding were not ready - then its enough to show in the graph ui why its not
 * possible at the moment"*. An upgraded instance rebuilt every space's search indexes, and the Graph tab spun with
 * nothing on it until it was done.
 *
 * Only what the server REPORTS for the space becomes a reason, so the page never invents a cause: an empty list is
 * the honest answer when nothing it knows about explains the wait, and the caller then says only that it is waiting.
 */
import type { Space } from '../../core/api.types';

export interface ReadinessReason {
  key: string;
  params?: Record<string, number>;
}

export interface EmbedQueueCounts {
  pending: number;
  processing: number;
  failed: number;
}

export function readinessReasons(indexStatus: Space['indexStatus'], queue: EmbedQueueCounts | undefined): ReadinessReason[] {
  const out: ReadinessReason[] = [];
  if (indexStatus === 'building') out.push({ key: 'graph.waiting.indexBuilding' });
  if (indexStatus === 'failed') out.push({ key: 'graph.waiting.indexFailed' });
  const waiting = (queue?.pending ?? 0) + (queue?.processing ?? 0);
  if (waiting > 0) out.push({ key: 'graph.waiting.embedding', params: { count: waiting } });
  return out;
}
