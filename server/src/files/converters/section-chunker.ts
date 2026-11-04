/**
 * Section chunker — splits a Markdown string on H2 / H3 boundaries.
 *
 * Rules:
 *  - Split on lines that start with `## ` or `### `
 *  - Chunks whose body (excluding heading line) is shorter than
 *    `minBodyLength` chars are merged into the previous chunk
 *  - **A section longer than `maxBodyLength` is split further, at paragraph
 *    boundaries**, keeping the heading as provenance on each part
 *  - Table blocks (<table>…</table>) are never split across SECTION boundaries, and this chunker leaves a block it cannot divide
 *    (a table, a fence, one long line) whole: the HARD bound on what the embedder is sent is the bounding pass that follows it
 *    (`bound-chunks.ts`, at `chunkForLevel`), which keeps a table whole under the embedder's ceiling and cuts it at row lines above it
 *  - The last paragraph of the previous chunk is prepended to the next chunk
 *    as overlap (context continuity for the embedding model), itself capped at `maxBodyLength` bytes so a table is never copied
 *    into the next section
 *  - Returns an array of Chunk objects with headingText, content, chunkIndex
 *
 * ## Why a maximum exists (customer report, 2026-08-02)
 *
 * There was a minimum and no maximum, so a document's chunk count was decided entirely by how many `##`/`###`
 * headings it happened to have. A 57,642-byte API guide with two of them produced **two chunks of ~28 KB**,
 * and that broke two things at once:
 *
 *  - **Recall.** One vector averaged across ~4,500 words is not semantically sharp about anything in it. The
 *    reporter searched their own ingested docs for a retention feature, got unrelated smaller files three
 *    times, and was one step from concluding the feature did not exist. It did — in one of the coarse files.
 *  - **Fact.** Self-attention is quadratic in sequence length: ~7,000 tokens is ~196 MiB of attention
 *    scores *per head* in fp32, so one embed of one chunk cost gigabytes. Their instance went 3.98 → 9.996 GiB
 *    inside a single 15-second scrape window and was OOMKilled at a 16 GiB limit, then sat at 15.40 GiB at
 *    idle because the ONNX arena allocator keeps its high-water mark. Lowering embed concurrency had made it
 *    *worse*, because the peak is set by the size of one chunk, not by how many run at once.
 *
 * So the cap is a retrieval-quality rule that happens to also be the fact fix. It is a SOFT cap: it never cuts a paragraph. What the
 * embedder is actually sent is bounded by `embedding.maxInputBytes` in the pass after this one (`bound-chunks.ts`); the local model's
 * own truncation was once called the backstop, and it is the local model's alone (an HTTP embedder refuses an over-long input).
 */

import type { Chunk } from './types.js';
import { cappedOverlap } from './chunk-overlap.js';

const HEADING_RE = /^#{2,3}\s+(.+)$/;
const TABLE_OPEN_RE = /^<table[^>]*>/i;
const TABLE_CLOSE_RE = /<\/table>/i;

export interface SectionChunkerOptions {
  minBodyLength?: number; // default 150
  /** Hard ceiling on one chunk's body, in characters. Default `DEFAULT_MAX_BODY_LENGTH`. */
  maxBodyLength?: number;
}

/**
 * Default ceiling on a chunk body, in characters.
 *
 * ~2,000 characters is roughly 500 tokens: small enough that a vector is about one topic, large enough that a
 * typical `###` subsection stays whole rather than being cut mid-argument. It is also two orders of magnitude
 * below the point where attention cost becomes interesting — 500 tokens is ~1 MiB of attention scores per head
 * against ~196 MiB at 7,000.
 *
 * Deliberately NOT the model's context limit. Fitting is not the goal; being *retrievable* is, and a chunk that
 * merely fits can still average away everything specific in it.
 */
export const DEFAULT_MAX_BODY_LENGTH = 2_000;

/**
 * Split one oversized body at paragraph boundaries, never inside a table.
 *
 * Greedy rather than balanced: paragraphs accumulate until the next one would exceed the cap. A single
 * paragraph (or table) longer than the cap is emitted alone and left intact: this is the soft, retrieval-quality cap, and a table the
 * embedder accepts is worth more whole. What the embedder would REFUSE is cut afterwards, at row lines, by the bounding pass
 * (`bound-chunks.ts`): an unembeddable table is worth less than a table in parts.
 */
function splitOversized(body: string, maxLen: number): string[] {
  if (body.length <= maxLen) return [body];

  const blocks = body.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
  const parts: string[] = [];
  let current: string[] = [];
  let len = 0;

  for (const block of blocks) {
    if (len > 0 && len + block.length > maxLen) {
      parts.push(current.join('\n\n'));
      current = [];
      len = 0;
    }
    current.push(block);
    len += block.length + 2;
  }
  if (current.length > 0) parts.push(current.join('\n\n'));
  return parts.length > 0 ? parts : [body];
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
  // Floored above the minimum: a maximum below the merge threshold would split a section and then merge the
  // parts straight back together, which loops in effect and produces chunks of an unpredictable size.
  const maxBodyLength = Math.max(opts.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH, minBodyLength * 2);
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

    // Capped, so an indivisible last paragraph (a 38 KB table of rows) is not copied whole into the next section's body.
    prevLastPara = cappedOverlap(body, maxBodyLength, { skipTables: true });

    // A section with no size limit was the whole defect: two headings in a 57 KB document meant two 28 KB
    // chunks. Every part keeps the section's heading, so provenance survives the split and a reader still sees
    // which section an answer came from.
    for (const part of splitOversized(body, maxBodyLength)) {
      chunks.push({
        headingText: rc.heading,
        content: part,
        chunkIndex: chunks.length,
      });
    }
  }

  return chunks;
}
