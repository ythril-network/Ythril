/**
 * A window of a long Markdown document: whole paragraphs from a character offset, never cut mid-text (`Q-128`).
 *
 * The extract read answered `text.slice(0, MAX_CONVERTED_BYTES)` — a cut mid-sentence, under a constant named for
 * BYTES that sliced UTF-16 characters. A reader could not reach the rest, and the last paragraph shown was not one
 * the document contains. Now a window is whole paragraphs, `nextSkip` is the character offset the next one starts at,
 * and the windows joined back together are the document, character for character.
 *
 * A paragraph is text up to and including its blank-line separator, so no separator is lost between windows. A
 * single paragraph larger than the cap is SPLIT — at a line break if one fits, else at the cap — so a window never
 * exceeds the budget it was handed and the paragraph is still read, over two windows (`Q-111`; it was returned whole,
 * which kept it readable at the price of the bound). `maxBytes` bounds the window in UTF-8 bytes as well, for a
 * caller whose ceiling is a transport's.
 *
 * Read by BOTH doors that read a document's text: `GET …/files/extract` for the converted Markdown, and `read_file`.
 */
import { resolveBudget, type BudgetRequest, type ResolvedBudget } from '../brain/result-budget.js';

export interface MarkdownWindow {
  markdown: string;
  /** Whole paragraphs in this window. */
  parts: number;
  /** Where this window started, as a character offset into the document. */
  skip: number;
  /** The document's length in characters, so a reader knows how far it has read. */
  totalChars: number;
  /** More follows. */
  truncated: boolean;
  /** The character offset the next window starts at, present exactly when `truncated`. */
  nextSkip?: number;
}

/**
 * The window a caller asked for — `markdownSkip` and the answer budget — resolved ONCE for both doors that read a
 * document's text (`read_file` and `GET …/files/extract`), so they refuse the same values in the same words.
 *
 * @param operatorDefault the door's character default when the caller states no budget
 * @param carriages       `carriagesFor(transport)`: MCP carries the text twice, so each copy gets its share
 */
export function resolveTextWindow(
  req: { markdownSkip?: unknown } & BudgetRequest,
  operatorDefault: number,
  carriages = 1,
): { ok: true; skip: number; budget: ResolvedBudget } | { ok: false; error: string } {
  const skip = req.markdownSkip;
  if (skip !== undefined && !(typeof skip === 'number' && Number.isInteger(skip) && skip >= 0)) {
    return { ok: false, error: '`markdownSkip` must be a non-negative integer character offset' };
  }
  const budget = resolveBudget(req, operatorDefault, carriages);
  if (!budget.ok) return budget;
  return { ok: true, skip: typeof skip === 'number' ? skip : 0, budget };
}

export function markdownWindow(text: string, skip: number, maxChars: number, maxBytes: number | null = null): MarkdownWindow {
  const start = Math.max(0, Math.min(skip, text.length));
  const para = /[\s\S]*?(?:\n{2,}|$)/g;
  para.lastIndex = start;
  let end = start;
  let parts = 0;
  const fits = (to: number): boolean => to - start <= maxChars
    && (maxBytes === null || Buffer.byteLength(text.slice(start, to), 'utf8') <= maxBytes);
  // Bytes of the paragraphs taken so far, kept as a running sum so a long window is not re-measured per paragraph.
  let bytes = 0;
  while (end < text.length) {
    const m = para.exec(text);
    if (!m || m[0].length === 0) break;
    const next = end + m[0].length;
    const add = maxBytes === null ? 0 : Buffer.byteLength(m[0], 'utf8');
    if (next - start > maxChars || (maxBytes !== null && bytes + add > maxBytes)) {
      // The FIRST paragraph alone is over the cap (`Q-111`). It used to be returned whole — readable, but a window
      // that ignores the budget it was given. It is split instead: at the last line break inside the cap, else at the
      // cap itself, so the window is bounded and the windows still join back into the document exactly.
      if (parts === 0) end = splitPoint(text, start, next, fits);
      break;
    }
    end = next;
    bytes += add;
    parts++;
    para.lastIndex = end;
  }
  const truncated = end < text.length;
  return {
    markdown: text.slice(start, end), parts, skip: start, totalChars: text.length, truncated,
    ...(truncated ? { nextSkip: end } : {}),
  };
}

/**
 * Where to cut one paragraph too large for a window: the furthest line break the window can hold, else the furthest
 * character it can (never zero — a window always advances). A UTF-16 surrogate pair is never split.
 */
function splitPoint(text: string, start: number, paragraphEnd: number, fits: (to: number) => boolean): number {
  let lo = start + 1;
  let hi = paragraphEnd;
  // The furthest prefix that fits, by binary search — `fits` is monotone in the end offset.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  let cut = Math.max(start + 1, lo);
  const newline = text.lastIndexOf('\n', cut - 1);
  if (newline >= start) cut = newline + 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff && cut < paragraphEnd) cut = cut > start + 1 ? cut - 1 : cut + 1;
  return cut;
}
