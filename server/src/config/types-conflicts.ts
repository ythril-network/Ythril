/**
 * What a space's `conflicts` collection holds: a file copy a peer delivered beside the local file (`ConflictDoc`), and a file's
 * metadata that lost an equal-seq tie (`MetadataConflictDoc`, Q-426). One collection, one listing, one resolution and one set of
 * rights for both kinds.
 *
 * Moved out of `config/types.ts` (Q-426, bundle-45) along the seam of the question it answers, as the scanner types were (Q-390),
 * and re-exported there, so every importer keeps importing them from `types.ts`.
 */
import type { AuthorRef } from './types.js';

export interface ConflictDoc {
  _id: string;
  spaceId: string;
  /** Absent on every row written before metadata conflicts existed: a conflict is a COPY of a file unless it says `'metadata'` (`MetadataConflictDoc`). */
  kind?: 'copy';
  originalPath: string;   // relative path of the local file (version kept)
  conflictPath: string;   // relative path of the conflict copy (incoming version renamed)
  peerInstanceId: string;
  peerInstanceLabel: string;
  detectedAt: string;     // ISO8601
}

/**
 * The authored metadata of a file row that LOST an equal-seq tie (Q-426): what `sync/metadata-conflict.ts` keeps of the stored row the arriving copy
 * displaced. Exactly the authored half the space hash sees (`FILE_HASH_PROJECTION`), minus what names the row.
 */
export interface LosingFileMetadata {
  description?: string;
  descriptionSource?: string;
  tags?: string[];
  properties?: Record<string, string | number | boolean>;
  suppressEmbeddings?: boolean;
  author?: AuthorRef;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A file's metadata that lost an equal-seq tie to the copy a peer delivered (Q-426), kept on THIS instance for its user to decide. Local, never replicated,
 * and in the same collection as the file-copy conflicts: a different record kind of one capability, so the listing, the resolution and the rights are one.
 * The id derives from the file, the seq and the hash of what lost, so a re-delivery writes no second one.
 */
export interface MetadataConflictDoc {
  _id: string;
  spaceId: string;
  kind: 'metadata';
  /** The file's row id (its path): what the stored row is under. There is no copy of the file, so no `conflictPath`. */
  originalPath: string;
  losing: LosingFileMetadata;
  /** The version both copies shared. */
  seq: number;
  peerInstanceId: string;
  peerInstanceLabel: string;
  detectedAt: string;     // ISO8601
}

/** Any record of a space's `conflicts` collection. */
export type AnyConflictDoc = ConflictDoc | MetadataConflictDoc;
