/**
 * The doors the schema-from-RDF tests drive (bundle-270, Q-754, design revisions 2 and 3): the real application over a loopback socket with
 * real tokens, spaces with RDF switched on (the import tests' doors, `_rdf-import-doors.mjs`), and the two doors that build a space's schema
 * from an RDF file of OWL, RDFS and SHACL without data.
 *
 * ## The contract it encodes, written before the doors
 *
 * - `POST /api/spaces/:id/schema-rdf?mode=&from=&format=&sourceBase=&sourceVocab=&dryRun=` with the document as the body, its media type in
 *   `Content-Type` (or `format`), plain or gzipped; `from` repeats (`from=declared&from=shacl`).
 * - MCP `import_schema_rdf { space, document, format, mode, from, sourceBase, sourceVocab, dryRun }`.
 * - Both answer `{ space, mode, from, format, dryRun, written, version, typeSchemas, changes, taken, notTaken, counts }` on success (MCP as
 *   `structuredContent`), and a refusal as `{ error, code, ... }` (MCP: the error result, its text ending `(<code>)`, its body as structured
 *   content where the tool carries the status).
 * - The act's test knobs: `setSchemaRdfImportKnobsForTest({ bodyMaxBytes, uploadIdleMs, maxQuads, entriesNamedMax, hooks })` in
 *   `server/dist/spaces/schema-rdf-import-act.js`.
 */
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { openRdfImportDoors, rdfMeta, baseOf, MEDIA } from './_rdf-import-doors.mjs';

export { rdfMeta, baseOf, MEDIA };

/**
 * The act module, loaded once the doors are open (the config loader reads where its instance lives when it is first imported, which the
 * doors set), so a missing module fails a case on its rule and not the file at import. A live binding: read it after the doors open.
 */
export let actModule = {};

/** The act's knobs, or a failing assertion naming what is missing. */
export function knobs(k) {
  assert.equal(typeof actModule.setSchemaRdfImportKnobsForTest, 'function', 'setSchemaRdfImportKnobsForTest is not exported by server/src/spaces/schema-rdf-import-act.ts');
  actModule.setSchemaRdfImportKnobsForTest(k);
}

/** A space with RDF on and the given type schemas. */
export const spaceWith = (id, typeSchemas, extra = {}) => ({ id, meta: rdfMeta(id, { ...(typeSchemas ? { typeSchemas } : {}), ...extra }) });

/** The code a tool's refusal carries: its structured body's, else the `(<code>)` its text ends with. */
export function mcpCode(a) {
  if (typeof a.structured?.code === 'string') return a.structured.code;
  return a.text.match(/\(([a-z][a-z0-9_]*)\)\s*$/)?.[1] ?? null;
}

/** A network carrying `spaces`, with one peer member: a schema change of a space in it is the network's to vote on. */
export const networkOf = (id, spaces) => ({
  id, label: id, type: 'closed', origin: 'created', syncSchedule: '', spaces, votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
  members: [{ instanceId: `${id}-peer`, label: 'Peer', url: 'https://peer.example', tokenHash: 'h', direction: 'both' }],
});

/** Open the doors over `spaces` (`[{ id, meta }]`). */
export async function openSchemaRdfImportDoors({ suite, spaces }) {
  const d = await openRdfImportDoors({ suite, spaces });
  actModule = await import('../../server/dist/spaces/schema-rdf-import-act.js').catch(() => ({}));

  const query = (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
    }
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  /** POST a document to the REST door. `body` may be a Buffer (sent as is) or text. */
  async function buildRest(key, space, text, { params = {}, format = 'turtle', contentType, gzip = false, headers = {} } = {}) {
    const raw = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const body = gzip ? zlib.gzipSync(raw) : raw;
    const r = await fetch(`${d.server.url}/api/spaces/${encodeURIComponent(space)}/schema-rdf${query(params)}`, {
      method: 'POST', body, signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': contentType ?? MEDIA[format], ...(gzip ? { 'Content-Encoding': 'gzip' } : {}), ...headers },
    });
    const t = await r.text();
    let json = null; try { json = JSON.parse(t); } catch { /* not JSON */ }
    return { door: 'rest', status: r.status, body: json, text: t, code: json?.code ?? null };
  }

  /** The tool, answered as the REST door's shape: `status` is 200 or the refusal's, read from the code where the tool says none. */
  async function buildMcp(key, args) {
    const a = await d.toolCall(key, 'import_schema_rdf', args);
    return { door: 'mcp', isError: a.isError, body: a.structured, text: a.text, code: a.isError ? mcpCode(a) : null, raw: a };
  }

  /** The same build through both doors, REST first: `{ rest, mcp }`. `params` are the REST query names, the tool's arguments alike. */
  async function both(key, spaces_, text, params = {}, { format = 'turtle' } = {}) {
    const [restSpace, mcpSpace] = Array.isArray(spaces_) ? spaces_ : [spaces_, spaces_];
    const rest = await buildRest(key, restSpace, text, { params: { format, ...params } });
    const mcp = await buildMcp(key, { space: mcpSpace, document: text, format, ...params });
    return { rest, mcp };
  }

  /** The schema export of `space` in Turtle, as a caller would download it. */
  async function exportTurtle(key, space) {
    const r = await d.schemaRest(key, space, { format: 'turtle' });
    assert.equal(r.status, 200, `the schema export of ${space}: ${r.text.slice(0, 200)}`);
    return r.text;
  }

  const heldMeta = (space) => d.loader.getConfig().spaces.find(s => s.id === space)?.meta ?? {};
  const heldTypes = (space) => heldMeta(space).typeSchemas ?? {};
  /** Join `space` to a new network now (the config the next request reads). */
  const joinNetwork = (netId, space) => d.loader.mutateConfig(cfg => { cfg.networks = [...(cfg.networks ?? []), networkOf(netId, [space])]; });
  const roundsOf = (netId) => (d.loader.getConfig().networks ?? []).find(n => n.id === netId)?.pendingRounds?.length ?? 0;

  return { ...d, buildRest, buildMcp, both, exportTurtle, heldMeta, heldTypes, joinNetwork, roundsOf };
}
