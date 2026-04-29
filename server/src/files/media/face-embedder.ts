/**
 * Face recognition pipeline.
 *
 * Uses @vladmandic/human with the CPU backend (pure JavaScript, no GPU, no
 * native TensorFlow bindings, no WASM file path configuration).
 * Model: BlazeFace Back (detection) + FaceRes (128d face descriptor).
 *
 * Pipeline per image:
 *  1. Decode image bytes via sharp → raw RGBA pixel data + dimensions
 *  2. Create tf.Tensor3D via human.tf (bundled TF.js) from pixel data
 *  3. human.detect() → per-face {embedding (128d), boxRaw (normalised bbox)}
 *  4. For each detected face with a valid embedding:
 *     a. Gallery search: $vectorSearch (exact) on faceEmbedding index, post-
 *        match for faceEntityId, top-1
 *     b. If score >= confidenceThreshold → auto-label: set faceEntityId on
 *        the chunk, update parent FileMetaDoc.entityIds
 *     c. Upsert face-chunk record ({fileId}#face-chunk{i}) with parentFileId,
 *        faceEmbedding, faceBbox, optionally faceEntityId + faceScore
 *
 * Model files (NOT bundled — must be placed manually):
 *   DATA_ROOT/<modelPath>/blazeface-back.json + .bin  (~0.5 MB, detection)
 *   DATA_ROOT/<modelPath>/faceres.json + .bin          (~6.7 MB, 128d embed)
 *
 * Download from:
 *   https://vladmandic.github.io/human/models/blazeface-back.json
 *   https://vladmandic.github.io/human/models/blazeface-back.bin
 *   https://vladmandic.github.io/human/models/faceres.json
 *   https://vladmandic.github.io/human/models/faceres.bin
 */

import path from 'path';
import sharp from 'sharp';
import { col, mDoc, mFilter } from '../../db/mongo.js';
import { getConfig, getDataRoot, getFaceRecognitionConfig } from '../../config/loader.js';
import { updateFileMeta } from '../file-meta.js';
import { log } from '../../util/log.js';
import type { FileMetaDoc, AuthorRef } from '../../config/types.js';
import type { Config as HumanConfig, Result } from '@vladmandic/human';

// ── Singleton Human instance (lazy init) ──────────────────────────────────

type HumanInstance = {
  tf: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  load(): Promise<void>;
  detect(input: unknown): Promise<Result>;
};

let _human: HumanInstance | null = null;
// serialise concurrent initialisations — only one load() runs at a time
let _humanLoading: Promise<HumanInstance> | null = null;

async function getHuman(): Promise<HumanInstance> {
  if (_human) return _human;
  if (_humanLoading) return _humanLoading;

  _humanLoading = (async (): Promise<HumanInstance> => {
    const faceCfg = getFaceRecognitionConfig();
    const modelDir = path.resolve(getDataRoot(), faceCfg.modelPath);
    // file:// URI with trailing slash — required by human's TF.js model loader
    const modelBasePath = `file://${modelDir.replace(/\\/g, '/')}/`;

    // Dynamic import: resolves to human.node.js (exports["node"] condition)
    // — includes TF.js cpu + wasm + tensorflow backends in one bundle.
    const { default: Human } = await import('@vladmandic/human');

    const humanCfg: Partial<HumanConfig> = {
      debug: false,
      async: true,
      // CPU backend: pure JavaScript TF.js, zero native deps, no WASM file paths.
      // Sufficient for a background processing job.
      backend: 'cpu',
      modelBasePath,
      cacheModels: true,
      cacheSensitivity: 0, // always use the cached model — no live-input drift check
      warmup: 'none',
      face: {
        enabled: true,
        detector: {
          modelPath: 'blazeface-back.json',
          rotation: false,     // skip rotation for speed — photos are typically upright
          maxDetected: 20,
          minConfidence: 0.3,
          iouThreshold: 0.1,
          return: false,
        },
        mesh: { enabled: false },
        attention: { enabled: false },
        iris: { enabled: false },
        description: {
          enabled: true,
          modelPath: 'faceres.json', // FaceRes — 128d descriptor; age/gender computed here too
          minConfidence: 0.0,
          skipFrames: 0,
        },
        emotion: { enabled: false },
        antispoof: { enabled: false },
        liveness: { enabled: false },
      },
      hand: { enabled: false },
      body: { enabled: false },
      gesture: { enabled: false },
      object: { enabled: false },
      segmentation: { enabled: false },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = new (Human as any)(humanCfg) as HumanInstance;
    log.info('Face recogniser: loading models…');
    await instance.load();
    log.info('Face recogniser: models loaded');
    _human = instance;
    return instance;
  })();

  try {
    return await _humanLoading;
  } catch (err) {
    // Allow retry on next call if init failed
    _humanLoading = null;
    throw err;
  }
}

// ── Gallery search ─────────────────────────────────────────────────────────

/**
 * Search the face gallery (labeled face-chunk records in the space) for the
 * closest match to the given 128d descriptor.
 *
 * Uses exact-mode $vectorSearch so all gallery entries are considered, then
 * a post-match filter for faceEntityId to restrict to labeled faces only.
 *
 * Returns { entityId, score } if the top match passes the threshold,
 * or null if the gallery is empty / no match meets the threshold.
 */
async function gallerySearch(
  spaceId: string,
  descriptor: number[],
  threshold: number,
): Promise<{ entityId: string; score: number } | null> {
  const indexName = `${spaceId}_files_faceEmbedding`;
  try {
    const pipeline: object[] = [
      {
        $vectorSearch: {
          index: indexName,
          path: 'faceEmbedding',
          queryVector: descriptor,
          // Exact (exhaustive) scan: the face-specific index only contains
          // face-chunk records, so this is efficient regardless of index size.
          // High limit ensures the best-scoring labeled face is within the
          // returned window even if unlabeled faces score higher.
          exact: true,
          limit: 1000,
        },
      },
      // Post-match for labeled faces only (doesn't require an index filter field)
      { $match: { faceEntityId: { $exists: true, $ne: null } } },
      { $addFields: { _score: { $meta: 'vectorSearchScore' } } },
      { $project: { _score: 1, faceEntityId: 1 } },
      { $limit: 1 },
    ];

    const results = await col<FileMetaDoc & { _score: number }>(`${spaceId}_files`)
      .aggregate(pipeline)
      .toArray();

    if (results.length === 0) return null;

    const top = results[0]!;
    if (typeof top._score !== 'number' || top._score < threshold) return null;
    if (!top.faceEntityId) return null;

    return { entityId: top.faceEntityId as string, score: top._score };
  } catch (err) {
    // The face index may not exist yet (feature just enabled, initSpace pending)
    log.debug(`Face gallery search failed for ${spaceId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

function authorRef(): AuthorRef {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/**
 * Detect all faces in an image and persist one face-chunk record per face.
 *
 * Called from embedImage() when config.mediaEmbedding.faceRecognition.enabled
 * is true.  Errors are non-fatal — the parent image job continues.
 *
 * @param spaceId  Space that owns the file
 * @param fileId   File _id (normalised path) — the parent FileMetaDoc
 * @param imageBytes  Raw image bytes (JPEG / PNG / WebP / etc.)
 */
export async function embedFaces(
  spaceId: string,
  fileId: string,
  imageBytes: Buffer,
): Promise<void> {
  const faceCfg = getFaceRecognitionConfig();

  let human: HumanInstance;
  try {
    human = await getHuman();
  } catch (err) {
    log.warn(
      `Face recogniser: failed to initialise (model files missing?): ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // ── 1. Decode image to raw RGBA ─────────────────────────────────────────
  let pixelData: Buffer;
  let width: number;
  let height: number;
  try {
    const result = await sharp(imageBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pixelData = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch (err) {
    log.warn(`Face recogniser: image decode failed for ${spaceId}/${fileId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const shorterSide = Math.min(width, height);
  const minFacePixels = shorterSide * faceCfg.minFaceSizeFraction;

  // ── 2. Create tensor + detect ────────────────────────────────────────────
  // human.tf is typed as `any` by @vladmandic/human — safe to use directly.
  const tensor = human.tf.tensor3d(new Uint8Array(pixelData), [height, width, 4], 'int32');
  let result: Result;
  try {
    result = await human.detect(tensor);
  } catch (err) {
    log.warn(`Face recogniser: detect() failed for ${spaceId}/${fileId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  } finally {
    // Always release the tensor — human does not dispose input tensors
    try { human.tf.dispose(tensor); } catch { /* ignore */ }
  }

  const faces = result.face;
  if (!faces || faces.length === 0) return;

  const now = new Date().toISOString();
  const author = authorRef();
  let autoLabelEntityId: string | undefined;

  // ── 3. Process each detected face ────────────────────────────────────────
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i]!;

    const embedding: number[] | undefined = face.embedding;
    if (!embedding || embedding.length !== 128) continue; // FaceRes not run / failed

    // Filter by minimum face size (fraction of shorter image side)
    const boxRaw = face.boxRaw; // [x, y, w, h] normalised 0–1
    if (boxRaw) {
      // Use the min of width/height fraction against the shorter image side
      const faceSizePx = Math.min(boxRaw[2], boxRaw[3]) * Math.max(width, height);
      if (faceSizePx < minFacePixels) continue;
    }

    // Gallery search — find the closest labeled face
    const match = await gallerySearch(spaceId, embedding, faceCfg.confidenceThreshold);

    const faceEntityId = match?.entityId;
    const faceScore = match?.score;

    // Track the first auto-label for the parent file update
    if (faceEntityId && !autoLabelEntityId) {
      autoLabelEntityId = faceEntityId;
    }

    // ── 4. Upsert face-chunk record ─────────────────────────────────────
    const chunkId = `${fileId}#face-chunk${i}`;
    const chunkDoc: Omit<FileMetaDoc, 'faceEntityId' | 'faceScore' | 'faceBbox'> & {
      faceEmbedding: number[];
      faceEntityId?: string;
      faceScore?: number;
      faceBbox?: [number, number, number, number];
    } = {
      _id: chunkId,
      spaceId,
      path: chunkId,
      tags: [],
      createdAt: now,
      updatedAt: now,
      sizeBytes: 128 * 4, // 128 × float32 = 512 bytes
      author,
      parentFileId: fileId,
      chunkIndex: i,
      faceEmbedding: Array.from(embedding),
      ...(faceEntityId !== undefined ? { faceEntityId } : {}),
      ...(faceScore !== undefined ? { faceScore } : {}),
      ...(boxRaw !== undefined ? { faceBbox: boxRaw as [number, number, number, number] } : {}),
    };

    await col<FileMetaDoc>(`${spaceId}_files`).replaceOne(
      mFilter<FileMetaDoc>({ _id: chunkId }),
      mDoc<FileMetaDoc>(chunkDoc as FileMetaDoc),
      { upsert: true },
    );
  }

  // ── 5. Auto-label parent file ───────────────────────────────────────────
  if (autoLabelEntityId) {
    try {
      const parent = await col<FileMetaDoc>(`${spaceId}_files`).findOne(
        mFilter<FileMetaDoc>({ _id: fileId }),
        { projection: { entityIds: 1 } },
      ) as FileMetaDoc | null;

      if (parent && !parent.entityIds?.includes(autoLabelEntityId)) {
        const existingIds = parent.entityIds ?? [];
        await updateFileMeta(spaceId, fileId, {
          entityIds: [...existingIds, autoLabelEntityId],
        });
        log.info(`Face recogniser: auto-labeled ${spaceId}/${fileId} → entity ${autoLabelEntityId}`);
      }
    } catch (err) {
      log.warn(
        `Face recogniser: auto-label failed for ${spaceId}/${fileId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Propagate a manual entity label to all existing face-chunk records of a file.
 *
 * Called from updateFileMeta() when entityIds changes so that face chunks
 * immediately enter the gallery and improve future auto-labeling accuracy.
 *
 * Uses the first entityId as the face identity (a face belongs to one person).
 */
export async function propagateFaceLabel(
  spaceId: string,
  fileId: string,
  entityId: string,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await col<FileMetaDoc>(`${spaceId}_files`).updateMany(
      mFilter<FileMetaDoc>({ parentFileId: fileId, faceEmbedding: { $exists: true } }),
      { $set: { faceEntityId: entityId, updatedAt: now } },
    );
  } catch (err) {
    log.warn(
      `Face recogniser: propagateFaceLabel failed for ${spaceId}/${fileId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
