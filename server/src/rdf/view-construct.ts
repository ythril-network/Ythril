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
import { SparqlRefusal, SPARQL_BAD_REQUEST, SPARQL_MALFORMED } from './sparql-refusal.js';
import type { RdfJsLike } from './rdf-js-terms.js';

/** The longest CONSTRUCT a view may carry, in UTF-8 bytes. */
export const VIEW_SPARQL_MAX_BYTES = 16 * 1024;
/** The most statements a view's CONSTRUCT may produce for one read. */
export const VIEW_CONSTRUCT_MAX_STATEMENTS = 50_000;
/** The code of a CONSTRUCT whose result passes {@link VIEW_CONSTRUCT_MAX_STATEMENTS}. */
export const VIEW_CONSTRUCT_TOO_LARGE = 'view_construct_too_large';
/** Its status: the answer would be too large. */
export const VIEW_CONSTRUCT_TOO_LARGE_STATUS = 413;

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

/** The parsed CONSTRUCT of a saved view. A text that no longer parses (the parser changed since it was saved) is the view's refusal. */
export async function viewConstructAlgebra(query: string): Promise<SparqlAlgebra> {
  const checked = await checkSparqlAlgebra(query);
  if ('refusal' in checked) throw new SparqlRefusal(checked.refusal.status, checked.refusal.code, `The view's CONSTRUCT is refused: ${checked.refusal.error}`);
  return checked.algebra;
}

/**
 * The statements of a view's CONSTRUCT over `source`, the quad source the door built from the members its guard accepted for the CALLER
 * (`createQuadSource` reads each as the caller reads it). Collected whole, at most {@link VIEW_CONSTRUCT_MAX_STATEMENTS}: one more ends the
 * run and is refused with {@link VIEW_CONSTRUCT_TOO_LARGE}, so no door answers a part of it as the whole.
 * @throws SparqlRefusal for the cap, the deadline, the read bounds and a store that does not answer.
 */
export async function constructStatements(query: string, source: unknown, opts: { deadline: number; maxBytes: number; signal?: AbortSignal }): Promise<RdfJsLike[]> {
  const algebra = await viewConstructAlgebra(query);
  const result = await runSparql(algebra, source, { deadline: opts.deadline, ...(opts.signal ? { signal: opts.signal } : {}) });
  try {
    if (result.kind !== 'quads') throw new SparqlRefusal(SPARQL_BAD_REQUEST, SPARQL_MALFORMED, 'The view\'s query is no CONSTRUCT');
    const taken = await result.rows(VIEW_CONSTRUCT_MAX_STATEMENTS + 1, opts.maxBytes);
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
