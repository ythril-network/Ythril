/**
 * A stored row as the recall result a caller reads — one mapping, for every door that turns a collection's row into a `RecallResult`.
 *
 * ## The question it answers
 *
 * "Given a row of a record collection and the kind it is, what is the result shape?" The index path, the fresh-write path, the hydration
 * of a fresh hit, the duplicate check and `findSimilar`'s source all ask it, and a caller must not be able to tell which channel found a
 * record: the shape is the same byte for byte. Moved out of `recall.ts` (frozen at its code-line limit, `no-new-god-files`) along the seam
 * that was already there: it reads one row and touches no database, deadline or embedder. The types stay in `recall.ts` and come back here
 * as type-only imports, which TypeScript erases, so at runtime the dependency is one way (see `recall-shape.ts` for the same arrangement).
 */
import type { ChronoStatus } from '../config/types.js';
import { deriveChronoStatus } from './chrono-status.js';
import { datePassedPolicy } from './chrono-date-policy.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import type { RecallBase, RecallFile, RecallKnowledgeType, RecallResult } from './recall.js';

/** `doc`, a row of the collection of `knowledgeType` (with its `score` when it came from a search), as the recall result of that kind. */
export function mapToRecallResult(doc: Record<string, unknown>, knowledgeType: RecallKnowledgeType): RecallResult {
  const base: RecallBase = {
    _id: doc['_id'] as string,
    spaceId: doc['spaceId'] as string,
    score: doc['score'] as number,
    createdAt: doc['createdAt'] as string | undefined,
    updatedAt: doc['updatedAt'] as string | undefined,
    seq: doc['seq'] as number | undefined,
    embeddingModel: doc['embeddingModel'] as string | undefined,
    tags: doc['tags'] as string[] | undefined,
    description: doc['description'] as string | undefined,
    properties: doc['properties'] as Record<string, string | number | boolean> | undefined,
    matchedText: doc['matchedText'] as string | undefined,
    superseded: doc['superseded'] as boolean | undefined,
  };
  switch (knowledgeType) {
    case 'fact':
      return { ...base, type: 'fact', fact: doc['fact'] as string };
    case 'entity':
      return { ...base, type: 'entity', name: doc['name'] as string, entityType: doc['type'] as string };
    case 'edge':
      return { ...base, type: 'edge', from: doc['from'] as string, to: doc['to'] as string, label: doc['label'] as string, weight: doc['weight'] as number | undefined, edgeType: doc['type'] as string | undefined };
    case 'chrono':
      return { ...base, type: 'chrono', title: doc['title'] as string, chronoType: doc['type'] as string, startsAt: doc['startsAt'] as string, status: deriveChronoStatus({ status: doc['status'] as ChronoStatus, startsAt: doc['startsAt'] as string, endsAt: doc['endsAt'] as string | undefined },
        new Date(), datePassedPolicy(getSpaceMeta(doc['spaceId'] as string), doc['type'] as string | undefined)) };
    case 'file':
      return { ...base, type: 'file', path: doc['path'] as string, sizeBytes: doc['sizeBytes'] as number | undefined, headingText: doc['headingText'] as string | null | undefined, content: doc['content'] as string | undefined, parentFileId: doc['parentFileId'] as string | undefined, chunkIndex: doc['chunkIndex'] as number | undefined, mediaType: doc['mediaType'] as 'image' | 'audio' | 'video' | undefined, embeddingStatus: doc['embeddingStatus'] as RecallFile['embeddingStatus'], chunkOffsetMs: doc['chunkOffsetMs'] as number | undefined, chunkDurationMs: doc['chunkDurationMs'] as number | undefined };
  }
}
