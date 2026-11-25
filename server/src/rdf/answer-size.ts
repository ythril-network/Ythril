/**
 * How many bytes an answer holds, counted as it is read (bundle-271, Q-756, Q-757, Q-758; lens-2 P1): the one measure the SPARQL engine's
 * collect step and the Linked Data reads hold to `sparql.maxResultBytes`.
 *
 * ## What it prevents
 *
 * - **An answer bounded in rows and not in bytes.** A record may be 10 MB, so 10 000 rows of long literals reach gigabytes in the server's
 *   memory before the first byte is sent. The bytes of every term value an answer holds (an IRI, a literal with its language or datatype, a
 *   blank node, every part of a triple term) are summed row by row, and the read ends with `413 sparql_answer_too_large` the moment the sum
 *   passes the bound: the rest of the answer is never read.
 * - **A meter that is dropped.** {@link ByteMeter} throws the refusal itself: a caller adds what it read, and no caller can forget to compare.
 *
 * A leaf module.
 */
import type { RdfJsLike } from './rdf-js-terms.js';
import { SparqlRefusal, SPARQL_TOO_LARGE, SPARQL_ANSWER_TOO_LARGE } from './sparql-refusal.js';

/** The bytes the values of a term hold, UTF-8: its value, a literal's language and datatype, every part of a triple term. */
export function termBytes(t: RdfJsLike): number {
  let bytes = Buffer.byteLength(t.value, 'utf8');
  if (t.language) bytes += t.language.length;
  if (t.datatype) bytes += t.datatype.value.length;
  for (const part of [t.subject, t.predicate, t.object, t.graph]) if (part) bytes += termBytes(part);
  return bytes;
}

/** The bytes of a SELECT row: the terms it binds. */
export const rowBytes = (row: Readonly<Record<string, RdfJsLike>>): number => Object.values(row).reduce((sum, t) => sum + termBytes(t), 0);

/** The refusal of an answer past the bound; it names the bound, never a value. */
export const answerTooLargeRefusal = (maxBytes: number): SparqlRefusal => new SparqlRefusal(SPARQL_TOO_LARGE, SPARQL_ANSWER_TOO_LARGE,
  `The answer holds more than ${maxBytes} bytes of values (sparql.maxResultBytes), so none of it is answered: narrow the query, select fewer or shorter values, or add LIMIT`);

/** A running sum of bytes held to `maxBytes`: {@link ByteMeter.add} throws the refusal when the sum passes it. */
export class ByteMeter {
  private held = 0;
  constructor(private readonly maxBytes: number) {}
  /** Count `bytes` more; throws `413 sparql_answer_too_large` when the total passes the bound. */
  add(bytes: number): void {
    this.held += bytes;
    if (this.held > this.maxBytes) throw answerTooLargeRefusal(this.maxBytes);
  }
}
