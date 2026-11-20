/**
 * What the writers write, the import parser reads back as the same quads, in all four formats, plain and gzipped (bundle-270, slice S1).
 *
 * ## The defect this prevents
 *
 * An import that reads a file the export wrote must find the statements the export meant. The writers are tested against independent parsers
 * (`the-rdf-writers-are-read-by-n3.test.js`); the import has a reader of its own, `parseRdf` (`server/src/rdf/parse.ts`), that every later slice
 * stands on, and it must agree with them on every value the writers can write.
 *
 * ## What it holds
 *
 * - **the writers' own output**, the table of nasty strings and the mapper's quads for a record of every kind, in Turtle, TriG, N-Quads and
 *   JSON-LD, both edge forms (RDF 1.2 reifiers, classic reification), read back as the same quads, graph included, from a stream cut into
 *   pieces that split tokens and UTF-8 characters;
 * - **gzip is invisible**: a gzipped body yields exactly what its plain body yields, in the same order;
 * - **a literal's language and datatype are apart**: a tagged string, a typed value and a plain string read as three different terms, and an
 *   `xsd:string` spelled out is the plain one;
 * - **a blank node is one subject, whatever the cutting**: the same blank-node label read from chunks of any size, or by two readers one after
 *   the other, is one label, an anonymous node is as stable, the prefix is the one the caller names, and a label and an anonymous node never
 *   share a name.
 *
 * The built server is needed (`npm run build:server`). Run: node --test testing/standalone/the-rdf-writers-are-read-by-the-import-parser.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { RDF, XSD, E, iri, lit, q, FORMATS, NASTY, recordBatches, write } from './_rdf-writer-fixtures.mjs';
import { readQuads, sourceOf, pieces, canon, canonQuad } from './_rdf-parse-doors.mjs';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** The writers cannot carry a lone surrogate: it is written, and read, as U+FFFD. */
const asWritten = (term) => (term.kind === 'literal' ? { ...term, value: term.value.replace(LONE_SURROGATE, '\u{FFFD}') } : term);
const modelSet = (batches) => [...new Set(batches.flatMap(b => b.quads.map(x => canonQuad({ subject: x.subject, predicate: x.predicate, object: asWritten(x.object), graph: b.graph ? iri(b.graph) : x.graph }))))].sort();
const readSet = (quads) => [...new Set(quads.map(canonQuad))].sort();
const SIZES = [1, 7, 4093];

describe('the nasty values the writers write are read back as the same quads', () => {
  for (const format of FORMATS) {
    it(`${format}: ${NASTY.length} strings, plain and typed, in pieces of 1, 7 and 4093 bytes`, async () => {
      const batches = [{ quads: NASTY.flatMap((v, i) => [q(`${E}s`, `${E}plain`, lit(v)), q(`${E}s${i}`, `${E}typed`, lit(v, `${E}custom`))]) }];
      const text = await write(format, batches);
      for (const size of SIZES) {
        assert.deepEqual(readSet(await readQuads(format, sourceOf(pieces(text, size)))), modelSet(batches), `pieces of ${size} bytes`);
      }
    });
    it(`${format}: a nasty-but-legal IRI, in a graph label too, comes back unchanged`, async () => {
      if (format === 'turtle') return; // Turtle holds no graph
      const legal = `${E}a%20b/%3C%3E%22/c?x=1&y=%23#f`;
      const batches = [{ graph: `${E}g%20h`, quads: [q(legal, `${E}p`, legal), q(`${E}s`, legal, lit('x'))] }];
      assert.deepEqual(readSet(await readQuads(format, sourceOf(pieces(await write(format, batches), 5)))), modelSet(batches));
    });
  }
});

describe('a space export of every record kind is read back as the same quads', () => {
  const FORMS = [
    ...['turtle', 'trig', 'nquads'].flatMap(f => [[f, 'rdf12'], [f, 'reification']]),
    ['jsonld', 'reification'],
  ];
  for (const [format, edgeDetails] of FORMS) {
    it(`${format}, ${edgeDetails}: every quad of every kind is read, in the data graph`, async () => {
      const batches = recordBatches(format, edgeDetails);
      assert.ok(batches.reduce((n, b) => n + b.quads.length, 0) > 60, 'a real export');
      const text = await write(format, batches, edgeDetails);
      const back = await readQuads(format, sourceOf(pieces(text, 997)));
      assert.deepEqual(readSet(back), modelSet(batches));
      if (edgeDetails === 'rdf12') {
        assert.ok(back.some(x => x.predicate.value === `${RDF}reifies` && x.object.kind === 'triple'), 'a reifier names its triple as a triple term');
      } else {
        assert.ok(back.some(x => x.predicate.value === `${RDF}subject`), 'a reifier is the classic rdf:Statement');
      }
      if (format !== 'turtle') assert.ok(back.every(x => x.graph?.kind === 'iri'), 'every record statement is in a named graph');
    });
  }
});

describe('a gzipped body yields what its plain body yields', () => {
  for (const format of FORMATS) {
    it(`${format}: the same quads in the same order, from pieces of 13 bytes`, async () => {
      const text = await write(format, recordBatches(format, format === 'jsonld' ? 'reification' : 'rdf12'), format === 'jsonld' ? 'reification' : 'rdf12');
      const plain = await readQuads(format, sourceOf(pieces(text, 4096)));
      const zipped = await readQuads(format, sourceOf(pieces(gzipSync(Buffer.from(text, 'utf8')), 13)));
      assert.ok(plain.length > 60);
      assert.deepEqual(zipped.map(canonQuad), plain.map(canonQuad));
    });
  }
});

describe('a literal keeps its language tag and its datatype apart', () => {
  const NQ = [
    `<${E}s> <${E}p> "hallo"@fr-be .`,
    `<${E}s> <${E}p> "hallo" .`,
    `<${E}s> <${E}p> "hallo"^^<${XSD}string> .`,
    `<${E}s> <${E}p> "1.5"^^<${XSD}decimal> .`,
    `<${E}s> <${E}p> "salaam"@ar--rtl .`,
  ].join('\n');
  const byObject = (quads) => quads.map(x => x.object);
  it('N-Quads: a tagged string has a language and no datatype, a typed one the reverse, a plain one neither, and xsd:string is the plain one', async () => {
    const [tagged, plain, spelled, typed, directional] = byObject(await readQuads('nquads', sourceOf([NQ])));
    assert.deepEqual(tagged, { kind: 'literal', value: 'hallo', language: 'fr-be' });
    assert.deepEqual(plain, { kind: 'literal', value: 'hallo' });
    assert.deepEqual(spelled, { kind: 'literal', value: 'hallo' });
    assert.deepEqual(typed, { kind: 'literal', value: '1.5', datatype: `${XSD}decimal` });
    assert.deepEqual(directional, { kind: 'literal', value: 'salaam', language: 'ar--rtl' }, 'an RDF 1.2 base direction stays in the tag, as the syntax writes it');
    assert.notEqual(canon(tagged), canon(plain));
  });
  it('Turtle and TriG read the same terms as N-Quads', async () => {
    const ttl = `@prefix xsd: <${XSD}> .\n<${E}s> <${E}p> "hallo"@fr-be, "hallo", "hallo"^^xsd:string, 1.5, "1.5"^^xsd:decimal .\n`;
    const read = byObject(await readQuads('turtle', sourceOf(pieces(ttl, 9)))).map(canon);
    assert.deepEqual(read.slice(0, 3), [canon({ kind: 'literal', value: 'hallo', language: 'fr-be' }), canon({ kind: 'literal', value: 'hallo' }), canon({ kind: 'literal', value: 'hallo' })]);
    assert.equal(read[3], canon({ kind: 'literal', value: '1.5', datatype: `${XSD}decimal` }), 'a bare decimal is typed');
    assert.equal(read[4], read[3]);
    const trig = `<${E}g> { <${E}s> <${E}p> "hallo"@en . }`;
    assert.deepEqual(byObject(await readQuads('trig', sourceOf([trig]))), [{ kind: 'literal', value: 'hallo', language: 'en' }]);
  });
  it('JSON-LD: @language gives a language, @type a datatype, a bare string neither', async () => {
    const doc = JSON.stringify({
      '@context': { p: { '@id': `${E}p` } },
      '@id': `${E}s`,
      p: [{ '@value': 'hallo', '@language': 'fr-be' }, 'hallo', { '@value': '1.5', '@type': `${XSD}decimal` }],
    });
    const objects = byObject(await readQuads('jsonld', sourceOf(pieces(doc, 11))));
    assert.deepEqual(objects.map(canon).sort(), [
      canon({ kind: 'literal', value: 'hallo', language: 'fr-be' }),
      canon({ kind: 'literal', value: 'hallo' }),
      canon({ kind: 'literal', value: '1.5', datatype: `${XSD}decimal` }),
    ].sort());
  });
});

describe('a blank node is one subject, however the document is cut', () => {
  const TTL = `@prefix : <${E}> .\n_:a :p _:a ; :q [ :r "x" ] , [] .\n_:b :p ( :one "two" ) .\n`;
  const NQ = `_:a <${E}p> _:a .\n_:a <${E}q> _:b .\n_:b <${E}r> "x" .\n`;
  const JSONLD = JSON.stringify({ '@context': { '@vocab': E }, '@graph': [{ '@id': '_:a', p: { '@id': '_:a' }, q: [{ r: 'x' }, {}] }] });
  const CASES = [['turtle', TTL], ['trig', TTL], ['nquads', NQ], ['jsonld', JSONLD]];
  const ids = (quads) => quads.flatMap(x => [x.subject, x.object].filter(t => t.kind === 'blank').map(t => t.id));

  for (const [format, text] of CASES) {
    it(`${format}: pieces of 1, 3 and 4096 bytes, and a second reader, name every blank node alike`, async () => {
      const whole = (await readQuads(format, sourceOf([text]), { blankNodePrefix: 'imp-' })).map(canonQuad);
      assert.ok(ids(await readQuads(format, sourceOf([text]), { blankNodePrefix: 'imp-' })).length >= 2, 'the document has blank nodes');
      for (const size of [1, 3, 4096]) {
        assert.deepEqual((await readQuads(format, sourceOf(pieces(text, size)), { blankNodePrefix: 'imp-' })).map(canonQuad), whole, `pieces of ${size} bytes`);
      }
      assert.deepEqual((await readQuads(format, sourceOf([text]), { blankNodePrefix: 'imp-' })).map(canonQuad), whole, 'a second reader');
    });
    it(`${format}: every blank id starts with the prefix the caller names, and another prefix gives other ids`, async () => {
      const a = ids(await readQuads(format, sourceOf([text]), { blankNodePrefix: 'one-' }));
      const b = ids(await readQuads(format, sourceOf([text]), { blankNodePrefix: 'two-' }));
      assert.ok(a.length > 0 && a.every(id => id.startsWith('one-')), a.join());
      assert.ok(b.every(id => id.startsWith('two-')), b.join());
      assert.equal(new Set([...a, ...b]).size, new Set(a).size + new Set(b).size, 'two prefixes never share an id');
    });
  }
  it('a label the document writes and an anonymous node never share a name, and one label is one node', async () => {
    const quads = await readQuads('turtle', sourceOf([`@prefix : <${E}> .\n_:x1 :p [] .\n[] :p _:x1 .\n_:x1 :q "z" .\n`]), { blankNodePrefix: 'imp-' });
    const subjects = new Set(quads.map(x => x.subject.id));
    const labelled = quads.filter(x => x.predicate.value === `${E}q`)[0].subject.id;
    assert.equal(quads.filter(x => x.subject.id === labelled).length, 2, 'both statements of _:x1 share a subject');
    assert.equal(subjects.size, 2, 'one labelled subject and one anonymous subject');
  });
  it('without a prefix the ids are still the same from one reader to the next', async () => {
    const one = (await readQuads('turtle', sourceOf([TTL]))).map(canonQuad);
    const two = (await readQuads('turtle', sourceOf([TTL]))).map(canonQuad);
    assert.deepEqual(two, one);
  });
});
