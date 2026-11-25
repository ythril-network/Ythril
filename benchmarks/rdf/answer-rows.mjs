/**
 * The row count of one SPARQL answer, the same way for both engines.
 *
 * A result set is its bindings, an ASK is one row, and a graph answer (Q9 DESCRIBE, Q12 CONSTRUCT) is the number of
 * distinct statements in it, counted by PARSING the text with n3. Turtle (what Ythril answers) and N-Triples (what
 * Oxigraph is asked for) are different texts of one graph: a line count of the first is wrong by its prefixes,
 * `;` and `,` lists and `[ ]` nodes, so the two engines' counts could never meet.
 *
 * ## What this prevents
 *
 * - **A count that is a guess.** A graph that does not parse, or JSON that is not JSON, throws; the caller records it
 *   as that query's error. It never becomes `0` or `null` rows, which would read as "an empty answer".
 * - **A statement counted twice.** The answer is a graph, so a statement stated twice is one; the count is over
 *   distinct statements.
 *
 * Needs the `n3` package (the server workspace carries it: `npm ci` at the repository root).
 */
import { Parser } from 'n3';

const GRAPH_FORMATS = { 'text/turtle': 'Turtle', 'application/n-triples': 'N-Triples' };

/** Rows of `text`, an answer given as `accept`. Throws `unparsable ...` for an answer that is not what `accept` says. */
export function countRows(text, accept) {
  const format = GRAPH_FORMATS[accept];
  if (format !== undefined) {
    let quads;
    try {
      quads = new Parser({ format }).parse(text);
    } catch (err) {
      throw new Error(`unparsable ${format} answer: ${err.message}`);
    }
    return new Set(quads.map((q) => `${q.subject.id} ${q.predicate.id} ${q.object.id}`)).size;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`unparsable JSON answer: ${err.message}`);
  }
  if (Array.isArray(json?.results?.bindings)) return json.results.bindings.length;
  if (typeof json?.boolean === 'boolean') return 1;
  throw new Error('unparsable JSON answer: it holds neither results.bindings nor a boolean');
}
