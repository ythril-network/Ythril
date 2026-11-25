/**
 * The 11 BSBM Explore queries: which they are, where their text comes from, and what each asks the engine to
 * send back.
 *
 * The text is never retyped here. It is read from the pinned BSBM Tools archive (`queries/explore/queryN.txt`),
 * so the harness cannot drift from the benchmark it names. BSBM removed Q6 from the Explore mix, so the set is
 * Q1-Q5 and Q7-Q12.
 *
 * ## What this prevents
 *
 * Q9 is a DESCRIBE and Q12 a CONSTRUCT: they answer a graph, not result rows. `acceptFor` picks the media type
 * from the query's form, so two of the eleven are not recorded as engine errors that the harness caused.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXPLORE_NUMBERS = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12];

/** The form keyword of a query: the first of SELECT, ASK, DESCRIBE, CONSTRUCT outside comments and prefixes. */
export function queryForm(text) {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/^\s*(PREFIX\s+\S*\s*<[^>]*>|BASE\s+<[^>]*>)\s*/gim, '');
  const m = /^\s*(SELECT|ASK|DESCRIBE|CONSTRUCT)\b/i.exec(body);
  if (!m) throw new Error('no query form (SELECT, ASK, DESCRIBE, CONSTRUCT) found after the prologue');
  return m[1].toUpperCase();
}

/**
 * The media type to ask `engine` for. Ythril's endpoint answers a graph as Turtle, N-Quads or JSON-LD, never
 * N-Triples (design R3.2), so it is asked for Turtle; Oxigraph keeps N-Triples.
 */
export function acceptFor(form, engine = 'oxigraph') {
  if (engine !== 'oxigraph' && engine !== 'ythril') throw new Error(`unknown engine ${JSON.stringify(engine)}`);
  if (form === 'SELECT' || form === 'ASK') return 'application/sparql-results+json';
  if (form === 'DESCRIBE' || form === 'CONSTRUCT') return engine === 'ythril' ? 'text/turtle' : 'application/n-triples';
  throw new Error(`unknown query form ${JSON.stringify(form)}`);
}

/** `{ Q1: {number, text, form}, ... }` from the extracted archive. */
export function loadTemplates(toolsDir) {
  const out = {};
  for (const n of EXPLORE_NUMBERS) {
    const text = readFileSync(join(toolsDir, 'queries', 'explore', `query${n}.txt`), 'utf8');
    out[`Q${n}`] = { number: n, text, form: queryForm(text) };
  }
  return out;
}
