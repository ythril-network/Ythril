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
 * - **A JSON-LD array the library would hold.** The library keeps the whole root object it reads, and holds a root `@graph` array's statements
 *   until the root closes, so the product's own export (`{"@context", "@graph": [nodes]}`) would be held whole. A document that ends within
 *   `RDF_MAX_UNPARSED_CHARS` is read whole, whatever its shape and key order. One that passes it as a root of only a `@context`, an `@id` and a
 *   `@graph` array is read again from its start: {@link GraphArrayScanner} takes the root apart and {@link GraphReader} gives the library a few
 *   nodes at a time, each batch the document in miniature, and a key after the array is refused by name (`rdf_jsonld_not_streamable`); any
 *   other shape stays whole under the bounds, and a root with properties of its own is refused by name over them.
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
import { DEFAULT_IMPORT_BODY_MAX_BYTES } from '../config/body-limits.js';
import { GraphArrayScanner, GraphScanRefusal, placeAfter, type GraphEvent, type GraphPlace } from './jsonld-graph-scan.js';
import { CHUNK_CHARS, Where, charIndexAtByte, type RdfPlace } from './parse-where.js';

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
export const RDF_MAX_INFLATED_BYTES = DEFAULT_IMPORT_BODY_MAX_BYTES;
/** The prefix of a blank node's id when the caller names none. */
export const RDF_DEFAULT_BLANK_NODE_PREFIX = 'in-';
/** The codes zlib gives a body that is not valid gzip: corrupt (`Z_DATA_ERROR`), cut short (`Z_BUF_ERROR`), or one the engine cannot inflate. Named, never matched by prefix or wording. */
const ZLIB_FAILURES: ReadonlySet<string> = new Set(['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_STREAM_ERROR', 'Z_NEED_DICT', 'Z_MEM_ERROR', 'Z_VERSION_ERROR']);
/** The units that open a surrogate pair: a piece never ends on one, so a pair is never cut between two parsers' writes. */
const HIGH_SURROGATES = Object.freeze({ first: 0xd800, last: 0xdbff });

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

export type { RdfPlace };

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
function blankFactory(markLabels: boolean, counter: { next: number } = { next: 0 }): object {
  return {
    ...N3Factory,
    blankNode: (name?: string) => N3Factory.blankNode(name === undefined ? `~${counter.next++}` : markLabels ? `l${name}` : name),
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

/** The library's error as a refusal; `locate` turns the byte offset the tokenizer names (when it names one) into a place of the document. */
function jsonLdRefusal(error: Error, refused: { address?: string }, locate: (byteOffset: number | undefined) => RdfPlace): RdfParseError {
  if (refused.address !== undefined) {
    return new RdfParseError('rdf_remote_context', `the document names the remote context ${cut(refused.address)}, which is never fetched: put its terms inline in the document's @context`, { address: refused.address });
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'invalid streaming key order') {
    return new RdfParseError('rdf_jsonld_not_streamable', `the document is not in streaming order: a @context must be the first key of its object, and an @id and @type must come before the properties (${cut(error.message)})`, { place: locate(undefined) });
  }
  const unclosed = /^Unclosed document/.test(error.message);
  const offset = /^Unexpected "[\s\S]*" at position (\d+)/.exec(error.message)?.[1];
  const place = locate(offset === undefined ? undefined : Number(offset));
  const address = /^Invalid (?:resource|term|predicate) IRI: ([\s\S]*)$/.exec(error.message)?.[1]
    ?? /^Invalid IRI mapping found for context entry '[^']*': '"?([\s\S]*?)"?'$/.exec(error.message)?.[1];
  if (address !== undefined && !ABSOLUTE_IRI.test(address)) {
    return new RdfParseError('rdf_relative_iri', `the address "${cut(address)}" is relative (no base address is given) or a term the context does not define`, { address, place });
  }
  return new RdfParseError('rdf_malformed', unclosed ? 'the JSON-LD document ends before its value is closed' : cut(error.message), { place });
}

/** The part of a JSON-LD parser the reader uses. */
interface JsonLdSurface extends Eventful {
  write(chunk: Buffer, callback?: () => void): boolean;
  end(): void;
  destroy(): void;
  on(event: 'data', listener: (quad: RdfJsTerm) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The one place a JSON-LD parser is built: a streaming profile, strict values, the given blank-node numbering, and a loader that fetches nothing. */
function newJsonLdParser(factory: object, refused: { address?: string }): JsonLdSurface {
  return new JsonLdParser({
    streamingProfile: true,
    // A plain @type after the @id adds a statement about a subject already known; only a type with a context of its own, which would change how the
    // keys already read are understood, is out of order.
    streamingProfileAllowOutOfOrderPlainType: true,
    strictValues: true,
    dataFactory: factory as never,
    documentLoader: refusingLoader(refused),
  }) as unknown as JsonLdSurface;
}

/** A scanner's refusal as the reader's own. */
function refusalOfScan(error: unknown, bounds: RdfParseBounds): unknown {
  if (!(error instanceof GraphScanRefusal)) return error;
  if (error.kind === 'too-long') return overBound('maxUnparsedChars', bounds.maxUnparsedChars, 'a node of the @graph array', error.place);
  return new RdfParseError(error.kind === 'not-streamable' ? 'rdf_jsonld_not_streamable' : 'rdf_malformed', error.message, { place: error.place });
}

/** One library document: a few nodes of the array under the root's `@context` and `@id`, written to a parser of its own and read to its end. */
interface Batch {
  parser: JsonLdSurface;
  queue: RdfJsTerm[];
  counter: { next: number };
  failure?: Error;
  ended: boolean;
  wake?: () => void;
  count: number;
  chars: number;
}

/**
 * Reads the nodes of a root `@graph` array (the events of a {@link GraphArrayScanner}) by giving the library, for every few nodes, a document
 * of its own: `{"@context": <the root's>, "@id": <the root's>, "@graph": [ node, node, ... ]}`. That is the document in miniature, so the
 * statements and graphs are those of the whole reading, and the library holds one batch at a time.
 *
 * What a split could get wrong, and where it is held: a blank-node LABEL is the document's (one prefix-and-label name whichever batch it is in);
 * an anonymous node is numbered by one counter across the batches, and a root with no `@id` costs each batch one blank node (the name the
 * library gives its graph) which is taken back, so the numbers are the whole reading's; a batch ends at {@link CHUNK_CHARS} of nodes, or
 * at the context's length when that is more, so the context is parsed once per piece of document of its own size.
 */
class GraphReader {
  private batch: Batch | undefined;
  /** The number the next anonymous node is given: the counter at the end of the last batch, less the node that batch spent on its graph's name. */
  private anonymous = 0;
  private opened = 0;
  private place: GraphPlace;
  private readonly terms: Terms;
  private readonly header: string;
  private readonly headPlace: GraphPlace;
  private readonly batchChars: number;
  private readonly spentOnGraphName: number;

  constructor(head: Extract<GraphEvent, { kind: 'head' }>, prefix: string, bounds: RdfParseBounds, private readonly refused: { address?: string }) {
    this.place = head.place;
    this.headPlace = head.place;
    this.terms = new Terms(prefix, bounds, () => false, () => this.place);
    this.header = `{${head.context === undefined ? '' : `"@context":${head.context},`}${head.id === undefined ? '' : `"@id":${head.id},`}"@graph":[`;
    this.batchChars = Math.max(CHUNK_CHARS, head.context?.length ?? 0);
    this.spentOnGraphName = head.id === undefined ? 1 : 0;
  }

  async *take(events: GraphEvent[]): AsyncGenerator<Quad> {
    for (const event of events) {
      if (event.kind === 'node') yield* this.node(event.text, event.place);
      else if (event.kind === 'end') yield* this.end();
    }
  }

  private async *node(text: string, place: GraphPlace): AsyncGenerator<Quad> {
    this.place = place;
    const batch = this.batch ?? await this.start();
    const chunk = `${batch.count === 0 ? '' : ','}${text}`;
    await this.write(batch, chunk, place, batch.count === 0 ? 0 : 1);
    batch.count += 1;
    batch.chars += text.length;
    yield* this.drain(batch);
    if (batch.chars >= this.batchChars) yield* this.close();
  }

  /** The document ended: the last batch is closed, and a document with no node at all still has its `@context` read. */
  private async *end(): AsyncGenerator<Quad> {
    if (this.opened === 0) await this.start();
    yield* this.close();
  }

  private async start(): Promise<Batch> {
    const counter = { next: this.anonymous };
    const parser = newJsonLdParser(blankFactory(true, counter), this.refused);
    const batch: Batch = { parser, queue: [], counter, ended: false, count: 0, chars: 0 };
    const poke = (): void => { const resume = batch.wake; batch.wake = undefined; resume?.(); };
    parser.on('data', (quad) => { batch.queue.push(quad); });
    parser.on('error', (error) => { batch.failure ??= error; poke(); });
    parser.on('end', () => { batch.ended = true; poke(); });
    parser.on('close', poke);
    this.batch = batch;
    this.opened += 1;
    await this.write(batch, this.header, this.headPlace, 0);
    return batch;
  }

  /** Writes `chunk` and waits until the library has read it; its failure is refused with the place `skip` characters into `chunk` from `start`. */
  private async write(batch: Batch, chunk: string, start: GraphPlace, skip: number): Promise<void> {
    if (!batch.failure) await new Promise<void>((resolve) => { batch.wake = resolve; batch.parser.write(Buffer.from(chunk, 'utf8'), () => resolve()); });
    batch.wake = undefined;
    if (!batch.failure) return;
    throw jsonLdRefusal(batch.failure, this.refused, (offset) => {
      const index = offset === undefined ? undefined : charIndexAtByte(chunk, offset);
      return index === undefined || index < skip ? start : placeAfter(start, chunk.slice(skip), index - skip);
    });
  }

  private *drain(batch: Batch): Generator<Quad> {
    for (const raw of batch.queue.splice(0)) yield this.terms.quad(raw);
  }

  private async *close(): AsyncGenerator<Quad> {
    const batch = this.batch;
    if (!batch) return;
    this.batch = undefined;
    try {
      await this.write(batch, ']}', this.place, 0);
      batch.parser.end();
      while (!batch.ended && !batch.failure) await new Promise<void>((resolve) => { batch.wake = resolve; });
      if (batch.failure) throw jsonLdRefusal(batch.failure, this.refused, () => this.place);
      yield* this.drain(batch);
    } finally {
      batch.parser.destroy();
    }
    this.anonymous = batch.counter.next - this.spentOnGraphName;
    await yieldToEventLoop();
  }
}

/** The library's own way: the whole document handed to one parser, piece by piece, under the unparsed-text bound. */
class WholeRead {
  private readonly parser: JsonLdSurface;
  private readonly queue: RdfJsTerm[] = [];
  private failure: Error | undefined;
  private ended = false;
  private quads = 0;
  private seen = 0;
  private unparsed = 0;
  private holdsGraph = false;
  private wake: (() => void) | undefined;
  private readonly terms: Terms;
  private readonly after = new AfterDocument();
  /** Its own, fed in step with the parser: a document held and read again is placed by the pieces it is read in. */
  private readonly where = new Where();

  constructor(prefix: string, private readonly bounds: RdfParseBounds, private readonly refused: { address?: string }) {
    this.parser = newJsonLdParser(blankFactory(true), refused);
    const poke = (): void => { const resume = this.wake; this.wake = undefined; resume?.(); };
    this.parser.on('data', (quad) => { this.queue.push(quad); this.quads += 1; poke(); });
    this.parser.on('error', (error) => { this.failure ??= error; poke(); });
    this.parser.on('end', () => { this.ended = true; poke(); });
    this.parser.on('close', poke);
    this.terms = new Terms(prefix, bounds, () => false, () => this.where.now());
  }

  private locate = (offset: number | undefined): RdfPlace => (offset === undefined ? undefined : this.where.inLastAtByte(offset)) ?? this.where.now();

  async *piece(piece: string): AsyncGenerator<Quad> {
    this.where.feed(piece);
    const extra = this.after.feed(piece);
    if (extra !== undefined) throw new RdfParseError('rdf_malformed', 'content follows the end of the JSON-LD document', { place: this.where.inLast(extra) });
    if (!this.failure && !this.parser.write(Buffer.from(piece, 'utf8'))) await settled(this.parser);
    // The library reports a failure, and finishes its asynchronous jobs, on later turns: wait for them, so a failure is seen against the piece it came from.
    await yieldToEventLoop();
    while (this.queue.length) yield this.terms.quad(this.queue.shift()!);
    if (this.failure) throw jsonLdRefusal(this.failure, this.refused, this.locate);
    if (this.quads !== this.seen) { this.seen = this.quads; this.unparsed = 0; return; }
    this.unparsed += piece.length;
    // The library holds the statements of a `@graph` array in a root of its own (properties, or an alias for `@graph`) until the root closes,
    // so over the bound such a document is not "no statement yet" but one that cannot be read as a stream (review U6).
    if (this.quads === 0 && !this.holdsGraph) this.holdsGraph = piece.includes('"@graph"');
    if (this.unparsed <= this.bounds.maxUnparsedChars) return;
    if (this.holdsGraph) {
      throw new RdfParseError('rdf_jsonld_not_streamable', `the document's @graph array sits in a root that is more than a @context, an @id and the array (it has properties of its own, or @graph is an alias), so it is read whole before any statement is released, and it is over ${this.bounds.maxUnparsedChars} characters: split the data into several documents, or send it as Turtle, TriG or N-Quads`, { place: this.where.now() });
    }
    throw overBound('maxUnparsedChars', this.bounds.maxUnparsedChars, 'text that completes no statement', this.where.now());
  }

  async *finish(): AsyncGenerator<Quad> {
    this.parser.end();
    for (;;) {
      while (this.queue.length) yield this.terms.quad(this.queue.shift()!);
      if (this.failure) throw jsonLdRefusal(this.failure, this.refused, this.locate);
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  destroy(): void { this.parser.destroy(); }
}

/**
 * Reads a JSON-LD document. A document that ends within `maxUnparsedChars` is read whole by the library, whatever its shape and key order. The
 * text is held until it passes that bound (or the shape is known not to be a root `@graph` array); one that passes it as a root of only a
 * `@context`, an `@id` and a `@graph` array is read again from its start by {@link GraphArrayScanner} and {@link GraphReader}, a node at a
 * time, where a key after the array is refused by name. Anything else is read whole under the bound, as ever.
 */
async function* jsonLdQuads(pieces: AsyncIterable<string>, prefix: string, bounds: RdfParseBounds): AsyncGenerator<Quad> {
  const refused: { address?: string } = {};
  const probe = new GraphArrayScanner(bounds.maxUnparsedChars);
  /** What the probe refused while the text was held (a key after the array): over the bound it is the refusal, within it the library decides. */
  let probeRefusal: unknown;
  const held: string[] = [];
  let heldChars = 0;
  let route = 'holding' as 'holding' | 'whole' | 'stream';
  let whole = undefined as WholeRead | undefined;
  let scan = undefined as GraphArrayScanner | undefined;
  let reader = undefined as GraphReader | undefined;
  /** Whether the route is `which`: asked through a function, since the generators below change it where a flow analysis cannot see. */
  const routeIs = (which: typeof route): boolean => route === which;

  const readWhole = async function* (): AsyncGenerator<Quad> {
    route = 'whole';
    whole = new WholeRead(prefix, bounds, refused);
    for (const piece of held.splice(0)) yield* whole.piece(piece);
  };
  const readStream = async function* (piece: string): AsyncGenerator<Quad> {
    scan ??= new GraphArrayScanner(bounds.maxUnparsedChars);
    let events: GraphEvent[];
    try { events = scan.feed(piece); } catch (err) { throw refusalOfScan(err, bounds); }
    const head = events.find((event): event is Extract<GraphEvent, { kind: 'head' }> => event.kind === 'head');
    if (head) reader = new GraphReader(head, prefix, bounds, refused);
    // Pieces before the array begins complete no event: there is no reader yet, and nothing for it to take.
    if (reader) { try { yield* reader.take(events); } catch (err) { throw refusalOfScan(err, bounds); } }
  };

  try {
    for await (const piece of pieces) {
      if (routeIs('whole')) { yield* whole!.piece(piece); continue; }
      if (routeIs('stream')) { yield* readStream(piece); continue; }
      held.push(piece);
      heldChars += piece.length;
      if (probeRefusal === undefined) { try { probe.feed(piece); } catch (err) { probeRefusal = err; } }
      const isStream = probe.mode === 'graph' || probeRefusal !== undefined;
      if (!isStream && probe.mode === 'library') yield* readWhole();
      else if (heldChars > bounds.maxUnparsedChars) {
        if (!isStream) { yield* readWhole(); continue; }
        route = 'stream';
        for (const text of held.splice(0)) yield* readStream(text);
      }
    }
    if (routeIs('holding')) yield* readWhole();
    if (routeIs('stream')) {
      try { scan!.finish(); } catch (err) { throw refusalOfScan(err, bounds); }
      return;
    }
    yield* whole!.finish();
  } finally {
    whole?.destroy();
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
      yield* jsonLdQuads(text, prefix, bounds);
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
