/**
 * UnstructuredConverter — converts PDF, DOCX, EPUB to Markdown via the
 * unstructured-api-full sidecar (localhost:8000).
 *
 * Default strategy: hi_res (full OCR + layout detection, image extraction).
 * Configurable via mediaEmbedding.documentProcessing.strategy in config.json.
 *
 * When strategy=hi_res and extractImages=true, embedded images are returned
 * alongside the Markdown so callers can write them as subfiles and re-enqueue
 * them for the full media pipeline (caption + face recognition).
 */

import type { FileConverter } from './types.js';
import { ConversionUnavailableError } from './types.js';
import { getDocumentProcessingConfig } from '../../config/loader.js';

/** Shape of a single element in the unstructured partition array. */
interface Partition {
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/** An image extracted from a document partition. */
export interface ExtractedImage {
  /** Base64-encoded image bytes from the unstructured sidecar. */
  base64: string;
  /** Suggested file extension (e.g. "png", "jpeg"). */
  ext: string;
  /** Optional caption/alt text from the surrounding context. */
  caption: string | null;
  /** 0-based index within the document (used for stable filenames). */
  index: number;
}

/** Full result from the unstructured sidecar including extracted images. */
export interface UnstructuredResult {
  markdown: string;
  extractedImages: ExtractedImage[];
}

const SIDECAR_URL = process.env['CONVERSION_SIDECAR_URL'] ?? 'http://localhost:8000';

/** Map unstructured partition elements to Markdown. Collects extracted images as a side-effect. */
function partitionsToMarkdown(partitions: Partition[], extractImages: boolean): { markdown: string; extractedImages: ExtractedImage[] } {
  const parts: string[] = [];
  const extractedImages: ExtractedImage[] = [];
  let imageIndex = 0;

  for (const p of partitions) {
    const text = (p.text ?? '').trim();
    const meta = p.metadata ?? {};

    switch (p.type) {
      case 'Title':
        if (text) parts.push(`## ${text}`);
        break;
      case 'NarrativeText':
        if (text) parts.push(`\n${text}\n`);
        break;
      case 'ListItem':
        if (text) parts.push(`- ${text}`);
        break;
      case 'Table': {
        // Prefer structured HTML from hi_res; fall back to raw text
        const htmlTable = typeof meta['text_as_html'] === 'string' ? meta['text_as_html'] : null;
        if (htmlTable) {
          parts.push(htmlTable);
        } else if (text) {
          parts.push(`<table>${text}</table>`);
        }
        break;
      }
      case 'Image': {
        if (extractImages) {
          const b64 = typeof meta['image_base64'] === 'string' ? meta['image_base64'] : null;
          if (b64) {
            // Detect image format from the base64 header or metadata
            const mimeType = typeof meta['image_mime_type'] === 'string' ? meta['image_mime_type'] : 'image/png';
            const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
            extractedImages.push({
              base64: b64,
              ext,
              caption: text || null,
              index: imageIndex++,
            });
            // Emit a placeholder line if there's a caption
            if (text) parts.push(`*[Image: ${text}]*`);
          } else if (text) {
            // No image bytes but we have alt text — emit as italic
            parts.push(`*${text}*`);
          }
        } else if (text) {
          parts.push(`*${text}*`);
        }
        break;
      }
      case 'FigureCaption':
        if (text) parts.push(`*${text}*`);
        break;
      case 'Header':
      case 'Footer':
      case 'PageBreak':
        // Drop noise elements
        break;
      default:
        if (text) parts.push(`\n${text}\n`);
    }
  }

  return { markdown: parts.join('\n'), extractedImages };
}

export class UnstructuredConverter implements FileConverter {
  /** Implements FileConverter — returns Markdown only (no images). */
  async convert(fileBytes: Buffer, fileName: string): Promise<string> {
    const result = await this.convertRich(fileBytes, fileName);
    return result.markdown;
  }

  /** Full conversion: returns Markdown + any extracted images. */
  async convertRich(fileBytes: Buffer, fileName: string): Promise<UnstructuredResult> {
    if (!SIDECAR_URL) {
      throw new ConversionUnavailableError('sidecar_down', 'CONVERSION_SIDECAR_URL is not set');
    }

    const docCfg = getDocumentProcessingConfig();
    const strategy = docCfg.strategy;
    const shouldExtractImages = strategy === 'hi_res' && docCfg.extractImages;

    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(fileBytes)]), fileName);
    form.append('strategy', strategy);
    if (shouldExtractImages) {
      // Ask the sidecar to base64-encode embedded images in the partition metadata
      form.append('extract_image_block_types', 'Image');
      form.append('extract_image_block_types', 'Table');
    }

    let response: Response;
    try {
      response = await fetch(`${SIDECAR_URL}/general/v0/general`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000), // 2 min max for OCR
      });
    } catch (err) {
      throw new ConversionUnavailableError(
        'sidecar_down',
        `Unstructured sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ConversionUnavailableError(
        'sidecar_error',
        `Unstructured sidecar returned HTTP ${response.status}: ${body}`,
      );
    }

    const partitions = await response.json() as Partition[];
    if (!Array.isArray(partitions) || partitions.length === 0) {
      throw new ConversionUnavailableError('no_content', 'Unstructured returned no partitions');
    }

    const { markdown, extractedImages } = partitionsToMarkdown(partitions, shouldExtractImages);
    if (!markdown.trim()) {
      throw new ConversionUnavailableError('no_content', 'Conversion produced no content');
    }

    return { markdown, extractedImages };
  }
}
