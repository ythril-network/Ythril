/**
 * Where a recall result is read from: its collection, its fields, and the parent a file chunk carries.
 *
 * ## The question it answers
 *
 * "Given a knowledge type, which collection holds it and which fields make up its result?" The vector path, the lexical
 * introduction, the fresh-write hydration, the duplicate check and `findSimilar` all read rows of those collections into
 * recall results, and a record's contents must not depend on which channel found it, so they all take the collection suffix and
 * the projection from here. The same module attaches a chunk's parent file to a final result list, because that step reads
 * through the same rows and is the last shaping a result gets.
 *
 * Moved out of `recall.ts` (frozen at its code-line limit, `no-new-god-files`) along a seam that was already there: none of
 * these touches the deadline, the embedder or the ranking. The types stay in `recall.ts` and come back here as type-only imports,
 * which TypeScript erases, so at runtime the dependency is one way (see `recall-result.ts` for the same arrangement).
 */
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { NOT_A_FLAGGED_ROW } from '../files/live-file-row.js';
import type { RecallFile, RecallKnowledgeType, RecallResult } from './recall.js';

/** Maps knowledge types to their MongoDB collection suffixes. */
export const KNOWLEDGE_COLLECTION: Record<RecallKnowledgeType, string> = {
  fact: 'facts',
  entity: 'entities',
  edge: 'edges',
  chrono: 'chrono',
  file: 'files',
};

/**
 * The fields a recall result is built from, per knowledge type.
 *
 * Shared by the vector path and the lexical-introduction path so the two cannot drift into returning
 * differently-shaped records for the same type — a record's contents must not depend on which channel
 * happened to find it.
 */
export function recallProjection(knowledgeType: RecallKnowledgeType): {
  commonProject: Record<string, 1>;
  typeProject: Record<string, 1>;
} {
  // An INCLUSION list, so a field absent from it never leaves Mongo — which is why `superseded` is here and
  // not only in `toRecallRecord`'s allowlist further down. Both are field-by-field rebuilds of one record,
  // and a new field has to be named in each: it was named in the second alone, and came back missing with
  // every gate green, because the record handed to the second had already lost it.
  const commonProject: Record<string, 1> = { _id: 1, spaceId: 1, _knowledgeType: 1, score: 1, createdAt: 1, updatedAt: 1, seq: 1, embeddingModel: 1, matchedText: 1, superseded: 1 };
  let typeProject: Record<string, 1> = {};
  if (knowledgeType === 'fact') {
    typeProject = { fact: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'entity') {
    typeProject = { name: 1, type: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'edge') {
    typeProject = { from: 1, to: 1, label: 1, weight: 1, type: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'chrono') {
    typeProject = { title: 1, description: 1, type: 1, status: 1, startsAt: 1, endsAt: 1, tags: 1, properties: 1 };
  } else if (knowledgeType === 'file') {
    typeProject = { path: 1, description: 1, tags: 1, sizeBytes: 1, properties: 1, headingText: 1, content: 1, parentFileId: 1, chunkIndex: 1, mediaType: 1, embeddingStatus: 1, chunkOffsetMs: 1, chunkDurationMs: 1 };
  }
  return { commonProject, typeProject };
}

/**
 * For file chunk results that have a parentFileId, batch-fetch the parent
 * file document and attach `parentFile: { path, description?, tags? }` inline.
 * Non-chunk file results and non-file results are left unchanged.
 */
export async function enrichFileChunksWithParent(spaceId: string, results: RecallResult[]): Promise<void> {
  const fileChunks = results.filter(
    (r): r is RecallFile => r.type === 'file' && typeof r.parentFileId === 'string',
  );
  if (fileChunks.length === 0) return;

  const parentIds = [...new Set(fileChunks.map(r => r.parentFileId as string))];

  // Batch-fetch parent file docs — projection only (no embedding field)
  // A flagged parent attaches nothing: its path, description and tags are what the audit record keeps, and a chunk
  // whose file was deleted must not carry them into an answer. The chunk is still returned — this closes the leak of
  // the parent's retained fields, exactly as a hard-deleted parent already does.
  const parentMap = await readStoredById<{ _id: string; path?: string; description?: string; tags?: string[] }>(
    spaceCollection(spaceId, 'files'), parentIds, { path: 1, description: 1, tags: 1 }, { filter: NOT_A_FLAGGED_ROW });

  for (const chunk of fileChunks) {
    const parent = parentMap.get(chunk.parentFileId as string);
    if (parent) {
      chunk.parentFile = {
        path: parent.path ?? (parent._id),
        ...(parent.description ? { description: parent.description } : {}),
        ...(parent.tags?.length ? { tags: parent.tags } : {}),
      };
    }
  }
}
