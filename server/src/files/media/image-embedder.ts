/**
 * Image embedding pipeline.
 *
 * Strategy: call the vision provider to generate a text caption, then embed
 * the caption with `nomic-embed-text-v1.5`.  The result is one chunk record
 * on the {spaceId}_files collection with `derivedText` = caption.
 */

import { col, mDoc, mFilter } from '../../db/mongo.js';
import { embed } from '../../brain/embedding.js';
import { getConfig } from '../../config/loader.js';
import type { FileMetaDoc, AuthorRef } from '../../config/types.js';
import type { VisionProvider } from './providers.js';

function authorRef(): AuthorRef {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/**
 * Generate caption + embedding for an image and store one chunk record.
 * Returns the derived caption text.
 */
export async function embedImage(
  spaceId: string,
  fileId: string,
  imageBytes: Buffer,
  mimeType: string,
  vision: VisionProvider,
): Promise<string> {
  const caption = await vision.caption(imageBytes, mimeType);

  // Hard guard: embedding input MUST be a string — never a raw vector
  if (typeof caption !== 'string' || caption.trim().length === 0) {
    throw new Error('Vision provider returned a non-string or empty caption; refusing to embed');
  }

  const embResult = await embed(caption);
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
    embedding: embResult.vector,
    embeddingModel: embResult.model,
  };

  // Upsert: a retry may re-run this after a partial failure
  await col<FileMetaDoc>(`${spaceId}_files`).replaceOne(
    mFilter<FileMetaDoc>({ _id: chunkId }),
    mDoc<FileMetaDoc>(chunkDoc),
    { upsert: true },
  );

  return caption;
}
