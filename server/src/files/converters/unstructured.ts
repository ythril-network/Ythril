/**
 * UnstructuredConverter — converts PDF, DOCX, EPUB to Markdown via the
 * unstructured-api-full sidecar (localhost:8000).
 *
 * Sends a multipart/form-data POST with the file bytes and strategy=auto.
 * Applies the partition → Markdown mapping table from the issue spec.
 */

import type { FileConverter } from './types.js';
import { ConversionUnavailableError } from './types.js';

/** Shape of a single element in the unstructured partition array. */
interface Partition {
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

const SIDECAR_URL = process.env['CONVERSION_SIDECAR_URL'] ?? 'http://localhost:8000';

/** Map unstructured partition elements to Markdown. */
function partitionsToMarkdown(partitions: Partition[]): string {
  const parts: string[] = [];

  for (const p of partitions) {
    const text = (p.text ?? '').trim();
    if (!text) continue;

    switch (p.type) {
      case 'Title':
        parts.push(`## ${text}`);
        break;
      case 'NarrativeText':
        parts.push(`\n${text}\n`);
        break;
      case 'ListItem':
        parts.push(`- ${text}`);
        break;
      case 'Table':
        // Emit as fenced HTML table block so table structure is preserved
        parts.push(`<table>${text}</table>`);
        break;
      case 'Header':
      case 'Footer':
      case 'PageBreak':
        // Drop noise elements
        break;
      case 'FigureCaption':
        parts.push(`*${text}*`);
        break;
      default:
        parts.push(`\n${text}\n`);
    }
  }

  return parts.join('\n');
}

export class UnstructuredConverter implements FileConverter {
  async convert(fileBytes: Buffer, fileName: string): Promise<string> {
    if (!SIDECAR_URL) {
      throw new ConversionUnavailableError('sidecar_down', 'CONVERSION_SIDECAR_URL is not set');
    }

    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(fileBytes)]), fileName);
    form.append('strategy', 'auto');

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

    const md = partitionsToMarkdown(partitions);
    if (!md.trim()) {
      throw new ConversionUnavailableError('no_content', 'Conversion produced no content');
    }

    return md;
  }
}
