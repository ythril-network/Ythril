/**
 * The shapes a recall answers with: one base, five variants, and the union of them (moved out of `recall.ts`, bundle-270 slice S6).
 *
 * ## What it prevents
 *
 * `recall-shape.ts` (the pure merge, rank and projection half of recall) read these types from `recall.ts` while `recall.ts` read its
 * functions: a type-only import, erased at run time, but still an edge the import-graph ratchet counts, and the one edge that held 32 modules
 * in the server's largest import cycle (`check-i-architecture-dependency-direction`). A leaf both import has no edge back. `recall.ts`
 * re-exports every name, so no importer changed.
 */
import type { RecordType } from '../config/types.js';

/** One of the five names this repo had for `RecordType`. Kept as the name recall's signatures read. */
export type RecallKnowledgeType = RecordType;

/** Fields shared by every knowledge-type recall result. */
export interface RecallBase {
  _id: string;
  spaceId: string;
  /** Vector similarity, on the configured `similarity` scale. `minScore` always filters on THIS. */
  score: number;
  /**
   * Cross-encoder relevance, present only when a reranker is configured and answered.
   *
   * Kept separate from `score` rather than overwriting it, because the two are different scales and
   * `minScore` is documented against the vector one. Folding them together would silently redefine
   * what a caller's threshold means. Ordering prefers this when present; filtering never uses it.
   */
  rerankScore?: number;
  /** MongoDB `textScore` from the lexical channel, when hybrid retrieval ran and this record matched. */
  lexicalScore?: number;
  /**
   * Reciprocal-Rank-Fusion score over the vector and lexical rankings. Ordering prefers it over the raw
   * vector score; `minScore` never uses it — the two are different scales and a caller's threshold was
   * written against vector similarity.
   */
  fusedScore?: number;
  /** The two ranks `fusedScore` came from — see `FusableResult` (`Q-159`). */
  vectorRank?: number;
  lexicalRank?: number;
  createdAt?: string;
  updatedAt?: string;
  seq?: number;
  embeddingModel?: string;
  tags?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  /** Pre-embedding source text — the exact string fed to the embedding model for this document. */
  matchedText?: string;
  /** The record is no longer true — see `RECORD_SUPERSEDED_FIELD`. Only ever `true`. */
  superseded?: boolean;
}

export interface RecallMemory extends RecallBase {
  type: 'fact';
  fact: string;
}

export interface RecallEntity extends RecallBase {
  type: 'entity';
  name: string;
  /** Entity type (named `entityType` to avoid conflict with the `type` discriminator). */
  entityType: string;
}

export interface RecallEdge extends RecallBase {
  type: 'edge';
  from: string;
  to: string;
  label: string;
  weight?: number;
  /** Edge relationship type (named `edgeType` to avoid conflict with the `type` discriminator). */
  edgeType?: string;
}

export interface RecallChrono extends RecallBase {
  type: 'chrono';
  title: string;
  /** Chrono type (event/deadline/plan/prediction/milestone). Named `chronoType` to
   *  avoid conflict with the `type` discriminator field. */
  chronoType: string;
  startsAt: string;
  /** Chrono status (upcoming/active/completed/overdue/cancelled). */
  status?: string;
}

export interface RecallFile extends RecallBase {
  type: 'file';
  path: string;
  sizeBytes?: number;
  /** Set on chunk records: the H2/H3 heading that opened this chunk (null for paragraph-chunked txt). */
  headingText?: string | null;
  /** Set on chunk records: the Markdown body of this chunk. */
  content?: string;
  /** Set on chunk and _converted/ records: _id of the parent file's filemeta record. */
  parentFileId?: string;
  /** Set on chunk records: 0-based position within the document. */
  chunkIndex?: number;
  /** Set on media chunk records: 'image' | 'audio' | 'video'. */
  mediaType?: 'image' | 'audio' | 'video';
  /** Set on media file records: current async embedding status. */
  embeddingStatus?: 'pending' | 'processing' | 'complete' | 'failed' | 'skipped' | 'disabled';
  /** Set on audio/video chunk records: start time of the chunk in milliseconds. */
  chunkOffsetMs?: number;
  /** Set on audio/video chunk records: duration of the chunk in milliseconds. */
  chunkDurationMs?: number;
  /** Inline parent file metadata — populated on chunk records when parentFileId is present. */
  parentFile?: { path: string; description?: string; tags?: string[] };
}

/** Discriminated union of all knowledge-type recall results. Narrow by `result.type`. */
export type RecallResult = RecallMemory | RecallEntity | RecallEdge | RecallChrono | RecallFile;
