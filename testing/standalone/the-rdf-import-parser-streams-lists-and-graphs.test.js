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
 *  - a `@graph` array several times the unparsed-text bound, as the export writes it (no `@id` on the root) and as a named graph document
 *    (`@id` first), is read whole, its first statement coming before one percent of the document was fed, and the heap, measured after a forced
 *    collection, never growing by more than a ceiling while it is read (the reader takes the root object apart and hands the library the
 *    array's nodes in groups of one batch);
 *  - what still cannot be read as a stream (a root with properties of its own before its `@graph`) is refused as `rdf_jsonld_not_streamable`
 *    naming the `@graph` array and what to do, over the unparsed-text bound, not as the unparsed-text bound itself.
 *
 * Run: node --test testing/standalone/the-rdf-import-parser-streams-lists-and-graphs.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';
import { parseModule, parseRdf, refusalOf } from './_rdf-parse-doors.mjs';

const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';

/** A JSON-LD document as pieces made on demand (`group` items to a piece); `fed.n` counts the characters handed to the reader. */
function lazyDocument(head, count, item, tail, fed, group = 1) {
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

const list = (n, fed) => lazyDocument('{"@context":{"p":{"@id":"http://a/p","@container":"@list"}},"@id":"http://a/s","p":[', n, (k) => `"value ${k} of a list"`, ']}', fed);
const node = (k) => `{"@id":"http://a/s${k}","p":"value ${k}"}`;
const graph = (n, fed, head = '{"@context":{"p":"http://a/p"},"@graph":[', group = 1) => lazyDocument(head, n, node, ']}', fed, group);

/** A function that runs a full collection: the engine's own, reached without a flag on the command line. */
const collect = (() => { v8.setFlagsFromString('--expose-gc'); return vm.runInNewContext('gc'); })();
const MIB = 1024 * 1024;
/** The most the heap may grow, after a forced collection, while a document several times the unparsed-text bound is read. */
const HEAP_CEILING_BYTES = 32 * MIB;

/** Reads `source` as JSON-LD through to its end, noting how far the document was fed at the first statement, the statements, and the most the settled heap grew. */
async function readSampled(source, fed) {
  collect();
  const base = process.memoryUsage().heapUsed;
  const seen = { firstAt: -1, statements: 0, nodes: 0, peak: 0 };
  for await (const quad of parseRdf(source, 'jsonld')) {
    if (seen.firstAt < 0) seen.firstAt = fed.n;
    seen.statements += 1;
    if (quad.predicate.value === 'http://a/p') seen.nodes += 1;
    if (seen.statements % 25_000 === 0) { collect(); seen.peak = Math.max(seen.peak, process.memoryUsage().heapUsed - base); }
  }
  return seen;
}

describe('a long @list and a long @graph array are streamed, and what cannot be streamed is refused by name past the bound', { timeout: 300_000 }, () => {
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

  /** The nodes that make a `@graph` document several times the unparsed-text bound (a node is at least 40 characters). */
  const NODES = Math.ceil((8 * parseModule.RDF_MAX_UNPARSED_CHARS) / 40);
  const PIECE_NODES = 400;
  const readsAsAStream = async (head, what) => {
    const fed = { n: 0 };
    const seen = await readSampled(graph(NODES, fed, head, PIECE_NODES), fed);
    assert.ok(fed.n > 6 * parseModule.RDF_MAX_UNPARSED_CHARS, `${what}: the document (${fed.n} characters) must be several times the unparsed-text bound`);
    assert.equal(seen.nodes, NODES, `${what}: ${seen.nodes} of ${NODES} nodes were read`);
    assert.equal(seen.statements, NODES, `${what}: one statement a node`);
    assert.ok(seen.firstAt < fed.n / 100, `${what}: the first statement came after ${seen.firstAt} of ${fed.n} characters: the array is held whole`);
    assert.ok(seen.peak < HEAP_CEILING_BYTES, `${what}: the heap grew by ${(seen.peak / MIB).toFixed(1)} MiB (ceiling ${HEAP_CEILING_BYTES / MIB} MiB) while the document was read: the reader's memory follows the document`);
  };

  it('@graph: the export\'s shape (a context, then the array) several times over the bound is read whole as a stream, in bounded memory', async () => {
    await readsAsAStream('{"@context":{"p":"http://a/p"},"@graph":[', 'a root without an @id');
  });

  it('@graph: a named graph document (the root\'s @id before the array) is read whole as a stream, in bounded memory', async () => {
    await readsAsAStream('{"@context":{"p":"http://a/p"},"@id":"http://a/g","@graph":[', 'a root with an @id');
  });

  it('@graph: what still cannot be read as a stream (a root with a property of its own before the array) is refused as not streamable over the bound, naming @graph and what to do, never as text that completes no statement', async () => {
    const fed = { n: 0 };
    const err = await refusalOf('jsonld', graph(80_000, fed, '{"@context":{"p":"http://a/p"},"p":"a property of the root","@graph":['));
    assert.equal(err.code, 'rdf_jsonld_not_streamable', `${err.code}: ${err.message}`);
    assert.match(err.message, /@graph/);
    assert.match(err.message, /split|Turtle|N-Quads/);
    assert.ok(fed.n < 2 * parseModule.RDF_MAX_UNPARSED_CHARS, `the document was read on to ${fed.n} characters after the bound was passed`);
  });
});
