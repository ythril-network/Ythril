/**
 * The doors the SPARQL endpoint tests drive (bundle-271, Q-757): the real application over a loopback socket with real tokens, spaces with
 * RDF switched on, records seeded straight into their collections, and a reader for each door of the endpoint.
 *
 * ## The contract it encodes, written before the endpoint (design §2, r2 R1.2, R2.2, R3.1-R3.7, R4.6, R5)
 *
 * - REST: `GET /api/brain/spaces/:spaceId/sparql?query=&limit=&default-graph-uri=&named-graph-uri=`, `POST` the same path with
 *   `application/sparql-query` (the query is the body, the other parameters in the URL) or `application/x-www-form-urlencoded` (every
 *   parameter in the body), and `HEAD`. `:spaceId` may be the caller's own view.
 * - MCP: `sparql_query { space, query, limit, default-graph-uri, named-graph-uri, maxChars, maxBytes, maxTokens }`: the answer body in
 *   `content[0]`, the summary as JSON in `content[1]`, and the summary in `structuredContent`.
 * - What the caller could not be answered is said in headers (`X-Ythril-Members-Left-Out`, `X-Ythril-File-Triples-Withheld`) on REST and in
 *   `warnings` on MCP, never in the standard result body.
 *
 * `sparqlRest` reads the answer with `node:http`, because only it sends a `HEAD` and lets a test go away mid-answer.
 */
import http from 'node:http';
import { openPushDoor } from './_push-door.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { rdfMeta, baseOf, storedRecord } from './_rdf-export-doors.mjs';

export { rdfMeta, baseOf };

/** The headers the endpoint says what it left out in. */
export const MEMBERS_LEFT_OUT = 'x-ythril-members-left-out';
export const FILE_TRIPLES_WITHHELD = 'x-ythril-file-triples-withheld';

/** The media types of the endpoint's answers. */
export const RESULTS_JSON = 'application/sparql-results+json';

/** The collection a seeded kind lives in. */
const COLLECTION = { entity: 'entities', fact: 'facts', edge: 'edges', chrono: 'chrono', link: 'links', file: 'files' };

/**
 * Open the doors over `spaces` (`[{ id, meta? }]`, each a real space, RDF on unless `meta` says otherwise).
 * @returns the view doors plus `seed`, `sparqlRest`, `sparqlGet`, `sparqlPost`, `sparqlMcp`, `toolCall`, `path`.
 */
export async function openSparqlDoors({ suite, spaces, monitorCommands = false }) {
  const doors = await openViewDoors({
    suite, spaces: spaces.map(s => s.id),
    openDoor: () => openPushDoor({
      suite, monitorCommands, spaces: spaces.map(s => ({ id: s.id, label: s.id, folders: [], meta: s.meta ?? rdfMeta(s.id) })),
    }),
  });

  /** Insert `docs` (stored shapes) into the kind's collection of `space`. */
  async function seed(space, kind, docs) {
    if (docs.length === 0) return;
    await doors.col(doors.spaceCollection(space, COLLECTION[kind])).insertMany(docs.map(d => storedRecord(kind, d)));
  }

  const path = (space, params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
    }
    const s = q.toString();
    return `/api/brain/spaces/${encodeURIComponent(space)}/sparql${s ? `?${s}` : ''}`;
  };

  /**
   * One request with `node:http`: status, headers, body text and JSON. `signal` aborts it (the client goes away); `body` is sent as given.
   */
  function sparqlRest(key, method, url, { headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${doors.server.url}${url}`, {
        method, signal,
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, body: json });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120_000, () => req.destroy(new Error('timed out')));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** `GET .../sparql?query=...` with `params` beside it. */
  const sparqlGet = (key, space, query, params = {}, headers = {}) => sparqlRest(key, 'GET', path(space, { query, ...params }), { headers });
  /**
   * `POST .../sparql`: `as: 'query'` sends the text as `application/sparql-query` (params in the URL), `as: 'form'` every parameter
   * urlencoded in the body.
   */
  function sparqlPost(key, space, query, { as = 'query', params = {}, headers = {}, signal } = {}) {
    if (as === 'form') {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries({ query, ...params })) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) form.append(k, String(one));
      }
      return sparqlRest(key, 'POST', path(space), { body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, signal });
    }
    return sparqlRest(key, 'POST', path(space, params), { body: query, headers: { 'Content-Type': 'application/sparql-query', ...headers }, signal });
  }

  /** A tool call answered as its blocks: the body text, the summary JSON, the structured half, the refusal text. */
  async function toolCall(key, tool, args) {
    const r = await fetch(`${doors.server.url}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const raw = await r.text();
    const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
    let rpc = {}; try { rpc = JSON.parse(data); } catch { /* not JSON */ }
    const blocks = (rpc.result?.content ?? []).map(c => c.text ?? '');
    let body = null; try { body = JSON.parse(blocks[0] ?? ''); } catch { /* not JSON */ }
    let summary = null; try { summary = JSON.parse(blocks[1] ?? ''); } catch { /* not JSON */ }
    return {
      isError: rpc.result?.isError === true || !!rpc.error, blocks, document: blocks[0] ?? '', body, summary,
      structured: rpc.result?.structuredContent ?? null, text: blocks.join('\n') || rpc.error?.message || '',
    };
  }
  const sparqlMcp = (key, args) => toolCall(key, 'sparql_query', args);

  /**
   * An Update (Q-761) on one of its doors, answered alike: `{door, status, code, body, text}`. `rest`: `POST .../sparql/update` with
   * `application/sparql-update` (or `as: 'form'`, `update=`); `mcp`: the tool `sparql_update` (its status is `refused` or 200, its code read
   * from the refusal's text); `tool`: `POST /api/sparql_update`.
   */
  async function sparqlUpdate(door, key, space, update, { as = 'update', params = {} } = {}) {
    if (door === 'rest') {
      const url = `/api/brain/spaces/${encodeURIComponent(space)}/sparql/update`;
      const r = as === 'form'
        ? await sparqlRest(key, 'POST', url, { body: new URLSearchParams({ update, ...params }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        : await sparqlRest(key, 'POST', url, { body: update, headers: { 'Content-Type': 'application/sparql-update' } });
      return { door, status: r.status, code: r.body?.code, body: r.body, text: r.text };
    }
    if (door === 'tool') {
      const r = await fetch(`${doors.server.url}/api/sparql_update`, {
        method: 'POST', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ space, update, ...params }),
      });
      const text = await r.text();
      let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { door, status: r.status, code: body?.data?.code ?? body?.code, body: body?.data ?? body, text };
    }
    const m = await toolCall(key, 'sparql_update', { space, update, ...params });
    const code = m.isError ? (/\(([a-z_]+)\)\s*$/m.exec(m.text)?.[1] ?? null) : undefined;
    return { door, status: m.isError ? 'refused' : 200, code, body: m.structured ?? m.body, text: m.text };
  }

  return { ...doors, seed, path, sparqlRest, sparqlGet, sparqlPost, sparqlMcp, toolCall, sparqlUpdate };
}

/** The rows of a SPARQL results JSON body as sorted strings `var=value` per row, for comparing answers. */
export function rowTexts(body) {
  const rows = body?.results?.bindings ?? [];
  return rows.map(r => Object.keys(r).sort().map(k => `${k}=${r[k].type}:${r[k].value}${r[k]['xml:lang'] ? `@${r[k]['xml:lang']}` : ''}`).join(' ')).sort();
}
