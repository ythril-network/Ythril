/**
 * The RDF writers: Turtle, TriG, N-Quads and JSON-LD from one term model, escaped per format by the writer alone (Q-749, design r4 §5.3).
 *
 * ## The defect this prevents
 *
 * An RDF file another tool cannot parse is worth nothing, and a writer that leaves escaping to its callers is a writer whose callers forget:
 * one record whose text holds a quote, a backslash, a newline, a control character or a `>` breaks the whole export, or worse, injects
 * a statement into it. `server/src/rdf/serialize.ts` is the ONLY place that spells a literal, an IRI or a comment in any format, and it
 * keeps the forgettable parts inside:
 *
 * - **escaping** per format (ECHAR plus `\uXXXX` for control characters; JSON for JSON-LD); a lone UTF-16 surrogate (no format can carry it)
 *   becomes U+FFFD and is counted in `replacedCharacters`;
 * - **compact names** only for safe local names; an IRI is never rewritten, and an IRI that JSON-LD would read as a compact name is refused;
 * - **an IRIREF guard** as the last check: an IRI holding a character IRIs cannot hold is refused, never written;
 * - **deterministic labels and order**: blank nodes are `_:b0`, `_:b1`, ... per document in output order; subjects, predicates, objects and
 *   prefixes are sorted, so one record gives the same bytes on every run, whatever order its quads came in;
 * - **RDF collections** in each format, **triple terms** (RDF 1.2 reifiers) in the three text formats and a refusal in JSON-LD;
 * - **streaming**: the writer takes an iterator of batches and gives a chunk per batch; it never holds the document as one string;
 * - **the closing comment** (`# ythril-export: ...`) is one line whatever the ids in it hold.
 *
 * The independent parsers read these bytes in `the-rdf-writers-are-read-by-n3.test.js`.
 *
 * Run: node --test testing/standalone/the-rdf-writers-escape-compact-and-label.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../server/dist/rdf/serialize.js').catch(() => ({}));
const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));
const need = (name) => {
  assert.equal(typeof mod[name], 'function', `${name} is not exported by server/src/rdf/serialize.ts: there is no writer`);
  return mod[name];
};

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SCHEMA = 'http://schema.org/';
const E = 'http://ex.org/';
const iri = (value) => ({ kind: 'iri', value });
const blank = (id) => ({ kind: 'blank', id });
const lit = (value, datatype) => (datatype === undefined ? { kind: 'literal', value } : { kind: 'literal', value, datatype });
const list = (...items) => ({ kind: 'list', items });
const triple = (subject, predicate, object) => ({ kind: 'triple', subject, predicate, object });
const q = (s, p, o, g) => ({ subject: typeof s === 'string' ? iri(s) : s, predicate: iri(p), object: typeof o === 'string' ? iri(o) : o, ...(g ? { graph: iri(g) } : {}) });
const PREFIXES = () => ({ rdf: RDF, rdfs: RDFS, xsd: XSD, schema: SCHEMA, ythril: vocab.YTHRIL_NS });

/** The whole document of `batches`, through the streaming writer. */
async function document(format, batches, opts = { prefixes: PREFIXES() }) {
  let out = '';
  for await (const chunk of need('serializeRdf')(format, batches, opts)) out += chunk;
  return out;
}
const FORMATS = ['turtle', 'trig', 'nquads', 'jsonld'];

describe('N-Quads: one statement per line, escaped, in a fixed order', () => {
  it('writes plain and typed literals and an IRI object, sorted by subject, predicate and object', async () => {
    const text = await document('nquads', [{ quads: [
      q(`${E}b`, `${E}p`, lit('x')),
      q(`${E}a`, `${E}q`, lit('1', `${XSD}decimal`)),
      q(`${E}a`, `${E}p`, `${E}o`),
      q(`${E}a`, `${RDF}type`, `${E}C`),
    ] }]);
    assert.equal(text, [
      `<${E}a> <${RDF}type> <${E}C> .`,
      `<${E}a> <${E}p> <${E}o> .`,
      `<${E}a> <${E}q> "1"^^<${XSD}decimal> .`,
      `<${E}b> <${E}p> "x" .`,
      '',
    ].join('\n'));
  });
  it('writes the graph of a batch as the fourth term', async () => {
    const text = await document('nquads', [{ graph: `${E}g`, quads: [q(`${E}a`, `${E}p`, lit('x'))] }]);
    assert.equal(text, `<${E}a> <${E}p> "x" <${E}g> .\n`);
  });
  it('escapes quote, backslash, newline, carriage return, tab and every control character; keeps other text as it is', async () => {
    const text = await document('nquads', [{ quads: [q(`${E}a`, `${E}p`, lit('a"b\\c\nd\re\tf\u0000g\u0001h\u001fi\u007fj \u{e9} \u{65e5}\u{672c} \u{1F600}'))] }]);
    assert.equal(text, `<${E}a> <${E}p> "a\\"b\\\\c\\nd\\re\\tf\\u0000g\\u0001h\\u001fi\\u007fj \u{e9} \u{65e5}\u{672c} \u{1F600}" .\n`);
  });
  it('a lone surrogate becomes U+FFFD and is counted; a valid pair is kept', async () => {
    const w = need('createRdfWriter')('nquads', { prefixes: PREFIXES() });
    const text = w.open() + w.write({ quads: [q(`${E}a`, `${E}p`, lit('x\uD800y\uDC00z\u{1F600}'))] }) + w.close();
    assert.equal(text, `<${E}a> <${E}p> "x\u{FFFD}y\u{FFFD}z\u{1F600}" .\n`);
    assert.equal(w.replacedCharacters, 2);
  });
});

describe('Turtle: prefixes, compact names only where safe, a type as "a"', () => {
  it('is byte-exact for a small record: sorted prefixes, a first, predicates sorted, objects sorted', async () => {
    const S = `${E}s`;
    const text = await document('turtle', [{ quads: [
      q(S, `${SCHEMA}keywords`, lit('k2')), q(S, `${SCHEMA}keywords`, lit('k1')),
      q(S, `${RDFS}label`, lit('A')), q(S, `${RDF}type`, `${vocab.YTHRIL_NS}Entity`),
    ] }]);
    assert.equal(text, [
      `@prefix rdf: <${RDF}> .`,
      `@prefix rdfs: <${RDFS}> .`,
      `@prefix schema: <${SCHEMA}> .`,
      `@prefix xsd: <${XSD}> .`,
      `@prefix ythril: <${vocab.YTHRIL_NS}> .`,
      '',
      `<${S}>`,
      '    a ythril:Entity ;',
      // Predicates are sorted by their full address: http://schema.org/keywords comes before http://www.w3.org/...#label.
      '    schema:keywords "k1", "k2" ;',
      '    rdfs:label "A" .',
      '',
      '',
    ].join('\n'));
  });
  it('writes a typed literal with a compact datatype, always in quoted form (the lexical form is kept as stored)', async () => {
    const text = await document('turtle', [{ quads: [q(`${E}s`, `${E}p`, lit('1.50', `${XSD}decimal`)), q(`${E}s`, `${E}b`, lit('true', `${XSD}boolean`))] }]);
    assert.match(text, /"1\.50"\^\^xsd:decimal/);
    assert.match(text, /"true"\^\^xsd:boolean/);
  });
  it('compacts only a safe local name: a dot, a colon, a percent or an empty local name stays a full IRI, and no IRI is rewritten', async () => {
    const odd = [`${SCHEMA}a.b`, `${SCHEMA}a:b`, `${SCHEMA}a%20b`, `${SCHEMA}`, `${SCHEMA}a/b`, `${SCHEMA}1x`, `${SCHEMA}x-y_z`];
    const text = await document('turtle', [{ quads: odd.map((p) => q(`${E}s`, p, lit('v'))) }]);
    for (const p of odd.slice(0, 6)) assert.ok(text.includes(`<${p}>`), `${p} stays a full IRI`);
    assert.ok(text.includes('schema:x-y_z'), 'a safe local name is compacted');
  });
  it('a prefix only compacts IRIs under its own namespace; the longest namespace wins', async () => {
    const text = await document('turtle', [{ quads: [q(`${E}s`, `${E}deep/name`, lit('v'))] }], { prefixes: { ex: E, deep: `${E}deep/` } });
    assert.ok(text.includes('deep:name'), 'the longest namespace is the prefix used');
    assert.ok(!text.includes('ex:deep'));
  });
  it('refuses a named graph: Turtle holds one graph', async () => {
    await assert.rejects(() => document('turtle', [{ graph: `${E}g`, quads: [q(`${E}a`, `${E}p`, lit('x'))] }]), /turtle|graph/i);
  });
});

describe('TriG: one block per graph of a batch', () => {
  it('wraps a batch with a graph in its graph block and leaves one without in the default graph', async () => {
    const text = await document('trig', [
      { graph: `${E}g`, quads: [q(`${E}a`, `${E}p`, lit('x'))] },
      { quads: [q(`${E}b`, `${E}p`, lit('y'))] },
    ]);
    assert.match(text, new RegExp(`<${E}g> \\{\\n<${E}a>\\n    <${E}p> "x" \\.\\n\\n\\}`));
    assert.match(text, new RegExp(`\\n<${E}b>\\n    <${E}p> "y" \\.`));
  });
});

describe('JSON-LD: a prefix-only context, a flat graph, typed values as strings', () => {
  it('is one JSON document: context of the prefixes, nodes in @graph, a graph batch as its own graph object', async () => {
    const text = await document('jsonld', [
      { quads: [q(`${E}a`, `${RDF}type`, `${vocab.YTHRIL_NS}Entity`), q(`${E}a`, `${RDFS}label`, lit('A')), q(`${E}a`, `${E}n`, lit('1', `${XSD}decimal`)), q(`${E}a`, `${E}r`, `${E}b`)] },
      { graph: `${E}g`, quads: [q(`${E}c`, `${E}p`, lit('x'))] },
    ]);
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc['@context']).sort(), ['rdf', 'rdfs', 'schema', 'xsd', 'ythril']);
    for (const ns of Object.values(doc['@context'])) assert.match(ns, /[/#]$/, 'a prefix namespace ends in a delimiter');
    assert.equal(doc['@graph'].length, 2);
    const node = doc['@graph'][0];
    assert.equal(node['@id'], `${E}a`);
    assert.deepEqual(node['@type'], ['ythril:Entity']);
    assert.deepEqual(node['rdfs:label'], [{ '@value': 'A' }]);
    assert.deepEqual(node[`${E}n`], [{ '@value': '1', '@type': 'xsd:decimal' }], 'a number keeps its lexical form as a string');
    assert.deepEqual(node[`${E}r`], [{ '@id': `${E}b` }]);
    assert.equal(doc['@graph'][1]['@id'], `${E}g`);
    assert.equal(doc['@graph'][1]['@graph'][0]['@id'], `${E}c`);
  });
  it('an empty export is still a valid document', async () => {
    assert.deepEqual(JSON.parse(await document('jsonld', []))['@graph'], []);
  });
  it('refuses a triple term: JSON-LD 1.1 has none, its reifier is the classic form', async () => {
    await assert.rejects(() => document('jsonld', [{ quads: [q(`${E}r`, `${RDF}reifies`, triple(iri(`${E}s`), iri(`${E}p`), iri(`${E}o`)))] }]), /triple term/i);
  });
  it('refuses an absolute IRI whose scheme is a declared prefix: a processor would read it as a compact name', async () => {
    await assert.rejects(() => document('jsonld', [{ quads: [q('schema:thing', `${E}p`, lit('x'))] }]), /prefix/i);
  });
});

describe('the IRIREF guard: an IRI that cannot be written is refused, never written', () => {
  const bad = [`${E}a b`, `${E}a>b`, `${E}a<b`, `${E}a"b`, `${E}a{b`, `${E}a}b`, `${E}a|b`, `${E}a\\b`, `${E}a^b`, `${E}a\`b`, `${E}a\nb`, `${E}a\u0000b`, `${E}a\uD800b`, 'relative/iri'];
  for (const format of FORMATS) {
    for (const b of bad) {
      it(`${format}: ${JSON.stringify(b)} as a subject, predicate, object and datatype`, async () => {
        for (const quads of [
          [q(b, `${E}p`, lit('x'))], [q(`${E}s`, b, lit('x'))], [q(`${E}s`, `${E}p`, b)], [q(`${E}s`, `${E}p`, lit('x', b))],
        ]) {
          await assert.rejects(() => document(format, [{ quads }]), /IRI/, 'refused');
        }
      });
    }
  }
});

describe('blank nodes and collections', () => {
  it('blank nodes are _:b0, _:b1, ... in output order, per document, whatever the caller called them', async () => {
    const batch = { quads: [q(blank('zzz'), `${E}p`, blank('aaa')), q(`${E}s`, `${E}q`, blank('zzz'))] };
    const first = await document('nquads', [batch]);
    assert.ok(/_:b0/.test(first) && /_:b1/.test(first) && !/zzz|aaa/.test(first), first);
    assert.equal(first, await document('nquads', [batch]), 'a second document starts again at b0 and gives the same bytes');
  });
  it('a collection is ( ... ) in Turtle, rdf:first/rdf:rest/rdf:nil in N-Quads, @list in JSON-LD, an empty one is rdf:nil', async () => {
    const batch = { quads: [q(`${E}s`, `${E}p`, list(lit('a'), iri(`${E}b`), lit('c'))), q(`${E}s`, `${E}empty`, list())] };
    const ttl = await document('turtle', [batch]);
    assert.ok(ttl.includes('( "a" <http://ex.org/b> "c" )'), ttl);
    assert.ok(/<http:\/\/ex\.org\/empty> \(\s*\)/.test(ttl) || ttl.includes('rdf:nil'), ttl);
    const nq = await document('nquads', [batch]);
    assert.equal((nq.match(new RegExp(`<${RDF}first>`, 'g')) ?? []).length, 3);
    assert.equal((nq.match(new RegExp(`<${RDF}rest>`, 'g')) ?? []).length, 3);
    assert.ok(nq.includes(`<${RDF}nil>`));
    const node = JSON.parse(await document('jsonld', [batch]))['@graph'][0];
    assert.deepEqual(node[`${E}p`], [{ '@list': [{ '@value': 'a' }, { '@id': `${E}b` }, { '@value': 'c' }] }]);
    assert.deepEqual(node[`${E}empty`], [{ '@list': [] }]);
  });
  it('a triple term is <<( s p o )>> in Turtle, TriG and N-Quads', async () => {
    const batch = { quads: [q(`${E}r`, `${RDF}reifies`, triple(iri(`${E}s`), iri(`${E}p`), lit('v')))] };
    for (const format of ['turtle', 'trig', 'nquads']) {
      assert.ok((await document(format, [batch], { prefixes: PREFIXES(), edgeDetails: 'rdf12' })).includes(`<<( <${E}s> <${E}p> "v" )>>`), format);
    }
  });
});

describe('the same quads give the same bytes, in whatever order they come', () => {
  const quads = [
    q(`${E}b`, `${E}z`, lit('2')), q(`${E}a`, `${E}y`, lit('1')), q(`${E}a`, `${RDF}type`, `${E}C`), q(`${E}a`, `${E}y`, lit('0')),
    q(`${E}b`, `${E}z`, lit('2')), q(`${E}a`, `${E}x`, `${E}k`),
  ];
  const shuffled = [quads[5], quads[3], quads[0], quads[4], quads[2], quads[1]];
  for (const format of FORMATS) {
    it(`${format}: quads in any order, prefixes in any key order, and a statement repeated give one document`, async () => {
      const a = await document(format, [{ quads }], { prefixes: { rdf: RDF, ex: E, xsd: XSD } });
      const b = await document(format, [{ quads: shuffled }], { prefixes: { xsd: XSD, ex: E, rdf: RDF } });
      assert.equal(a, b);
      assert.equal(a, await document(format, [{ quads }], { prefixes: { rdf: RDF, ex: E, xsd: XSD } }), 'and on a second run');
    });
  }
});

describe('the writer streams', () => {
  const batches = (n, onPull) => (async function* () {
    try {
      for (let i = 0; i < n; i++) { onPull(i); yield { quads: [q(`${E}s${i}`, `${E}p`, lit(`v${i}`))] }; }
    } finally { onPull('closed'); }
  })();

  for (const format of FORMATS) {
    it(`${format}: one chunk per batch, pulled as they are read; a document is never built in one string`, async () => {
      const pulled = [];
      const chunks = [];
      for await (const chunk of need('serializeRdf')(format, batches(5, (i) => pulled.push(i)), { prefixes: PREFIXES() })) {
        chunks.push(chunk);
        const batchesRead = pulled.filter((p) => p !== 'closed').length;
        assert.ok(batchesRead <= Math.max(0, chunks.length - 1) + 1, `after chunk ${chunks.length} the source had been drained to ${batchesRead}`);
      }
      assert.ok(chunks.length >= 5 + 2, `a preamble, a chunk per batch and a close (${chunks.length} chunks)`);
      assert.equal(pulled.filter((p) => p !== 'closed').length, 5);
    });
    it(`${format}: stopping the reader stops the source`, async () => {
      const pulled = [];
      const gen = need('serializeRdf')(format, batches(50, (i) => pulled.push(i)), { prefixes: PREFIXES() });
      await gen.next();
      await gen.next();
      await gen.return(undefined);
      assert.ok(pulled.includes('closed'), 'the source was closed');
      assert.ok(pulled.filter((p) => p !== 'closed').length < 5, 'and not drained');
    });
  }
  it('takes a plain iterable as well as an async one', async () => {
    const text = await document('nquads', [{ quads: [q(`${E}a`, `${E}p`, lit('x'))] }, { quads: [q(`${E}b`, `${E}p`, lit('y'))] }]);
    assert.equal(text.split('\n').filter(Boolean).length, 2);
  });
});

describe('the closing comment', () => {
  it('states the count and names the records, and is ONE comment line whatever the ids hold', () => {
    const closing = need('closingComment');
    assert.equal(closing({ count: 0, named: [], unnamed: 0 }), undefined, 'nothing left out, nothing said');
    const text = closing({ count: 3, named: [{ recordId: 'e1', key: 'k' }, { recordId: 'e2\nINJECT <http://x> <http://y> "z" .', key: 'a\r\u{2028}b' }], unnamed: 1 });
    assert.match(text, /^ythril-export: 3 property values left out \(not a plain value\)/);
    assert.ok(!/[\r\n\u{2028}\u{2029}\u{85}]/u.test(text), 'one line');
    assert.match(text, /e1/);
  });
  for (const format of ['turtle', 'trig', 'nquads']) {
    it(`${format}: ends the document with it as a comment no parser reads as a statement`, async () => {
      const w = need('createRdfWriter')(format, { prefixes: PREFIXES() });
      const text = w.open() + w.write({ quads: [q(`${E}a`, `${E}p`, lit('x'))] }) + w.close('ythril-export: 1 property values left out\nINJECT <a> <b> <c> .');
      const last = text.trimEnd().split('\n').pop();
      assert.match(last, /^# ythril-export: 1 property values left out/);
      assert.equal(text.trimEnd().split('\n').filter((l) => /INJECT/.test(l) && !l.startsWith('#')).length, 0, 'no line of the comment is outside it');
    });
  }
  it('jsonld: has no comment; the document is still valid JSON', () => {
    const w = need('createRdfWriter')('jsonld', { prefixes: PREFIXES() });
    const text = w.open() + w.write({ quads: [q(`${E}a`, `${E}p`, lit('x'))] }) + w.close('ythril-export: 1');
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(!text.includes('ythril-export'));
  });
});
