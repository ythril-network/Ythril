/**
 * The product count a Ythril import can take, found from the generator's output and not by loading.
 *
 * The import refuses a kind with more than 200 types (`schema_rdf_refused`, "Max 200 type definitions per knowledge
 * type"). Every class the data states for a subject becomes one type, so the largest size the import accepts is the
 * largest product count whose generated data keeps its distinct `rdf:type` classes under the cap. The count rises
 * with the product count (more product types are used), so a binary search finds it.
 *
 * ## What this prevents
 *
 * - **A size chosen by a refused load.** Each load is minutes; the generator's output is counted instead.
 * - **A cap read as inclusive.** "Under the cap" is strictly less: a count equal to it is not under it, and the
 *   search never returns a size it did not measure.
 * - **A guess at an end.** A smallest size already over the cap throws; a largest already under it is returned as it
 *   is, with its measured count.
 */

import { linesOfFile } from './prepare.mjs';

const RDF_TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';
const OBJECT = /^(<[^>]*>)\s*\.\s*$/;

/** The class of an `rdf:type` statement line, or null for any other line. */
function classOfLine(line) {
  const at = line.indexOf(` ${RDF_TYPE} `);
  return at < 0 ? null : OBJECT.exec(line.slice(at + RDF_TYPE.length + 2))?.[1] ?? null;
}

/** The distinct classes of the `rdf:type` statements in an N-Triples text. */
export function countTypes(text) {
  const classes = new Set();
  for (const line of text.split('\n')) {
    const c = classOfLine(line);
    if (c !== null) classes.add(c);
  }
  return classes.size;
}

/** The same count over a file, line by line (the larger sizes are bigger than one string should be). */
export function countTypesInFile(path) {
  const classes = new Set();
  for (const { line } of linesOfFile(path, 1 << 22)) {
    const c = classOfLine(line);
    if (c !== null) classes.add(c);
  }
  return classes.size;
}

/**
 * The largest `n` in `[lo, hi]` with `count(n) < cap`, and its count: `{ size, types }`. `count` must not fall as `n`
 * rises. Asks for `lo`, `hi` and then about log2(hi - lo) sizes between.
 */
export function largestUnderCap(count, { lo, hi, cap }) {
  const measured = new Map();
  const at = (n) => {
    if (!measured.has(n)) measured.set(n, count(n));
    return measured.get(n);
  };
  if (at(lo) >= cap) throw new Error(`the smallest size ${lo} has ${at(lo)} types, not under the cap ${cap}`);
  if (at(hi) < cap) return { size: hi, types: at(hi) };
  let good = lo;
  let bad = hi;
  while (bad - good > 1) {
    const mid = Math.floor((good + bad) / 2);
    if (at(mid) < cap) good = mid;
    else bad = mid;
  }
  return { size: good, types: at(good) };
}
