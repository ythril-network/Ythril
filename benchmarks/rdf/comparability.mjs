/**
 * Whether each query of a Ythril run is comparable with Oxigraph's, one query at a time.
 *
 * A query is comparable when its row count matches Oxigraph's on every run (validity.mjs). Otherwise it is not, with
 * one reason from a fixed list, derived and never typed per query:
 *
 * - `data-not-held`: the query names a predicate the import does not keep (`notTaken`, counted per predicate by
 *   not-taken.mjs) and Ythril answered fewer rows on every differing run;
 * - `system-statements`: the query reads a whole record (query-shape.mjs) and Ythril answered more rows on every
 *   differing run: the statements the server adds to every record are counted;
 * - `rows-differ`: any other mismatch, an error included. It is a finding about the engine, not about the data shape.
 *
 * `valid` is: every query comparable or named with one of the first two reasons.
 *
 * ## What this prevents
 *
 * - **A whole-record flag throwing six good queries away with five.** The verdict is per query; the record and the
 *   table carry each one's reason.
 * - **A reason that excuses what it does not explain.** A named predicate explains fewer rows, an added statement
 *   explains more rows; the other direction, or an error, is `rows-differ` and stays a finding.
 * - **An unnamed mismatch.** A `rows-differ` query keeps its first differing run with both counts, and makes `valid` false.
 */
import { predicatesOf, readsWholeRecord } from './query-shape.mjs';
import { judgeValidity } from './validity.mjs';

export const REASONS = Object.freeze(['data-not-held', 'system-statements', 'rows-differ']);

const number = (name) => Number(/^Q(\d+)$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** The row count of every run of a query record, or of its first measured answer when it holds no per-run counts. */
const countsOf = (q) => (Array.isArray(q?.rowsPerRun) ? q.rowsPerRun : [Number.isInteger(q?.rows) ? q.rows : null]);

/** The `[oxigraph, ythril]` count pairs of the runs on which the two engines differ; a missing count is `null`. */
function differingPairs(ox, yt) {
  const a = countsOf(ox);
  const b = countsOf(yt);
  const pairs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [Number.isInteger(a[i]) ? a[i] : null, Number.isInteger(b[i]) ? b[i] : null];
    if (x === null || y === null || x !== y) pairs.push([x, y]);
  }
  return pairs;
}

/**
 * `{ valid, differing, queries }`: `queries` holds each query's `{ comparable: true }` or `{ comparable: false, reason, ... }`
 * (`predicates` for data-not-held, `differing` for rows-differ); `differing` lists the rows-differ queries in the form
 * validity.mjs gives; `valid` is true when there are none.
 *
 * `templates` is `{ Qn: { text } }` (one for every query), `notTaken` is `{ iri: { statements, held } }`.
 */
export function judgeComparability({ oxigraph, ythril, templates, notTaken }) {
  const names = [...new Set([...Object.keys(oxigraph), ...Object.keys(ythril)])].sort((a, b) => number(a) - number(b));
  if (names.length === 0) throw new Error('no queries to compare: a run with none cannot be judged');
  const queries = {};
  const differing = [];
  for (const name of names) {
    if (!templates[name]?.text) throw new Error(`${name} has no query text: its reason cannot be derived`);
    const verdict = judgeValidity({ [name]: oxigraph[name] }, { [name]: ythril[name] });
    if (verdict.valid) { queries[name] = { comparable: true }; continue; }
    const pairs = differingPairs(oxigraph[name], ythril[name]);
    const counted = pairs.every(([x, y]) => x !== null && y !== null);
    const missing = predicatesOf(templates[name].text).filter((iri) => Object.hasOwn(notTaken, iri));
    if (counted && missing.length > 0 && pairs.every(([x, y]) => y < x)) {
      queries[name] = { comparable: false, reason: 'data-not-held', predicates: missing };
    } else if (counted && readsWholeRecord(templates[name].text) && pairs.every(([x, y]) => y > x)) {
      queries[name] = { comparable: false, reason: 'system-statements' };
    } else {
      queries[name] = { comparable: false, reason: 'rows-differ', differing: verdict.differing[0] };
      differing.push(verdict.differing[0]);
    }
  }
  return { valid: differing.length === 0, differing, queries };
}
