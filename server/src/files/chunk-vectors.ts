/**
 * The vector fields of a FILE's derived passage (a conversion chunk, an image caption, an audio or video transcript segment),
 * unless the file is suppressed — one place that decides it, for every producer.
 *
 * ## What it prevents
 *
 * Four producers (the conversion pipeline and the image, audio and video embedders) each wrote the same step: ask whether the
 * file holds vectors, and if not, call the embedder and spread `embedding` and `embeddingModel` onto the chunk row. Written
 * four times, the guard was a line one copy could drop, and the first version of it was dropped in all four: a file the operator
 * had retired from meaning-ranked search kept a vector on every passage (`Q-255`), and because the caller then skips the queue,
 * nothing ever came back to remove it. Here the question is asked once per JOB, at the entry of {@link chunkVectorsFor}, and the
 * embedder is not even called for a suppressed file: no caller can store a vector without having asked, and none can ask per
 * segment (a read per passage).
 *
 * ## The rule
 *
 * `chunkVectorsFor(spaceId, fileId)` resolves suppression for the file ({@link storedFileEmbeddingSuppressed}: the file's own
 * flag, the space setting, and its ancestors — an image extracted from a suppressed document is suppressed with it; a file no
 * longer there counts as suppressed). `fieldsFor(text)` then answers the fields to spread onto the chunk row: `{}` for a
 * suppressed file, the vector and its model otherwise. An embed failure THROWS: the caller decides what a failed passage means
 * (the pipeline counts it and stores the text without a vector; a media job fails and retries), so this never returns empty where
 * it should throw. `suppressed` is exposed for the caller's own text-side choices (a suppressed file still keeps the text the
 * lexical channel searches) and is never a reason to skip the call to `fieldsFor`.
 */
import { embed } from '../brain/embedding.js';
import { storedFileEmbeddingSuppressed } from '../brain/suppress-embeddings.js';

/** What a chunk row takes from the embedder: both fields, or neither. */
export interface ChunkVectorFields {
  embedding?: number[];
  embeddingModel?: string;
}

export interface ChunkVectors {
  /** Whether the file holds no vectors (for the caller's text-side choices only). */
  readonly suppressed: boolean;
  /** The vector fields of one passage's text: `{}` when the file is suppressed, without calling the embedder. */
  fieldsFor(text: string): Promise<ChunkVectorFields>;
}

/** Resolve the file's suppression ONCE and hand back the producer of its passages' vector fields. */
export async function chunkVectorsFor(spaceId: string, fileId: string): Promise<ChunkVectors> {
  const suppressed = await storedFileEmbeddingSuppressed(spaceId, fileId);
  return {
    suppressed,
    async fieldsFor(text: string): Promise<ChunkVectorFields> {
      if (suppressed) return {};
      const result = await embed(text);
      return { embedding: result.vector, embeddingModel: result.model };
    },
  };
}
