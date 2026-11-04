/**
 * What of a chunk does the next chunk carry as overlap?
 *
 * ## What it prevents
 *
 * The overlap is the chunk's last paragraph, and a paragraph that cannot be divided (a 38 KB table of rows, a fence, one long line) copied
 * whole into the next chunk made that chunk larger than the size the chunker was asked for. The cap is applied here, inside the one
 * function that answers the question, so neither chunker (`paragraph-chunker.ts`, `section-chunker.ts`) can take the last paragraph
 * and forget it. The cut is `boundedPrefix`'s, the same rule that bounds what the embedder is sent.
 */
import { boundedPrefix } from '../../util/bounded-text.js';

/**
 * The last paragraph of `body` (paragraphs split on blank lines), cut to at most `max` UTF-8 bytes: '' when there is none.
 *
 * `skipTables`: a paragraph holding `<table` is passed over for the one before it, since a table is a semantic unit that is not
 * duplicated into the following chunk as context (the section chunker's rule; the plain-text chunker has no tables).
 */
export function cappedOverlap(body: string, max: number, opts: { skipTables?: boolean } = {}): string {
  const paras = body.split(/\n{2,}/).filter(p => p.trim().length > 0);
  for (let i = paras.length - 1; i >= 0; i--) {
    const para = paras[i]!;
    if (opts.skipTables && /<table/i.test(para)) continue;
    return boundedPrefix(para, max).text;
  }
  return '';
}
