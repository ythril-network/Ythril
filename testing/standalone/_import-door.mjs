/**
 * Drive the real admin import and export doors over HTTP against a real Mongo, with bodies of any size, shape and encoding - the question
 * "what does `POST /api/admin/spaces/:id/import` do with THIS body", answered once for every test of the import door.
 *
 * ## Why a module
 *
 * The import door's rules are about the BODY: how large it may be, how it is encoded, whether it is valid all the way down, whether the caller
 * is let in before it is read. A test that hands `importDocuments` an object has said nothing about any of them (bundle-40, Q-267). So the
 * fixtures here are the bytes a client sends, and the request is `node:http` rather than `fetch`: `fetch` hides the early answer of a server
 * that refuses a body it has not finished reading, and it cannot send a body whose `Content-Length` is chosen by the test.
 *
 * ## What a hand-written copy drops
 *
 * - **The answer that comes before the body is sent.** A server that answers 413 or 401 and closes may reset the upload; `postBody` keeps
 *   the response it saw and ignores the reset that follows it, and says so when it saw none.
 * - **The spool.** An import that is accepted may keep its body on disk (`import-spool/` under the data root) until its act ends. `spoolFiles`
 *   lists what stands there, so "nothing was kept" and "the spool is gone" are one read rather than two hand-written `readdir`s that miss a
 *   directory which does not exist yet.
 * - **The act.** `importActs` reads the standing acts of kind `import` from the live config, as the runner's own harness reads any kind.
 *
 * ## What it does not do
 *
 * It does not stub the writer, the planner or the runner. It reuses `openToolDoor` (config, harness database, spaces initialised the way
 * production does) and starts the application the one way a test may (`listenApp`).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { openToolDoor } from './_tool-door.mjs';
import { entriesOf } from './_space-act-harness.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

/** Where an import keeps the body it is working from (bundle-40 R1: `<data root>/import-spool/`). */
export const SPOOL_DIR_NAME = 'import-spool';

/** One exported fact: `padBytes` of text make a body as large as the case needs from a count of documents the writer accepts. */
export function fact(id, seq, { padBytes = 0, over = {} } = {}) {
  return {
    _id: id, spaceId: 'elsewhere', fact: padBytes > 0 ? `fact ${id} ${'x'.repeat(padBytes)}` : `fact ${id}`, tags: [],
    author: { instanceId: 'origin', instanceLabel: 'Origin' }, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    seq, ...over,
  };
}

/**
 * The text of an export body: the envelope first (as the export writes it), then one array per family, each document one `JSON.stringify`.
 * `families` maps a family key to its documents, or to a function `() => Iterable<string>` of already-serialised documents (for a body too
 * large to hold as objects, or one that is deliberately broken). `tail` is appended raw before the closing brace, so a test can break the body
 * AFTER a first page without a second serialiser.
 */
export function exportText(families, { envelope = {}, tail = '', unclosed = false } = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(envelope ?? {})) parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(families)) {
    const docs = typeof v === 'function' ? [...v()] : v.map(d => JSON.stringify(d));
    parts.push(`${JSON.stringify(k)}:[${docs.join(',')}]`);
  }
  if (tail) parts.push(tail);
  return `{${parts.join(',')}${unclosed ? '' : '}'}`;
}

/** `count` facts of `padBytes` each, as a function giving the serialised documents - a body of about `count * padBytes` bytes. */
export function paddedFacts(count, padBytes, { idPrefix = 'big', seqFrom = 1 } = {}) {
  return () => Array.from({ length: count }, (_, i) => JSON.stringify(fact(`${idPrefix}-${String(i).padStart(6, '0')}`, seqFrom + i, { padBytes })));
}

/** Encode a body: `identity`, `gzip`, `br` or `deflate`. */
export function encoded(buf, encoding) {
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  if (encoding === 'gzip') return zlib.gzipSync(body);
  if (encoding === 'br') return zlib.brotliCompressSync(body);
  if (encoding === 'deflate') return zlib.deflateSync(body);
  return body;
}

/**
 * POST a body to a URL and answer what the server said: `{ status, text, json }`, or `{ status: 0, error }` when it said nothing. A server that
 * answers and then resets the rest of a refused upload is not an error: the answer it gave is the answer.
 */
export function postBody(url, body, { headers = {}, contentType = 'application/json', method = 'POST' } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return new Promise((resolve) => {
    let answered = false;
    let settled = false;
    const req = http.request(url, {
      method, headers: { 'Content-Type': contentType, 'Content-Length': buf.length, ...headers },
    }, (res) => {
      answered = true;
      const chunks = [];
      const finish = () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, text, json });
      };
      res.on('data', c => chunks.push(c));
      res.on('end', finish);
      res.on('error', finish);
      res.on('close', finish);
    });
    req.on('error', (error) => { if (!answered && !settled) { settled = true; resolve({ status: 0, error: String(error?.message ?? error) }); } });
    // The body in slices, so a server that answers early and closes is not written to in one blocking call.
    const SLICE = 1 << 20;
    const write = (at) => {
      if (at >= buf.length) { req.end(); return; }
      if (req.destroyed) return;
      const ok = req.write(buf.subarray(at, at + SLICE));
      if (ok) setImmediate(() => write(at + SLICE)); else req.once('drain', () => write(at + SLICE));
    };
    write(0);
  });
}

/**
 * Open the import door: the tool door's config and harness database, an admin token, and the application served on loopback.
 * `suite` is the harness database slug (unique per test file), `spaces` the config `spaces` entries, `networks` the config `networks`
 * entries (a test of the receive marks seeds one).
 */
export async function openImportDoor({ suite, spaces, networks = [] }) {
  process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
  process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
  const door = await openToolDoor({ suite, spaces });
  const loader = await import('../../server/dist/config/loader.js');
  if (networks.length > 0) loader.mutateConfig(cfg => { cfg.networks = structuredClone(networks); });
  const tokens = await import('../../server/dist/auth/tokens.js');
  const adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
  const server = await listenApp();
  const dataRoot = process.env['DATA_ROOT'];
  const spoolDir = path.join(dataRoot, SPOOL_DIR_NAME);
  const importUrl = (space) => `${server.url}/api/admin/spaces/${encodeURIComponent(space)}/import`;
  const exportUrl = (space) => `${server.url}/api/admin/spaces/${encodeURIComponent(space)}/export`;

  return {
    ...door, loader, base: server.url, adminKey, dataRoot, spoolDir, server,
    instanceId: () => loader.getConfig().instanceId,
    /** POST `body` to the import door as an admin (`token: null` sends no credentials at all). */
    post(space, body, { token = adminKey, headers = {}, contentType, encoding } = {}) {
      return postBody(importUrl(space), body, {
        contentType,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(encoding ? { 'Content-Encoding': encoding } : {}), ...headers },
      });
    },
    /** The export of a space as the door answers it: `{ status, text, json }`. */
    async exportSpace(space) {
      const r = await fetch(exportUrl(space), { headers: { Authorization: `Bearer ${adminKey}` } });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: r.status, text, json };
    },
    /** The files standing in the spool directory (empty when the directory does not exist yet). */
    spoolFiles() {
      try { return fs.readdirSync(spoolDir).sort(); } catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
    },
    /** The standing acts of kind `import`, as the live config holds them. */
    importActs: () => entriesOf(loader).filter(e => e.kind === 'import'),
    async close() {
      await server.close();
      await door.close();
    },
  };
}

/** The document ids of one family's collection, sorted. */
export async function idsOf(door, space, part = 'facts') {
  return (await door.coll(space, part).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
}
