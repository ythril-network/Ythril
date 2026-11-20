/**
 * How the import parser's tests hand it a document and read what it answers (bundle-270, slice S1).
 *
 * ## The contract it encodes, written before the parser
 *
 * `parseRdf(source, format, options?)` of `server/src/rdf/parse.ts` takes a byte stream (any async iterable of `Buffer`s or strings; a gzipped
 * body is told by its magic bytes) and a format (`turtle`, `trig`, `nquads`, `jsonld`), and yields the model's `Quad`s. A document it cannot read
 * is refused by throwing an `RdfParseError` (`name`, `code`, `message`, and, where they apply, `place: { line, column }` (1-based), `bound`
 * (the constant's name) and `address`), from the iteration, never as an event nobody listens to.
 *
 * What the helpers decide once: a document reaches the parser in chunks that split lines, tokens and UTF-8 characters, because a parser that
 * is only tried on one whole chunk has not been tried on a stream.
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

export const parseModule = await import('../../server/dist/rdf/parse.js').catch(() => ({}));

/** The parser's one entry, asked for inside each case so a case fails on its own rule when the module is missing. */
export function parseRdf(source, format, options) {
  assert.equal(typeof parseModule.parseRdf, 'function', 'parseRdf is not exported by server/src/rdf/parse.ts: there is no import parser');
  return parseModule.parseRdf(source, format, options);
}

/** A byte stream over `chunks` (Buffers or strings). */
export const sourceOf = (chunks) => Readable.from(chunks.map(c => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c)), { objectMode: false });

/** `data` (a string or a Buffer) cut into pieces of `size` bytes, which split tokens, lines and multi-byte characters. */
export function pieces(data, size) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const out = [];
  for (let at = 0; at < buf.length; at += size) out.push(buf.subarray(at, at + size));
  return out;
}

/** Every quad the parser yields for `source`. */
export async function readQuads(format, source, options) {
  const out = [];
  for await (const quad of parseRdf(source, format, options)) out.push(quad);
  return out;
}

/** The refusal the parser throws for `source`; fails when it reads the document through. */
export async function refusalOf(format, source, options) {
  try {
    await readQuads(format, source, options);
  } catch (err) {
    assert.equal(err?.name, 'RdfParseError', `the parser threw ${err?.name}: ${err?.message}, not a refusal a caller can show`);
    return err;
  }
  assert.fail(`the parser read the whole document (${format}) and refused nothing`);
  return undefined;
}

/** The 1-based line and column of the first `needle` in `text` (columns count UTF-16 units, as the parser's do). */
export function placeOf(text, needle) {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `${needle} is not in the document`);
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  return { line, column: at - (before.lastIndexOf('\n') + 1) + 1 };
}

/** A canonical string for a read term (the same shape for a model term), so term sets compare with `deepEqual`. */
export function canon(term) {
  if (term.kind === 'iri') return `<${term.value}>`;
  if (term.kind === 'blank') return `_:${term.id}`;
  if (term.kind === 'literal') return JSON.stringify([term.value, term.datatype ?? null, term.language ?? null]);
  if (term.kind === 'triple') return `<<( ${canon(term.subject)} ${canon(term.predicate)} ${canon(term.object)} )>>`;
  throw new Error(`no canonical string for ${term.kind}`);
}

/** A canonical string for a quad, its graph included. */
export const canonQuad = (quad) => `${canon(quad.subject)} ${canon(quad.predicate)} ${canon(quad.object)} ${quad.graph ? canon(quad.graph) : '-'}`;

/**
 * A document as pieces made on demand, never held whole: `head`, then `count` items (`item(k)`, `group` to a piece, comma-separated), then `tail`.
 * `fed.n` counts the characters handed to the reader, so a case can say how much of the document was fed when a statement came.
 */
export function lazyDocument(head, count, item, tail, fed, group = 1) {
  return Readable.from((function* () {
    fed.n += head.length; yield Buffer.from(head);
    for (let k = 0; k < count; k += group) {
      let s = '';
      for (let j = k; j < Math.min(k + group, count); j += 1) s += `${j === 0 ? '' : ','}${item(j)}`;
      fed.n += s.length; yield Buffer.from(s);
    }
    fed.n += tail.length; yield Buffer.from(tail);
  })(), { objectMode: false });
}
