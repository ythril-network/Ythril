/**
 * What a SPARQL query's text says about the data it needs: the IRIs it names (predicates among them) and whether it
 * reads a whole record. Pure; the text is read through a small tokenizer that knows IRIs, strings and comments, so a
 * `#` inside an IRI or a prefixed name inside a string is not misread.
 *
 * ## What this prevents
 *
 * - **A reason typed per query.** Whether a query needs data the import does not keep, or counts the statements the
 *   server adds to every record, is read from its text here and judged in `comparability.mjs`; no query number is
 *   named anywhere.
 * - **A guessed prefix.** A prefixed name whose prefix the query does not declare throws: expanding it by a remembered
 *   table would name an IRI the query never asked for.
 * - **A variable list read as a pattern.** `SELECT ?a ?b ?c` and `ORDER BY ?a ?b ?c` look like a triple of variables;
 *   a pattern starts only after `{`, `}` or `.`.
 */
import { queryForm } from './queries.mjs';

const TOKEN = new RegExp([
  '(?<ws>\\s+)',
  '(?<comment>#[^\\n]*)',
  '(?<iri><[^<>"{}|^`\\\\\\s]*>)',
  '(?<str>"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')',
  '(?<placeholder>%\\w+%)',
  '(?<var>[?$]\\w+)',
  '(?<pname>(?:[A-Za-z][\\w-]*)?:[\\w-]*(?:\\.[\\w-]+)*)',
  '(?<word>[A-Za-z_]\\w*)',
  '(?<other>[\\s\\S])',
].join('|'), 'y');

/** The significant tokens of a query: `{ kind, text }`, with whitespace and comments dropped. */
function tokens(query) {
  const out = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(query); m !== null; m = TOKEN.exec(query)) {
    const kind = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
    if (kind !== 'ws' && kind !== 'comment') out.push({ kind, text: m[0] });
  }
  return out;
}

/** The query's own `PREFIX` lines as `{ prefix: iri }`, and the tokens left once the prologue is dropped. */
function prologue(toks) {
  const prefixes = {};
  const rest = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'word' && /^prefix$/i.test(t.text) && toks[i + 1]?.kind === 'pname' && toks[i + 2]?.kind === 'iri') {
      prefixes[toks[i + 1].text.slice(0, -1)] = toks[i + 2].text.slice(1, -1);
      i += 2;
    } else if (t.kind === 'word' && /^base$/i.test(t.text) && toks[i + 1]?.kind === 'iri') i += 1;
    else rest.push(t);
  }
  return { prefixes, rest };
}

/**
 * Every IRI the query names, expanded through its own PREFIX lines, sorted and without repeats: the predicates, and
 * with them the IRIs it uses as objects or in a function. A superset of its predicates; the callers intersect it
 * with a set of predicates. `a` (rdf:type) is no mention.
 */
export function predicatesOf(query) {
  const { prefixes, rest } = prologue(tokens(query));
  const found = new Set();
  for (const t of rest) {
    if (t.kind === 'iri') found.add(t.text.slice(1, -1));
    else if (t.kind === 'pname') {
      const colon = t.text.indexOf(':');
      const prefix = t.text.slice(0, colon);
      if (!(prefix in prefixes)) throw new Error(`the query uses the prefix "${prefix}:" without declaring it`);
      found.add(prefixes[prefix] + t.text.slice(colon + 1));
    }
  }
  return [...found].sort();
}

const bound = (t) => t.kind === 'iri' || t.kind === 'pname' || t.kind === 'placeholder';
const isTerm = (t) => t !== undefined && (bound(t) || t.kind === 'var');

/**
 * Whether the query reads a whole record: a DESCRIBE, or a triple pattern with a variable predicate and a bound
 * subject or object (`<record> ?p ?o`, `?s ?p <record>`). Three variables are a scan of everything and are not.
 */
export function readsWholeRecord(query) {
  if (queryForm(query) === 'DESCRIBE') return true;
  const { rest } = prologue(tokens(query));
  for (let i = 1; i + 2 < rest.length; i++) {
    if (!['{', '}', '.'].includes(rest[i - 1].text)) continue;
    const [s, p, o] = [rest[i], rest[i + 1], rest[i + 2]];
    if (isTerm(s) && p.kind === 'var' && isTerm(o) && (bound(s) || bound(o))) return true;
  }
  return false;
}

/** Well-known namespaces, for showing an IRI the way a reader writes it. Display only: nothing is expanded through it. */
const DISPLAY_PREFIXES = [
  ['bsbm', 'http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/vocabulary/'],
  ['dc', 'http://purl.org/dc/elements/1.1/'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['foaf', 'http://xmlns.com/foaf/0.1/'],
  ['rev', 'http://purl.org/stuff/rev#'],
  ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
];

/** `dc:publisher` for a well-known namespace, the full IRI otherwise. */
export function shortName(iri) {
  const hit = DISPLAY_PREFIXES.find(([, ns]) => iri.startsWith(ns));
  return hit ? `${hit[0]}:${iri.slice(hit[1].length)}` : iri;
}
