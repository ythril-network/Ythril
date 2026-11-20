/**
 * The import parser reads a file a stranger made, inside the server: it refuses what it cannot trust, says where and why, and fetches nothing
 * (bundle-270, slice S1; amendments A6, A9).
 *
 * ## The defects this prevents
 *
 * - **A request forged from inside the server.** A JSON-LD document names a remote `@context`; the library's default loader fetches it, so an
 *   upload makes the server call any address its author chooses. The parser answers every remote context (in the document, in an `@import`, in
 *   a nested node, in a list) with a refusal that names the address, and the test watches `fetch`, `node:http`, `node:https`, `node:net` and
 *   `node:dns` and holds that nothing is called. A control call proves the watch sees a request.
 * - **A document that needs buffering.** The JSON-LD reader runs in its streaming profile; a `@context` that comes after the data it would
 *   govern is refused instead of held whole.
 * - **A malformed document that ends the process.** A parser's stream error with nobody listening is an uncaught exception. Every malformed
 *   document, in every format, surfaces as a refusal thrown from the iteration, with the line and column in the document, and none reaches
 *   `uncaughtException` or `unhandledRejection`.
 * - **A relative address read against a base nobody gave.** No parser is given a base (A9). A relative address is refused with its place and
 *   the address, in every format; a document that declares its own `@base` is the one thing that resolves them.
 * - **A refused upload that goes on being read.** The source is destroyed when the reader refuses, and when the caller stops iterating.
 * - **A second reader of the JSON-LD library that fetches.** The only module that builds the JSON-LD parser is `rdf/parse.ts`, and it names a
 *   document loader; the scope is every tracked file of the server's code roots.
 *
 * The built server is needed (`npm run build:server`). Run: node --test testing/standalone/the-rdf-import-parser-refuses-what-it-cannot-trust.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseRdf, readQuads, refusalOf, sourceOf, pieces, placeOf } from './_rdf-parse-doors.mjs';

const uncaught = [];
const onUncaught = (err) => uncaught.push(err);
before(() => { process.on('uncaughtException', onUncaught); process.on('unhandledRejection', onUncaught); });
after(() => {
  process.off('uncaughtException', onUncaught); process.off('unhandledRejection', onUncaught);
  assert.deepEqual(uncaught.map(e => e?.message), [], 'a refusal ended up as an event nobody handled');
});

/** Watch every door a request could leave through; calls are recorded and refused. */
function watchNetwork() {
  const calls = [];
  const saved = [];
  const patch = (obj, key, label) => {
    const original = obj[key];
    saved.push(() => { obj[key] = original; });
    obj[key] = (...args) => { calls.push(`${label}(${String(args[0]?.href ?? args[0]?.host ?? args[0])})`); throw new Error(`the test is offline: ${label}`); };
  };
  patch(globalThis, 'fetch', 'fetch');
  patch(http, 'request', 'http.request'); patch(http, 'get', 'http.get');
  patch(https, 'request', 'https.request'); patch(https, 'get', 'https.get');
  patch(net, 'connect', 'net.connect'); patch(net, 'createConnection', 'net.createConnection');
  patch(dns, 'lookup', 'dns.lookup'); patch(dns.promises, 'lookup', 'dns.promises.lookup');
  const connect = net.Socket.prototype.connect;
  saved.push(() => { net.Socket.prototype.connect = connect; });
  net.Socket.prototype.connect = function refused(...args) { calls.push(`socket.connect(${JSON.stringify(args[0])})`); throw new Error('the test is offline: socket.connect'); };
  return { calls, restore: () => { for (const undo of saved.reverse()) undo(); } };
}

const NODE = { '@id': 'http://a/s', 'http://a/p': 'x' };
const doc = (value) => JSON.stringify(value);

describe('a JSON-LD document that names a remote context is refused, and no request leaves the process', () => {
  const CASES = [
    ['a context given as an address', doc({ '@context': 'https://schema.org/', ...NODE }), 'https://schema.org/'],
    ['an @import inside an inline context', doc({ '@context': { '@import': 'https://ex.org/imported.jsonld' }, ...NODE }), 'https://ex.org/imported.jsonld'],
    ['an address among inline contexts', doc({ '@context': [{ p: 'http://a/p' }, 'https://ex.org/second'], ...NODE }), 'https://ex.org/second'],
    ['a nested node', doc({ '@context': { p: 'http://a/p' }, '@id': 'http://a/s', p: { '@context': 'https://ex.org/nested', '@id': 'http://a/o' } }), 'https://ex.org/nested'],
    ['a graph array', doc({ '@context': { p: 'http://a/p' }, '@graph': [{ '@context': 'https://ex.org/in-graph', ...NODE }] }), 'https://ex.org/in-graph'],
    ['an address a loopback server would answer', doc({ '@context': 'http://127.0.0.1:1/ctx', ...NODE }), 'http://127.0.0.1:1/ctx'],
    ['a gzipped body', gzipSync(Buffer.from(doc({ '@context': 'https://ex.org/zipped', ...NODE }))), 'https://ex.org/zipped'],
  ];
  for (const [name, body, address] of CASES) {
    it(`${name}: refused as rdf_remote_context naming ${address}`, async () => {
      const watch = watchNetwork();
      let err;
      try { err = await refusalOf('jsonld', sourceOf(pieces(body, 17))); } finally { watch.restore(); }
      assert.equal(err.code, 'rdf_remote_context');
      assert.equal(err.address, address);
      assert.ok(err.message.includes(address), err.message);
      assert.deepEqual(watch.calls, [], 'a request left the process');
    });
  }
  it('the watch sees a request (so an empty list above means nothing was called)', async () => {
    const watch = watchNetwork();
    try {
      assert.throws(() => fetch('https://schema.org/'), /offline/);
      assert.throws(() => http.get('http://127.0.0.1:1/'), /offline/);
      assert.throws(() => net.connect(1, '127.0.0.1'), /offline/);
    } finally { watch.restore(); }
    assert.equal(watch.calls.length, 3);
  });
  it('an inline context is read, with nothing fetched', async () => {
    const watch = watchNetwork();
    let quads;
    try { quads = await readQuads('jsonld', sourceOf([doc({ '@context': { p: 'http://a/p' }, '@id': 'http://a/s', p: 'x' })])); } finally { watch.restore(); }
    assert.deepEqual(quads.map(x => x.object.value), ['x']);
    assert.deepEqual(watch.calls, []);
  });
});

describe('a JSON-LD document that would need buffering is refused (the streaming profile)', () => {
  it('a @context after the data it would govern is refused as rdf_jsonld_not_streamable', async () => {
    const err = await refusalOf('jsonld', sourceOf([doc({ '@id': 'http://a/s', '@context': { p: 'http://a/p' }, p: 'x' })]));
    assert.equal(err.code, 'rdf_jsonld_not_streamable');
    assert.match(err.message, /context/i);
  });
});

describe('a malformed document is refused with its line and column, never as an unhandled event', () => {
  const MALFORMED = {
    nquads: `<http://a/s> <http://a/p> "x" .\n<http://a/s> <http://a/p> oops .\n`,
    turtle: `@prefix ex: <http://ex/> .\nex:a ex:b nope:c .\n`,
    trig: `<http://g> {\n  <http://a/s> <http://a/p> }\n`,
    jsonld: `{\n  "@context": { "p": "http://a/p" },\n  "@id": "http://a/s",\n  "p": "ééé", "q": x\n}\n`,
  };
  const AT = { nquads: 'oops', turtle: 'nope:c', trig: '}', jsonld: 'x\n}' };
  for (const format of ['nquads', 'turtle', 'trig', 'jsonld']) {
    it(`${format}: refused as rdf_malformed at the offending token, from pieces of 1, 5 and 4096 bytes`, async () => {
      for (const size of [1, 5, 4096]) {
        const err = await refusalOf(format, sourceOf(pieces(MALFORMED[format], size)));
        assert.equal(err.code, 'rdf_malformed', `${err.code}: ${err.message}`);
        assert.deepEqual(err.place, placeOf(MALFORMED[format], AT[format]), `pieces of ${size} bytes: ${err.message}`);
        assert.ok(err.message.length > 0 && err.message.length < 400);
      }
    });
  }
  it('a document that ends inside a statement is refused at its end, naming a line', async () => {
    for (const [format, text] of [['nquads', `<http://a/s> <http://a/p> "x" .\n<http://a/s> <http://a/p>`], ['turtle', '<http://a/s> <http://a/p> "x"\n'], ['jsonld', '{"@context": {}, "@id": "http://a/s"']]) {
      const err = await refusalOf(format, sourceOf(pieces(text, 6)));
      assert.equal(err.code, 'rdf_malformed', `${format}: ${err.message}`);
      assert.ok(Number.isInteger(err.place?.line) && err.place.line >= 1, `${format}: ${JSON.stringify(err.place)}`);
    }
  });
  it('bytes that are not UTF-8 are refused, not read as replacement characters', async () => {
    const err = await refusalOf('nquads', sourceOf([Buffer.from(`<http://a/s> <http://a/p> "`), Buffer.from([0xff, 0xfe]), Buffer.from('" .\n')]));
    assert.equal(err.code, 'rdf_malformed');
    assert.equal(err.place.line, 1);
  });
  it('a gzip body that is not gzip, or is cut short, is refused as rdf_gzip_invalid', async () => {
    const good = gzipSync(Buffer.from(`<http://a/s> <http://a/p> "x" .\n`.repeat(200)));
    const cut = await refusalOf('nquads', sourceOf(pieces(good.subarray(0, good.length - 12), 9)));
    assert.equal(cut.code, 'rdf_gzip_invalid');
    const broken = Buffer.from(good); broken[Math.floor(broken.length / 2)] ^= 0xff;
    assert.equal((await refusalOf('nquads', sourceOf(pieces(broken, 9)))).code, 'rdf_gzip_invalid');
  });
  it('JSON-LD: a second value after the document is refused at its first character, not read or dropped', async () => {
    const first = `{"@context": {"p": "http://a/p"}, "@id": "http://a/s", "p": "x"}\n`;
    const text = `${first}{"@id": "http://a/t", "http://a/p": "y"}\n`;
    const err = await refusalOf('jsonld', sourceOf(pieces(text, 8)));
    assert.equal(err.code, 'rdf_malformed');
    assert.deepEqual(err.place, { line: 2, column: 1 });
    assert.equal((await readQuads('jsonld', sourceOf(pieces(`${first}\n  \n`, 8)))).length, 1, 'trailing white space is not content');
  });
  it('an unknown format is refused, not read as Turtle', async () => {
    const err = await refusalOf('rdfxml', sourceOf(['<rdf/>']));
    assert.equal(err.code, 'rdf_unsupported_format');
  });
});

describe('a relative address is refused with its place, since no base is given', () => {
  const RELATIVE = {
    nquads: `<http://a/s> <http://a/p> "x" .\n<s> <http://a/p> "y" .\n`,
    turtle: `<http://a/s> <http://a/p> "x" .\n<http://a/s> <http://a/p> <o> .\n`,
    trig: `<http://g> { <http://a/s> <http://a/p> "x" } <rel-graph> { <http://a/s> <http://a/p> "y" }\n`,
  };
  const NEEDLE = { nquads: '<s>', turtle: '<o>', trig: '<rel-graph>' };
  const ADDRESS = { nquads: 's', turtle: 'o', trig: 'rel-graph' };
  for (const format of ['nquads', 'turtle', 'trig']) {
    it(`${format}: refused as rdf_relative_iri naming ${ADDRESS[format]}, at its token`, async () => {
      const err = await refusalOf(format, sourceOf(pieces(RELATIVE[format], 4)));
      assert.equal(err.code, 'rdf_relative_iri', `${err.code}: ${err.message}`);
      assert.equal(err.address, ADDRESS[format]);
      assert.deepEqual(err.place, placeOf(RELATIVE[format], NEEDLE[format]));
    });
  }
  it('a relative datatype, and a relative address through a prefix declaration, are refused too', async () => {
    assert.equal((await refusalOf('nquads', sourceOf([`<http://a/s> <http://a/p> "x"^^<dt> .\n`]))).code, 'rdf_relative_iri');
    const err = await refusalOf('turtle', sourceOf([`@prefix r: <rel/> .\n<http://a/s> <http://a/p> r:x .\n`]));
    assert.equal(err.code, 'rdf_relative_iri');
    assert.deepEqual(err.place, placeOf(`@prefix r: <rel/> .\n`, '<rel/>'));
  });
  it('JSON-LD: a relative @id, and a relative property, are refused naming the address', async () => {
    const id = await refusalOf('jsonld', sourceOf([doc({ '@context': { p: 'http://a/p' }, '@id': 'http://a/s', p: { '@id': 'rel/o' } })]));
    assert.equal(id.code, 'rdf_relative_iri');
    assert.equal(id.address, 'rel/o');
    const prop = await refusalOf('jsonld', sourceOf([doc({ '@context': { p: 'rel/p' }, '@id': 'http://a/s', p: 'x' })]));
    assert.equal(prop.code, 'rdf_relative_iri');
    assert.equal(prop.address, 'rel/p');
  });
  it('a document that declares its own @base resolves its relative addresses against it', async () => {
    const quads = await readQuads('turtle', sourceOf(pieces(`@base <http://b/dir/> .\n<s> <http://a/p> <o> .\n`, 3)));
    assert.deepEqual([quads[0].subject.value, quads[0].object.value], ['http://b/dir/s', 'http://b/dir/o']);
    const sparql = await readQuads('turtle', sourceOf([`BASE <http://b/dir/>\n<s> <http://a/p> <o> .\n`]));
    assert.equal(sparql[0].subject.value, 'http://b/dir/s');
  });
  it('an absolute address of any scheme is read as it is', async () => {
    const quads = await readQuads('nquads', sourceOf([`<urn:x:1> <mailto:a@b.c> <tag:a,2020:b> .\n`]));
    assert.deepEqual([quads[0].subject.value, quads[0].predicate.value, quads[0].object.value], ['urn:x:1', 'mailto:a@b.c', 'tag:a,2020:b']);
  });
});

describe('the source is destroyed when the reader refuses and when the caller stops', () => {
  const endless = (first) => {
    let reads = 0;
    const source = new Readable({ read() { reads += 1; this.push(reads === 1 ? Buffer.from(first) : Buffer.from(`<http://a/s> <http://a/p> "${'x'.repeat(2000)}" .\n`)); } });
    return { source, reads: () => reads };
  };
  it('a refused upload stops being read', async () => {
    const { source, reads } = endless(`<http://a/s> <http://a/p> oops .\n`);
    await refusalOf('nquads', source);
    assert.equal(source.destroyed, true);
    assert.ok(reads() < 50, `${reads()} reads: the source went on being read`);
  });
  it('a refused JSON-LD upload stops being read', async () => {
    const { source, reads } = endless(`{"@context": "https://ex.org/remote", "@id": "http://a/s"}\n`);
    await refusalOf('jsonld', source);
    assert.equal(source.destroyed, true);
    assert.ok(reads() < 50, `${reads()} reads`);
  });
  it('a caller that stops iterating destroys the source', async () => {
    const { source } = endless(`<http://a/s> <http://a/p> "x" .\n`);
    for await (const quad of parseRdf(source, 'nquads')) { assert.equal(quad.subject.value, 'http://a/s'); break; }
    assert.equal(source.destroyed, true);
  });
  it('a source that throws is a refusal too, not an unhandled error', async () => {
    const source = new Readable({ read() { this.destroy(new Error('the client went away')); } });
    const err = await refusalOf('nquads', source);
    assert.equal(err.code, 'rdf_source_failed');
    assert.match(err.message, /cut off/);
  });
});

describe('no code but the import parser builds a JSON-LD parser, and it names a document loader', () => {
  const sources = readTrackedSources(SERVER_CODE_ROOTS, { floor: 200 });
  const BUILDERS = /\bnew\s+(?:JsonLdParser|ContextParser|JsonLdContextNormalized|FetchDocumentLoader)\b|from\s+['"]jsonld(?:-streaming-parser|-context-parser)?['"]|require\(\s*['"]jsonld/;
  it('the files that build or import a JSON-LD library are exactly rdf/parse.ts', () => {
    const files = sources.filter(s => BUILDERS.test(s.text)).map(s => s.file);
    assert.deepEqual(files, ['server/src/rdf/parse.ts']);
  });
  it('rdf/parse.ts passes the parser a documentLoader, and the loader it names is the refusing one', () => {
    const parse = sources.find(s => s.file === 'server/src/rdf/parse.ts');
    assert.ok(parse, 'server/src/rdf/parse.ts is not tracked');
    const text = stripComments(parse.text);
    const construct = /new\s+JsonLdParser\(([\s\S]*?)\)\s*;/.exec(text);
    assert.ok(construct, 'no `new JsonLdParser(...)` in rdf/parse.ts');
    assert.match(construct[1], /\bdocumentLoader\b/, 'the JSON-LD parser is built without a documentLoader: the default loader fetches');
    assert.doesNotMatch(text, /FetchDocumentLoader/, 'the fetching loader is named');
  });
});
