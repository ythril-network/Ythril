/**
 * Where in an RDF document an error is, from the text a reader has fed so far (bundle-270, slice S1; split out of `parse.ts`, the reader).
 *
 * ## What it prevents
 *
 * A library reports a failure by line, token or byte offset of the piece it was last given, and the reader refuses a document with the line and
 * column of the document. {@link Where} keeps the last two pieces fed so the report can be turned into a place, and never more: a position further
 * back, or inside a line longer than they hold, is answered with the line alone, so a long hostile line cannot make the tracker large.
 */

/** The characters of a piece fed to a parser. */
export const CHUNK_CHARS = 65_536;
/** The last code point a single UTF-16 unit holds; above it a character is a surrogate pair. */
const LAST_BMP_CODE_POINT = 0xffff;
/** The code of `\n`: the character a library counts lines by. */
const LINE_FEED = 0x0a;
/** How much of the text fed is kept to turn a library's report (a line, a token, a byte offset) into a line and column: two pieces. */
const TAIL_CHARS = 2 * CHUNK_CHARS;

/** Where in the document: 1-based, columns in UTF-16 units. A column is left out when it cannot be told. */
export interface RdfPlace { line: number; column?: number }

/** The index of the character of `text` that starts `offset` bytes in, as UTF-8 (how the JSON tokenizer counts), or undefined when `text` ends before it. */
export function charIndexAtByte(text: string, offset: number): number | undefined {
  let at = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (at >= offset) return i;
    const code = text.codePointAt(i)!;
    at += Buffer.byteLength(String.fromCodePoint(code), 'utf8');
    if (code > LAST_BMP_CODE_POINT) i += 1;
  }
  return undefined;
}

/**
 * Tracks the text fed so far, so an error a library reports by line, token or byte offset becomes a line and column of the document. Only the
 * last few pieces are kept: a position further back, or inside a line longer than they hold, is answered with the line alone.
 */
export class Where {
  private line = 1;
  private column = 0;
  /** The characters since the last line end of either kind (line feed or lone carriage return), across pieces: what the line bound measures. */
  private run = 0;
  /** The last {@link TAIL_CHARS} characters fed, and the line, column and byte offset of the first of them. */
  private tail = '';
  private tailLine = 1;
  private tailColumn = 0;
  /** How much of the tail the last piece is. */
  private lastPiece = 0;
  /** The longest line the last piece fed reached (its line end not counted), whether or not that line is complete, and its line number. */
  longest = { length: 0, line: 1 };

  feed(text: string): void {
    this.tail += text;
    this.lastPiece = text.length;
    if (this.tail.length > TAIL_CHARS) {
      const dropped = this.tail.slice(0, this.tail.length - TAIL_CHARS);
      this.tail = this.tail.slice(dropped.length);
      const lastEnd = dropped.lastIndexOf('\n');
      for (let at = dropped.indexOf('\n'); at !== -1; at = dropped.indexOf('\n', at + 1)) this.tailLine += 1;
      this.tailColumn = lastEnd === -1 ? this.tailColumn + dropped.length : dropped.length - lastEnd - 1;
    }
    // A line for the bound ends at a line feed OR a lone carriage return (white space in every text format, and the line end of old files);
    // the line NUMBER a library reports counts line feeds only, as the libraries do.
    this.longest = { length: 0, line: this.line };
    let line = this.line;
    let start = 0;
    const lineEnd = /[\r\n]/g;
    for (;;) {
      lineEnd.lastIndex = start;
      const found = lineEnd.exec(text);
      const end = found === null ? -1 : found.index;
      const length = (start === 0 ? this.run : 0) + ((end === -1 ? text.length : end) - start);
      if (length > this.longest.length) this.longest = { length, line };
      if (end === -1) break;
      if (text.charCodeAt(end) === LINE_FEED) line += 1;
      start = end + 1;
    }
    const lastEnd = text.lastIndexOf('\n');
    const lastBreak = Math.max(lastEnd, text.lastIndexOf('\r'));
    this.line = line;
    this.column = lastEnd === -1 ? this.column + text.length : text.length - lastEnd - 1;
    this.run = lastBreak === -1 ? this.run + text.length : text.length - lastBreak - 1;
  }

  /** The place just after the last text fed. */
  now(): RdfPlace { return { line: this.line, column: this.column + 1 }; }

  /** The place of the character at `index` in the last text fed. */
  inLast(index: number): RdfPlace { return this.placeAt(this.tail.length - this.lastPiece + index); }

  /** The place of the character `offset` bytes into the last piece fed: how the JSON tokenizer counts, from the start of the chunk it was given. */
  inLastAtByte(offset: number): RdfPlace | undefined {
    const first = this.tail.length - this.lastPiece;
    const index = charIndexAtByte(this.tail.slice(first), offset);
    return index === undefined ? undefined : this.placeAt(first + index);
  }

  /** The text of `line` as far as the tail reaches, and the column its first held character is at (`offset`). */
  lineText(line: number): { text: string; offset: number } | undefined {
    if (line < this.tailLine) return undefined;
    const index = line - this.tailLine;
    const text = this.tail.split('\n')[index];
    return text === undefined ? undefined : { text, offset: index === 0 ? this.tailColumn : 0 };
  }

  /** The line and column of the character at `index` of the tail. */
  private placeAt(index: number): RdfPlace {
    let line = this.tailLine;
    let lastEnd = -1;
    for (let at = this.tail.indexOf('\n'); at !== -1 && at < index; at = this.tail.indexOf('\n', at + 1)) { line += 1; lastEnd = at; }
    return { line, column: lastEnd === -1 ? this.tailColumn + index + 1 : index - lastEnd };
  }
}
