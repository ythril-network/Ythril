/**
 * What the writers write, independent parsers read back as the same triples, in all four formats (Q-749, design r4 §5.3, §8).
 *
 * ## The defect this prevents
 *
 * A writer is only right if a parser that did not write it reads the same statements back. The writers are tested byte by byte in
 * `the-rdf-writers-escape-compact-and-label.test.js`; this test hands their output to `n3` (Turtle, TriG, N-Quads, RDF 1.2 triple terms)
 * and to `jsonld` (JSON-LD, expanded to N-Quads and read by `n3`), both dev dependencies, offline (a document loader that refuses every
 * address, so no request leaves the test).
 *
 * ## What it holds
 *
 * - **one table of nasty strings** (quotes, backslashes, newlines, control characters, a lone surrogate, `<`, `>`, text that looks like a
 *   language tag, a datatype, a prefix line, a comment or a closing brace) round-trips in EVERY format. A lone surrogate is the one value
 *   no format can carry: it comes back as U+FFFD, exactly as the writer says;
 * - **records**: the mapper's quads for a fixture of every record kind are read back as the same set of triples, with RDF 1.2 reifiers in
 *   the three text formats and classic reification in JSON-LD;
 * - **graphs**: a named graph is the graph of each statement in TriG, N-Quads and JSON-LD;
 * - **collections and blank nodes** keep their structure.
 *
 * Run: node --test testing/standalone/the-rdf-writers-are-read-by-n3.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import jsonld from 'jsonld';

import { ser, RDF, XSD, E, iri, lit, q, PREFIXES, FORMATS, NASTY, recordBatches, write } from './_rdf-writer-fixtures.mjs';

// -- canonical strings for a term of the model and for a term n3 parsed ----------------------------------------------------------------
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const fromModel = (t) => {
  if (t.kind === 'iri') return `<${t.value}>`;
  if (t.kind === 'literal') return `"${t.value.replace(LONE_SURROGATE, '\u{FFFD}')}"^^<${t.datatype ?? `${XSD}string`}>`;
  if (t.kind === 'triple') return `<<( ${fromModel(t.subject)} ${fromModel(t.predicate)} ${fromModel(t.object)} )>>`;
  throw new Error(`no canonical string for ${t.kind}`);
};
const fromN3 = (t) => {
  if (t.termType === 'NamedNode') return `<${t.value}>`;
  if (t.termType === 'Literal') {
    assert.equal(t.language, '', 'the writers never write a language tag');
    return `"${t.value}"^^<${t.datatype.value}>`;
  }
  if (t.termType === 'Quad') return `<<( ${fromN3(t.subject)} ${fromN3(t.predicate)} ${fromN3(t.object)} )>>`;
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  throw new Error(`no canonical string for ${t.termType}`);
};
const withGraph = (s, p, o, g) => `${s} ${p} ${o} ${g}`;
const modelSet = (batches) => new Set(batches.flatMap((b) => b.quads.map((x) => withGraph(fromModel(x.subject), fromModel(x.predicate), fromModel(x.object), (b.graph ?? x.graph?.value) ? `<${b.graph ?? x.graph.value}>` : '-'))));
const parsedSet = (quads) => new Set(quads.map((x) => withGraph(fromN3(x.subject), fromN3(x.predicate), fromN3(x.object), x.graph.termType === 'DefaultGraph' ? '-' : fromN3(x.graph))));

const refuseRemote = async (url) => { throw new Error(`the test is offline: ${url}`); };

/** The quads an independent parser reads from `text`. */
async function readBack(format, text) {
  if (format === 'jsonld') {
    const nquads = await jsonld.toRDF(JSON.parse(text), { format: 'application/n-quads', documentLoader: refuseRemote });
    return new Parser({ format: 'N-Quads' }).parse(nquads);
  }
  return new Parser({ format: { turtle: 'Turtle', trig: 'TriG', nquads: 'N-Quads' }[format] }).parse(text);
}

describe('the nasty values round-trip in every format', () => {
  for (const format of FORMATS) {
    it(`${format}: ${NASTY.length} strings as plain and as typed literals come back as the same triples`, async () => {
      const subject = `${E}s`;
      const batches = [{ quads: NASTY.flatMap((v, i) => [
        q(subject, `${E}plain`, lit(v)),
        q(`${E}s${i}`, `${E}typed`, lit(v, `${E}custom`)),
      ]) }];
      const text = await write(format, batches);
      const back = parsedSet(await readBack(format, text));
      const expected = modelSet(batches);
      assert.deepEqual([...back].sort(), [...expected].sort());
    });
    it(`${format}: a nasty-but-legal IRI, in a graph label too, comes back unchanged`, async () => {
      if (format === 'turtle') return; // Turtle holds no graph; its IRIs are read in the record test below
      const legal = `${E}a%20b/%3C%3E%22/c?x=1&y=%23#f`;
      const batches = [{ graph: `${E}g%20h`, quads: [q(legal, `${E}p`, legal), q(`${E}s`, legal, lit('x'))] }];
      const back = parsedSet(await readBack(format, await write(format, batches)));
      assert.deepEqual([...back].sort(), [...modelSet(batches)].sort());
    });
  }
  it('a lone surrogate is counted by the writer, and only the lone ones', async () => {
    const w = ser.createRdfWriter('nquads', { prefixes: PREFIXES() });
    w.write({ quads: [q(`${E}s`, `${E}p`, lit('a\uD800b\uDC00c\u{1F600}d\uD800\uD800'))] });
    assert.equal(w.replacedCharacters, 4);
  });
});

describe('a space export of every record kind is read back as the same triples', () => {
  for (const format of FORMATS) {
    it(`${format}: the quads of every kind (${format === 'jsonld' ? 'classic reification' : 'RDF 1.2 reifiers'}) are the triples a parser reads`, async () => {
      const edgeDetails = format === 'jsonld' ? 'reification' : 'rdf12';
      const batches = recordBatches(format, edgeDetails);
      assert.ok(batches.reduce((n, b) => n + b.quads.length, 0) > 60, 'a real export');
      const text = await write(format, batches, edgeDetails);
      const back = parsedSet(await readBack(format, text));
      const expected = modelSet(batches);
      assert.deepEqual([...back].sort(), [...expected].sort());
    });
  }
});

describe('collections and blank nodes keep their structure', () => {
  const batch = { quads: [
    q(`${E}s`, `${E}p`, { kind: 'list', items: [lit('a'), iri(`${E}b`), lit('1', `${XSD}decimal`)] }),
    q(`${E}s`, `${E}empty`, { kind: 'list', items: [] }),
    q({ kind: 'blank', id: 'n' }, `${RDF}type`, `${E}Node`),
    q(`${E}s`, `${E}has`, { kind: 'blank', id: 'n' }),
  ] };
  for (const format of FORMATS) {
    it(`${format}: the list is an rdf:first/rdf:rest chain, the blank node is one node used twice`, async () => {
      const quads = await readBack(format, await write(format, [batch]));
      const one = (s, p) => {
        const found = quads.filter((x) => x.subject.value === s && x.predicate.value === p);
        assert.equal(found.length, 1, `${s} ${p}`);
        return found[0].object;
      };
      const items = [];
      let node = one(`${E}s`, `${E}p`);
      while (node.value !== `${RDF}nil`) { items.push(one(node.value, `${RDF}first`)); node = one(node.value, `${RDF}rest`); }
      assert.deepEqual(items.map(fromN3), [`"a"^^<${XSD}string>`, `<${E}b>`, `"1"^^<${XSD}decimal>`]);
      assert.equal(one(`${E}s`, `${E}empty`).value, `${RDF}nil`);
      const blankNode = one(`${E}s`, `${E}has`);
      assert.equal(blankNode.termType, 'BlankNode');
      assert.equal(quads.filter((x) => x.subject.value === blankNode.value && x.predicate.value === `${RDF}type`).length, 1);
    });
  }
});
