/**
 * The bounding pass: every chunk the chunkers make is split until what the embedder is SENT for it stays under its ceiling.
 *
 * ## What it prevents
 *
 * The chunkers keep a SOFT cap (2,000 characters: the size a vector is still about one topic) and left any block they cannot divide
 * (a 38 KB table of Markdown rows with no blank line in it, a fenced block, a line with no break) whole, on the reasoning that
 * `embed()`'s truncation was the backstop. It is the local model's alone: an HTTP embedder REFUSES an input over its context with
 * HTTP 400, and two pages of the shipped documentation were stored with no vector for it. This is the HARD bound, applied where the
 * conversion makes its chunks (`chunkForLevel`, `pipeline.ts`) and nowhere else, AFTER both chunkers' overlaps are in, so what is
 * counted is what is embedded: the heading, the body and the overlap.
 *
 * ## The rule
 *
 *  - The heading is capped to a quarter of the budget (`cappedHeading`) and the CAPPED heading is the stored `headingText`: the
 *    queue's rebuild builds from the stored heading, so the stored one must be the one that was embedded.
 *  - The body budget is the embed budget (`embedTextBudget()`: the ceiling less the largest task prefix) less the bytes the heading
 *    and the space after it take.
 *  - A body over its budget is cut by `boundedParts` (the last line break that fits, so tables keep whole rows; else the furthest
 *    character; never inside a surrogate pair), every part keeps the heading, and `chunkIndex` is renumbered once, in order.
 *  - A body that fits is untouched, including at exactly the budget.
 */
import { boundedParts, utf8Bytes } from '../../util/bounded-text.js';
import { cappedHeading, embedTextBudget } from '../../brain/embed-text.js';
import type { Chunk } from './types.js';

export function boundChunks(chunks: Chunk[]): Chunk[] {
  const budget = embedTextBudget();
  const bounded: Chunk[] = [];
  for (const chunk of chunks) {
    const heading = cappedHeading(chunk.headingText, budget);
    // "<heading> <body>": the heading and the one space that `chunkEmbedText` puts after it. The space counts only with a heading.
    const bodyBudget = budget - (heading ? utf8Bytes(heading) + 1 : 0);
    const parts = utf8Bytes(chunk.content) <= bodyBudget ? [chunk.content] : boundedParts(chunk.content, bodyBudget);
    for (const part of parts) {
      const content = parts.length === 1 ? part : part.trimEnd();
      if (!content) continue;
      bounded.push({
        headingText: heading,
        content,
        chunkIndex: bounded.length,
      });
    }
  }
  return bounded;
}
