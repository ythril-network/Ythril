/**
 * The five doors that read a SPARQL view (bundle-273, Q-762), each answered as one comparable value: the RDF export and the SPARQL query
 * endpoint on REST and MCP, and the view's Linked Data address. A suite about one rule across the doors (the same cause, the same refusal)
 * reads them all here, so a door added to the list is read by every such suite and none can leave one out.
 */

/**
 * An N-Quads document without its ending, the statements of its report graph and its closing comment (what every RDF export closes with):
 * the ending is the export's own, not what the CONSTRUCT made, so a comparison with the other doors reads the document without it.
 */
export const withoutReportGraph = (text) => text.split('\n')
  .filter(l => !/ <urn:ythril:export-report:[0-9a-f]+> \.\s*$/.test(l) && !l.startsWith('# ythril-export: ')).join('\n');

/** A statement of an N-Quads text without its graph, as a sorted line list (the report graph's statements are not among them). */
export function triplesOfNQuads(text) {
  return withoutReportGraph(text).split('\n').map(l => l.trim()).filter(Boolean)
    // `<s> <p> <o> .` or `<s> <p> <o> <g> .`: the graph is dropped, whichever door wrote it.
    .map(l => l.replace(/ <[^<>]*> \.$/, ' .').replace(/ \.$/, ''))
    .sort();
}

const refusedCode = (a) => a.structured?.code ?? /\(([a-z_]+)\)\s*$/m.exec(a.text ?? '')?.[1] ?? /\b((?:sparql|view|rdf)_[a-z_]+)\b/.exec(a.text ?? '')?.[1];

/**
 * What each door answers for the view `id` read by `key`: `{ status, code }` for a refusal (`status` is `refused` on MCP), else
 * `{ status: 200, triples }`. `exportParams` is added to the REST export's query (`&maxChars=1000`), `exportArgs` to the tool's arguments.
 * @param d the doors of `openSparqlDoors`
 */
export async function fiveDoors(d, key, id, { exportParams = '', exportArgs = { maxChars: 5_000_000 } } = {}) {
  const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';
  const enc = encodeURIComponent(id);
  const rest = (a) => (a.status === 200 ? { status: 200, triples: triplesOfNQuads(a.text), headers: a.headers } : { status: a.status, code: a.body?.code ?? a.body?.data?.code, headers: a.headers });
  const mcp = (a, triples) => (a.isError ? { status: 'refused', code: refusedCode(a) } : { status: 200, triples: triples(a) });
  const rows = (body) => (body?.results?.bindings ?? []).map(b => `<${b.s.value}> <${b.p.value}> ${b.o.type === 'uri' ? `<${b.o.value}>` : `"${b.o.value}"`}`).sort();
  const exp = await d.sparqlRest(key, 'GET', `/api/brain/spaces/${enc}/export/rdf?format=nquads${exportParams}`);
  const expMcp = await d.toolCall(key, 'export_rdf', { space: id, format: 'nquads', ...exportArgs });
  const spq = await d.sparqlGet(key, id, ALL);
  const spqMcp = await d.sparqlMcp(key, { space: id, query: ALL });
  const ld = await d.sparqlRest(key, 'GET', `/ld/${id}/`, { headers: { Accept: 'application/n-quads' } });
  return {
    export: rest(exp),
    exportMcp: mcp(expMcp, a => triplesOfNQuads(a.document)),
    sparql: spq.status === 200 ? { status: 200, rows: rows(spq.body) } : { status: spq.status, code: spq.body?.code },
    sparqlMcp: mcp(spqMcp, a => rows(a.body)),
    ld: ld.status === 200 ? { status: 200, triples: triplesOfNQuads(ld.text), headers: ld.headers } : { status: ld.status, code: ld.body?.code, headers: ld.headers },
  };
}

/** A refusal as the doors compare it: its status and code only. */
export const refusalOf = (a) => (a.code === undefined ? a : { status: a.status, code: a.code });
