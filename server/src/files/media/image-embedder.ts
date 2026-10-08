/**
 * Image embedding pipeline.
 *
 * Strategy: call the vision provider to generate a text caption, then embed
 * the caption with `nomic-embed-text-v1.5`.  The result is one chunk record
 * on the {spaceId}_files collection with `derivedText` = caption.
 */

import { authorRef } from '../../config/author.js';
import { chunkVectorsFor } from '../chunk-vectors.js';
import { getMediaEmbeddingConfig, getFaceRecognitionConfig } from '../../config/loader.js';
import { log } from '../../util/log.js';
import type { FileMetaDoc } from '../../config/types.js';
import type { VisionProvider } from './providers.js';
import { upsertDerivedFileRow } from '../derived-fields.js';


/**
 * May faces be analysed in this image? The one place `faceRecognition.reprocessSyncedImages` is applied to a media job.
 *
 * An image a peer delivered (`MediaJobDoc.arrival`) is analysed for faces only when the operator chose to build the gallery from
 * synced images; one written here always is, so a local upload is never touched by the setting. It answers for BOTH arrival
 * doors (the upload door and the manifest pull) because both queue their job through `files/bytes-arrived.ts`, and it is read
 * when the job runs, so a setting changed while the job waits is the one honoured. Without it the push door ignored the
 * setting altogether and only the pull's own re-enqueue obeyed it (bundle-48): a biometric step governed by which door a file
 * happened to come through.
 *
 * The label-triggered case (`files/file-meta.ts`, an image given a person entity) asks the same setting at its own trigger and
 * queues a job that is NOT an arrival; it is not decided here.
 */
export function facesAreWithheldFor(arrival: boolean): boolean {
  return arrival && !getFaceRecognitionConfig().reprocessSyncedImages;
}

/**
 * Generate caption + embedding for an image and store one chunk record.
 * Returns the derived caption text.
 *
 * `opts.arrival` is the job's {@link MediaJobDoc.arrival}: the caption is made either way, the face analysis follows
 * {@link facesAreWithheldFor}.
 */
export async function embedImage(
  spaceId: string,
  fileId: string,
  imageBytes: Buffer,
  mimeType: string,
  vision: VisionProvider,
  opts: { arrival?: boolean } = {},
): Promise<string> {
  // Asked ONCE for the job, at its entry. A suppressed file (or an image extracted from a suppressed document) keeps its
  // caption as text and holds no vector; the embedder is asked nothing (Q-255).
  const vectors = await chunkVectorsFor(spaceId, fileId);
  const caption = await vision.caption(imageBytes, mimeType);

  // Hard guard: embedding input MUST be a string — never a raw vector
  if (typeof caption !== 'string' || caption.trim().length === 0) {
    throw new Error('Vision provider returned a non-string or empty caption; refusing to embed');
  }

  const vectorFields = await vectors.fieldsFor(caption);
  const now = new Date().toISOString();
  const chunkId = `${fileId}#media-chunk0`;

  const chunkDoc: FileMetaDoc = {
    _id: chunkId,
    spaceId,
    path: chunkId,
    tags: [],
    createdAt: now,
    updatedAt: now,
    sizeBytes: Buffer.byteLength(caption, 'utf8'),
    author: authorRef(),
    parentFileId: fileId,
    chunkIndex: 0,
    // Store the caption text in `content` (parallel to text chunk records)
    content: caption,
    matchedText: caption,
    ...vectorFields,
  };

  // Upsert: a retry may re-run this after a partial failure. Through the one writer of a derived row, which reads the
  // PARENT first: a caption written after the file was deleted is an orphan row nothing removes, and the upsert is why
  // the check cannot be a predicate in the filter — a non-matching filter on an upsert inserts.
  await upsertDerivedFileRow(spaceId, chunkDoc);

  // Face recognition — run after the caption chunk is stored so the job can
  // still complete if face detection fails. Non-fatal.
  const mediaCfg = getMediaEmbeddingConfig();
  if (mediaCfg.faceRecognition?.enabled && !facesAreWithheldFor(opts.arrival === true)) {
    const { embedFaces, GalleryIncompleteError } = await import('./face-embedder.js');
    await embedFaces(spaceId, fileId, imageBytes).catch((err: unknown) => {
      // The one failure that must NOT be absorbed: the gallery could not answer, and absorbing it writes the
      // face unlabelled for good. Rethrown, the job retries like any other transient failure; the caption chunk
      // above is an upsert, so the retry rewrites it rather than duplicating it.
      if (err instanceof GalleryIncompleteError) throw err;
      log.warn(`Face recogniser: embedFaces failed for ${spaceId}/${fileId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return caption;
}
