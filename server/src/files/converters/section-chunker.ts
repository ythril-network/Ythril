/**
 * Section chunker — splits a Markdown string on H2 / H3 boundaries.
 *
 * Rules:
 *  - Split on lines that start with `## ` or `### `
 *  - Chunks whose body (excluding heading line) is shorter than
 *    `minBodyLength` chars are merged into the previous chunk
 *  - Table blocks (<table>…</table>) are never split across boundaries
 *  - The last paragraph of the previous chunk is prepended to the next chunk
 *    as overlap (context continuity for the embedding model)
 *  - Returns an array of Chunk objects with headingText, content, chunkIndex
 */

import type { Chunk } from './types.js';

const HEADING_RE = /^#{2,3}\s+(.+)$/;
const TABLE_OPEN_RE = /^<table[^>]*>/i;
const TABLE_CLOSE_RE = /<\/table>/i;

export interface SectionChunkerOptions {
  minBodyLength?: number; // default 150
}

/** Extract the last paragraph from a chunk body for overlap.
 *  Table blocks are excluded — they are semantic units that should
 *  not be duplicated into the following chunk as context overlap.
 */
function lastParagraph(body: string): string {
  const paras = body.split(/\n{2,}/).filter(p => p.trim().length > 0);
  for (let i = paras.length - 1; i >= 0; i--) {
    const para = paras[i]!;
    if (!/<table/i.test(para)) {
      return para;
    }
  }
  return '';
}

/**
 * Split normalised Markdown into heading-delimited chunks.
 * Table blocks are kept whole and never bisected.
 */
export function sectionChunk(
  md: string,
  opts: SectionChunkerOptions = {},
): Chunk[] {
  const minBodyLength = opts.minBodyLength ?? 150;
  const lines = md.split('\n');

  interface RawChunk { heading: string | null; lines: string[] }
  const raw: RawChunk[] = [];
  let current: RawChunk = { heading: null, lines: [] };
  let inTable = false;

  for (const line of lines) {
    // Detect table block boundaries
    if (!inTable && TABLE_OPEN_RE.test(line.trim())) {
      inTable = true;
      current.lines.push(line);
      if (TABLE_CLOSE_RE.test(line)) inTable = false;
      continue;
    }
    if (inTable) {
      current.lines.push(line);
      if (TABLE_CLOSE_RE.test(line)) inTable = false;
      continue;
    }

    const hMatch = line.match(HEADING_RE);
    if (hMatch) {
      raw.push(current);
      current = { heading: hMatch[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  raw.push(current);

  // Build chunks, merging short bodies into previous
  const merged: RawChunk[] = [];
  for (const rc of raw) {
    const body = rc.lines.join('\n').trim();
    if (body.length < minBodyLength && merged.length > 0) {
      // Append to previous chunk
      const prev = merged[merged.length - 1]!;
      prev.lines.push('', ...(rc.heading ? [`## ${rc.heading}`] : []), ...rc.lines);
    } else {
      merged.push(rc);
    }
  }

  // Build final Chunk objects with overlap
  const chunks: Chunk[] = [];
  let prevLastPara = '';

  for (let i = 0; i < merged.length; i++) {
    const rc = merged[i]!;
    let body = rc.lines.join('\n').trim();
    if (!body && !rc.heading) continue; // skip empty preamble

    // Prepend overlap from previous chunk
    if (prevLastPara && i > 0) {
      body = prevLastPara + '\n\n' + body;
    }

    prevLastPara = lastParagraph(body);

    chunks.push({
      headingText: rc.heading,
      content: body,
      chunkIndex: chunks.length,
    });
  }

  return chunks;
}
