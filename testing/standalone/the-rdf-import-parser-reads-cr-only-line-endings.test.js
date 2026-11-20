/**
 * A valid file with CR-only line endings is read, and a real over-long line is still refused (bundle-270 review F6, slice S1).
 *
 * ## The defect
 *
 * The reader counts a line to its bound (`RDF_MAX_LINE_CHARS`, 1 MiB) by splitting on LF alone, so a Turtle, TriG or N-Quads file over 1 MiB
 * whose lines end in a lone CR (old Mac files, and valid: a carriage return is white space in all three) counted as ONE line and was refused
 * with the line bound.
 *
 * ## What it holds
 *
 * A document of short statements over the line bound in total, ended by CR alone, by CRLF or by LF alone, yields every quad in all three
 * text formats; a statement that is itself longer than the bound is still refused as RDF_MAX_LINE_CHARS whichever way its lines end.
 *
 * Run: node --test testing/standalone/the-rdf-import-parser-reads-cr-only-line-endings.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModule, readQuads, refusalOf, sourceOf, pieces } from './_rdf-parse-doors.mjs';

const LINES = 13_000;
const statement = (format, n) => (format === 'nquads'
  ? `<http://a/s${n}> <http://a/p> "a value of some length, number ${n}, padded to make the lines a hundred characters" .`
  : `<http://a/s${n}> <http://a/p> "a value of some length, number ${n}, padded to make the lines a hundred characters" .`);
const FORMATS = ['turtle', 'trig', 'nquads'];
const ENDINGS = [['CR alone', '\r'], ['CRLF', '\r\n'], ['LF alone', '\n']];

function document(format, ending, count) {
  const out = [];
  for (let n = 0; n < count; n += 1) out.push(statement(format, n));
  return out.join(ending) + ending;
}

describe('a valid file over the line bound in total is read whatever ends its lines', () => {
  for (const format of FORMATS) {
    for (const [name, ending] of ENDINGS) {
      it(`${format}, ${name}: every statement is read`, async () => {
        const maxLine = parseModule.RDF_MAX_LINE_CHARS;
        const text = document(format, ending, LINES);
        assert.ok(text.length > maxLine, `the document (${text.length}) must be over the line bound (${maxLine}) in total`);
        const quads = await readQuads(format, sourceOf(pieces(text, 64 * 1024)));
        assert.equal(quads.length, LINES, `${quads.length} of ${LINES} statements were read`);
      });
    }
  }
});

describe('a line that is itself over the bound is still refused', () => {
  for (const format of FORMATS) {
    for (const [name, ending] of ENDINGS) {
      it(`${format}, ${name}: a statement longer than the bound is refused as RDF_MAX_LINE_CHARS`, async () => {
        const long = `<http://a/s> <http://a/p> "${'x'.repeat(parseModule.RDF_MAX_LINE_CHARS + 10)}" .`;
        const text = `${statement(format, 1)}${ending}${long}${ending}${statement(format, 2)}${ending}`;
        const err = await refusalOf(format, sourceOf(pieces(text, 64 * 1024)), { bounds: { maxLiteralChars: 10_000_000 } });
        assert.equal(err.code, 'rdf_bound_exceeded');
        assert.equal(err.bound, 'RDF_MAX_LINE_CHARS', `${err.bound}: ${err.message}`);
      });
    }
  }
});
