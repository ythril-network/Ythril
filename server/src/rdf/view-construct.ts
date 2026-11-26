/**
 * A personal view defined by a SPARQL CONSTRUCT (bundle-273, Q-762): what may be saved as one, which doors read one, and its statements
 * for a caller. The RDF doors (the export, the SPARQL query endpoint, the view's Linked Data address) read the view as these statements;
 * every other door refuses it (DEC-3: filter, recall and traverse do not read a SPARQL view).
 *
 * ## What each export prevents
 *
 * - {@link checkViewSparql} is the one save-time check both doors' acts run: a text that is no CONSTRUCT (a SELECT, an ASK, a DESCRIBE, an
 *   Update), a text no parser reads, one past {@link VIEW_SPARQL_MAX_BYTES}, or a value that is no `{ query: <text> }` is refused with its
 *   reason, so no door saves a query the readers would refuse later.
 * - Which doors read a SPARQL view is `constructViewRefusal`'s (`config/views.ts`), asked by every guard that resolves a view.
 * - {@link constructStatements} runs the CONSTRUCT over a quad source the caller's door built from the members the guard accepted for
 *   the caller: the members are read as the CALLER reads them, never as the view's owner had them or as the instance. Its result is
 *   capped at {@link VIEW_CONSTRUCT_MAX_STATEMENTS}: one more is refused ({@link VIEW_CONSTRUCT_TOO_LARGE}), never a cut answer.
 */
import { Store } from 'n3';
import type * as RDF from '@rdfjs/types';
import { checkSparqlAlgebra, runSparql, type SparqlAlgebra } from './sparql-engine.js';
import { formOf } from './sparql-form.js';
import { SparqlRefusal } from './sparql-refusal.js';
import { VIEW_SPARQL_MAX_BYTES } from '../config/view-shape.js';
import { fromRdfJs, RdfJsTermError, type RdfJsLike } from './rdf-js-terms.js';

/** The longest CONSTRUCT a view may carry, in UTF-8 bytes (`config/view-shape.ts`, which a config load refuses a stored one by). */
export { VIEW_SPARQL_MAX_BYTES };
/** The most statements a view's CONSTRUCT may produce for one read. */
export const VIEW_CONSTRUCT_MAX_STATEMENTS = 50_000;
/** The code of a CONSTRUCT whose result passes {@link VIEW_CONSTRUCT_MAX_STATEMENTS}. */
export const VIEW_CONSTRUCT_TOO_LARGE = 'view_construct_too_large';
/** Its status: the answer would be too large. */
export const VIEW_CONSTRUCT_TOO_LARGE_STATUS = 413;
/** The codes of a stored view whose query no door can run: the save's own (`VIEW_REFUSALS`, `config/views.ts`), answered `409` at a read. */
export const VIEW_SPARQL_INVALID = 'view_sparql_invalid';
export const VIEW_SPARQL_NOT_CONSTRUCT = 'view_sparql_not_construct';

/** Why a view's `sparql` is not saved: the view refusal it is answered as (`VIEW_REFUSALS` in `config/views.ts`). */
export type ViewSparqlProblem = 'sparqlInvalid' | 'sparqlNotConstruct' | 'sparqlTooLarge';

/**
 * Judge a `sparql` value a door was sent for a view: `{ query }` when it is a CONSTRUCT the readers will run, else the problem and the
 * sentence a caller reads. Runs nothing.
 */
export async function checkViewSparql(raw: unknown): Promise<{ query: string } | { problem: ViewSparqlProblem; message: string }> {
  const query = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['query'] : undefined;
  const keys = raw !== null && typeof raw === 'object' ? Object.keys(raw) : [];
  if (typeof query !== 'string' || query.trim() === '' || keys.some(k => k !== 'query')) {
    return { problem: 'sparqlInvalid', message: '`sparql` is `{ "query": "<a SPARQL CONSTRUCT>" }`, or null to make the view a plain one' };
  }
  if (Buffer.byteLength(query, 'utf8') > VIEW_SPARQL_MAX_BYTES) {
    return { problem: 'sparqlTooLarge', message: `A view's CONSTRUCT is at most ${VIEW_SPARQL_MAX_BYTES} bytes; this one is ${Buffer.byteLength(query, 'utf8')}` };
  }
  const checked = await checkSparqlAlgebra(query);
  if ('refusal' in checked) {
    // An Update is no query: the parser of queries refuses it, and it is answered as what it is, not as a broken text.
    if (/^\s*(?:(?:PREFIX|BASE)\b[^{]*?)*\b(?:INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b/i.test(stripComments(query))) {
      return { problem: 'sparqlNotConstruct', message: 'A view is defined by a SPARQL CONSTRUCT; this is an Update, which writes and defines no statements' };
    }
    const at = checked.refusal.line !== undefined ? ` (line ${checked.refusal.line}${checked.refusal.column !== undefined ? `, column ${checked.refusal.column}` : ''})` : '';
    return { problem: 'sparqlInvalid', message: `The view's query is not SPARQL the server reads${at}: ${checked.refusal.code}` };
  }
  const { form } = formOf(checked.algebra);
  if (form !== 'construct') {
    return { problem: 'sparqlNotConstruct', message: `A view is defined by a SPARQL CONSTRUCT; this is a ${form.toUpperCase()}, which answers no statements` };
  }
  return { query };
}

/** A query's text without its comments, for telling an Update from a broken query by its first keyword. */
const stripComments = (text: string): string => text.replace(/#[^\n\r]*/g, ' ');

/**
 * The status of a stored view's query that no door can run: the view is in a state the request did not make, as `view_is_construct` is.
 * Its codes are the save's own (`VIEW_REFUSALS` in `config/views.ts`), so one sentence per code serves the save and every read.
 */
const STORED_VIEW_REFUSED_STATUS = 409;
const storedViewRefusal = (code: typeof VIEW_SPARQL_INVALID | typeof VIEW_SPARQL_NOT_CONSTRUCT, message: string): SparqlRefusal =>
  new SparqlRefusal(STORED_VIEW_REFUSED_STATUS, code, message);

/**
 * The parsed CONSTRUCT of a saved view. A text that no longer parses (the parser changed since it was saved) is `409 view_sparql_invalid`, and
 * one that is no CONSTRUCT (a hand-edited `config.json`: a save refuses it) is `409 view_sparql_not_construct`: never a code of the query
 * endpoint, which would blame a query the caller did not send.
 */
export async function viewConstructAlgebra(query: string): Promise<SparqlAlgebra> {
  const checked = await checkSparqlAlgebra(query);
  if ('refusal' in checked) throw storedViewRefusal(VIEW_SPARQL_INVALID, `The view's CONSTRUCT is refused: ${checked.refusal.error}`);
  const { form } = formOf(checked.algebra);
  if (form !== 'construct') throw storedViewRefusal(VIEW_SPARQL_NOT_CONSTRUCT, `The view's query is a ${form.toUpperCase()}, not a SPARQL CONSTRUCT: change the view's query`);
  return checked.algebra;
}

/** A term's identity: equal terms, equal text (a statement made twice is one). */
function termIdentity(t: RdfJsLike): string {
  if (t.termType === 'Quad') return `<<${[t.subject, t.predicate, t.object, t.graph].map(p => (p ? termIdentity(p) : '')).join(' ')}>>`;
  return `${t.termType}\u0000${t.value}\u0000${t.language ?? ''}\u0000${t.direction ?? ''}\u0000${t.datatype?.value ?? ''}`;
}

/**
 * The filter a CONSTRUCT's statements pass through before they are counted: the statements of the RDF GRAPH it makes, once each. A CONSTRUCT
 * makes a graph (SPARQL 1.1 Query §16.2): a template triple that instantiates to no RDF statement (a literal or a triple term as its subject,
 * a predicate that is no IRI: `CONSTRUCT { ?o ?p ?s }` over a literal object) is not in it, and one made by many solutions is one statement. So
 * the cap counts what the view holds, and no door meets a statement it cannot write.
 */
function graphStatementsOnce(): (q: RdfJsLike) => boolean {
  const seen = new Set<string>();
  return (q) => {
    try {
      fromRdfJs(q);
    } catch (err) {
      if (err instanceof RdfJsTermError) return false;
      throw err;
    }
    const key = [q.subject, q.predicate, q.object, q.graph].map(p => (p ? termIdentity(p) : '')).join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

/**
 * The statements of a view's CONSTRUCT over `source`, the quad source the door built from the members its guard accepted for the CALLER
 * (`createQuadSource` reads each as the caller reads it). Collected whole, at most {@link VIEW_CONSTRUCT_MAX_STATEMENTS} statements of the
 * graph it makes (each once; one no RDF statement can be is not in it, {@link graphStatementsOnce}): one more ends the run and is refused
 * with {@link VIEW_CONSTRUCT_TOO_LARGE}, so no door answers a part of it as the whole.
 * @throws SparqlRefusal for the cap, the deadline, the read bounds and a store that does not answer.
 */
export async function constructStatements(query: string, source: unknown, opts: { deadline: number; maxBytes: number; signal?: AbortSignal }): Promise<RdfJsLike[]> {
  const algebra = await viewConstructAlgebra(query);
  const result = await runSparql(algebra, source, { deadline: opts.deadline, ...(opts.signal ? { signal: opts.signal } : {}) });
  try {
    if (result.kind !== 'quads') throw storedViewRefusal(VIEW_SPARQL_NOT_CONSTRUCT, 'The view\'s query is no CONSTRUCT: change the view\'s query');
    const taken = await result.rows(VIEW_CONSTRUCT_MAX_STATEMENTS + 1, opts.maxBytes, graphStatementsOnce());
    if (taken.length > VIEW_CONSTRUCT_MAX_STATEMENTS) {
      throw new SparqlRefusal(VIEW_CONSTRUCT_TOO_LARGE_STATUS, VIEW_CONSTRUCT_TOO_LARGE,
        `The view's CONSTRUCT makes more than ${VIEW_CONSTRUCT_MAX_STATEMENTS} statements, so none of them is answered: narrow its query or its members`);
    }
    return taken;
  } finally {
    result.destroy();
  }
}

/** The statements as an RDF/JS source a query runs over (in the default graph, as a CONSTRUCT makes them). */
export function constructSource(statements: readonly RdfJsLike[]): Store {
  return new Store(statements as unknown as RDF.Quad[]);
}
