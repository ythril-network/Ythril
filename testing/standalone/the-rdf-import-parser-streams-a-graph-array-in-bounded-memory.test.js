/**
 * A JSON-LD document that is a root `@graph` array is read as a stream: its first statement comes early and the heap does not follow the
 * document (bundle-270, slice S1, review U6 follow-up).
 *
 * ## The defect this prevents
 *
 * By the library alone the product's own export (`{"@context": ..., "@graph": [ node, node, ... ]}`) is held whole: without an `@id` on the root
 * `EntryHandlerPredicate.handlePredicateObject` buffers every statement in `unidentifiedGraphsBuffer` and `JsonLdParser.flushBuffer` releases them
 * with the document's last character, and with or without one the tokenizer (`@bergos/jsonparse`, `onToken`: `this.value[this.key] = value`) keeps
 * the value of the root it is given. The memory of a reader followed the document, and an export over `RDF_MAX_UNPARSED_CHARS` was refused.
 *
 * ## What it holds
 *
 * A document that ends within the bound is read whole by the library, whatever its shape (`the-rdf-import-parser-reads-a-graph-array-as-its-whole-document`).
 * A document that passes the bound as a root of only a context, an `@id` and a `@graph` array is read again from its start, a batch of nodes at a time.
 * The documents are generated lazily and many times the bound long:
 *  - the export's shape (no `@id` on the root) is read whole, every node once, its first statement coming before the bound plus one batch of
 *    characters was fed (the text is held up to the bound, then read again), and the heap, measured after a forced collection every few thousand
 *    statements, never growing by more than a ceiling;
 *  - the ceiling can be exceeded: the same document given to the library as one object (the array's key an alias the reader does not take apart,
 *    under a root `@id`, so that the library streams its statements and only its tokenizer holds the document) grows the heap past it;
 *  - a named graph document (the root's `@id` before the array) is read whole, every node once, its first statement as early.
 *
 * The bound is the option a caller with a lower ceiling passes (`BOUND`, an eighth of the default), so that the file takes seconds: the rule is the
 * bound's, whatever its value; the default itself is held by the cases of the other two files that read a document over it.
 *
 * Run: node --test testing/standalone/the-rdf-import-parser-streams-a-graph-array-in-bounded-memory.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { parseRdf, lazyDocument } from './_rdf-parse-doors.mjs';

/** A function that runs a full collection: the engine's own, reached without a flag on the command line. */
const collect = (() => { v8.setFlagsFromString('--expose-gc'); return vm.runInNewContext('gc'); })();
const MIB = 1024 * 1024;
const BOUND = 131_072;
const READ_UNDER_BOUND = { bounds: { maxUnparsedChars: BOUND } };
/** The characters of one batch the reader gives the library at a time. */
const BATCH_CHARS = 65_536;
/** The nodes of a document of about 3.7 MB, nearly thirty times the bound (a node is about 47 characters). */
const NODES = 80_000;
const PIECE_NODES = 400;
/** The statements between two forced collections. */
const SAMPLE_EVERY = 5_000;
/** The most the heap may grow, after a forced collection, while such a document is read: between what the reader needs and what the library given the document whole keeps (see the diagnostics). */
const HEAP_CEILING_BYTES = 8 * MIB;

const node = (k) => `{"@id":"http://a/s${k}","p":"value ${k}"}`;
const EXPORT_SHAPE = '{"@context":{"p":"http://a/p"},"@graph":[';
const NAMED_GRAPH = '{"@context":{"p":"http://a/p"},"@id":"http://a/g","@graph":[';
const ALIASED_NAMED_GRAPH = '{"@context":{"p":"http://a/p","g":"@graph"},"@id":"http://a/g","g":[';

/** Reads a small document of each route once, so that the code the readers run is compiled before any heap is measured: compiled code is heap too. */
let warmed;
const warmUp = () => warmed ??= (async () => {
  for (const head of [EXPORT_SHAPE, NAMED_GRAPH, ALIASED_NAMED_GRAPH]) {
    for await (const quad of parseRdf(lazyDocument(head, 4_000, node, ']}', { n: 0 }, PIECE_NODES), 'jsonld', READ_UNDER_BOUND)) void quad;
  }
})();

/** Reads `nodes` nodes under `head` through to the end, noting how far the document was fed at the first statement, the statements, and the most the settled heap grew. */
async function readSampled(head, nodes) {
  await warmUp();
  const fed = { n: 0 };
  const source = lazyDocument(head, nodes, node, ']}', fed, PIECE_NODES);
  collect();
  const base = process.memoryUsage().heapUsed;
  const seen = { firstAt: -1, statements: 0, nodes: 0, peak: 0, fed };
  for await (const quad of parseRdf(source, 'jsonld', READ_UNDER_BOUND)) {
    if (seen.firstAt < 0) seen.firstAt = fed.n;
    seen.statements += 1;
    if (quad.predicate.value === 'http://a/p') seen.nodes += 1;
    if (seen.statements % SAMPLE_EVERY === 0) { collect(); seen.peak = Math.max(seen.peak, process.memoryUsage().heapUsed - base); }
  }
  return seen;
}

describe('a @graph array many times the bound is read as a stream, in bounded memory', { timeout: 120_000 }, () => {
  const readWhole = (seen, nodes, what) => {
    assert.ok(seen.fed.n > 5 * BOUND, `${what}: the document (${seen.fed.n} characters) must be many times the unparsed-text bound`);
    assert.equal(seen.nodes, nodes, `${what}: ${seen.nodes} of ${nodes} nodes were read`);
    assert.equal(seen.statements, nodes, `${what}: one statement a node`);
    assert.ok(seen.firstAt <= BOUND + BATCH_CHARS, `${what}: the first statement came after ${seen.firstAt} of ${seen.fed.n} characters (the bound is ${BOUND}): the array is held whole`);
  };

  it('the export\'s shape (a context, then the array): every node, the first statement early, the heap bounded', async (t) => {
    const seen = await readSampled(EXPORT_SHAPE, NODES);
    t.diagnostic(`the reader: ${seen.fed.n} characters, first statement after ${seen.firstAt}, heap grew by ${(seen.peak / MIB).toFixed(2)} MiB`);
    readWhole(seen, NODES, 'a root without an @id');
    assert.ok(seen.peak < HEAP_CEILING_BYTES, `the heap grew by ${(seen.peak / MIB).toFixed(1)} MiB (ceiling ${HEAP_CEILING_BYTES / MIB} MiB) while the document was read: the reader's memory follows the document`);
  });

  it('the ceiling can be exceeded: the library given the same document as one object (the array under an alias) grows the heap past it', async (t) => {
    const seen = await readSampled(ALIASED_NAMED_GRAPH, NODES);
    t.diagnostic(`the library given the document whole: ${seen.fed.n} characters, heap grew by ${(seen.peak / MIB).toFixed(2)} MiB`);
    assert.equal(seen.nodes, NODES);
    assert.ok(seen.peak > HEAP_CEILING_BYTES, `the library read the document whole and the heap grew by only ${(seen.peak / MIB).toFixed(1)} MiB: the ceiling of the case above cannot fail`);
  });

  it('a named graph document (the root\'s @id before the array): every node, the first statement early', async () => {
    const nodes = 20_000;
    readWhole(await readSampled(NAMED_GRAPH, nodes), nodes, 'a root with an @id');
  });
});
