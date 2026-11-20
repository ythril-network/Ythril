/**
 * A JSON-LD document whose top level is a `@graph` array is read as a stream, and reads to the statements the whole document would read to
 * (bundle-270, slice S1, review U6 follow-up).
 *
 * ## The defect this prevents
 *
 * The JSON-LD library holds the statements of a root `@graph` array until the root closes (its graph name may still come) and its tokenizer
 * keeps the whole value of the object it is given, so a reader memory followed the document, and over 2 MiB the product's own export could
 * not be imported as JSON-LD. The reader now takes the root object apart itself (`server/src/rdf/jsonld-graph-scan.ts`) and hands the library the
 * array's nodes in documents of their own, each with the root's `@context` (and `@id`). Every part of the root and of its nodes that such a
 * split can get wrong is held here, each against the SAME document read whole: the baseline gives the array's key as an alias (`"g": "@graph"`
 * in the context), which the reader does not take apart, so the library reads it whole; the two readings must be the same statements,
 * blank-node names and graphs included.
 *
 * ## What it holds
 *
 * - the export's real output (a seeded space: every record kind, a named graph, a second graph, a default-graph batch; both edge forms), cut
 *   into pieces of 4093 bytes and into pieces that split every token, plain and gzipped, reads as the whole reading does;
 * - blank nodes: a label shared by nodes of different batches is one subject (under the caller's prefix), anonymous nodes are numbered as the
 *   whole reading numbers them, a named graph nested in a node, a node with a context of its own, an `@reverse`, a `@list`, odd elements (a
 *   string, `null`, an array, `{}`), an empty array;
 * - what is not this shape is not touched: a document that is one object and no array, an array in a node, a root with properties of its own;
 * - key order: a context that is not first, or comes after an `@id`, is `rdf_jsonld_not_streamable`; a key after the array is too, naming it;
 * - the end: content after the document is refused (same piece and a later one), a document cut off inside the array is `rdf_malformed`;
 * - the bounds still fire by their names on such a document (`RDF_MAX_TOKEN_CHARS`, `RDF_MAX_LITERAL_CHARS`, `RDF_MAX_UNPARSED_CHARS` for one
 *   node over it, `RDF_MAX_INFLATED_BYTES`, `RDF_MAX_INFLATE_RATIO`), and a node of exactly the bound is read. There is no line bound for JSON-LD (the
 *   case of `the-rdf-import-parser-holds-its-bounds` reads a one-line `@graph` far over it); the quad count is the import's (`RDF_IMPORT_MAX_QUADS`);
 * - a malformed node names its place (line and column of the character the tokenizer stopped at, in a node of a later batch), and so does a node
 *   whose address is relative.
 *
 * Run: node --test testing/standalone/the-rdf-import-parser-reads-a-graph-array-as-its-whole-document.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { BASE, E, iri, lit, recordBatches, write } from './_rdf-writer-fixtures.mjs';
import { parseModule, readQuads, refusalOf, sourceOf, pieces, placeOf, canonQuad } from './_rdf-parse-doors.mjs';

/** The characters of a batch of nodes: the reader's piece size. A document over three of them reaches the library in several documents. */
const BATCH = 65_536;
const CTX = { p: 'http://a/p', q: { '@id': 'http://a/q', '@type': '@id' }, ex: 'http://a/', rev: { '@reverse': 'http://a/rev' } };
const bound = (name) => {
  assert.ok(Number.isSafeInteger(parseModule[name]) && parseModule[name] > 0, `${name} is not an exported positive integer of server/src/rdf/parse.ts`);
  return parseModule[name];
};

/** The same document with its `@graph` key given as an alias the context defines: the reader leaves it to the library, which reads it whole. */
function aliased(doc) {
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === '@context') out[key] = { ...value, g: '@graph' };
    else out[key === '@graph' ? 'g' : key] = value;
  }
  return out;
}
const read = async (text, size = 4093, options) => (await readQuads('jsonld', sourceOf(pieces(text, size)), options)).map(canonQuad).sort();
/** The statements of `doc` as the reader reads it, which must be the statements of its whole reading. */
async function readsAsWhole(doc, what, size = 4093) {
  const split = await read(JSON.stringify(doc), size);
  const whole = await read(JSON.stringify(aliased(doc)), size);
  assert.ok(whole.length > 0, `${what}: the whole reading read nothing`);
  assert.deepEqual(split, whole, what);
  return split;
}
/** What reading `text` comes to: its statements, or the code that refused it. */
async function outcome(text, size = 4093) {
  try { return { quads: await read(text, size) }; } catch (err) { assert.equal(err?.name, 'RdfParseError', String(err)); return { refused: err.code }; }
}

/** Nodes of every kind a space export or a stranger writes; the array of `count` of them is several batches long from about 400. */
function nodeOf(k) {
  switch (k % 6) {
    case 0: return { '@id': `ex:s${k}`, '@type': ['ex:T'], p: [k, { p: `inner ${k}` }], q: [{ '@id': '_:shared' }] };
    case 1: return { p: `an anonymous node ${k}`, q: { '@id': `ex:s${k - 1}` } };
    case 2: return { '@id': `ex:s${k}`, p: [{ '@list': [1, { p: `in a list ${k}` }] }], rev: { '@id': 'ex:r' } };
    case 3: return { '@id': '_:shared', p: `about the shared node ${k}` };
    case 4: return { '@id': `ex:g${k % 4}`, '@graph': [{ '@id': `ex:in${k}`, p: [{ p: 'nested' }, 'x'] }, { p: `anonymous in a graph ${k}` }] };
    default: return { '@context': { w: 'http://a/w' }, '@id': `ex:s${k}`, w: `a node with its own context ${k}`, p: 'x'.repeat(40) };
  }
}
const nodes = (count) => Array.from({ length: count }, (_, k) => nodeOf(k));
const MANY = 6000;

describe('the export\'s own output is read as its whole document is read', () => {
  /**
   * The fixture space exported as the product writes it (JSON-LD writes the classic reification of an edge, never RDF 1.2 triple terms): the
   * record graph as a default-graph batch and as 40 graphs of its own, and a batch of blank nodes with each of them (the writer numbers the labels of
   * its batches on, so no label is shared by two batches: the cases below hold the shared label, as a stranger writes it).
   */
  const exported = () => {
    const record = recordBatches('jsonld', 'reification');
    const blank = (id) => ({ kind: 'blank', id });
    const blanks = (n) => ({ quads: [{ subject: blank('a'), predicate: iri(`${E}p`), object: lit(`blank ${n}`) }, { subject: blank('a'), predicate: iri(`${E}q`), object: blank('b') }, { subject: blank('b'), predicate: iri(`${E}p`), object: lit('second') }] });
    const batches = [{ quads: record.flatMap(b => b.quads) }, blanks(0)];
    for (let i = 0; i < 40; i += 1) {
      for (const b of record) batches.push({ graph: `${BASE}copy-${i}/`, quads: b.quads });
      batches.push({ graph: `${BASE}copy-${i}/`, ...blanks(i + 1) });
    }
    return batches;
  };
  it('every statement, graph and blank node is the whole reading\'s, plain, in pieces of 4093 and 13 bytes, and gzipped', async () => {
    const text = await write('jsonld', exported(), 'reification');
    assert.ok(text.length > 3 * BATCH, `the export (${text.length} characters) must reach the library in several documents`);
    const doc = JSON.parse(text);
    assert.ok(doc['@graph'].some(item => item['@graph']) && doc['@graph'].some(item => !item['@graph']), 'named graphs and default-graph nodes are both there');
    const whole = await read(JSON.stringify(aliased(doc)));
    assert.ok(whole.length > 3000, 'a real export');
    assert.deepEqual(await read(text, 4093), whole);
    assert.deepEqual(await read(text, 13), whole);
    const gz = (await readQuads('jsonld', sourceOf(pieces(gzipSync(Buffer.from(text)), 997)))).map(canonQuad).sort();
    assert.deepEqual(gz, whole, 'the gzipped body');
  });
  it('the blank nodes of the export carry the prefix the caller names, and the nodes of different batches stay different nodes', async () => {
    const text = await write('jsonld', exported(), 'reification');
    const back = await readQuads('jsonld', sourceOf(pieces(text, 4093)), { blankNodePrefix: 'b-' });
    const blanks = new Set(back.flatMap(x => [x.subject, x.object]).filter(t => t.kind === 'blank').map(t => t.id));
    assert.ok(blanks.size > 0, 'the fixture holds blank nodes');
    assert.ok([...blanks].every(id => id.startsWith('b-')), `a blank node does not carry the caller's prefix: ${[...blanks].join(', ')}`);
    const firsts = back.filter(x => x.subject.kind === 'blank' && x.predicate.value === `${E}q`);
    assert.equal(firsts.length, 41, 'one statement of the blank-node batch in every graph');
    assert.equal(new Set(firsts.map(x => x.subject.id)).size, 41, 'the writer labels every batch\'s nodes apart, and so do they read');
  });
});

describe('a node array reads as its whole document reads, whatever its nodes hold', () => {
  it('every kind of node, in several batches, in pieces of 4093 and of 65536 bytes', async () => {
    const doc = { '@context': CTX, '@graph': nodes(MANY) };
    assert.ok(JSON.stringify(doc).length > 4 * BATCH);
    const quads = await readsAsWhole(doc, 'pieces of 4093', 4093);
    assert.deepEqual(await readsAsWhole(doc, 'pieces of 65536', 65536), quads);
    assert.ok(quads.length > 8000, `${quads.length} statements`);
  });
  it('a named graph document (the root @id after the context) too', async () => {
    await readsAsWhole({ '@context': CTX, '@id': 'http://a/graph', '@graph': nodes(MANY) }, 'a root with an @id');
  });
  it('a document with no context at all, named and not (the addresses are absolute)', async () => {
    const absolute = Array.from({ length: 4000 }, (_, k) => ({ '@id': `http://a/s${k}`, 'http://a/p': [`value ${k}`, { 'http://a/p': 'inner' }] }));
    assert.ok(JSON.stringify(absolute).length > 3 * BATCH);
    for (const root of [{ '@graph': absolute }, { '@id': 'http://a/graph', '@graph': absolute }]) {
      const whole = await read(JSON.stringify({ '@context': { g: '@graph' }, ...Object.fromEntries(Object.entries(root).map(([k, v]) => [k === '@graph' ? 'g' : k, v])) }));
      assert.ok(whole.length > 3000);
      assert.deepEqual(await read(JSON.stringify(root)), whole, Object.keys(root).join(', '));
    }
  });
  it('a label shared by nodes of different batches is one subject, under the prefix the caller names; anonymous nodes are all different', async () => {
    const doc = { '@context': CTX, '@graph': nodes(MANY) };
    const quads = await readQuads('jsonld', sourceOf(pieces(JSON.stringify(doc), 4093)), { blankNodePrefix: 'x-' });
    const about = quads.filter(x => x.subject.kind === 'blank' && x.object.kind === 'literal' && /about the shared node/.test(x.object.value));
    assert.equal(about.length, nodes(MANY).filter((_, k) => k % 6 === 3).length, 'every statement about the shared node is read');
    assert.equal(new Set(about.map(x => x.subject.id)).size, 1, 'the shared label is more than one subject');
    assert.ok(about[0].subject.id.startsWith('x-'), about[0].subject.id);
    const referring = quads.filter(x => x.predicate.value === 'http://a/q' && x.object.kind === 'blank');
    assert.ok(referring.length > 100 && referring.every(x => x.object.id === about[0].subject.id), 'a reference to the label is the same subject');
    const anonymous = quads.filter(x => x.object.kind === 'literal' && /^an anonymous node \d+$/.test(x.object.value)).map(x => x.subject.id);
    assert.ok(anonymous.length > 300);
    assert.equal(new Set(anonymous).size, anonymous.length, 'two anonymous nodes share a name');
    assert.ok(!anonymous.includes(about[0].subject.id), 'an anonymous node and a label share a name');
  });
  it('a context in a node, a named graph nested in a node, an @reverse and a @list read as the whole reading reads them (all of them are in nodeOf)', async () => {
    const quads = await readsAsWhole({ '@context': CTX, '@graph': nodes(MANY) }, 'every kind');
    assert.ok(quads.some(x => x.includes('http://a/w')), 'a node with a context of its own');
    assert.ok(quads.some(x => x.endsWith('<http://a/g0>')), 'a statement in the graph a node names');
    assert.ok(quads.some(x => x.includes('<http://a/rev>')), 'an @reverse');
    assert.ok(quads.some(x => x.includes('rdf-syntax-ns#first')), 'a @list');
  });
  it('odd elements read as the whole reading reads them (the same statements, or the same refusal)', async () => {
    for (const elements of [
      [], [{}], ['a string'], [null], [[{ '@id': 'ex:a', p: 1 }, { '@id': 'ex:b', p: 2 }]], [1, 2.5, true],
      [{ '@id': 'ex:a', p: 1 }, {}, { '@id': 'ex:b', p: 2 }], [{ '@graph': [{ '@id': 'ex:z', p: 1 }] }],
    ]) {
      const doc = { '@context': CTX, '@graph': elements };
      const split = await outcome(JSON.stringify(doc));
      const whole = await outcome(JSON.stringify(aliased(doc)));
      assert.deepEqual(split, whole, `elements ${JSON.stringify(elements)}`);
    }
  });
  it('pieces that split every token, string and escape read the same (a small document, pieces of 1 to 7 bytes)', async () => {
    const doc = { '@context': CTX, '@graph': nodes(60).concat([{ '@id': 'ex:esc', p: 'a "quoted" \\ back\\slash é \u{1F600} ]}, [{' }]) };
    const whole = await read(JSON.stringify(aliased(doc)), 65536);
    for (const size of [1, 2, 3, 5, 7]) assert.deepEqual(await read(JSON.stringify(doc), size), whole, `pieces of ${size}`);
  });
  it('whitespace between the parts of the root and of the array is read (a pretty-printed document)', async () => {
    const doc = { '@context': CTX, '@graph': nodes(300) };
    assert.deepEqual(await read(JSON.stringify(doc, null, 4), 37), await read(JSON.stringify(aliased(doc), null, 4), 37));
    assert.deepEqual(await read(`\n \t${JSON.stringify(doc, null, 2)}\r\n\r\n  `, 4093), await read(JSON.stringify(aliased(doc)), 4093));
  });
});

describe('what is not a root @graph array is read as before', () => {
  const DOC = { '@context': { p: 'http://a/p' }, '@id': 'http://a/s', p: 'x' };
  it('one object and no array', async () => {
    assert.equal((await read(JSON.stringify(DOC))).length, 1);
    assert.equal((await read(JSON.stringify({ '@context': DOC['@context'], '@graph': { '@id': 'http://a/s', p: 'x' } }))).length, 1, 'a @graph that is one node object');
    assert.equal((await read(JSON.stringify([DOC]))).length, 1, 'a root array');
  });
  it('an array inside a node, and a root with properties of its own', async () => {
    const inner = { '@context': { p: 'http://a/p' }, '@id': 'http://a/s', p: [{ '@id': 'http://a/o', p: 'y' }, 'z'] };
    assert.equal((await read(JSON.stringify(inner))).length, 3);
    const outcomeOf = await outcome(JSON.stringify({ '@context': { p: 'http://a/p' }, p: 'a root property', '@graph': [{ '@id': 'http://a/s', p: 'x' }] }));
    assert.equal(outcomeOf.refused, 'rdf_unsupported', 'a root with properties and no @id names a blank graph, which the model does not hold');
  });
  it('a root @id before the array names the graph of every node (a small document)', async () => {
    const text = JSON.stringify({ '@context': { p: 'http://a/p' }, '@id': 'http://a/g', '@graph': [{ '@id': 'http://a/s', p: 'x' }] });
    const back = await readQuads('jsonld', sourceOf([text]));
    assert.equal(back.length, 1);
    assert.equal(back[0].graph?.value, 'http://a/g');
  });
});

describe('key order that cannot be streamed is refused by name', () => {
  /** Absolute addresses only, so that nothing but the order of the keys can refuse the document. */
  const array = JSON.stringify([{ '@id': 'http://a/s', 'http://a/p': 'x' }]);
  const refused = async (text, what) => {
    const err = await refusalOf('jsonld', sourceOf(pieces(text, 4093)));
    assert.equal(err.code, 'rdf_jsonld_not_streamable', `${what}: ${err.code}: ${err.message}`);
    return err;
  };
  it('a context after the array', async () => {
    assert.match((await refused(`{"@graph":${array},"@context":{"p":"http://a/p"}}`, 'context last')).message, /@context/);
    assert.match((await refused(`{"@context":{"p":"http://a/p"},"@graph":${array},"@context":{}}`, 'context twice')).message, /@context/);
  });
  it('a context after the @id', async () => {
    assert.match((await refused(`{"@id":"http://a/g","@context":{"p":"http://a/p"},"@graph":${array}}`, 'id then context')).message, /@context/);
  });
  it('a key after the array (it may name the graph or add statements about it), naming the key, whatever the size', async () => {
    const err = await refused(`{"@context":{"p":"http://a/p"},"@graph":${array},"@id":"http://a/g"}`, '@id after');
    assert.match(err.message, /@id/);
    assert.match(err.message, /@graph/);
    const text = `{"@context":{"p":"http://a/p"},"@graph":${array},"@id":"http://a/g"}`;
    assert.deepEqual(err.place, { line: 1, column: text.lastIndexOf('"@id"') + 1 }, 'the place of the key');
    assert.match((await refused(`{"@context":{"p":"http://a/p"},"@graph":${array},"p":"x"}`, 'a property after')).message, /"p"/);
  });
});

describe('the end of the document', () => {
  const doc = JSON.stringify({ '@context': { p: 'http://a/p' }, '@graph': [{ '@id': 'http://a/s', p: 'x' }, { '@id': 'http://a/t', p: 'y' }] });
  it('content after the document is refused, in its own piece and in the piece that ends the document; white space is not content', async () => {
    for (const tail of ['x', '{}', '\n  \n[', ' ,']) {
      for (const size of [4093, doc.length, 9]) {
        const err = await refusalOf('jsonld', sourceOf(pieces(`${doc}${tail}`, size)));
        assert.equal(err.code, 'rdf_malformed', `${JSON.stringify(tail)} in pieces of ${size}: ${err.code}`);
        assert.match(err.message, /follows the end/);
      }
    }
    assert.equal((await read(`${doc}\n \r\n\t `, 4)).length, 2);
  });
  it('a document cut off inside the array, inside a node and before the array is refused as not closed', async () => {
    for (const cut of [doc.indexOf('"@graph"') + 12, doc.indexOf('http://a/t') + 3, doc.length - 2, doc.length - 1]) {
      const err = await refusalOf('jsonld', sourceOf(pieces(doc.slice(0, cut), 11)));
      assert.equal(err.code, 'rdf_malformed', `cut at ${cut}: ${err.code}: ${err.message}`);
    }
  });
});

describe('the bounds fire by their names on a @graph document', () => {
  const head = '{"@context":{"p":"http://a/p"},"@graph":[';
  const doc = (...items) => `${head}${items.join(',')}]}`;
  const exceeded = (err, name) => {
    assert.equal(err.code, 'rdf_bound_exceeded', `${err.code}: ${err.message}`);
    assert.equal(err.bound, name);
    assert.ok(err.message.includes(name), err.message);
  };
  for (const size of [4096, 65536]) {
    it(`RDF_MAX_TOKEN_CHARS: an address of the bound in a node is read, one more is refused (pieces of ${size})`, async () => {
      const max = bound('RDF_MAX_TOKEN_CHARS');
      const address = (n) => `http://a/${'p'.repeat(n - 'http://a/'.length)}`;
      const text = (n) => doc('{"@id":"http://a/s1","p":"x"}', `{"@id":"http://a/s2","p":{"@id":"${address(n)}"}}`);
      assert.equal((await read(text(max), size)).length, 2);
      exceeded(await refusalOf('jsonld', sourceOf(pieces(text(max + 1), size))), 'RDF_MAX_TOKEN_CHARS');
    });
    it(`RDF_MAX_LITERAL_CHARS: a literal of the bound in a node is read, one more is refused (pieces of ${size})`, async () => {
      const max = bound('RDF_MAX_LITERAL_CHARS');
      const text = (n) => doc('{"@id":"http://a/s1","p":"x"}', `{"@id":"http://a/s2","p":"${'a'.repeat(n)}"}`);
      assert.equal((await read(text(max), size)).length, 2);
      exceeded(await refusalOf('jsonld', sourceOf(pieces(text(max + 1), size))), 'RDF_MAX_LITERAL_CHARS');
    });
  }
  it('RDF_MAX_UNPARSED_CHARS: one node of the bound is read, one character more is refused, before it is held whole', async () => {
    const max = bound('RDF_MAX_UNPARSED_CHARS');
    /** A node of exactly `n` characters: a list of literals of a thousand characters and a last one that fills it. */
    const nodeOfLength = (n) => {
      const open = '{"@id":"http://a/s","p":[';
      const close = ']}';
      const item = `"${'a'.repeat(1000)}"`;
      const parts = [];
      let length = open.length + close.length;
      while (n - length >= item.length + 1 + 3) { parts.push(item); length += item.length + (parts.length > 1 ? 1 : 0); }
      const rest = n - length - (parts.length ? 1 : 0);
      parts.push(`"${'b'.repeat(rest - 2)}"`);
      const text = `${open}${parts.join(',')}${close}`;
      assert.equal(text.length, n);
      return text;
    };
    assert.ok((await read(doc(nodeOfLength(max)), 65536)).length > 1000, 'a node of the bound is read');
    let fed = 0;
    const source = (async function* () { for (const piece of pieces(doc(nodeOfLength(max + 1)), 65536)) { fed += piece.length; yield piece; } })();
    exceeded(await refusalOf('jsonld', source), 'RDF_MAX_UNPARSED_CHARS');
    assert.ok(fed <= max + 3 * 65536, `${fed} characters were fed`);
  });
  it('RDF_MAX_INFLATED_BYTES and RDF_MAX_INFLATE_RATIO: a gzipped @graph document over either is refused by its name', async () => {
    const text = doc(...Array.from({ length: 3000 }, (_, k) => `{"@id":"http://a/s${k}","p":["value ${k}","another value"]}`));
    const zipped = gzipSync(Buffer.from(text));
    const relaxed = { maxInflateRatio: 1_000_000, inflateRatioFloorBytes: 1 };
    assert.ok((await readQuads('jsonld', sourceOf(pieces(zipped, 2048)), { bounds: { ...relaxed, maxInflatedBytes: text.length } })).length > 1000);
    exceeded(await refusalOf('jsonld', sourceOf(pieces(zipped, 2048)), { bounds: { ...relaxed, maxInflatedBytes: text.length - 1 } }), 'RDF_MAX_INFLATED_BYTES');
    const ratio = Math.ceil(text.length / zipped.length);
    const loose = { maxInflatedBytes: 10 * text.length, inflateRatioFloorBytes: 1 };
    assert.ok((await readQuads('jsonld', sourceOf(pieces(zipped, 2048)), { bounds: { ...loose, maxInflateRatio: ratio } })).length > 1000);
    exceeded(await refusalOf('jsonld', sourceOf(pieces(zipped, 2048)), { bounds: { ...loose, maxInflateRatio: ratio - 1 } }), 'RDF_MAX_INFLATE_RATIO');
  });
});

describe('a malformed node names its place', () => {
  /** A pretty-printed document of `before` plain nodes, then `bad`, then a plain one: the bad node is in a later batch than the first. */
  const documentWith = (before, bad) => {
    const plain = (k) => `    {"@id": "http://a/s${k}", "p": "value ${k}"}`;
    const lines = [...Array.from({ length: before }, (_, k) => plain(k)), `    ${bad}`, plain(before + 1)];
    return `{\n  "@context": {"p": "http://a/p"},\n  "@graph": [\n${lines.join(',\n')}\n  ]\n}\n`;
  };
  for (const before of [0, 4000]) {
    it(`a character the tokenizer cannot read, after ${before} nodes: its line and column`, async () => {
      const text = documentWith(before, '{"@id": "http://a/bad", "p": #BAD}');
      assert.ok(before === 0 || text.length > 3 * BATCH);
      for (const size of [37, 4093]) {
        const err = await refusalOf('jsonld', sourceOf(pieces(text, size)));
        assert.equal(err.code, 'rdf_malformed', `${err.code}: ${err.message}`);
        assert.deepEqual(err.place, placeOf(text, '#BAD'), `pieces of ${size}`);
      }
    });
    it(`a relative address, after ${before} nodes: the line of its node`, async () => {
      const text = documentWith(before, '{"@id": "relative/address", "p": "x"}');
      const err = await refusalOf('jsonld', sourceOf(pieces(text, 4093)));
      assert.equal(err.code, 'rdf_relative_iri', `${err.code}: ${err.message}`);
      assert.equal(err.place?.line, placeOf(text, '"relative/address"').line);
    });
  }
  it('a bracket that closes the wrong thing, and a missing comma between nodes, are refused with their place', async () => {
    const wrong = `{\n "@context": {"p": "http://a/p"},\n "@graph": [\n  {"@id": "http://a/s", "p": "x"}\n }\n`;
    const e1 = await refusalOf('jsonld', sourceOf(pieces(wrong, 5)));
    assert.equal(e1.code, 'rdf_malformed');
    const closer = placeOf(wrong, '\n }\n');
    assert.deepEqual(e1.place, { line: closer.line + 1, column: 2 }, 'the place of the closing brace');
    const missing = `{"@context": {"p": "http://a/p"},\n "@graph": [\n  {"@id": "http://a/s", "p": "x"}\n  {"@id": "http://a/t", "p": "y"}\n ]}`;
    const e2 = await refusalOf('jsonld', sourceOf(pieces(missing, 5)));
    assert.equal(e2.code, 'rdf_malformed');
    assert.equal(e2.place?.line, 4);
  });
});
