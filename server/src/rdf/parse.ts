/**
 * The RDF import reader: Turtle, TriG, N-Quads and JSON-LD, plain or gzipped, as a stream of quads (bundle-270, slice S1).
 *
 * ## What it prevents
 *
 * The import reads a file a stranger made, inside the server. Every later slice of the import stands on this reader, so the parts a caller
 * would forget are inside it:
 *
 * - **A request forged from inside the server.** The JSON-LD library fetches a remote `@context` unless told otherwise. It is built here, and
 *   only here, with a document loader that refuses every address (`rdf_remote_context`, naming it): nothing is ever fetched, and a test holds
 *   that no module but this one builds the library. Its streaming profile is on: a document that would need buffering (a `@context` after the
 *   data it governs) is refused (`rdf_jsonld_not_streamable`), never held whole.
 * - **Memory the author chooses.** Each bound below is a named constant with its reason; exceeding one refuses with `rdf_bound_exceeded` and
 *   the constant's NAME in `bound`. A gzip body is counted after it inflates, against the bytes read so far and against an absolute cap.
 * - **A refusal that ends the process.** A parser's error is an event; nobody listening makes it an uncaught exception. Every failure of a
 *   library, of the source, of the UTF-8 decoding or of the gzip stream surfaces as one {@link RdfParseError} thrown from the iteration, with
 *   the line and column where the document is wrong when they can be told.
 * - **A refused upload that goes on being read.** The source is destroyed when the reader refuses, when the caller stops iterating, and when
 *   the document ends.
 * - **A relative address read against a base nobody gave** (amendment A9). No parser is given a base; a relative address is refused
 *   (`rdf_relative_iri`) with its place, unless the document declares a base of its own (`@base`, `BASE`), which is its own statement.
 * - **A blank node that is two subjects.** A blank node's id is the caller's prefix ({@link RDF_DEFAULT_BLANK_NODE_PREFIX} unless named) plus
 *   a label the document gave, or a counter of this reader for an anonymous node (`[]`, `( )`, a nested node): the same document reads to the
 *   same ids however its bytes are cut and however often it is read, so one blank node read in two chunks, or by two readers, is one subject.
 *   A label and an anonymous node never share a name, and neither library's own global counter is used.
 * - **A tag taken for a plain string.** A literal keeps its language tag (`language`, with an RDF 1.2 base direction as `en--ltr`) and its
 *   `datatype` apart; `xsd:string` is the plain literal.
 *
 * ## What it does not do
 *
 * It does not group, sort or decide anything about a statement: it yields the quads of the document in document order and the caller does the
 * rest. RDF lists are the `rdf:first`/`rdf:rest` statements they are, a triple term (RDF 1.2) is a `triple` term, and a blank-node graph name,
 * a triple term as a subject, and N3 variables are refused (`rdf_unsupported`): the model holds none of them.
 *
 * ## The bounds (characters are UTF-16 units; the line end is not part of a line)
 *
 * The text formats are fed to the library in pieces of at most {@link CHUNK_CHARS}, so every bound is checked at least that often.
 */
import { createGunzip } from 'node:zlib';
import { Parser as N3Parser, DataFactory as N3Factory } from 'n3';
import { JsonLdParser } from 'jsonld-streaming-parser';
import type { BlankTerm, IriTerm, LiteralTerm, Quad, Term, TripleTerm } from './literals.js';
import { xsd } from './literals.js';
import { RDF_FORMATS, type RdfFormat } from './serialize.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';

/** The longest literal value the reader takes: twice the longest text the store keeps (`MAX_FACT_LENGTH`, 50 000), so a text that fits is read and one that could never be stored is not buffered. */
export const RDF_MAX_LITERAL_CHARS = 100_000;
/** The longest address, blank-node label or language tag: a file path (`MAX_PEER_PATH_LENGTH`, 4096) percent-encoded three-fold, a base, and room. */
export const RDF_MAX_TOKEN_CHARS = 16_384;
/** The longest line of a text format: a literal at its bound with every character escaped six-fold (`A`), and the rest of its statement. JSON-LD has no line. */
export const RDF_MAX_LINE_CHARS = 1_048_576;
/** The most characters fed since a piece last completed a statement: a statement spans lines (a triple-quoted literal), but a comment, a blank run or an unterminated literal must not grow the library's buffer without end. */
export const RDF_MAX_UNPARSED_CHARS = 2_097_152;
/** How many times larger a gzip body may inflate than the bytes read of it so far: text RDF with repeated addresses compresses to a tenth or a twentieth, a zero-filled bomb a thousand-fold. */
export const RDF_MAX_INFLATE_RATIO = 200;
/** The inflated size below which the ratio is not asked: a small, very regular document compresses far beyond the ratio and is no risk. */
export const RDF_INFLATE_RATIO_FLOOR_BYTES = 1_048_576;
/** The most bytes a gzip body may hold once inflated: the admin import door's own ceiling (`DEFAULT_IMPORT_BODY_MAX_BYTES`, 1 GiB). */
export const RDF_MAX_INFLATED_BYTES = 1_073_741_824;
/** The prefix of a blank node's id when the caller names none. */
export const RDF_DEFAULT_BLANK_NODE_PREFIX = 'in-';
/** The characters of a piece fed to a parser. */
const CHUNK_CHARS = 65_536;
/** The codes zlib gives a body that is not valid gzip: corrupt (`Z_DATA_ERROR`), cut short (`Z_BUF_ERROR`), or one the engine cannot inflate. Named, never matched by prefix or wording. */
const ZLIB_FAILURES: ReadonlySet<string> = new Set(['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_STREAM_ERROR', 'Z_NEED_DICT', 'Z_MEM_ERROR', 'Z_VERSION_ERROR']);
/** The last code point a single UTF-16 unit holds; above it a character is a surrogate pair. */
const LAST_BMP_CODE_POINT = 0xffff;
/** The units that open a surrogate pair: a piece never ends on one, so a pair is never cut between two parsers' writes. */
const HIGH_SURROGATES = Object.freeze({ first: 0xd800, last: 0xdbff });
/** How much of the text fed is kept to turn a library's report (a line, a token, a byte offset) into a line and column: two pieces. */
const TAIL_CHARS = 2 * CHUNK_CHARS;

/** The bounds one reader holds, by the names of its options. */
export interface RdfParseBounds {
  maxLiteralChars: number;
  maxTokenChars: number;
  maxLineChars: number;
  maxUnparsedChars: number;
  maxInflateRatio: number;
  inflateRatioFloorBytes: number;
  maxInflatedBytes: number;
}

export const DEFAULT_RDF_PARSE_BOUNDS: Readonly<RdfParseBounds> = Object.freeze({
  maxLiteralChars: RDF_MAX_LITERAL_CHARS,
  maxTokenChars: RDF_MAX_TOKEN_CHARS,
  maxLineChars: RDF_MAX_LINE_CHARS,
  maxUnparsedChars: RDF_MAX_UNPARSED_CHARS,
  maxInflateRatio: RDF_MAX_INFLATE_RATIO,
  inflateRatioFloorBytes: RDF_INFLATE_RATIO_FLOOR_BYTES,
  maxInflatedBytes: RDF_MAX_INFLATED_BYTES,
});

export interface ParseRdfOptions {
  /** The prefix of every blank node's id; default {@link RDF_DEFAULT_BLANK_NODE_PREFIX}. Two readers of one import use one prefix. */
  blankNodePrefix?: string;
  /** A lower ceiling than the defaults (a door whose own limit is smaller), by the option names of {@link RdfParseBounds}. */
  bounds?: Partial<RdfParseBounds>;
}

/** Where in the document: 1-based, columns in UTF-16 units. A column is left out when it cannot be told. */
export interface RdfPlace { line: number; column?: number }

export type RdfRefusalCode =
  | 'rdf_malformed' | 'rdf_relative_iri' | 'rdf_remote_context' | 'rdf_jsonld_not_streamable' | 'rdf_bound_exceeded'
  | 'rdf_gzip_invalid' | 'rdf_unsupported_format' | 'rdf_unsupported' | 'rdf_source_failed';

/** What the reader throws for a document it refuses: a reason a caller can show, and where. */
export class RdfParseError extends Error {
  override readonly name = 'RdfParseError';
  constructor(
    readonly code: RdfRefusalCode,
    reason: string,
    readonly details: { place?: RdfPlace; bound?: string; address?: string } = {},
  ) {
    super(details.place ? `${reason} (line ${details.place.line}${details.place.column === undefined ? '' : `, column ${details.place.column}`})` : reason);
  }
  get place(): RdfPlace | undefined { return this.details.place; }
  get bound(): string | undefined { return this.details.bound; }
  get address(): string | undefined { return this.details.address; }
}

const ABSOLUTE_IRI = /^[a-z][a-z0-9+.-]*:/i;
const GZIP_MAGIC = [0x1f, 0x8b];
/** What each message of an input-derived error is cut to, so a hostile token cannot make a refusal large. */
const REASON_CHARS = 200;
const cut = (text: string): string => (text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS - 1)}…` : text);

const NAMES_OF_BOUND: Readonly<Record<keyof RdfParseBounds, string>> = Object.freeze({
  maxLiteralChars: 'RDF_MAX_LITERAL_CHARS',
  maxTokenChars: 'RDF_MAX_TOKEN_CHARS',
  maxLineChars: 'RDF_MAX_LINE_CHARS',
  maxUnparsedChars: 'RDF_MAX_UNPARSED_CHARS',
  maxInflateRatio: 'RDF_MAX_INFLATE_RATIO',
  inflateRatioFloorBytes: 'RDF_INFLATE_RATIO_FLOOR_BYTES',
  maxInflatedBytes: 'RDF_MAX_INFLATED_BYTES',
});

/** The refusal of a bound, naming it. */
function overBound(key: keyof RdfParseBounds, limit: number, what: string, place?: RdfPlace): RdfParseError {
  const bound = NAMES_OF_BOUND[key];
  return new RdfParseError('rdf_bound_exceeded', `${what} is over ${bound} (${limit})`, { bound, ...(place ? { place } : {}) });
}

function resolveBounds(given: Partial<RdfParseBounds> | undefined): RdfParseBounds {
  const merged = { ...DEFAULT_RDF_PARSE_BOUNDS, ...given };
  for (const key of Object.keys(DEFAULT_RDF_PARSE_BOUNDS) as (keyof RdfParseBounds)[]) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] <= 0) throw new TypeError(`parseRdf: bounds.${key} must be a positive whole number`);
  }
  return merged;
}

// ── Where in the document ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tracks the text fed so far, so an error a library reports by line, token or byte offset becomes a line and column of the document. Only the
 * last few pieces are kept: a position further back, or inside a line longer than they hold, is answered with the line alone.
 */
class Where {
  private line = 1;
  private column = 0;
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
    this.longest = { length: 0, line: this.line };
    let line = this.line;
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      const length = (start === 0 ? this.column : 0) + ((end === -1 ? text.length : end) - start);
      if (length > this.longest.length) this.longest = { length, line };
      if (end === -1) break;
      line += 1;
      start = end + 1;
    }
    const lastEnd = text.lastIndexOf('\n');
    this.line = line;
    this.column = lastEnd === -1 ? this.column + text.length : text.length - lastEnd - 1;
  }

  /** The place just after the last text fed. */
  now(): RdfPlace { return { line: this.line, column: this.column + 1 }; }

  /** The place of the character at `index` in the last text fed. */
  inLast(index: number): RdfPlace { return this.placeAt(this.tail.length - this.lastPiece + index); }

  /** The place of the character `offset` bytes into the last piece fed: how the JSON tokenizer counts, from the start of the chunk it was given. */
  inLastAtByte(offset: number): RdfPlace | undefined {
    let at = 0;
    for (let i = this.tail.length - this.lastPiece; i < this.tail.length; i += 1) {
      if (at >= offset) return this.placeAt(i);
      const code = this.tail.codePointAt(i)!;
      at += Buffer.byteLength(String.fromCodePoint(code), 'utf8');
      if (code > LAST_BMP_CODE_POINT) i += 1;
    }
    return undefined;
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

// ── Bytes to text ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The source's chunks as buffers; a failure of the source is a refusal, not an unhandled error. */
async function* chunksOf(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of source) yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  } catch (err) {
    if (err instanceof RdfParseError) throw err;
    const code = (err as { code?: unknown } | null)?.code;
    throw new RdfParseError('rdf_source_failed', `the document could not be read to its end${typeof code === 'string' ? ` (${cut(code)})` : ''}: the upload failed or was cut off`);
  }
}

/** What `settled` listens on. */
interface Eventful {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** Resolves when `stream` can take more, or has ended or failed. */
function settled(stream: Eventful): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => { stream.off('drain', done); stream.off('close', done); stream.off('error', done); resolve(); };
    stream.once('drain', done); stream.once('close', done); stream.once('error', done);
  });
}

/** The bytes of a gzip body, inflated and counted: past the absolute cap, or past the ratio to what was read once past the floor, refuses. */
async function* inflated(bytes: AsyncIterable<Buffer>, bounds: RdfParseBounds): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  let read = 0;
  let produced = 0;
  void (async () => {
    try {
      for await (const chunk of bytes) {
        if (gunzip.destroyed) return;
        read += chunk.length;
        if (!gunzip.write(chunk)) await settled(gunzip);
      }
      gunzip.end();
    } catch (err) {
      gunzip.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  try {
    for await (const out of gunzip as AsyncIterable<Buffer>) {
      produced += out.length;
      if (produced > bounds.maxInflatedBytes) throw overBound('maxInflatedBytes', bounds.maxInflatedBytes, 'the body, inflated,');
      if (produced > bounds.inflateRatioFloorBytes && produced > bounds.maxInflateRatio * read) {
        throw overBound('maxInflateRatio', bounds.maxInflateRatio, `the body inflates ${Math.floor(produced / Math.max(read, 1))}-fold, which`);
      }
      yield out;
    }
  } catch (err) {
    if (err instanceof RdfParseError) throw err;
    const code = String((err as { code?: unknown })?.code ?? '');
    if (ZLIB_FAILURES.has(code)) throw new RdfParseError('rdf_gzip_invalid', `the body is not a valid gzip stream (${code})`);
    throw err;
  } finally {
    gunzip.destroy();
  }
}

/** The bytes of the document: the source's, or its inflation when it starts with the gzip magic. */
async function* documentBytes(source: AsyncIterable<Uint8Array | string>, bounds: RdfParseBounds): AsyncGenerator<Buffer> {
  const chunks = chunksOf(source);
  const held: Buffer[] = [];
  let have = 0;
  let ended = false;
  while (have < GZIP_MAGIC.length && !ended) {
    const next = await chunks.next();
    if (next.done) ended = true; else { held.push(next.value); have += next.value.length; }
  }
  const head = Buffer.concat(held);
  async function* all(): AsyncGenerator<Buffer> {
    if (head.length) yield head;
    if (!ended) yield* { [Symbol.asyncIterator]: () => chunks };
  }
  const isGzip = head.length >= GZIP_MAGIC.length && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  yield* isGzip ? inflated(all(), bounds) : all();
}

/**
 * The document as text in pieces of at most {@link CHUNK_CHARS}, none ending between the halves of a surrogate pair, each already fed to `where`.
 * Bytes that are not UTF-8 are refused: a replacement character would change the data.
 */
async function* textOf(bytes: AsyncIterable<Buffer>, where: Where): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pieces = async function* (): AsyncGenerator<string> {
    for await (const chunk of bytes) {
      let text: string;
      try { text = decoder.decode(chunk, { stream: true }); } catch { throw new RdfParseError('rdf_malformed', 'the document is not valid UTF-8', { place: where.now() }); }
      yield text;
    }
    try { yield decoder.decode(); } catch { throw new RdfParseError('rdf_malformed', 'the document ends inside a UTF-8 character', { place: where.now() }); }
  };
  for await (const text of pieces()) {
    for (let at = 0; at < text.length;) {
      let end = Math.min(at + CHUNK_CHARS, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= HIGH_SURROGATES.first && last <= HIGH_SURROGATES.last) end += 1;
      const piece = text.slice(at, end);
      where.feed(piece);
      yield piece;
      at = end;
    }
  }
}

/** Refuses a line of a text format over the bound the moment a piece reaches it, complete or not (the piece is already counted by `where`). */
function checkLines(where: Where, bounds: RdfParseBounds): void {
  if (where.longest.length > bounds.maxLineChars) {
    throw overBound('maxLineChars', bounds.maxLineChars, 'a line', { line: where.longest.line, column: bounds.maxLineChars + 1 });
  }
}

// ── The libraries' terms ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of an RDF/JS term the reader reads. */
interface RdfJsTerm {
  termType: string;
  value: string;
  language?: string;
  direction?: string;
  datatype?: { value: string };
  subject?: RdfJsTerm; predicate?: RdfJsTerm; object?: RdfJsTerm; graph?: RdfJsTerm;
}

/**
 * A data factory whose anonymous blank nodes are numbered by the reader that made it, never by the library's global counter: `~0`, `~1`, ... A
 * label the document gave stays what it is for Turtle (the library prefixes it with `l`), and is marked with that `l` here for JSON-LD, so a label
 * and an anonymous node never share a name.
 */
function blankFactory(markLabels: boolean): object {
  let anonymous = 0;
  return {
    ...N3Factory,
    blankNode: (name?: string) => N3Factory.blankNode(name === undefined ? `~${anonymous++}` : markLabels ? `l${name}` : name),
    // The JSON-LD library asks for a plain string with a null language, which n3's factory reads as a term.
    literal: (value: string, languageOrDatatype?: unknown) => N3Factory.literal(value, languageOrDatatype === null ? undefined : languageOrDatatype as string),
  };
}

/** Converts what a library read to the model, refusing what the model cannot hold or a bound forbids. `place` names where the statement is. */
class Terms {
  constructor(private readonly prefix: string, private readonly bounds: RdfParseBounds, private readonly relativeOk: () => boolean, private readonly place: () => RdfPlace | undefined) {}

  quad(raw: RdfJsTerm): Quad {
    const subject = this.term(raw.subject!);
    if (subject.kind !== 'iri' && subject.kind !== 'blank') throw new RdfParseError('rdf_unsupported', 'a triple term as the subject of a statement cannot be imported', this.at());
    const predicate = this.term(raw.predicate!);
    if (predicate.kind !== 'iri') throw new RdfParseError('rdf_unsupported', 'a blank node as a predicate cannot be imported', this.at());
    const object = this.term(raw.object!);
    const graphRaw = raw.graph;
    if (!graphRaw || graphRaw.termType === 'DefaultGraph') return { subject, predicate, object };
    const graph = this.term(graphRaw);
    if (graph.kind !== 'iri') throw new RdfParseError('rdf_unsupported', 'a blank node as a graph name cannot be imported', this.at());
    return { subject, predicate, object, graph };
  }

  private at(): { place?: RdfPlace } {
    const place = this.place();
    return place ? { place } : {};
  }

  private term(raw: RdfJsTerm): Term {
    switch (raw.termType) {
      case 'NamedNode': return this.iri(raw.value);
      case 'BlankNode': {
        // A label carries the one-character marker the factories give it (`l`), an anonymous node its `~`.
        if (raw.value.length - 1 > this.bounds.maxTokenChars) throw overBound('maxTokenChars', this.bounds.maxTokenChars, 'a blank-node label', this.place());
        return { kind: 'blank', id: `${this.prefix}${raw.value}` } satisfies BlankTerm;
      }
      case 'Literal': return this.literal(raw);
      case 'Quad': {
        const subject = this.term(raw.subject!);
        if (subject.kind !== 'iri' && subject.kind !== 'blank') throw new RdfParseError('rdf_unsupported', 'a triple term inside a triple term as a subject cannot be imported', this.at());
        const predicate = this.term(raw.predicate!);
        if (predicate.kind !== 'iri') throw new RdfParseError('rdf_unsupported', 'a blank node as a predicate cannot be imported', this.at());
        return { kind: 'triple', subject, predicate, object: this.term(raw.object!) } satisfies TripleTerm;
      }
      default: throw new RdfParseError('rdf_unsupported', `a ${raw.termType} cannot be imported`, this.at());
    }
  }

  private iri(value: string): IriTerm {
    if (value.length > this.bounds.maxTokenChars) throw overBound('maxTokenChars', this.bounds.maxTokenChars, 'an address', this.place());
    if (!ABSOLUTE_IRI.test(value) && !this.relativeOk()) {
      throw new RdfParseError('rdf_relative_iri', `the address "${cut(value)}" is relative and no base address is given`, { address: value, ...this.at() });
    }
    return { kind: 'iri', value };
  }

  private literal(raw: RdfJsTerm): LiteralTerm {
    if (raw.value.length > this.bounds.maxLiteralChars) throw overBound('maxLiteralChars', this.bounds.maxLiteralChars, 'a literal', this.place());
    if (raw.language) {
      if (raw.language.length > this.bounds.maxTokenChars) throw overBound('maxTokenChars', this.bounds.maxTokenChars, 'a language tag', this.place());
      return { kind: 'literal', value: raw.value, language: raw.direction ? `${raw.language}--${raw.direction}` : raw.language };
    }
    const datatype = raw.datatype?.value;
    if (datatype === undefined || datatype === xsd('string')) return { kind: 'literal', value: raw.value };
    return { kind: 'literal', value: raw.value, datatype: this.iri(datatype).value };
  }
}

// ── Turtle, TriG, N-Quads ────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of n3's token the reader reads: a line, and a zero-based start column. */
interface N3Token { type: string; value: string; line: number; start: number }
interface N3Error extends Error { context?: { token?: N3Token; line?: number; previousToken?: { line: number; end: number } } }
interface N3Callbacks { onQuad: (error: N3Error | null, quad: RdfJsTerm | null) => void; onToken: (token: N3Token) => void }
/** The one method of n3's parser the reader uses, and the stream-shaped input it takes. */
interface N3ParserSurface { parse(input: { on(event: string, callback: (data?: string) => void): void }, callbacks: N3Callbacks): void }

const N3_FORMAT_NAMES: Readonly<Record<'turtle' | 'trig' | 'nquads', string>> = Object.freeze({ turtle: 'Turtle', trig: 'TriG', nquads: 'N-Quads' });

/** The place of an error n3 reports: its token, else the text it names on its line. */
function n3Place(error: N3Error, where: Where): RdfPlace | undefined {
  const context = error.context;
  const token = context?.token;
  if (token && Number.isInteger(token.line) && Number.isInteger(token.start)) return { line: token.line, column: token.start + 1 };
  const line = context?.line;
  if (!line) return undefined;
  const issue = /^Unexpected "([\s\S]*)" on line \d+\.$/.exec(error.message)?.[1];
  const held = where.lineText(line);
  if (issue && held) {
    const previous = context?.previousToken;
    const from = previous && previous.line === line ? Math.max(previous.end - held.offset, 0) : 0;
    const at = held.text.indexOf(issue, from);
    if (at !== -1) return { line, column: held.offset + at + 1 };
  }
  return { line };
}

async function* n3Quads(pieces: AsyncIterable<string>, format: 'turtle' | 'trig' | 'nquads', prefix: string, bounds: RdfParseBounds, where: Where): AsyncGenerator<Quad> {
  let failure: N3Error | undefined;
  let last: N3Token | undefined;
  let baseDeclared = false;
  let expectingBase = false;
  const here = (): RdfPlace | undefined => (last ? { line: last.line, column: last.start + 1 } : undefined);
  const terms = new Terms(prefix, bounds, () => baseDeclared, here);
  const found: RdfJsTerm[] = [];
  const check = (token: N3Token): void => {
    last = token;
    const place = { line: token.line, column: token.start + 1 };
    if (token.type === '@base' || token.type === 'BASE') { expectingBase = true; return; }
    if (token.type === 'IRI' || token.type === 'typeIRI') {
      if (token.value.length > bounds.maxTokenChars) throw overBound('maxTokenChars', bounds.maxTokenChars, 'an address', place);
      const relative = !ABSOLUTE_IRI.test(token.value);
      if (relative && (expectingBase || !baseDeclared)) {
        throw new RdfParseError('rdf_relative_iri', `the address "${cut(token.value)}" is relative and no base address is given`, { address: token.value, place });
      }
      if (expectingBase) baseDeclared = true;
    } else if ((token.type === 'blank' || token.type === 'langcode') && token.value.length > bounds.maxTokenChars) {
      throw overBound('maxTokenChars', bounds.maxTokenChars, token.type === 'blank' ? 'a blank-node label' : 'a language tag', place);
    }
    expectingBase = false;
  };
  const parser = new (N3Parser as unknown as new (options: object) => N3ParserSurface)({
    format: N3_FORMAT_NAMES[format],
    blankNodePrefix: 'l',
    factory: blankFactory(false),
  });
  let feed: (data: string) => void = () => undefined;
  let finish: () => void = () => undefined;
  parser.parse({ on: (event, callback) => { if (event === 'data') feed = callback as (data: string) => void; else if (event === 'end') finish = callback as () => void; } }, {
    onQuad: (error, quad) => { if (error) failure ??= error; else if (quad) found.push(quad); },
    onToken: check,
  });
  const fail = (error: N3Error): RdfParseError => new RdfParseError('rdf_malformed', cut(error.message), (() => { const place = n3Place(error, where); return place ? { place } : {}; })());
  let unparsed = 0;
  for await (const piece of pieces) {
    feed(piece);
    if (failure) throw fail(failure);
    if (found.length) {
      unparsed = 0;
      for (const raw of found.splice(0)) yield terms.quad(raw);
    } else {
      unparsed += piece.length;
      if (unparsed > bounds.maxUnparsedChars) throw overBound('maxUnparsedChars', bounds.maxUnparsedChars, 'text that completes no statement', where.now());
    }
  }
  finish();
  if (failure) throw fail(failure);
  for (const raw of found.splice(0)) yield terms.quad(raw);
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the JSON-LD library's context loader asks of its loader. */
interface RefusingLoader { load(url: string): Promise<never> }

/** A loader that answers no address: it notes the first one asked for and fails, so the parse stops and the reader can name it. */
function refusingLoader(refused: { address?: string }): RefusingLoader {
  return { load: async (url: string): Promise<never> => { refused.address ??= url; throw new Error(`a remote context is never fetched: ${url}`); } };
}

/** Finds the first character after the JSON-LD document's top-level value has closed: the library reads on past it. */
class AfterDocument {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private done = false;
  /** The index in `text` of the first non-whitespace character after the document, if there is one. */
  feed(text: string): number | undefined {
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (this.done) { if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') return i; continue; }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.inString = false;
      } else if (c === '"') this.inString = true;
      else if (c === '{' || c === '[') this.depth += 1;
      else if (c === '}' || c === ']') { this.depth -= 1; if (this.depth <= 0) this.done = true; }
    }
    return undefined;
  }
}

/** The library's error as a refusal. */
function jsonLdRefusal(error: Error, refused: { address?: string }, where: Where): RdfParseError {
  if (refused.address !== undefined) {
    return new RdfParseError('rdf_remote_context', `the document names the remote context ${cut(refused.address)}, which is never fetched: put its terms inline in the document's @context`, { address: refused.address });
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'invalid streaming key order') {
    return new RdfParseError('rdf_jsonld_not_streamable', `the document is not in streaming order: a @context must be the first key of its object, and an @id and @type must come before the properties (${cut(error.message)})`, { place: where.now() });
  }
  const unclosed = /^Unclosed document/.test(error.message);
  const offset = /^Unexpected "[\s\S]*" at position (\d+)/.exec(error.message)?.[1];
  const place = (offset !== undefined ? where.inLastAtByte(Number(offset)) : undefined) ?? where.now();
  const address = /^Invalid (?:resource|term|predicate) IRI: ([\s\S]*)$/.exec(error.message)?.[1]
    ?? /^Invalid IRI mapping found for context entry '[^']*': '"?([\s\S]*?)"?'$/.exec(error.message)?.[1];
  if (address !== undefined && !ABSOLUTE_IRI.test(address)) {
    return new RdfParseError('rdf_relative_iri', `the address "${cut(address)}" is relative (no base address is given) or a term the context does not define`, { address, place });
  }
  return new RdfParseError('rdf_malformed', unclosed ? 'the JSON-LD document ends before its value is closed' : cut(error.message), { place });
}

/** The part of a JSON-LD parser the reader uses. */
interface JsonLdSurface extends Eventful {
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
  on(event: 'data', listener: (quad: RdfJsTerm) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

async function* jsonLdQuads(pieces: AsyncIterable<string>, prefix: string, bounds: RdfParseBounds, where: Where): AsyncGenerator<Quad> {
  const refused: { address?: string } = {};
  const parser = new JsonLdParser({
    streamingProfile: true,
    // A plain @type after the @id adds a statement about a subject already known; only a type with a context of its own, which would change how the
    // keys already read are understood, is out of order.
    streamingProfileAllowOutOfOrderPlainType: true,
    strictValues: true,
    dataFactory: blankFactory(true) as never,
    documentLoader: refusingLoader(refused),
  }) as unknown as JsonLdSurface;
  const queue: RdfJsTerm[] = [];
  let failure: Error | undefined;
  let ended = false;
  let quads = 0;
  let wake: (() => void) | undefined;
  const changed = (): Promise<void> => new Promise<void>((resolve) => { wake = resolve; });
  const poke = (): void => { const resume = wake; wake = undefined; resume?.(); };
  parser.on('data', (quad) => { queue.push(quad); quads += 1; poke(); });
  parser.on('error', (error) => { failure ??= error; poke(); });
  parser.on('end', () => { ended = true; poke(); });
  parser.on('close', poke);
  const terms = new Terms(prefix, bounds, () => false, () => where.now());
  const after = new AfterDocument();
  let unparsed = 0;
  let seen = 0;
  try {
    for await (const piece of pieces) {
      const extra = after.feed(piece);
      if (extra !== undefined) throw new RdfParseError('rdf_malformed', 'content follows the end of the JSON-LD document', { place: where.inLast(extra) });
      if (!failure && !parser.write(Buffer.from(piece, 'utf8'))) await settled(parser);
      // The library reports a failure, and finishes its asynchronous jobs, on later turns: wait for them, so a failure is seen against the piece it came from.
      await yieldToEventLoop();
      while (queue.length) yield terms.quad(queue.shift()!);
      if (failure) throw jsonLdRefusal(failure, refused, where);
      if (quads !== seen) { seen = quads; unparsed = 0; } else {
        unparsed += piece.length;
        if (unparsed > bounds.maxUnparsedChars) throw overBound('maxUnparsedChars', bounds.maxUnparsedChars, 'text that completes no statement', where.now());
      }
    }
    parser.end();
    for (;;) {
      while (queue.length) yield terms.quad(queue.shift()!);
      if (failure) throw jsonLdRefusal(failure, refused, where);
      if (ended) return;
      await changed();
    }
  } finally {
    parser.destroy();
  }
}

// ── The door ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The quads of one RDF document, in document order. `source` is a byte stream (a gzipped body is told by its magic bytes); `format` is one of
 * {@link RDF_FORMATS}. Throws {@link RdfParseError} from the iteration for a document it refuses, and destroys `source` however the iteration
 * ends.
 */
export async function* parseRdf(source: AsyncIterable<Uint8Array | string>, format: RdfFormat, options: ParseRdfOptions = {}): AsyncGenerator<Quad, void, undefined> {
  try {
    if (!RDF_FORMATS.includes(format)) throw new RdfParseError('rdf_unsupported_format', `"${cut(String(format))}" is not an RDF format the import reads (${RDF_FORMATS.join(', ')})`);
    const bounds = resolveBounds(options.bounds);
    const prefix = options.blankNodePrefix ?? RDF_DEFAULT_BLANK_NODE_PREFIX;
    const where = new Where();
    const text = textOf(documentBytes(source, bounds), where);
    if (format === 'jsonld') {
      yield* jsonLdQuads(text, prefix, bounds, where);
    } else {
      const lines = async function* (): AsyncGenerator<string> {
        for await (const piece of text) { checkLines(where, bounds); yield piece; }
      };
      yield* n3Quads(lines(), format, prefix, bounds, where);
    }
  } finally {
    const stream = source as { destroy?: () => void };
    if (typeof stream.destroy === 'function') stream.destroy();
  }
}
