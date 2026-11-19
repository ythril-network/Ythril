/**
 * No request a caller can send ends the server through the two RDF exports (bundle-269 slice E, Q-750, Q-751; the first drive with real
 * requests, findings 1 to 3).
 *
 * ## What the drive found
 *
 * - `HEAD /api/brain/spaces/:id/export/rdf` and an HTTP/1.0 `GET` of it ended the server process: the route declared `Trailer:` on an
 *   answer that is not chunked, Node threw `ERR_HTTP_TRAILER_INVALID` writing the headers, the error handler's own answer threw it again in
 *   an event callback, and the process handler (`server/src/index.ts`) ended the process on that uncaught exception.
 * - `HEAD /api/spaces/:id/schema-rdf` answered 200 with the document's headers to a token whose `GET` answers 403: the rights inventory
 *   keys on the method, so a `HEAD` found no row and only reach was asked.
 *
 * ## What it holds
 *
 * - `HEAD` on both routes is answered deliberately (RFC 9110 §9.3.2: the headers `GET` would send, no content) after the same rights check
 *   as `GET`: a token without the rung gets the 403 `GET` gets; the records export walks nothing for it (no store page is read).
 * - An HTTP/1.0 client gets the whole file with the in-body ending only: no `Trailer` header, no chunking, the document ending with its
 *   closing comment; the paged answer likewise.
 * - A request that stops in the middle of its header lines is dropped without harm.
 * - After all of that the same server answers a normal export, and no uncaught exception or unhandled rejection was raised. In the server
 *   process an uncaught exception ends the process, so one raised here is the process ending.
 *
 * Raw requests go over `node:net`, because `node:http` cannot send HTTP/1.0 or stop half way through a header.
 *
 * Run: node --test testing/standalone/no-request-ends-the-server-through-the-rdf-exports-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfnoend';
const RECORDS = `/api/brain/spaces/${SPACE}/export/rdf`;
const SCHEMA = `/api/spaces/${SPACE}/schema-rdf`;

/**
 * Send `head` (the request line and header lines, no final blank line) over a raw socket; with `cut`, stop after `cut` bytes and close.
 * Answers the raw response split into status, headers and body, read until the server closes (every request asks `Connection: close`).
 */
function raw(url, head, { cut } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    const chunks = [];
    socket.setTimeout(30_000, () => socket.destroy(new Error('the raw request timed out')));
    socket.on('data', c => chunks.push(c));
    socket.on('error', err => (cut === undefined ? reject(err) : resolve(null)));
    socket.on('close', () => {
      if (cut !== undefined) { resolve(null); return; }
      const text = Buffer.concat(chunks).toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      const lines = text.slice(0, end === -1 ? text.length : end).split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const headers = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve({ status, headers, body: Buffer.from(end === -1 ? '' : text.slice(end + 4), 'latin1').toString('utf8') });
    });
    socket.on('connect', () => {
      const all = `${head}\r\n\r\n`;
      if (cut === undefined) { socket.write(all); return; }
      socket.write(all.slice(0, cut), () => socket.destroy());
    });
  });
}

const request = (method, path, key, version = '1.1', extra = '') =>
  `${method} ${path} HTTP/${version}\r\nHost: test.invalid\r\nAuthorization: Bearer ${key}\r\nConnection: close${extra}`;

describe('no request ends the server through the RDF exports', { skip, timeout: 120_000 }, () => {
  let d, act, reader, noSchema, noKnowledge;
  const raised = [];
  const onRaised = (err) => raised.push(err);
  before(async () => {
    process.on('uncaughtException', onRaised);
    process.on('unhandledRejection', onRaised);
    d = await openRdfExportDoors({ suite: 'rdf_export_noend', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: 5 }, (_, i) => ({ _id: `n${i}`, name: `No end ${i}` })));
    act = await import('../../server/dist/rdf/export-act.js');
    reader = await d.mint('reader', { [SPACE]: d.row({ knowledge: 'read', schema: 'read' }) });
    noSchema = await d.mint('noschema', { [SPACE]: d.row({ knowledge: 'read' }) });
    noKnowledge = await d.mint('noknowledge', { [SPACE]: d.row({ schema: 'read' }) });
  });
  after(async () => {
    act?.setRdfExportPageReaderForTest?.(null);
    process.off('uncaughtException', onRaised);
    process.off('unhandledRejection', onRaised);
    await d?.close();
  });

  it('HEAD on the records export answers the headers GET would send, walks nothing, and declares no trailer', async () => {
    let reads = 0;
    const { idKeysetPage } = await import('../../server/dist/db/id-keyset-page.js');
    act.setRdfExportPageReaderForTest((spec, afterId) => { reads++; return idKeysetPage(spec, afterId); });
    let r;
    try { r = await raw(d.server.url, request('HEAD', RECORDS, reader.key)); } finally { act.setRdfExportPageReaderForTest(null); }
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.headers['content-type'], 'text/turtle; version=1.2');
    assert.match(r.headers['content-disposition'] ?? '', /attachment; filename="rdfnoend\.ttl"/);
    assert.match(r.headers['vary'] ?? '', /\bAccept\b/);
    assert.equal(r.headers['trailer'], undefined, 'a HEAD answer carries no content, so it declares no trailer');
    assert.equal(r.body, '', 'a HEAD answer has no content');
    assert.equal(reads, 0, 'a HEAD walks no store page');
  });

  it('HEAD on the records export is refused as GET is, to a token without knowledge: read', async () => {
    const get = await d.exportRest(noKnowledge.key, SPACE);
    assert.equal(get.status, 403);
    const head = await raw(d.server.url, request('HEAD', RECORDS, noKnowledge.key));
    assert.equal(head.status, 403, 'HEAD answers what GET answers');
  });

  it('HEAD on the schema export answers its headers to a schema reader and 403 to a token GET refuses', async () => {
    const ok = await raw(d.server.url, request('HEAD', SCHEMA, reader.key));
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal(ok.headers['content-type'], 'text/turtle');
    assert.match(ok.headers['content-disposition'] ?? '', /rdfnoend-schema\.ttl/);
    assert.equal(ok.body, '');
    const get = await d.schemaRest(noSchema.key, SPACE);
    assert.equal(get.status, 403, 'the GET of a token without schema: read');
    const head = await raw(d.server.url, request('HEAD', SCHEMA, noSchema.key));
    assert.equal(head.status, 403, 'HEAD is refused as GET is (the drive: 200 with the document\'s headers)');
    assert.equal(head.headers['content-disposition'], undefined, 'no document header to a token that may not read it');
  });

  it('an HTTP/1.0 client gets the whole records export with the in-body ending, no Trailer and no chunking', async () => {
    const r = await raw(d.server.url, request('GET', `${RECORDS}?format=nquads`, reader.key, '1.0'));
    assert.equal(r.status, 200, JSON.stringify(r).slice(0, 400));
    assert.equal(r.headers['trailer'], undefined);
    assert.equal(r.headers['transfer-encoding'], undefined, 'HTTP/1.0 has no chunking');
    assert.match(r.body, /# ythril-export: 5 records; complete, nothing is left[^\n]*\n$/, 'the document ends with its closing comment');
    await parseRdf('nquads', r.body);
  });

  it('an HTTP/1.0 client gets a page of the records export, and the schema export, without a Trailer', async () => {
    const page = await raw(d.server.url, request('GET', `${RECORDS}?format=nquads&limit=2`, reader.key, '1.0'));
    assert.equal(page.status, 200, JSON.stringify(page).slice(0, 400));
    assert.equal(page.headers['trailer'], undefined);
    assert.match(page.headers['link'] ?? '', /rel="next"/);
    const schema = await raw(d.server.url, request('GET', SCHEMA, reader.key, '1.0'));
    assert.equal(schema.status, 200);
    assert.equal(schema.headers['trailer'], undefined);
  });

  it('a request that stops in the middle of its header lines is dropped, on both routes', async () => {
    for (const path of [RECORDS, SCHEMA]) {
      const head = request('GET', path, reader.key);
      await raw(d.server.url, head, { cut: Math.floor(head.length / 2) });
    }
  });

  it('afterwards the same server answers a normal export, and nothing was raised that would end its process', async () => {
    const r = await d.exportRest(reader.key, SPACE, { format: 'nquads' });
    assert.equal(r.status, 200);
    assert.equal(r.trailers['ythril-export-complete'], 'true', 'a chunked HTTP/1.1 answer still carries its trailers');
    const s = await d.schemaRest(reader.key, SPACE);
    assert.equal(s.status, 200);
    assert.deepEqual(raised.map(e => String(e?.message ?? e)), [], 'an uncaught exception or unhandled rejection ends the server process');
  });
});
