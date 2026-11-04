/**
 * Image embedding pipeline.
 *
 * Strategy: call the vision provider to generate a text caption, then embed
 * the caption with `nomic-embed-text-v1.5`.  The result is one chunk record
 * on the {spaceId}_files collection with `derivedText` = caption.
 */

import { authorRef } from '../../config/author.js';
import { chunkVectorsFor } from '../chunk-vectors.js';
import { embedTextForProducer } from '../../brain/embed-text.js';
import { getMediaEmbeddingConfig, getFaceRecognitionConfig } from '../../config/loader.js';
import { log } from '../../util/log.js';
import type { FileMetaDoc } from '../../config/types.js';
import type { VisionProvider } from './providers.js';
import { upsertDerivedFileRow } from '../derived-fields.js';
import type { PlaintextFile } from '../plaintext-file.js';
import { isAbandonment, stopIfLeaseLost } from './lease.js';
import { IMAGE_STEPS, type MediaRunOpts } from './progress.js';
import { col, asFilter } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { NOT_A_FLAGGED_ROW } from '../live-file-row.js';

/** What an image run carries beyond every media run's options: read from its job by the worker. */
export interface ImageRunOpts {
  /** The job's {@link MediaJobDoc.arrival}: the caption is made either way, the face analysis follows {@link facesAreWithheldFor}. */
  arrival?: boolean;
  /** A deferred job's re-run (`job-queue.ts: deferJob`): the stored caption is reused when its row is there. */
  facesOnly?: boolean;
  /** False once the job's deferral cap is spent: a face the gallery cannot match yet is stored matched to no one by the gallery, a label it already had is kept (`embedFaces`). */
  galleryMayDefer?: boolean;
}


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
 * `opts` carries the job's {@link ImageRunOpts}: an arrival's faces follow {@link facesAreWithheldFor}, and a deferred job's re-run
 * (`facesOnly`) reuses the caption its first run stored instead of calling the vision model again.
 *
 * **Every hop beats at its entry and checks the lease before it spends a model budget**: a caption hop that outlasts the stall
 * threshold used to leave the job silent, stall recovery took it, and the run met its own fence at the first write after the recovery.
 * **Abandonment is never absorbed**: a write that found the claim gone (or the space not writable) ends the run as abandoned, whatever
 * hop it is made in — the face catch below absorbs a face FAILURE, never the loss of the claim.
 */
export async function embedImage(
  spaceId: string,
  fileId: string,
  /**
   * The file's PLAINTEXT, as a path and a size (`files/plaintext-file.ts`) — never its bytes (`Q-425`).
   *
   * The caption call is the only thing here that needs the image at all, and it streams it: from a `Buffer` the body
   * cost the file four times over (in memory, as base64, as JSON, and again at the fetch encode) before the provider
   * saw a byte. The face step reads the same path.
   */
  image: PlaintextFile,
  mimeType: string,
  vision: VisionProvider,
  opts: MediaRunOpts & ImageRunOpts,
): Promise<string> {
  const beat = (step: typeof IMAGE_STEPS[number]): void => opts.onProgress?.({ step, steps: [...(opts.steps ?? IMAGE_STEPS)] });
  const chunkId = `${fileId}#media-chunk0`;
  beat('caption');
  stopIfLeaseLost(spaceId, opts);
  const stored = opts.facesOnly ? await storedCaption(spaceId, chunkId) : null;
  const caption = stored ?? await captionAndStore(spaceId, fileId, chunkId, image, mimeType, vision, opts);

  // Face recognition — run after the caption chunk is stored so the job can
  // still complete if face detection fails. Non-fatal.
  const mediaCfg = getMediaEmbeddingConfig();
  if (mediaCfg.faceRecognition?.enabled && !facesAreWithheldFor(opts.arrival === true)) {
    const { embedFaces, GalleryIncompleteError } = await import('./face-embedder.js');
    beat('faces');
    stopIfLeaseLost(spaceId, opts);
    await embedFaces(spaceId, fileId, image, opts).catch((err: unknown) => {
      // Two failures must NOT be absorbed. The gallery could not answer: absorbing it writes the face unlabelled for
      // good, so it is rethrown and the worker defers the job (`deferJob`, no attempt spent; its re-run skips the caption
      // stored above). And an ABANDONMENT — the claim is gone or the space is no longer writable: it is not a face that failed,
      // and absorbing it let the run go on writing for a file that is not its.
      if (err instanceof GalleryIncompleteError || isAbandonment(err)) throw err;
      log.warn(`Face recogniser: embedFaces failed for ${spaceId}/${fileId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return caption;
}

/**
 * The caption a deferred run's first attempt stored, or `null` when there is none to reuse (Q-327).
 *
 * A deferred image job re-runs for its faces (`job-queue.ts: deferJob`), possibly many times while a face index rebuilds, and the caption
 * is a vision model call per run per photo. Reused only when its row is there: the flag skips work that is done, never work that is owed.
 */
async function storedCaption(spaceId: string, chunkId: string): Promise<string | null> {
  const row = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .findOne(asFilter<FileMetaDoc>({ _id: chunkId, ...NOT_A_FLAGGED_ROW }), { projection: { content: 1 } }) as { content?: unknown } | null;
  return typeof row?.content === 'string' && row.content.trim().length > 0 ? row.content : null;
}

/** Caption the image with the vision model and store it as the file's caption row; the caption. */
async function captionAndStore(
  spaceId: string,
  fileId: string,
  chunkId: string,
  image: PlaintextFile,
  mimeType: string,
  vision: VisionProvider,
  opts: MediaRunOpts,
): Promise<string> {
  // Asked ONCE for the job, at its entry. A suppressed file (or an image extracted from a suppressed document) keeps its
  // caption as text and holds no vector; the embedder is asked nothing (Q-255).
  const vectors = await chunkVectorsFor(spaceId, fileId);
  const caption = await vision.caption({ path: image.path, size: image.size }, mimeType);

  // Hard guard: embedding input MUST be a string — never a raw vector
  if (typeof caption !== 'string' || caption.trim().length === 0) {
    throw new Error('Vision provider returned a non-string or empty caption; refusing to embed');
  }

  // The ONE builder's text (a caption over the embedder's ceiling is cut), which `matchedText` is exactly; `content` keeps the whole caption.
  const embedded = embedTextForProducer(null, caption, 'media');
  const vectorFields = await vectors.fieldsFor(embedded);
  const now = new Date().toISOString();

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
    matchedText: embedded,
    ...vectorFields,
  };

  // Upsert: a retry may re-run this after a partial failure. Through the one writer of a derived row, which reads the
  // PARENT first: a caption written after the file was deleted is an orphan row nothing removes, and the upsert is why
  // the check cannot be a predicate in the filter — a non-matching filter on an upsert inserts.
  await upsertDerivedFileRow(spaceId, opts.claim, chunkDoc);
  return caption;
}
