/**
 * Conversion pipeline orchestration.
 *
 * Exports:
 *   resolveInputFormat(filePath, mimeType?, inputFormat?) → ResolvedFormat
 *   runConversionPipeline(fileBytes, filePath, format, opts) → ConversionResult
 *   storeConversionResults(spaceId, originalFilePath, chunks, convertedMarkdown) → { chunkCount, convertedFileId }
 *   deleteConversionArtifacts(spaceId, originalFilePath) → void
 */

import path from 'path';
import { toDocId } from '../../util/paths.js';
import { escapeRegex } from '../../util/redos.js';
import { authorRef } from '../../config/author.js';
import fs from 'fs/promises';
import { UnstructuredConverter } from './unstructured.js';
import type { ExtractedImage } from './unstructured.js';
import { HtmlConverter } from './html.js';
import { MarkdownPassthrough, PlainTextPassthrough } from './passthrough.js';
import { normaliseMarkdown } from './normaliser.js';
import { sectionChunk } from './section-chunker.js';
import { paragraphChunk } from './paragraph-chunker.js';
import type { Chunk } from './types.js';
import { ConversionUnavailableError } from './types.js';
import { writeFile, writeFileBytes } from '../files.js';
import { resolveSafePathChecked } from '../sandbox.js';
import { col, asFilter, asDoc } from '../../db/mongo.js';
import { embed } from '../../brain/embedding.js';
import { getConfig, getDocumentProcessingConfig, getEmbeddingConfig } from '../../config/loader.js';
import { vlmExtractDocument } from './vlm-extract.js';
import type { FileMetaDoc, DocExtractionMode, TextLevel } from '../../config/types.js';
import type { StepProgress } from './types.js';
import { log } from '../../util/log.js';
import { enqueueMediaJob } from '../media/job-queue.js';
import { embedConcurrency } from './embed-concurrency.js';
import { JobLeaseLostError, shouldHeartbeat } from '../media/lease.js';
import { embedChunksTotal } from '../../metrics/registry.js';
import { spaceCollection } from '../../db/space-collection.js';

export type InputFormat = 'pdf' | 'docx' | 'epub' | 'html' | 'md' | 'txt' | 'text' | 'auto';

/** The resolved, concrete format used for dispatching. */
export type ResolvedFormat = 'pdf' | 'docx' | 'epub' | 'html' | 'md' | 'txt' | 'text' | 'image' | 'audio' | 'video';

/** The set of resolved formats that represent binary media files (handled by the async media pipeline). */
export const MEDIA_FORMATS = new Set<ResolvedFormat>(['image', 'audio', 'video']);

export function isMediaFormat(fmt: ResolvedFormat): fmt is 'image' | 'audio' | 'video' {
  return MEDIA_FORMATS.has(fmt);
}


const EXT_MAP: Record<string, ResolvedFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.epub': 'epub',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  // Images
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.bmp': 'image',
  '.tiff': 'image',
  '.tif': 'image',
  // Audio
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  // Video
  '.mp4': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.ogv': 'video',
};

const MIME_MAP: Record<string, ResolvedFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/epub+zip': 'epub',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
};

// MIME type prefix → media format (checked separately since Map iteration order is not guaranteed for prefixes)
const MIME_PREFIX_MAP: Array<[string, 'image' | 'audio' | 'video']> = [
  ['image/', 'image'],
  ['audio/', 'audio'],
  ['video/', 'video'],
];

/** Resolve the input format to a concrete format. */
export function resolveInputFormat(
  filePath: string,
  mimeType?: string,
  inputFormat?: string,
): ResolvedFormat {
  const declared = (inputFormat ?? 'auto') as InputFormat;

  if (declared !== 'auto') {
    return declared === 'text' ? 'text' :
           declared === 'pdf' ? 'pdf' :
           declared === 'docx' ? 'docx' :
           declared === 'epub' ? 'epub' :
           declared === 'html' ? 'html' :
           declared === 'md' ? 'md' :
           declared === 'txt' ? 'txt' : 'text';
  }

  // Auto-detect from MIME type first, then extension
  if (mimeType) {
    const base = mimeType.split(';')[0]?.trim() ?? '';
    if (MIME_MAP[base]) return MIME_MAP[base]!;
    // Check MIME prefix for media types (image/*, audio/*, video/*)
    for (const [prefix, fmt] of MIME_PREFIX_MAP) {
      if (base.startsWith(prefix)) return fmt;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  if (EXT_MAP[ext]) return EXT_MAP[ext]!;

  return 'text'; // fallback: no conversion
}

export interface ConversionPipelineOptions {
  minChunkBodyLength?: number;
  maxParagraphChunkLength?: number;
  /** F11-c: per-space document-extraction mode override. When set, it wins over the instance-wide
   *  `documentProcessing.mode`; when absent, the instance default applies. */
  mode?: DocExtractionMode;
  /** Per-space text level. Governs what happens to the text that comes OUT of conversion, which is a
   *  separate question from how the document was read: `chunk` splits it into passages, `embed`
   *  keeps it whole, `off` indexes nothing. Absent = the instance level applies. */
  textLevel?: TextLevel;
  /** Called as each unit of work completes, so a long conversion reads as slow rather than wedged.
   *  The worker uses it to advance the job's stall heartbeat. */
  onProgress?: (p: StepProgress) => void;
}

export interface ConversionResult {
  chunks: Chunk[];
  convertedMarkdown: string | null; // null for md/txt (source IS the markdown)
  extractedImages: ExtractedImage[];  // populated for pdf/docx/epub when hi_res extraction is on
  extractionPath?: string;            // F11: which extraction path ran (ocr / ocr+vlm / ocr+vlm→ocr / …)
}

/**
 * Run the conversion pipeline for a file:
 *  1. Convert to Markdown (or passthrough)
 *  2. Normalise
 *  3. Chunk
 *  Returns the produced chunks and the full converted Markdown (null for md/txt).
 */
// Conversion runs in-process (jsdom for HTML) or ships the whole file to the
// sidecar — an unbounded input pins CPU/RAM for the duration. Documents over
// the cap are rejected up front with reason 'too_large' (never retried).
const DEFAULT_MAX_CONVERSION_BYTES = 100 * 1024 * 1024;

/**
 * Turn converted text into the units that get embedded, per the space's text level.
 *
 *   off    nothing — the file is stored and its content is never findable by search
 *   embed  ONE unit for the whole document: cheaper, and enough to find the FILE
 *   chunk  a unit per section/paragraph: finds the PASSAGE, which is what makes a recall quotable
 *   auto   as much as possible, i.e. chunk
 *
 * `embed` is not a degraded `chunk` — it is a real trade. One vector per document costs a fraction
 * of the storage and index time, and for a space full of short notes it loses almost nothing. It
 * matters for long documents, where a single averaged vector answers "which file mentions this?" but
 * can no longer answer "where does it say that?".
 */
function chunkForLevel(normalised: string, format: ResolvedFormat, opts: ConversionPipelineOptions): Chunk[] {
  const level = opts.textLevel ?? 'auto';
  if (level === 'off') return [];
  if (level === 'embed') {
    // Whole document as a single unit. An empty body would produce a vector of nothing, so treat it
    // as having no content rather than storing an embedding that matches everything weakly.
    return normalised.trim() ? [{ headingText: null, content: normalised, chunkIndex: 0 }] : [];
  }
  return format === 'txt'
    ? paragraphChunk(normalised, { maxChunkLength: opts.maxParagraphChunkLength })
    : sectionChunk(normalised, { minBodyLength: opts.minChunkBodyLength });
}

export async function runConversionPipeline(
  fileBytes: Buffer,
  filePath: string,
  format: ResolvedFormat,
  opts: ConversionPipelineOptions = {},
): Promise<ConversionResult> {
  const fileName = path.basename(filePath);
  let markdown: string;
  let convertedMarkdown: string | null = null;

  if (format !== 'text' && !isMediaFormat(format)) {
    const cap = getConfig().maxDocumentConversionBytes ?? DEFAULT_MAX_CONVERSION_BYTES;
    if (fileBytes.length > cap) {
      throw new ConversionUnavailableError(
        'too_large',
        `Document is ${fileBytes.length} bytes; conversion is capped at ${cap} bytes`,
      );
    }
  }

  switch (format) {
    case 'text':
      // Bypass: caller handles single-record storage
      return { chunks: [], convertedMarkdown: null, extractedImages: [] };

    case 'image':
    case 'audio':
    case 'video':
      // Media formats are handled by the async media embedding pipeline, not here
      return { chunks: [], convertedMarkdown: null, extractedImages: [] };

    case 'md': {
      const conv = new MarkdownPassthrough();
      markdown = await conv.convert(fileBytes, fileName);
      // No _converted/ copy needed
      break;
    }

    case 'txt': {
      const conv = new PlainTextPassthrough();
      markdown = await conv.convert(fileBytes, fileName);
      break;
    }

    case 'html': {
      const conv = new HtmlConverter();
      markdown = await conv.convert(fileBytes, fileName);
      convertedMarkdown = markdown;
      break;
    }

    case 'pdf':
    case 'docx':
    case 'epub': {
      // F11: `ocr` mode (default) is the unchanged path; `vlm`/`auto`/`max` run the capability extractor,
      // which itself falls back to OCR when render/VLM are absent or the VLM output fails validation.
      // F11-c: a per-space override (opts.mode) wins over the instance-wide default.
      const mode = opts.mode ?? getDocumentProcessingConfig().mode;
      let extractionPath: string | undefined;
      let richMarkdown: string;
      let images = [] as ExtractedImage[];
      if (mode === 'ocr') {
        const result = await new UnstructuredConverter().convertRich(fileBytes, fileName);
        richMarkdown = result.markdown;
        images = result.extractedImages;
      } else {
        const result = await vlmExtractDocument(fileBytes, fileName, mode, opts.onProgress);
        richMarkdown = result.markdown;
        images = result.extractedImages;
        extractionPath = result.extractionPath;
      }
      return {
        chunks: chunkForLevel(normaliseMarkdown(richMarkdown), format, opts),
        convertedMarkdown: richMarkdown,
        extractedImages: images,
        ...(extractionPath ? { extractionPath } : {}),
      };
    }
  }

  const normalised = normaliseMarkdown(markdown);
  const chunks = chunkForLevel(normalised, format, opts);

  return { chunks, convertedMarkdown, extractedImages: [] };
}


/**
 * Store a converted file's chunk records in the {spaceId}_files collection.
 * Each chunk gets its own record with a per-chunk embedding.
 * Extracted images (from hi_res PDF/DOCX/EPUB conversion) are written as
 * `_extracted/{originalId}/image-{N}.{ext}` subfiles and enqueued for the
 * full media pipeline (caption + face recognition).
 *
 * @param spaceId           Space ID
 * @param originalFilePath  Relative path of the original file (its _id in filemeta)
 * @param chunks            Chunk array from the pipeline
 * @param convertedMarkdown If not null, write to _converted/<originalFileId>.md and return its path
 * @param extractedImages   Embedded images extracted during hi_res conversion
 * @returns object with chunkCount and optional convertedFileId
 */
export async function storeConversionResults(
  spaceId: string,
  originalFilePath: string,
  chunks: Chunk[],
  convertedMarkdown: string | null,
  extractedImages: ExtractedImage[] = [],
  /**
   * Progress + lease, for the phase that takes the longest and reported neither.
   *
   * Conversion heartbeats per page; embedding did not heartbeat at all, so on a document with more than
   * `stalledJobTimeoutMs` worth of chunks the queue concluded the job was wedged and re-queued it while it
   * was still running. `onProgress` is what stops that, and `shouldStop` is what makes the *loser* of a
   * recovery stop instead of racing the new claimant.
   */
  opts: {
    onProgress?: (p: StepProgress) => void;
    /** Checked between chunks; true means the claim is gone and this run throws `JobLeaseLostError`. */
    shouldStop?: () => boolean;
  } = {},
): Promise<{ chunkCount: number; convertedFileId: string | null; embedFailures: number }> {
  const originalId = toDocId(originalFilePath);
  const now = new Date().toISOString();
  let embedFailures = 0;

  // 1. Write the full converted Markdown to disk (binary formats only)
  let convertedFileId: string | null = null;
  if (convertedMarkdown !== null) {
    const convertedPath = `_converted/${originalId}.md`;
    await writeFile(spaceId, convertedPath, convertedMarkdown);
    convertedFileId = toDocId(convertedPath);

    // Insert a minimal filemeta record for the converted file so it's discoverable
    const convertedSizeBytes = Buffer.byteLength(convertedMarkdown, 'utf8');
    const convertedDoc: FileMetaDoc = {
      _id: convertedFileId,
      spaceId,
      path: convertedFileId,
      tags: [],
      createdAt: now,
      updatedAt: now,
      sizeBytes: convertedSizeBytes,
      author: authorRef(),
      parentFileId: originalId,
    };
    await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).insertOne(asDoc<FileMetaDoc>(convertedDoc));
  }

  // 2. Write extracted image subfiles and enqueue for media pipeline.
  // Bounded: a crafted document can embed thousands of images — cap the count
  // and the aggregate decoded size so conversion cannot flood storage.
  const MAX_EXTRACTED_IMAGES = 50;
  const MAX_EXTRACTED_IMAGE_BYTES = 100 * 1024 * 1024;
  if (extractedImages.length > MAX_EXTRACTED_IMAGES) {
    log.warn(`Conversion of ${spaceId}/${originalId} extracted ${extractedImages.length} images; storing only the first ${MAX_EXTRACTED_IMAGES}`);
    extractedImages = extractedImages.slice(0, MAX_EXTRACTED_IMAGES);
  }
  let extractedBytesTotal = 0;
  if (extractedImages.length > 0) {
    for (const img of extractedImages) {
      const imgPath = `_extracted/${originalId}/image-${img.index}.${img.ext}`;
      const imgId = toDocId(imgPath);
      try {
        const imgBytes = Buffer.from(img.base64, 'base64');
        if (extractedBytesTotal + imgBytes.length > MAX_EXTRACTED_IMAGE_BYTES) {
          log.warn(`Extracted-image size budget (${MAX_EXTRACTED_IMAGE_BYTES} bytes) reached for ${spaceId}/${originalId}; skipping remaining images`);
          break;
        }
        extractedBytesTotal += imgBytes.length;
        await writeFileBytes(spaceId, imgPath, imgBytes);

        const imgDoc: FileMetaDoc = {
          _id: imgId,
          spaceId,
          path: imgId,
          tags: [],
          createdAt: now,
          updatedAt: now,
          sizeBytes: imgBytes.length,
          author: authorRef(),
          parentFileId: originalId,
        };
        await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).insertOne(asDoc<FileMetaDoc>(imgDoc));

        // Enqueue for media pipeline (caption + face recognition)
        const mimeType = `image/${img.ext === 'jpg' ? 'jpeg' : img.ext}`;
        await enqueueMediaJob(spaceId, imgPath, mimeType, 'image');
      } catch (err) {
        // Non-fatal: log and continue; other images and chunks still processed
        log.warn(`Failed to store extracted image ${imgId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log.info(`Stored ${extractedImages.length} extracted image(s) from ${spaceId}/${originalId}`);
  }

  // 3. Embed and insert chunk records.
  //
  // This used to embed ONE chunk at a time and insertOne() each — a 500-chunk PDF meant 1000
  // sequential awaits, and the embed call dominates. Chunks are independent, so they are now
  // embedded with bounded concurrency and inserted with insertMany.
  //
  // Concurrency is bounded rather than unbounded: a large document would otherwise fire
  // hundreds of simultaneous requests at the embedding provider (or at the bundled ONNX
  // model), which throttles or OOMs rather than going faster.
  //
  // Per-chunk failure isolation is preserved (B3): one chunk failing to embed must not poison
  // the batch. It is still stored WITHOUT a vector — its text is preserved but it is invisible
  // to $vectorSearch — and counted, so the caller reports the job as partial/failed rather
  // than silently "complete".
  // Sized per embedder, because the two are different problems: an external endpoint is network-bound and
  // wants sockets in flight, while the bundled in-process model is CPU-bound and eight at once simply
  // saturates the machine. Measured: one in-process chunk embed blocks the event loop for ~200 ms, so eight
  // concurrent ones on a small CPU allocation leave nothing for the thread that answers /health — which is
  // how a 358 KB document turned into a liveness-probe crash loop with no error anywhere.
  const EMBED_CONCURRENCY = embedConcurrency(getEmbeddingConfig());
  const INSERT_BATCH = 200;

  const chunkDocs: FileMetaDoc[] = new Array(chunks.length);

  // Heartbeat bookkeeping for this phase. `embedded` counts finished chunks across all workers, so the
  // report is the document's progress rather than one worker's.
  const EMBED_STEPS = ['embed'];
  let embedded = 0;
  let lastBeatAt = Date.now();
  function reportChunk(): void {
    embedded++;
    // Motion, in a form a dashboard can rate(). Unthrottled on purpose: the heartbeat below is a database
    // write and this is an in-process increment, and it is the counter that distinguishes slow from stuck.
    embedChunksTotal.labels({ space: spaceId }).inc();
    const isLast = embedded === chunks.length;
    if (!opts.onProgress || !shouldHeartbeat(lastBeatAt, Date.now(), isLast)) return;
    lastBeatAt = Date.now();
    opts.onProgress({ step: 'embed', steps: EMBED_STEPS, done: embedded, total: chunks.length });
  }

  let cursor = 0;
  async function embedWorker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= chunks.length) return;
      const chunk = chunks[i]!;
      const chunkId = `${originalId}#chunk${chunk.chunkIndex}`;
      const embedText = chunk.headingText
        ? `${chunk.headingText} ${chunk.content}`
        : chunk.content;

      let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText?: string } = {};
      try {
        const embResult = await embed(embedText);
        embeddingFields = {
          embedding: embResult.vector,
          embeddingModel: embResult.model,
          matchedText: embedText,
        };
      } catch (err) {
        embedFailures++;
        log.warn(`Chunk embed failed for ${spaceId}/${chunkId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Hand the event loop a turn between chunks.
      //
      // An in-process embed blocks it for ~200 ms (measured), and a large document is hundreds of them
      // back to back. `await` on a promise that is already settled does NOT yield to the macrotask queue —
      // it resumes in the same tick's microtask drain — so without this, pending I/O callbacks (the ones
      // that answer /health) can sit behind the whole run. `setImmediate` puts this worker behind them
      // instead. Cheap: one macrotask per chunk against ~200 ms of work.
      await new Promise<void>(resolve => setImmediate(resolve));

      // Say so, and check we are still the run that is allowed to. Both ride on the same tick: the
      // heartbeat is throttled to one write per 2 s, and the lease answer it returns is what `shouldStop`
      // reports here. A recovered job's old holder stops within a beat instead of embedding the same file
      // alongside its replacement.
      reportChunk();
      if (opts.shouldStop?.()) throw new JobLeaseLostError(spaceId, originalId);

      chunkDocs[i] = {
        _id: chunkId,
        spaceId,
        path: chunkId,
        tags: [],
        createdAt: now,
        updatedAt: now,
        sizeBytes: Buffer.byteLength(chunk.content, 'utf8'),
        author: authorRef(),
        parentFileId: originalId,
        chunkIndex: chunk.chunkIndex,
        headingText: chunk.headingText,
        content: chunk.content,
        ...embeddingFields,
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(EMBED_CONCURRENCY, chunks.length) }, () => embedWorker()),
  );

  for (let i = 0; i < chunkDocs.length; i += INSERT_BATCH) {
    const batch = chunkDocs.slice(i, i + INSERT_BATCH);
    if (batch.length === 0) continue;
    // ordered:false — one duplicate/invalid chunk must not abort the rest of the batch.
    await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
      .insertMany(batch.map(d => asDoc<FileMetaDoc>(d)), { ordered: false });
  }

  return { chunkCount: chunks.length, convertedFileId, embedFailures };
}

/** Best-effort recursive delete of a space-relative path. Never throws (missing = success). */
async function rmArtifactPath(spaceId: string, relPath: string): Promise<void> {
  try {
    const abs = await resolveSafePathChecked(spaceId, relPath);
    await fs.rm(abs, { recursive: true, force: true });
  } catch (err) {
    log.warn(`Failed to remove conversion artifact path ${spaceId}/${relPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Delete every conversion artifact belonging to a single original file:
 * its chunk / `_converted/` / `_extracted/` filemeta records AND the mirrored
 * on-disk sidecar files (`_converted/<id>.md`, `_extracted/<id>/`).
 */
export async function deleteConversionArtifacts(
  spaceId: string,
  originalFilePath: string,
): Promise<void> {
  const originalId = toDocId(originalFilePath);

  // DB: all filemeta records with parentFileId = originalId (chunks, converted, extracted).
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).deleteMany(
    asFilter<FileMetaDoc>({ parentFileId: originalId }),
  );

  // Disk: the sidecar files those records described. deleteMany above does not touch disk,
  // so without this the `_converted/`/`_extracted/` trees would be orphaned on the filesystem.
  await rmArtifactPath(spaceId, `_converted/${originalId}.md`);
  await rmArtifactPath(spaceId, `_extracted/${originalId}`);

  log.info(`Deleted conversion artifacts for ${spaceId}/${originalId}`);
}

/**
 * Delete conversion artifacts for EVERY original file under `dirPath/` — used
 * when a directory is deleted recursively. The sidecar records/files live under
 * the separate `_converted/<path>` and `_extracted/<path>` top-level prefixes,
 * so a `<dirPath>/`-only cleanup (deleteFileMetaByPrefix + fs.rm) leaves them
 * orphaned; this removes them by parent-path prefix and clears the sidecar trees.
 */
export async function deleteConversionArtifactsByPrefix(
  spaceId: string,
  dirPath: string,
): Promise<void> {
  const dir = toDocId(dirPath).replace(/\/?$/, '');
  if (!dir) return; // guard: empty path would match everything
  const escaped = escapeRegex(dir + '/');

  // DB: every child record whose parent lived under the folder.
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).deleteMany(
    asFilter<FileMetaDoc>({ parentFileId: { $regex: `^${escaped}` } }),
  );

  // Disk: the mirrored sidecar subtrees.
  await rmArtifactPath(spaceId, `_converted/${dir}`);
  await rmArtifactPath(spaceId, `_extracted/${dir}`);

  log.info(`Deleted conversion artifacts under ${spaceId}/${dir}/`);
}
