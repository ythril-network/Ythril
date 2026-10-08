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
import { removeTree } from '../remove-tree.js';
import { bytesPresentAt } from '../stored-bytes.js';
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
import { chunkEmbedText } from '../../brain/embed-text.js';
import { getConfig, getDocumentProcessingConfig, getEmbeddingConfig } from '../../config/loader.js';
import { vlmExtractDocument } from './vlm-extract.js';
import type { FileMetaDoc, DocExtractionMode, TextLevel } from '../../config/types.js';
import type { StepProgress } from './types.js';
import { log, peerText } from '../../util/log.js';
import { enqueueMediaJob, cancelMediaJobsByPrefix } from '../media/job-queue.js';
import { convertedFileOf, extractedTreeOf, movedRoot, sidecarsOf, sidecarsOwnedBy, type Sidecar } from '../moved-paths.js';
import { rowsDerivedFrom } from '../derived-rows.js';
import { retireFileMeta } from '../file-meta.js';
import { READ_CHUNK } from '../../db/read-by-id.js';
import { embedConcurrency } from './embed-concurrency.js';
import { JobLeaseLostError, isLeaseLost, shouldHeartbeat, writeUnderClaim, type JobClaim } from '../media/lease.js';
import { embedChunksTotal } from '../../metrics/registry.js';
import { spaceCollection } from '../../db/space-collection.js';
import { mapLimit } from '../../util/map-limit.js';
import { inChunks } from '../../util/chunks.js';

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
 *
 * Every record this writes lands in ONE commit at the end, fenced on the job's claim (`writeUnderClaim`). They used
 * to be inserted as they were produced, unconditionally — so a conversion that finished after its file was moved
 * wrote its chunk records under the path the file had just left, where nothing would ever delete them. A claim
 * taken away before the commit now means nothing is written; after it, the records are there for whoever took it.
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
    /**
     * The run these results belong to. REQUIRED, not optional: an unfenced caller is exactly the writer that
     * resurrected a moved file's records, and a default would make that the path of least resistance.
     */
    claim: JobClaim;
    onProgress?: (p: StepProgress) => void;
    /** Checked between chunks; true means the claim is gone and this run throws `JobLeaseLostError`. */
    shouldStop?: () => boolean;
  },
): Promise<{ chunkCount: number; convertedFileId: string | null; embedFailures: number }> {
  const originalId = toDocId(originalFilePath);
  const now = new Date().toISOString();
  let embedFailures = 0;
  // Every record this run derives, committed together at the end — see the fence in the docblock.
  const derivedDocs: FileMetaDoc[] = [];
  const imageJobs: Array<{ path: string; mimeType: string }> = [];

  // 1. Write the full converted Markdown to disk (binary formats only)
  let convertedFileId: string | null = null;
  if (convertedMarkdown !== null) {
    const convertedPath = convertedFileOf(originalId);
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
    derivedDocs.push(convertedDoc);
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
      const imgPath = `${extractedTreeOf(originalId)}/image-${img.index}.${img.ext}`;
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
        derivedDocs.push(imgDoc);
        // Enqueued for the media pipeline (caption + face recognition) once the commit has landed — a job for a
        // record the fence then refused would retry against metadata that was never written.
        imageJobs.push({ path: imgPath, mimeType: `image/${img.ext === 'jpg' ? 'jpeg' : img.ext}` });
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
  // wants sockets in flight, while the bundled local model is CPU-bound and runs one embed at a time in its own
  // process, so eight at once only queue in front of every recall and write. (Before the model moved out of this
  // process, one chunk embed blocked the event loop for ~200 ms and eight concurrent ones on a small CPU allocation
  // left nothing for the thread that answers /health — a 358 KB document turned into a liveness-probe crash loop with
  // no error anywhere. `embed-concurrency.ts` has the measurements.)
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

  // EMBED_CONCURRENCY chunks in flight at a time, through the shared bounded pool; each result lands at its
  // own index, so chunkDocs keeps the chunk order whatever order the embeds finish in.
  await mapLimit(chunks, EMBED_CONCURRENCY, async (chunk, i) => {
    const chunkId = `${originalId}#chunk${chunk.chunkIndex}`;
    // The one builder a rebuild uses too (`buildEmbedText`), so a reindexed chunk embeds this exact string.
    const embedText = chunkEmbedText(chunk.headingText, chunk.content);

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

    // There used to be a `setImmediate` yield here, to hand the event loop a turn between chunks. It existed because
    // an embed ran INSIDE this process and blocked it for ~200 ms (measured), and `await` on an already-settled
    // promise does not yield to the macrotask queue. The embed no longer runs here: the local model is in a child
    // process (`brain/local-inference.ts`) and an external endpoint is a socket, so every `await embed(...)` above is
    // a real I/O round trip that returns to the event loop before it resumes. What is left on this thread between
    // two chunks is a few string operations and an awaited database write, so the yield bought nothing and is gone.

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
  });

  derivedDocs.push(...chunkDocs.filter(Boolean));

  // The commit. Replace-by-id rather than a bare insert, for two reasons: a transaction aborts on its first
  // duplicate key (the old `ordered: false` tolerance cannot exist inside one), and a write conflict makes
  // `withTransaction` run this callback again from the top.
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  try {
    await writeUnderClaim(spaceId, opts.claim, async session => {
      for (const batch of inChunks(derivedDocs, INSERT_BATCH)) {
        await files.deleteMany(asFilter<FileMetaDoc>({ _id: { $in: batch.map(d => d._id) } }), { session });
        await files.insertMany(batch.map(d => asDoc<FileMetaDoc>(d)), { session });
      }
    });
  } catch (err) {
    // The sidecar FILES were written before the commit, so a refused commit can leave them at a path whose file has
    // gone — moved or deleted mid-run — where sync would advertise them for ever. Only when the file is gone: under a
    // claim lost to stall recovery the file is still there, and the same paths now belong to the run that replaced us.
    // Gone means the path does not exist (`bytesPresentAt`). A failure to look is NOT gone: it keeps the sidecars, which
    // is what every case but a deleted source wants (preship-4 P4-5).
    let sourceGone = false;
    try {
      sourceGone = !(await bytesPresentAt(spaceId, originalId));
    } catch (lookErr) {
      log.warn(`Could not tell whether ${peerText(spaceId)}/${peerText(originalId)} is still here; its sidecars are kept: ${peerText(lookErr)}`);
    }
    if (isLeaseLost(err) && sourceGone && (convertedFileId || extractedImages.length > 0)) {
      // For a caller with no failure to give: what cannot be looked at (a failure to tell whether a path is a directory means
      // "not known to be the file's", which keeps it) is logged and the sidecars stay.
      // Both steps inside the one catch: listing what the file owns can fail to look too, and must not replace `err`.
      await sidecarsOwnedBy(spaceId, originalId, 'file').then(owned => removeSidecarBytes(spaceId, owned)).catch(cleanupErr =>
        log.warn(`Could not remove the sidecars of ${peerText(spaceId)}/${peerText(originalId)}: ${peerText(cleanupErr)}`));
    }
    throw err;
  }

  for (const job of imageJobs) {
    await enqueueMediaJob(spaceId, job.path, job.mimeType, 'image').catch(err =>
      log.warn(`Failed to enqueue extracted image ${spaceId}/${job.path}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  return { chunkCount: chunks.length, convertedFileId, embedFailures };
}

/** Best-effort recursive delete of a space-relative path. Never throws (missing = success). */
async function rmArtifactPath(spaceId: string, relPath: string): Promise<void> {
  try {
    const abs = await resolveSafePathChecked(spaceId, relPath);
    await removeTree(abs);
  } catch (err) {
    log.warn(`Failed to remove conversion artifact path ${peerText(spaceId)}/${peerText(relPath)}: ${peerText(err)}`);
  }
}

/**
 * THE byte step of every sidecar removal: the bytes of `owned`, whatever cannot be removed logged and left (`rmArtifactPath`
 * never throws). `deleteConversionArtifacts` and the directory's remover reach it through {@link removeWhatSidecarsLeft}; a
 * conversion that lost its lease reaches it directly, for the sidecars it wrote.
 */
async function removeSidecarBytes(spaceId: string, owned: readonly Sidecar[]): Promise<void> {
  for (const sidecar of owned) await rmArtifactPath(spaceId, sidecar.path);
}

/**
 * Delete everything a single original file's conversion — and the peers that delivered its sidecars — left behind: the rows
 * derived from it at EVERY level, the rows an ARRIVED sidecar made, the queued jobs of its extracted images, and the sidecar
 * bytes (`_converted/<id>.md`, `_extracted/<id>/`; `sidecarsOwnedBy`, which spares a directory `<id>.md/`'s tree).
 *
 * ## What it takes, and why each is on the list (bundle-71, Q-349)
 *
 *  - **Rows derived at every level**: the file's chunk and sidecar rows (`parentFileId` = the file) AND the caption and face
 *    rows of each extracted image, whose `parentFileId` is the image — two levels down (`rowsDerivedFrom`, the walk the vector
 *    sweep reads too). The delete used to read the first level, so a deleted document left its images' captions and faces,
 *    searchable, belonging to nothing.
 *  - **The rows arrived sidecars made**: a peer that never converted holds a sidecar as an ordinary file — a top-level row, no
 *    `parentFileId`, authored by whoever's bytes landed first — and derived rows never replicate, so nothing that removed
 *    derived rows removed it. It takes the file's own treatment (`retireFileMeta`: flagged under `softDeleteFileMeta`, else
 *    removed), and the rows beneath it go with it.
 *  - **The extracted images' jobs**: a queued caption or face job retries for ever against a path nothing holds.
 *
 * The one list for a local delete, a peer's tombstone for the file, the media worker's reconcile and a re-conversion's clean-up
 * (`removeFileHere`, `dispatch`, the worker), so the rows a peer's apply removes are the rows the owner's delete does.
 */
export async function deleteConversionArtifacts(
  spaceId: string,
  originalFilePath: string,
): Promise<void> {
  const originalId = toDocId(originalFilePath);
  // The jobs go first, so none starts over what is being removed. The queue derives the trees a path owns (`_extracted/<id>/…`,
  // an extracted image's jobs) from the path itself: the rule is its, and is not spelled a second time here.
  await cancelMediaJobsByPrefix(spaceId, originalId);
  await removeWhatSidecarsLeft(spaceId, [originalId], await sidecarsOwnedBy(spaceId, originalId, 'file'));

  log.info(`Deleted conversion artifacts for ${peerText(spaceId)}/${peerText(originalId)}`);
}

/**
 * THE one step both removers share, for a file and for a directory's whole tree: take the rows and the bytes that `owned`
 * sidecars and `roots` (the file rows they belong to) left behind.
 *
 *  1. **Every row derived from the roots or from a sidecar row, at every level** (`rowsDerivedFrom`): rows whose parent is one of
 *     them, found by `parentFileId $in` — chunks, converted and extracted rows, and the caption and face rows beneath an image,
 *     whose parent is the image and not the file.
 *  2. **A derived row at a sidecar path whose parent is gone** (an orphan the walk cannot reach from a root), by id.
 *  3. **The rows an arrival made** at a sidecar path — top-level, no `parentFileId` — each retired as the file's own row is
 *     (`retireFileMeta`: flagged under `softDeleteFileMeta`, else removed). Their children went in step 1: they were roots of it.
 *  4. **The sidecar bytes**: `deleteMany` does not touch disk, and the trees would otherwise be orphaned on the filesystem.
 *
 * A file's remover and a directory's used to each hand-write a part of this, one level deep, and each missed a different half:
 * the file's left the arrivals' rows, the directory's left those and the rows two levels down (bundle-71, Q-349).
 */
async function removeWhatSidecarsLeft(spaceId: string, roots: readonly string[], owned: readonly Sidecar[]): Promise<void> {
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  // The rows at the sidecars' own paths: a converted file by id, a tree by prefix (with its slash, so `d` is not `d2`).
  const atSidecars = owned.length === 0 ? [] : await files.find(
    asFilter<FileMetaDoc>({ $or: owned.map(s => s.shape === 'file' ? { _id: s.path } : { _id: { $regex: `^${escapeRegex(`${s.path}/`)}` } }) }),
    { projection: { _id: 1, parentFileId: 1 } },
  ).toArray() as Array<Pick<FileMetaDoc, '_id' | 'parentFileId'>>;

  const parents = [...await rowsDerivedFrom(spaceId, [...roots, ...atSidecars.map(r => r._id)])];
  for (const part of inChunks(parents, READ_CHUNK)) {
    await files.deleteMany(asFilter<FileMetaDoc>({ parentFileId: { $in: part } }));
  }
  const derivedHere = atSidecars.filter(r => r.parentFileId !== undefined).map(r => r._id);
  for (const part of inChunks(derivedHere, READ_CHUNK)) await files.deleteMany(asFilter<FileMetaDoc>({ _id: { $in: part } }));
  for (const r of atSidecars) if (r.parentFileId === undefined) await retireFileMeta(spaceId, r._id);

  await removeSidecarBytes(spaceId, owned);
}

/**
 * Delete conversion artifacts for EVERY original file under `dirPath/` — used
 * when a directory is deleted recursively. The sidecar records/files live under
 * the separate `_converted/<path>` and `_extracted/<path>` top-level prefixes,
 * so a `<dirPath>/`-only cleanup (deleteFileMetaByPrefix + fs.rm) leaves them
 * orphaned; this removes them — every row derived from a file under the folder at every level, the rows an arrival made under
 * the sidecar trees, and the trees — by the same step a single file's delete takes (`removeWhatSidecarsLeft`).
 */
export async function deleteConversionArtifactsByPrefix(
  spaceId: string,
  dirPath: string,
): Promise<void> {
  const dir = movedRoot(dirPath);
  if (!dir) return; // guard: empty path would match everything

  // The roots: the file rows under the folder (with its slash, so `d` is not `d2`). What derives from them — chunks, the rows of
  // their sidecars, the caption and face rows of an extracted image — is found by the walk the single file's remover shares.
  const roots = (await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).find(
    asFilter<FileMetaDoc>({ _id: { $regex: `^${escapeRegex(dir + '/')}` }, parentFileId: { $exists: false } }),
    { projection: { _id: 1 } },
  ).toArray()).map(r => r._id);
  await removeWhatSidecarsLeft(spaceId, roots, sidecarsOf(dir, 'directory'));

  log.info(`Deleted conversion artifacts under ${spaceId}/${dir}/`);
}
