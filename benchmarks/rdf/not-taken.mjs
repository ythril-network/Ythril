/**
 * Which predicates the Ythril import does not keep, found by counting: what the variant states per predicate against
 * what the instance answers per predicate. The import's own report names only a count per reason (`not-inferred`), not
 * the predicates, so the predicates come from the data and the instance, never from a list typed for the benchmark.
 *
 * ## What this prevents
 *
 * - **A hand-typed list of lost predicates.** A predicate is not taken because the instance answers fewer statements
 *   of it than the variant holds, whatever the reason (a custom datatype, an IRI that is no subject, a hierarchy).
 * - **A system statement read as a gain that hides a loss.** Only fewer statements count as not taken; the statements
 *   the server adds make a predicate's count larger, which is no loss.
 * - **An unanswered count read as zero.** A predicate the instance gave no count for throws: absent is not "held none".
 * - **A query injected through a predicate.** `countQuery` accepts only text that can sit inside `<...>`.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const STATEMENT = /^(?:<[^>]*>|_:\S+)\s+<([^>]*)>\s/;

/** `{ predicateIri: statements }` over N-Triples lines; blank lines and comments are skipped, any other non-statement throws. */
export function countPredicates(lines) {
  const counts = {};
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = STATEMENT.exec(line);
    if (!m) throw new Error(`not a statement: ${line.slice(0, 80)}`);
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

/** The same count over a file, one line at a time (a variant has millions of lines). */
export async function countPredicatesOfFile(file) {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const counts = {};
  for await (const line of lines) {
    for (const [p, n] of Object.entries(countPredicates([line]))) counts[p] = (counts[p] ?? 0) + n;
  }
  return counts;
}

/** The query that counts the statements of one predicate. */
export function countQuery(iri) {
  if (!/^[^<>"{}|^`\\\s]+$/.test(iri)) throw new Error(`not an IRI that can be named in a query: ${JSON.stringify(iri)}`);
  return `SELECT (COUNT(*) AS ?n) WHERE { ?s <${iri}> ?o }`;
}

/** `{ iri: { statements, held } }` for every predicate of `statements` the instance holds fewer statements of. */
export function notTakenOf(statements, held) {
  const out = {};
  for (const [iri, n] of Object.entries(statements)) {
    if (!Number.isInteger(held[iri])) throw new Error(`the instance gave no count for ${iri}: it cannot be told from none held`);
    if (held[iri] < n) out[iri] = { statements: n, held: held[iri] };
  }
  return out;
}
