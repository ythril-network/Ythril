/**
 * A graph answer written by the export's writer: the one place a SPARQL CONSTRUCT or DESCRIBE and a Linked Data address turn statements into
 * a document (bundle-271, Q-757, Q-758; lens-2 A3, moved out of `sparql-answer.ts` so the Linked Data door does not import the SPARQL
 * endpoint's act).
 *
 * ## What it prevents
 *
 * - **A graph answer that writes what the statements never held.** The document is written by the export's writer (`createRdfWriter`, its
 *   IRIREF guard and its `VERSION "1.2"` rule); RDF 1.2 is announced only when a statement holds a triple term ({@link holdsTriple}).
 * - **A term no document can carry, said in a part of it.** A statement the writer refuses is `409 rdf_unwritable` ({@link unwritable}),
 *   which names no part of the term (the term may be the query's own text).
 */
import { createRdfWriter, rdfVersionOf, RdfWriteError, type RdfFormat, type RdfWriter } from './serialize.js';
import { rdfContentType } from './export-format.js';
import { EXPORT_CONFLICT } from '../export/export-statuses.js';
import type { Quad } from './literals.js';
import { RDF_UNWRITABLE } from './rdf-space-state.js';

/** A refusal of a graph answer: its status, its code and the words. */
export interface GraphRefusal { status: number; code: string; error: string }

/** A rendered answer: its Content-Type and its bytes. */
export interface RenderedAnswer { contentType: string; body: string }

/** The refusal of an answer holding a term no document can carry; it names no part of the term (the term may be the query's text). */
export const unwritable = (): GraphRefusal => ({
  status: EXPORT_CONFLICT, code: RDF_UNWRITABLE,
  error: 'The answer holds a term no document of this format can carry (an IRI with a character an IRI cannot hold, or a triple term in JSON-LD): ask for another format, or construct other terms',
});

/** Does a statement hold a triple term (only an object can)? */
export const holdsTriple = (q: Quad): boolean => q.object.kind === 'triple';

/**
 * A graph answer by the export's writer: RDF 1.2 (announced) only when a statement holds a triple term. `ending` writes the document's end
 * in place of a bare close (the SPARQL view's export ends as every other export does); it is handed the writer that wrote the document.
 */
export function renderGraph(format: RdfFormat, quads: readonly Quad[], ending?: (writer: RdfWriter) => string): RenderedAnswer | GraphRefusal {
  const edgeDetails = quads.some(holdsTriple) ? 'rdf12' : 'reification';
  try {
    const writer = createRdfWriter(format, { edgeDetails });
    const body = writer.open() + writer.write({ quads }) + (ending ? ending(writer) : writer.close());
    return { contentType: rdfContentType(format, rdfVersionOf(format, edgeDetails)), body };
  } catch (err) {
    if (err instanceof RdfWriteError) return unwritable();
    throw err;
  }
}
