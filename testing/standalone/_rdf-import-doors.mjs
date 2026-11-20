/**
 * The doors the RDF import tests drive (bundle-270 slice S6, Q-753): the real application over a loopback socket with real tokens, spaces with
 * RDF switched on (the export tests' doors, `_rdf-export-doors.mjs`), and the two import doors with their status doors.
 *
 * ## The contract it encodes, written before the doors
 *
 * - `POST /api/brain/spaces/:spaceId/import/rdf?dryRun=&blankNodes=&sourceBase=&sourceVocab=&graphBase=` with the document as the body, its
 *   media type in `Content-Type` (`text/turtle`, `application/trig`, `application/n-quads`, `application/ld+json`), plain or gzipped
 *   (`Content-Encoding: gzip`), and MCP `import_rdf { space, document, format, dryRun, blankNodes, sourceBase, sourceVocab, graphBase }`.
 * - `GET /api/brain/spaces/:spaceId/import/rdf/:importId` and MCP `import_rdf_status { space, importId }`.
 * - Both answer the import's report: `importId`, `status` (`completed`, `refused`, `running`, `dry-run`), `kinds` (per kind `inserted` and
 *   `converged`), `reasons` (each `code`, `outcome`, `statements`), `reasonCount`, `notTaken`. MCP carries it as `structuredContent`.
 */
import zlib from 'node:zlib';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';

export { rdfMeta, baseOf };

/** The media type of each format the import reads. */
export const MEDIA = { turtle: 'text/turtle', trig: 'application/trig', nquads: 'application/n-quads', jsonld: 'application/ld+json' };

/** A strict space's meta with a `person` entity type (a number `age`) and a `knows` edge label. */
export const personMeta = (id, mode = 'strict') => rdfMeta(id, {
  validationMode: mode,
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number' } } } },
    edge: { knows: {} },
  },
});

const RDFS_LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';
const DECIMAL = '<http://www.w3.org/2001/XMLSchema#decimal>';

/** Two people who know each other, as foreign subjects (minted on import), in Turtle. */
export function goodTurtle(space) {
  const v = `${baseOf(space)}vocab/`;
  return [
    `<http://people.example/alice> a <${v}entity/person> ; ${RDFS_LABEL} "Alice" ; <${v}entity/person#age> "41"^^${DECIMAL} .`,
    `<http://people.example/bob> a <${v}entity/person> ; ${RDFS_LABEL} "Bob" .`,
    `<http://people.example/alice> <${v}edge/knows> <http://people.example/bob> .`,
    '',
  ].join('\n');
}

/** A literal no answer, audit row or status may repeat. */
export const SECRET = 'SECRET-VALUE-7f3a';

/** The good file plus a third person with a language-tagged age and an unknown predicate: two reasons, both refused in strict only. */
export function badTurtle(space) {
  const v = `${baseOf(space)}vocab/`;
  return goodTurtle(space) + [
    `<http://people.example/carol> a <${v}entity/person> ; ${RDFS_LABEL} "Carol" ; <${v}entity/person#age> "${SECRET}"@en .`,
    `<http://people.example/carol> <http://unknown.example/says> "${SECRET}" .`,
    '',
  ].join('\n');
}

/** Open the import doors over `spaces` (`[{ id, meta }]`). */
export async function openRdfImportDoors({ suite, spaces }) {
  const d = await openRdfExportDoors({ suite, spaces });

  const query = (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
    }
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  /** POST a document to the REST import door; `gzip` sends it compressed. */
  async function importRest(key, space, text, { format = 'turtle', params = {}, gzip = false, contentType } = {}) {
    const body = gzip ? zlib.gzipSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': contentType ?? MEDIA[format], ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) };
    const r = await fetch(`${d.server.url}/api/brain/spaces/${encodeURIComponent(space)}/import/rdf${query(params)}`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(120_000),
    });
    const raw = await r.text();
    let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: r.status, body: json, text: raw, headers: r.headers };
  }

  /** The REST status door. */
  async function statusRest(key, space, importId) {
    const r = await fetch(`${d.server.url}/api/brain/spaces/${encodeURIComponent(space)}/import/rdf/${encodeURIComponent(importId)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000),
    });
    const raw = await r.text();
    let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: r.status, body: json, text: raw };
  }

  const importMcp = (key, args) => d.toolCall(key, 'import_rdf', args);
  const statusMcp = (key, args) => d.toolCall(key, 'import_rdf_status', args);

  /** The stored records of `kind` in `space`. */
  const records = (space, collection) => d.col(d.spaceCollection(space, collection)).find({}).toArray();

  /** The acts standing for `space` on the live config. */
  const actsOf = (space) => (d.loader.getConfig().pendingSpaceActs ?? []).filter(e => e.localId === space);

  return { ...d, importRest, statusRest, importMcp, statusMcp, records, actsOf };
}

/** The reason codes of a report, sorted. */
export const reasonCodes = (report) => [...new Set((report?.reasons ?? []).map(r => r.code))].sort();
