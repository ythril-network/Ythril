/**
 * Every bound of the import parser refuses at one over and passes at the bound, naming itself (bundle-270, slice S1; amendment A6).
 *
 * ## The defect this prevents
 *
 * The parser reads a file a stranger made, inside the server: an unbounded token, an unbounded line, or a gzip body that inflates a thousand
 * fold is memory and time the author chooses. Each bound is a named constant of `server/src/rdf/parse.ts` with its reason, and a document over
 * it is refused as `rdf_bound_exceeded` with `bound` set to the constant's NAME, so the caller's answer says which one.
 *
 * ## What it holds, per bound
 *
 * - `RDF_MAX_LITERAL_CHARS`: a literal's value, in every format (the value, unescaped);
 * - `RDF_MAX_TOKEN_CHARS`: an address, a blank-node label, in every format (an address made by a prefix too);
 * - `RDF_MAX_LINE_CHARS`: a line of a text format (Turtle, TriG, N-Quads), the line end not counted; JSON-LD is one document and has no
 *   line, so a single line far over the bound is read;
 * - `RDF_MAX_UNPARSED_CHARS`: the characters fed since the last chunk that completed a statement, so a comment, an unterminated literal or
 *   whitespace cannot grow the reader's buffer without end;
 * - `RDF_MAX_INFLATE_RATIO` (with its floor `RDF_INFLATE_RATIO_FLOOR_BYTES`) and `RDF_MAX_INFLATED_BYTES`: a gzip body is refused once
 *   it has inflated past the ratio to the bytes read so far, or past the absolute cap, whichever comes first. The cap and the ratio are also
 *   options (`bounds`), so a caller with a lower ceiling passes it and these cases run on small bodies.
 *
 * The constants are read from the built module, never retyped here: a bound that is changed moves the case with it.
 * The built server is needed (`npm run build:server`). Run: node --test testing/standalone/the-rdf-import-parser-holds-its-bounds.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { parseModule, readQuads, refusalOf, sourceOf, pieces } from './_rdf-parse-doors.mjs';
import { XSD } from './_rdf-writer-fixtures.mjs';

const bound = (name) => {
  const value = parseModule[name];
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} is not an exported positive integer of server/src/rdf/parse.ts`);
  return value;
};
const exceeded = (err, name) => {
  assert.equal(err.code, 'rdf_bound_exceeded', `${err.code}: ${err.message}`);
  assert.equal(err.bound, name);
  assert.ok(err.message.includes(name), err.message);
};
const SIZES = [4096, 65536];

/** A document of each format with one statement whose object literal is `text`. */
const withLiteral = {
  nquads: (text) => `<http://a/s> <http://a/p> "${text}" .\n`,
  turtle: (text) => `<http://a/s> <http://a/p> "${text}" .\n`,
  trig: (text) => `<http://g> { <http://a/s> <http://a/p> "${text}" . }\n`,
  jsonld: (text) => JSON.stringify({ '@context': { p: 'http://a/p' }, '@id': 'http://a/s', p: text }),
};

describe('RDF_MAX_LITERAL_CHARS', () => {
  for (const format of ['nquads', 'turtle', 'trig', 'jsonld']) {
    it(`${format}: a literal of the bound is read, one more is refused`, async () => {
      const max = bound('RDF_MAX_LITERAL_CHARS');
      for (const size of SIZES) {
        const ok = await readQuads(format, sourceOf(pieces(withLiteral[format]('a'.repeat(max)), size)));
        assert.equal(ok.length, 1);
        assert.equal(ok[0].object.value.length, max);
        exceeded(await refusalOf(format, sourceOf(pieces(withLiteral[format]('a'.repeat(max + 1)), size))), 'RDF_MAX_LITERAL_CHARS');
      }
    });
  }
  it('the length is the value the literal has, not the text that spells it (an escape counts as the one character it stands for)', async () => {
    const max = bound('RDF_MAX_LITERAL_CHARS');
    const escaped = await readQuads('nquads', sourceOf([withLiteral.nquads('\\u0041'.repeat(max))]));
    assert.equal(escaped[0].object.value.length, max);
    exceeded(await refusalOf('nquads', sourceOf([withLiteral.nquads('\\n'.repeat(max + 1))])), 'RDF_MAX_LITERAL_CHARS');
  });
  it('a typed and a tagged literal are bounded alike', async () => {
    const max = bound('RDF_MAX_LITERAL_CHARS');
    exceeded(await refusalOf('nquads', sourceOf([`<http://a/s> <http://a/p> "${'a'.repeat(max + 1)}"@en .\n`])), 'RDF_MAX_LITERAL_CHARS');
    exceeded(await refusalOf('nquads', sourceOf([`<http://a/s> <http://a/p> "${'a'.repeat(max + 1)}"^^<${XSD}string> .\n`])), 'RDF_MAX_LITERAL_CHARS');
  });
});

describe('RDF_MAX_TOKEN_CHARS', () => {
  const addressOf = (length) => `http://a/${'p'.repeat(length - 'http://a/'.length)}`;
  const DOCS = {
    nquads: (iri) => `<http://a/s> <http://a/p> <${iri}> .\n`,
    turtle: (iri) => `<http://a/s> <http://a/p> <${iri}> .\n`,
    trig: (iri) => `<${iri}> { <http://a/s> <http://a/p> <http://a/o> . }\n`,
    jsonld: (iri) => JSON.stringify({ '@context': { p: 'http://a/p' }, '@id': 'http://a/s', p: { '@id': iri } }),
  };
  for (const format of ['nquads', 'turtle', 'trig', 'jsonld']) {
    it(`${format}: an address of the bound is read, one more is refused`, async () => {
      const max = bound('RDF_MAX_TOKEN_CHARS');
      for (const size of SIZES) {
        assert.equal((await readQuads(format, sourceOf(pieces(DOCS[format](addressOf(max)), size)))).length, 1);
        exceeded(await refusalOf(format, sourceOf(pieces(DOCS[format](addressOf(max + 1)), size))), 'RDF_MAX_TOKEN_CHARS');
      }
    });
  }
  it('an address a prefix makes is bounded as written out, and so is a blank-node label', async () => {
    const max = bound('RDF_MAX_TOKEN_CHARS');
    const ttl = (local) => `@prefix e: <http://a/> .\ne:s e:p e:${local} .\n`;
    assert.equal((await readQuads('turtle', sourceOf([ttl('x'.repeat(max - 'http://a/'.length))]))).length, 1);
    exceeded(await refusalOf('turtle', sourceOf([ttl('x'.repeat(max - 'http://a/'.length + 1))])), 'RDF_MAX_TOKEN_CHARS');
    const label = (n) => `_:${'b'.repeat(n)} <http://a/p> "x" .\n`;
    assert.equal((await readQuads('nquads', sourceOf([label(max)]))).length, 1);
    exceeded(await refusalOf('nquads', sourceOf([label(max + 1)])), 'RDF_MAX_TOKEN_CHARS');
  });
  it('the refusal of an address names the line and column it starts at', async () => {
    const max = bound('RDF_MAX_TOKEN_CHARS');
    const err = await refusalOf('nquads', sourceOf([`<http://a/s> <http://a/p> "x" .\n<http://a/s> <${addressOf(max + 1)}> "y" .\n`]));
    assert.deepEqual(err.place, { line: 2, column: 14 });
  });
});

describe('RDF_MAX_LINE_CHARS', () => {
  const QUAD = '<http://a/s> <http://a/p> "x" .\n';
  const commentOf = (length) => `#${'c'.repeat(length - 1)}\n`;
  for (const format of ['nquads', 'turtle', 'trig']) {
    it(`${format}: a line of the bound is read, one more is refused naming its line`, async () => {
      const max = bound('RDF_MAX_LINE_CHARS');
      for (const size of SIZES) {
        assert.equal((await readQuads(format, sourceOf(pieces(`${QUAD}${commentOf(max)}${QUAD}`, size)))).length, 2);
        const err = await refusalOf(format, sourceOf(pieces(`${QUAD}${commentOf(max + 1)}${QUAD}`, size)));
        exceeded(err, 'RDF_MAX_LINE_CHARS');
        assert.equal(err.place.line, 2);
      }
    });
  }
  it('a line is counted across chunks, and a long run with no line end at all is refused too', async () => {
    const max = bound('RDF_MAX_LINE_CHARS');
    exceeded(await refusalOf('nquads', sourceOf(pieces(`#${'c'.repeat(max)}`, 1000))), 'RDF_MAX_LINE_CHARS');
  });
  it('JSON-LD has no lines: one line far over the bound is read', async () => {
    const max = bound('RDF_MAX_LINE_CHARS');
    const nodes = Array.from({ length: Math.ceil((max * 2.4) / 40) }, (_, i) => ({ '@id': `http://a/s${i}`, p: 'x' }));
    const text = JSON.stringify({ '@context': { p: 'http://a/p' }, '@graph': nodes });
    // Over the line bound, and over the unparsed bound too: only the statements completing along the way keep it from being refused.
    assert.ok(text.length > max && text.length > bound('RDF_MAX_UNPARSED_CHARS') && !text.includes('\n'));
    assert.equal((await readQuads('jsonld', sourceOf(pieces(text, 65536)))).length, nodes.length);
  });
});

describe('RDF_MAX_UNPARSED_CHARS', () => {
  const QUAD = '<http://a/s> <http://a/p> "x" .\n';
  /** `count` characters of comment lines, in chunks of 64 Ki characters, then a chunk of its own holding a statement. */
  const comments = (count) => {
    const line = `#${'c'.repeat(1022)}\n`; // 1024 characters
    const rest = count % 1024;
    const text = line.repeat(Math.floor(count / 1024)) + (rest === 0 ? '' : `#${'c'.repeat(rest - 1)}`);
    assert.equal(text.length, count);
    return [...pieces(text, 65536), `${rest === 0 ? '' : '\n'}${QUAD}`]; // the text is ASCII: a piece of 65536 bytes is 65536 characters
  };
  it('a stretch of the bound that completes nothing is read when a statement follows, one more is refused', async () => {
    const max = bound('RDF_MAX_UNPARSED_CHARS');
    assert.equal(max % 1024, 0, 'the case below builds whole 1 KiB lines');
    assert.equal((await readQuads('nquads', sourceOf(comments(max)))).length, 1);
    exceeded(await refusalOf('nquads', sourceOf(comments(max + 1))), 'RDF_MAX_UNPARSED_CHARS');
  });
  it('an unterminated triple-quoted literal is refused before it is held whole', async () => {
    const max = bound('RDF_MAX_UNPARSED_CHARS');
    const body = `<http://a/s> <http://a/p> """${'line of a literal that never ends\n'.repeat(Math.ceil(max / 34) + 10)}`;
    exceeded(await refusalOf('turtle', sourceOf(pieces(body, 65536))), 'RDF_MAX_UNPARSED_CHARS');
  });
  it('a statement that completes resets the count', async () => {
    const max = bound('RDF_MAX_UNPARSED_CHARS');
    const line = `#${'c'.repeat(1022)}\n`;
    const block = line.repeat(Math.floor((max * 0.6) / 1024));
    const text = `${block}${QUAD}${block}${QUAD}${block}${QUAD}`;
    assert.equal((await readQuads('nquads', sourceOf(pieces(text, 8192)))).length, 3);
  });
  it('a JSON-LD document is bounded alike', async () => {
    const max = bound('RDF_MAX_UNPARSED_CHARS');
    const head = '{"@context": {"p": "http://a/p"}, "@id": "http://a/s", "p": "';
    exceeded(await refusalOf('jsonld', sourceOf(pieces(`${head}${'a'.repeat(max + 70000)}"}`, 65536))), 'RDF_MAX_UNPARSED_CHARS');
  });
});

describe('the gzip bounds', () => {
  const QUAD = '<http://a/s> <http://a/p> "x" .\n';
  /** An N-Quads body of exactly `size` bytes: comment lines, then one statement. */
  const body = (size) => {
    const lines = [];
    let length = 0;
    while (size - length - QUAD.length > 0) {
      const n = Math.min(1024, size - length - QUAD.length);
      lines.push(n === 1 ? '\n' : `#${'c'.repeat(n - 2)}\n`);
      length += n;
    }
    const text = lines.join('') + QUAD;
    assert.equal(text.length, size);
    return Buffer.from(text, 'utf8');
  };

  it('RDF_MAX_INFLATED_BYTES: a body that inflates to the bound is read, one byte more is refused', async () => {
    const size = 300_000;
    const zipped = gzipSync(body(size));
    assert.equal((await readQuads('nquads', sourceOf(pieces(zipped, 4096)), { bounds: { maxInflatedBytes: size, maxInflateRatio: 1_000_000 } })).length, 1);
    exceeded(await refusalOf('nquads', sourceOf(pieces(zipped, 4096)), { bounds: { maxInflatedBytes: size - 1, maxInflateRatio: 1_000_000 } }), 'RDF_MAX_INFLATED_BYTES');
  });
  it('RDF_MAX_INFLATE_RATIO: a body at the ratio is read, a body over it is refused, once past the floor', async () => {
    const size = 600_000;
    const zipped = gzipSync(body(size));
    const ratio = Math.ceil(size / zipped.length);
    assert.ok(ratio > 3, `the fixture inflates ${ratio}-fold`);
    const loose = { maxInflatedBytes: 10 * size, inflateRatioFloorBytes: 1 };
    assert.equal((await readQuads('nquads', sourceOf(pieces(zipped, 2048)), { bounds: { ...loose, maxInflateRatio: ratio } })).length, 1);
    exceeded(await refusalOf('nquads', sourceOf(pieces(zipped, 2048)), { bounds: { ...loose, maxInflateRatio: ratio - 1 } }), 'RDF_MAX_INFLATE_RATIO');
  });
  it('the ratio is not asked of a small body, however well it compresses (the floor)', async () => {
    const size = 600_000;
    const zipped = gzipSync(body(size));
    const floor = { maxInflatedBytes: 10 * size, maxInflateRatio: 2, inflateRatioFloorBytes: size };
    assert.equal((await readQuads('nquads', sourceOf(pieces(zipped, 2048)), { bounds: floor })).length, 1);
    exceeded(await refusalOf('nquads', sourceOf(pieces(zipped, 2048)), { bounds: { ...floor, inflateRatioFloorBytes: size - 1 } }), 'RDF_MAX_INFLATE_RATIO');
  });
  it('a gzip bomb at the defaults is refused by the ratio long before the cap, and stops being inflated', async () => {
    const floor = bound('RDF_INFLATE_RATIO_FLOOR_BYTES');
    // Whole statements, so the unparsed bound (which a comment bomb meets first) has nothing to say: 128 MiB of one statement repeated.
    const statements = Buffer.from('<http://a/s> <http://a/p> "x" .\n'.repeat(4096));
    const bomb = pieces(gzipSync(Buffer.concat(Array.from({ length: (128 * floor) / statements.length }, () => statements)), { level: 9 }), 512);
    let next = 0;
    const source = new Readable({ read() { this.push(next < bomb.length ? bomb[next++] : null); } });
    exceeded(await refusalOf('nquads', source), 'RDF_MAX_INFLATE_RATIO');
    assert.equal(source.destroyed, true);
    assert.ok(next < bomb.length / 2, `${next} of ${bomb.length} pieces were read: the bomb went on being inflated`);
  });
  it('the defaults leave room for what the writers write: a gzipped export of every record kind is read', async () => {
    const { recordBatches, write } = await import('./_rdf-writer-fixtures.mjs');
    const text = await write('nquads', recordBatches('nquads', 'rdf12'), 'rdf12');
    assert.ok((await readQuads('nquads', sourceOf(pieces(gzipSync(Buffer.from(text)), 512)))).length > 60);
  });
});
