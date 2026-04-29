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
import { UnstructuredConverter } from './unstructured.js';
import { HtmlConverter } from './html.js';
import { MarkdownPassthrough, PlainTextPassthrough } from './passthrough.js';
import { normaliseMarkdown } from './normaliser.js';
import { sectionChunk } from './section-chunker.js';
import { paragraphChunk } from './paragraph-chunker.js';
import type { Chunk } from './types.js';
import { writeFile } from '../files.js';
import { col, mFilter, mDoc } from '../../db/mongo.js';
import { embed } from '../../brain/embedding.js';
import { getConfig } from '../../config/loader.js';
import type { FileMetaDoc, AuthorRef } from '../../config/types.js';
import { log } from '../../util/log.js';

export type InputFormat = 'pdf' | 'docx' | 'epub' | 'html' | 'md' | 'txt' | 'text' | 'auto';

/** The resolved, concrete format used for dispatching. */
export type ResolvedFormat = 'pdf' | 'docx' | 'epub' | 'html' | 'md' | 'txt' | 'text' | 'image' | 'audio' | 'video';

/** The set of resolved formats that represent binary media files (handled by the async media pipeline). */
export const MEDIA_FORMATS = new Set<ResolvedFormat>(['image', 'audio', 'video']);

export function isMediaFormat(fmt: ResolvedFormat): fmt is 'image' | 'audio' | 'video' {
  return MEDIA_FORMATS.has(fmt);
}

function authorRef(): AuthorRef {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
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
}

export interface ConversionResult {
  chunks: Chunk[];
  convertedMarkdown: string | null; // null for md/txt (source IS the markdown)
}

/**
 * Run the conversion pipeline for a file:
 *  1. Convert to Markdown (or passthrough)
 *  2. Normalise
 *  3. Chunk
 *  Returns the produced chunks and the full converted Markdown (null for md/txt).
 */
export async function runConversionPipeline(
  fileBytes: Buffer,
  filePath: string,
  format: ResolvedFormat,
  opts: ConversionPipelineOptions = {},
): Promise<ConversionResult> {
  const fileName = path.basename(filePath);
  let markdown: string;
  let convertedMarkdown: string | null = null;

  switch (format) {
    case 'text':
      // Bypass: caller handles single-record storage
      return { chunks: [], convertedMarkdown: null };

    case 'image':
    case 'audio':
    case 'video':
      // Media formats are handled by the async media embedding pipeline, not here
      return { chunks: [], convertedMarkdown: null };

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
      const conv = new UnstructuredConverter();
      markdown = await conv.convert(fileBytes, fileName);
      convertedMarkdown = markdown;
      break;
    }
  }

  const normalised = normaliseMarkdown(markdown);

  const chunks = format === 'txt'
    ? paragraphChunk(normalised, { maxChunkLength: opts.maxParagraphChunkLength })
    : sectionChunk(normalised, { minBodyLength: opts.minChunkBodyLength });

  return { chunks, convertedMarkdown };
}

/** Normalise a path to forward-slash convention and strip leading slashes. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Store a converted file's chunk records in the {spaceId}_files collection.
 * Each chunk gets its own record with a per-chunk embedding.
 *
 * @param spaceId           Space ID
 * @param originalFilePath  Relative path of the original file (its _id in filemeta)
 * @param chunks            Chunk array from the pipeline
 * @param convertedMarkdown If not null, write to _converted/<originalFileId>.md and return its path
 * @returns object with chunkCount and optional convertedFileId
 */
export async function storeConversionResults(
  spaceId: string,
  originalFilePath: string,
  chunks: Chunk[],
  convertedMarkdown: string | null,
): Promise<{ chunkCount: number; convertedFileId: string | null }> {
  const originalId = normPath(originalFilePath);
  const now = new Date().toISOString();

  // 1. Write the full converted Markdown to disk (binary formats only)
  let convertedFileId: string | null = null;
  if (convertedMarkdown !== null) {
    const convertedPath = `_converted/${originalId}.md`;
    await writeFile(spaceId, convertedPath, convertedMarkdown);
    convertedFileId = normPath(convertedPath);

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
    await col<FileMetaDoc>(`${spaceId}_files`).insertOne(mDoc<FileMetaDoc>(convertedDoc));
  }

  // 2. Insert chunk records
  for (const chunk of chunks) {
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
    } catch {
      // best-effort — chunk stored without vector if embedding unavailable
    }

    const chunkDoc: FileMetaDoc = {
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

    await col<FileMetaDoc>(`${spaceId}_files`).insertOne(mDoc<FileMetaDoc>(chunkDoc));
  }

  return { chunkCount: chunks.length, convertedFileId };
}

/** Delete all chunk records and the _converted/ file for a given original file. */
export async function deleteConversionArtifacts(
  spaceId: string,
  originalFilePath: string,
): Promise<void> {
  const originalId = normPath(originalFilePath);

  // Delete all filemeta records with parentFileId = originalId
  await col<FileMetaDoc>(`${spaceId}_files`).deleteMany(
    mFilter<FileMetaDoc>({ parentFileId: originalId }),
  );

  log.info(`Deleted conversion artifacts for ${spaceId}/${originalId}`);
}
