import type { RecallKnowledgeType } from './api.types';

/**
 * One recall hit: the ranking beside the record, never mixed into it (`Q-87`).
 *
 * No index signature, ON PURPOSE: the type is the gate. It declared `[key: string]: unknown` and so let four
 * consumers read `r['_id']`, `r['name']` off the hit itself for a year after the record moved under `record` — every
 * semantic search in the Graph picker and the tabs rendered blank rows with an undefined id, and nothing failed to
 * compile. A record field is read through `recordOf` (`pages/brain/recall-hits.ts`), which throws on a hit without one.
 *
 * Its own module because `api.types.ts` is frozen by the god-file ratchet, whose instruction is to put new shape
 * BESIDE a large file rather than inside it.
 */
export interface RecallHit {
  type: RecallKnowledgeType;
  spaceId?: string;
  score?: number;
  lexicalScore?: number;
  fusedScore?: number;
  rerankScore?: number;
  record: Record<string, unknown>;
  _graph?: unknown[];
}
