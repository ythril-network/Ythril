/**
 * The doors the RDF export tests drive (bundle-269 slice D, Q-750, Q-751): the real application over a loopback socket with real tokens
 * (`openViewDoors`), spaces with RDF switched on, records seeded straight into their collections, and readers for both answers.
 *
 * ## The contract it encodes, written before the doors
 *
 * - Records: `GET /api/brain/spaces/:spaceId/export/rdf?format=&edgeDetails=&after=&limit=&maxChars=&maxBytes=&maxTokens=` (and the
 *   `Accept` header) and MCP `export_rdf { space, format, edgeDetails, after, limit, maxChars, maxBytes, maxTokens }`.
 * - Schema: `GET /api/spaces/:id/schema-rdf?format=` (and `Accept`) and MCP `space_schema_rdf { space, format }`.
 * - MCP answers the document once in `content[0]`, the summary as JSON in `content[1]`, and the summary (never the document) in
 *   `structuredContent`.
 *
 * `restGet` reads the answer with `node:http`, because only it hands over HTTP trailers (`fetch` drops them).
 */
import http from 'node:http';
import { Parser } from 'n3';
import jsonld from 'jsonld';
import { openPushDoor } from './_push-door.mjs';
import { openViewDoors } from './_view-doors.mjs';

/** The base of a test space: an `example.org` address, never resolved. */
export const baseOf = (id) => `https://rdf.example.org/ld/${id}/`;

/** A space's meta with RDF on (and embeddings off, so seeding needs no embedder). */
export const rdfMeta = (id, extra = {}) => ({
  suppressEmbeddings: true, validationMode: 'warn',
  rdf: { enabled: true, base: baseOf(id), vocab: `${baseOf(id)}vocab/`, baseEpoch: 0 },
  ...extra,
});

/** The collection a seeded kind lives in. */
const COLLECTION = { entity: 'entities', fact: 'facts', edge: 'edges', chrono: 'chrono', link: 'links', file: 'files' };

const AUTHOR = { instanceId: 'rdf-test-instance', instanceLabel: 'RDF test' };
const STAMP = { createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z', author: AUTHOR };

/** A stored record of `kind`, with the fields every record carries. */
export function storedRecord(kind, doc) {
  if (kind === 'link' || kind === 'file') return { ...doc };
  return { ...STAMP, tags: [], ...doc };
}

/**
 * Open the doors over `spaces` (`[{ id, meta }]`, each opened as a real space).
 * @returns the view doors plus `seed(space, kind, docs)`, `restGet(key, path, headers)`, `exportRest`, `exportMcp`, `schemaRest`, `schemaMcp`.
 */
export async function openRdfExportDoors({ suite, spaces }) {
  const doors = await openViewDoors({
    suite, spaces: spaces.map(s => s.id),
    openDoor: () => openPushDoor({ suite, spaces: spaces.map(s => ({ id: s.id, label: s.label ?? s.id, folders: [], meta: s.meta ?? rdfMeta(s.id) })) }),
  });

  /** Insert `docs` (stored shapes) into the kind's collection of `space`. */
  async function seed(space, kind, docs) {
    if (docs.length === 0) return;
    await doors.col(doors.spaceCollection(space, COLLECTION[kind])).insertMany(docs.map(d => storedRecord(kind, d)));
    // The space is held to its records (its triple index marked `stale`), as `_sparql-doors.mjs` `seed` holds it: the suites that seed state
    // the records path's rules (bundle-273, Q-764 S3); the index path's are stated by the S3 specs.
    await doors.col(doors.spaceCollection(space, 'rdfState')).updateOne({ _id: 'state' }, { $set: { status: 'stale' }, $setOnInsert: { appliedPos: 0, formKey: '' } }, { upsert: true });
  }

  /** Empty every seeded collection of `space`. */
  async function clear(space) {
    for (const c of Object.values(COLLECTION)) await doors.col(doors.spaceCollection(space, c)).deleteMany({});
  }

  /** A GET with `node:http`: status, headers, body text and trailers. */
  function restGet(key, path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${doors.server.url}${path}`, { headers: { Authorization: `Bearer ${key}`, ...headers } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, body, trailers: res.trailers });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60_000, () => req.destroy(new Error('timed out')));
    });
  }

  const query = (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  /** The records export over REST. */
  const exportRest = (key, space, params = {}, headers = {}) =>
    restGet(key, `/api/brain/spaces/${encodeURIComponent(space)}/export/rdf${query(params)}`, headers);
  /** The schema export over REST. */
  const schemaRest = (key, space, params = {}, headers = {}) =>
    restGet(key, `/api/spaces/${encodeURIComponent(space)}/schema-rdf${query(params)}`, headers);

  /** A tool call answered as its blocks: the document, the summary JSON, the structured half, the refusal text. */
  async function toolCall(key, tool, args) {
    const r = await fetch(`${doors.server.url}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const raw = await r.text();
    const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
    let rpc = {}; try { rpc = JSON.parse(data); } catch { /* not JSON */ }
    const blocks = (rpc.result?.content ?? []).map(c => c.text ?? '');
    let summary = null; try { summary = JSON.parse(blocks[1] ?? ''); } catch { /* not JSON */ }
    return {
      isError: rpc.result?.isError === true || !!rpc.error, blocks, document: blocks[0] ?? '', summary,
      structured: rpc.result?.structuredContent ?? null, text: blocks.join('\n') || rpc.error?.message || '',
    };
  }
  const exportMcp = (key, args) => toolCall(key, 'export_rdf', args);
  const schemaMcp = (key, args) => toolCall(key, 'space_schema_rdf', args);

  return { ...doors, seed, clear, restGet, exportRest, schemaRest, exportMcp, schemaMcp, toolCall };
}

/** The n3 format name of an export format. */
const N3_FORMAT = { turtle: 'text/turtle', trig: 'application/trig', nquads: 'application/n-quads' };

/** Parse an export with the independent parsers: n3 for the text formats, jsonld (to N-Quads, then n3) for JSON-LD. */
export async function parseRdf(format, text) {
  if (format === 'jsonld') {
    const nquads = await jsonld.toRDF(JSON.parse(text), { format: 'application/n-quads', documentLoader: offlineLoader });
    return new Parser({ format: 'application/n-quads' }).parse(nquads);
  }
  return new Parser({ format: N3_FORMAT[format] }).parse(text);
}

/** A JSON-LD document loader that loads nothing: the export's context is inline, and a test never reaches the network. */
async function offlineLoader(url) {
  throw new Error(`the test loads no remote document (${url})`);
}

/** A term as one comparable string (blank nodes as `_:`, since a record form has none). */
export function termText(t) {
  switch (t.termType) {
    case 'NamedNode': return `<${t.value}>`;
    case 'BlankNode': return '_:';
    case 'Literal': return `"${t.value}"^^<${t.datatype?.value ?? 'http://www.w3.org/2001/XMLSchema#string'}>${t.language ? `@${t.language}` : ''}`;
    case 'Quad': return `<<( ${termText(t.subject)} ${termText(t.predicate)} ${termText(t.object)} )>>`;
    default: return `?${t.value}`;
  }
}

/** The (subject, predicate, object) statements of `quads` outside the graphs `skipGraphs` names, as a sorted set of strings. */
export function tripleSet(quads, skipGraphs = new Set()) {
  return [...new Set(quads.filter(q => !skipGraphs.has(q.graph.value)).map(q => `${termText(q.subject)} ${termText(q.predicate)} ${termText(q.object)}`))].sort();
}

/** The graph names of the report nodes in `quads`: the graphs holding a subject typed `ythril:ExportReport`. */
export function reportGraphs(quads, ythrilNs) {
  const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  return new Set(quads.filter(q => q.predicate.value === type && q.object.value === `${ythrilNs}ExportReport`).map(q => q.graph.value));
}

/** The record form of a doc (the slice B mapper) as a triple set, for comparing the export with it. */
export function recordFormSet(mapper, meta, kind, doc, edgeDetails) {
  const out = mapper.recordTriples(meta, kind, storedRecord(kind, doc), { edgeDetails });
  const text = (t) => {
    switch (t.kind) {
      case 'iri': return `<${t.value}>`;
      case 'blank': return '_:';
      case 'literal': return `"${t.value}"^^<${t.datatype ?? 'http://www.w3.org/2001/XMLSchema#string'}>`;
      case 'triple': return `<<( ${text(t.subject)} ${text(t.predicate)} ${text(t.object)} )>>`;
      default: throw new Error(`a ${t.kind} is not in a record form`);
    }
  };
  return out.quads.map(q => `${text(q.subject)} ${text(q.predicate)} ${text(q.object)}`);
}
