/**
 * Paragraph chunker — used for plain-text (.txt) files that have no heading structure.
 *
 * Rules:
 *  - Split on double newlines (paragraph boundaries)
 *  - Concatenate consecutive paragraphs until the chunk reaches `maxChunkLength` chars
 *  - Prepend the last paragraph of the previous chunk as overlap
 *  - headingText is null on all produced chunks
 */

import type { Chunk } from './types.js';

export interface ParagraphChunkerOptions {
  maxChunkLength?: number; // default 800
}

/** Extract the last paragraph from a chunk body for overlap. */
function lastParagraph(body: string): string {
  const paras = body.split(/\n{2,}/).filter(p => p.trim().length > 0);
  return paras.length > 0 ? (paras[paras.length - 1] ?? '') : '';
}

/**
 * Split plain text into paragraph-delimited chunks.
 */
export function paragraphChunk(
  text: string,
  opts: ParagraphChunkerOptions = {},
): Chunk[] {
  const maxLen = opts.maxChunkLength ?? 800;
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);

  const chunks: Chunk[] = [];
  let currentParas: string[] = [];
  let currentLen = 0;
  let prevLastPara = '';

  function flush(): void {
    if (currentParas.length === 0) return;
    let body = currentParas.join('\n\n');
    if (prevLastPara) {
      body = prevLastPara + '\n\n' + body;
    }
    prevLastPara = lastParagraph(body);
    chunks.push({ headingText: null, content: body, chunkIndex: chunks.length });
    currentParas = [];
    currentLen = 0;
  }

  for (const para of paras) {
    if (currentLen + para.length > maxLen && currentParas.length > 0) {
      flush();
    }
    currentParas.push(para);
    currentLen += para.length;
  }
  flush();

  return chunks;
}
