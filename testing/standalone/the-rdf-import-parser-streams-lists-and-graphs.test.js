/**
 * What the JSON-LD reader holds of a long `@list` and of a long `@graph` (bundle-270 review U6, slice S1).
 *
 * ## The doubt
 *
 * The streaming profile of the JSON-LD library refuses a document that needs buffering, but a list's items are linked by blank nodes
 * (`rdf:first`, `rdf:rest`), and a library may hold a whole list, or a whole `@graph` array, before it emits the first statement. Measured:
 *
 *  - a `@list` IS streamed: its first statement is released after a few characters of the document, and every item is read;
 *  - a top-level `@graph` array is NOT: the library holds it whole and releases the first statement with the document's last character (the
 *    product's own JSON-LD export has exactly this shape). Memory then follows the document, so the reader's bound on text that completes no
 *    statement (`RDF_MAX_UNPARSED_CHARS`) is what keeps it safe; but over that bound the refusal said "text that completes no statement", a
 *    description of nothing the caller wrote.
 *
 * ## What it holds
 *
 * The documents are generated lazily (never held) and the characters fed are counted:
 *  - a `@list` over the bound is read whole, its first statement coming before one percent of the document was fed;
 *  - a `@graph` under the bound is read whole;
 *  - a `@graph` over the bound is refused as `rdf_jsonld_not_streamable` naming the `@graph` array and what to do, not as the unparsed-text bound.
 *
 * Run: node --test testing/standalone/the-rdf-import-parser-streams-lists-and-graphs.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseModule, parseRdf, refusalOf } from './_rdf-parse-doors.mjs';

const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';

/** A JSON-LD document as pieces made on demand; `fed.n` counts the characters handed to the reader. */
function lazyDocument(head, count, item, tail, fed) {
  return Readable.from((function* () {
    fed.n += head.length; yield Buffer.from(head);
    for (let k = 0; k < count; k += 1) { const s = `${k === 0 ? '' : ','}${item(k)}`; fed.n += s.length; yield Buffer.from(s); }
    fed.n += tail.length; yield Buffer.from(tail);
  })(), { objectMode: false });
}

const list = (n, fed) => lazyDocument('{"@context":{"p":{"@id":"http://a/p","@container":"@list"}},"@id":"http://a/s","p":[', n, (k) => `"value ${k} of a list"`, ']}', fed);
const graph = (n, fed) => lazyDocument('{"@context":{"p":"http://a/p"},"@graph":[', n, (k) => `{"@id":"http://a/s${k}","p":"value ${k}"}`, ']}', fed);

describe('a long @list is streamed, a long @graph is held whole and refused past the bound', { timeout: 180_000 }, () => {
  it('@list: a list over the unparsed-text bound is read whole, and its first statement comes before 1% of it was fed', async () => {
    const fed = { n: 0 };
    let firstAt = -1;
    let firsts = 0;
    for await (const quad of parseRdf(list(100_000, fed), 'jsonld')) {
      if (firstAt < 0) firstAt = fed.n;
      if (quad.predicate.value === RDF_FIRST) firsts += 1;
    }
    assert.ok(fed.n > parseModule.RDF_MAX_UNPARSED_CHARS, `the list (${fed.n} characters) must be over the unparsed-text bound`);
    assert.equal(firsts, 100_000, `${firsts} of the list's items were read`);
    assert.ok(firstAt < fed.n / 100, `the first statement came after ${firstAt} of ${fed.n} characters: the list is held whole`);
  });

  it('@graph: an array under the bound is read whole', async () => {
    let nodes = 0;
    for await (const quad of parseRdf(graph(5_000, { n: 0 }), 'jsonld')) if (quad.predicate.value === 'http://a/p') nodes += 1;
    assert.equal(nodes, 5_000);
  });

  it('@graph: an array over the bound is refused as not streamable, naming @graph and what to do, never as text that completes no statement', async () => {
    const fed = { n: 0 };
    const err = await refusalOf('jsonld', graph(80_000, fed));
    assert.equal(err.code, 'rdf_jsonld_not_streamable', `${err.code}: ${err.message}`);
    assert.match(err.message, /@graph/);
    assert.match(err.message, /split|Turtle|N-Quads/);
    assert.ok(fed.n < 2 * parseModule.RDF_MAX_UNPARSED_CHARS, `the document was read on to ${fed.n} characters after the bound was passed`);
  });
});
