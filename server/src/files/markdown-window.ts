/**
 * A window of a long Markdown document: whole paragraphs from a character offset, never cut mid-text (`Q-128`).
 *
 * The extract read answered `text.slice(0, MAX_CONVERTED_BYTES)` — a cut mid-sentence, under a constant named for
 * BYTES that sliced UTF-16 characters. A reader could not reach the rest, and the last paragraph shown was not one
 * the document contains. Now a window is whole paragraphs, `nextSkip` is the character offset the next one starts at,
 * and the windows joined back together are the document, character for character.
 *
 * A paragraph is text up to and including its blank-line separator, so no separator is lost between windows. A
 * single paragraph larger than the cap is returned whole and alone: otherwise it could never be read.
 */
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

export function markdownWindow(text: string, skip: number, maxChars: number): MarkdownWindow {
  const start = Math.max(0, Math.min(skip, text.length));
  const para = /[\s\S]*?(?:\n{2,}|$)/g;
  para.lastIndex = start;
  let end = start;
  let parts = 0;
  while (end < text.length) {
    const m = para.exec(text);
    if (!m || m[0].length === 0) break;
    const next = end + m[0].length;
    if (parts > 0 && next - start > maxChars) break;
    end = next;
    parts++;
    para.lastIndex = end;
  }
  const truncated = end < text.length;
  return {
    markdown: text.slice(start, end), parts, skip: start, totalChars: text.length, truncated,
    ...(truncated ? { nextSkip: end } : {}),
  };
}
