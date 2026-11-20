/**
 * What the JSON-LD reader holds of a long `@list` and of a long `@graph` (bundle-270 review U6, slice S1).
 *
 * ## The doubt
 *
 * The streaming profile of the JSON-LD library refuses a document that needs buffering, but a list's items are linked by blank nodes
 * (`rdf:first`, `rdf:rest`), and a library may hold a whole list, or a whole `@graph` array, before it emits the first statement. Measured:
 *
 *  - a `@list` IS streamed: its first statement is released after a few characters of the document, and every item is read;
 *  - a top-level `@graph` array is NOT, by the library alone: without an `@id` on the root it holds every statement until the root closes
 *    (`EntryHandlerPredicate.handlePredicateObject` buffers them in `unidentifiedGraphsBuffer`, `JsonLdParser.flushBuffer` releases them: the
 *    first statement arrives with the document's last character), and with or without one its JSON tokenizer (`@bergos/jsonparse`) keeps the
 *    value of the root object it is given, so the memory of a reader follows the document. The product's own JSON-LD export has exactly this
 *    shape (`{"@context": ..., "@graph": [ node, node, ... ]}`).
 *
 * ## What it holds
 *
 * The documents are generated lazily (never held) and the characters fed are counted:
 *  - a `@list` over the bound is read whole, its first statement coming before one percent of the document was fed;
 *  - a `@graph` under the bound is read whole;
 *  - a `@graph` array that is a root of only a context, an `@id` and the array is read as a stream, in bounded memory, its first statement coming
 *    early (`the-rdf-import-parser-streams-a-graph-array-in-bounded-memory`, apart because of this file's own time);
 *  - what still cannot be read as a stream (a root with properties of its own before its `@graph`) is refused as `rdf_jsonld_not_streamable`
 *    naming the `@graph` array and what to do, over the unparsed-text bound (a lower one, which a caller passes, so that the case takes seconds),
 *    not as the unparsed-text bound itself.
 *
 * Run: node --test testing/standalone/the-rdf-import-parser-streams-lists-and-graphs.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModule, parseRdf, refusalOf, lazyDocument } from './_rdf-parse-doors.mjs';

const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';

const list = (n, fed) => lazyDocument('{"@context":{"p":{"@id":"http://a/p","@container":"@list"}},"@id":"http://a/s","p":[', n, (k) => `"value ${k} of a list"`, ']}', fed);
const node = (k) => `{"@id":"http://a/s${k}","p":"value ${k}"}`;
const graph = (n, fed, head = '{"@context":{"p":"http://a/p"},"@graph":[', group = 1) => lazyDocument(head, n, node, ']}', fed, group);

describe('a long @list is streamed, and what cannot be streamed is refused by name past the bound', { timeout: 120_000 }, () => {
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

  it('@graph: what still cannot be read as a stream (a root with a property of its own before the array) is refused as not streamable over the bound, naming @graph and what to do, never as text that completes no statement', async () => {
    const bound = 262_144;
    const fed = { n: 0 };
    const err = await refusalOf('jsonld', graph(30_000, fed, '{"@context":{"p":"http://a/p"},"p":"a property of the root","@graph":[', 400), { bounds: { maxUnparsedChars: bound } });
    assert.equal(err.code, 'rdf_jsonld_not_streamable', `${err.code}: ${err.message}`);
    assert.match(err.message, /@graph/);
    assert.match(err.message, /split|Turtle|N-Quads/);
    assert.ok(fed.n < 2 * bound, `the document was read on to ${fed.n} characters after the bound (${bound}) was passed`);
  });
});
