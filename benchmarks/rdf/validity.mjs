/**
 * Whether a Ythril run answered what Oxigraph answered.
 *
 * Both engines hold the same triples and are asked the same questions (run k of a query uses parameter set k), so a
 * query whose row count differs between them means one engine answered something else; its time is not a time for
 * the same work. A run is valid only when every query's count is Oxigraph's.
 *
 * ## What this prevents
 *
 * - **A fast wrong answer read as a fast engine.** The first Ythril run answered 0 rows for queries Oxigraph
 *   answered with rows and was "faster". Every differing query is named with both counts and the run is invalid.
 * - **One matching run standing for twenty-three.** When both records hold the row count of every run
 *   (`rowsPerRun`, by parameter set), every run is compared and the first differing run is named.
 * - **A missing answer passing as zero.** A query that errored, holds no count or is absent from a record has NO
 *   count (`null`), which equals no number, `0` included. Oxigraph without a count cannot be matched either.
 */

const number = (name) => Number(/^Q(\d+)$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** `rows` of a query record when it was timed and counted, else `null`. */
const rowsOf = (q) => (q !== undefined && typeof q.median === 'number' && Number.isInteger(q.rows) ? q.rows : null);

/**
 * `{ valid, differing: [{ query, oxigraph, ythril }] }` from the two engines' `queries` objects, queries in number
 * order. Throws when neither record holds a query: nothing was compared.
 */
export function judgeValidity(oxigraph, ythril) {
  const names = [...new Set([...Object.keys(oxigraph), ...Object.keys(ythril)])].sort((a, b) => number(a) - number(b));
  if (names.length === 0) throw new Error('no queries to compare: a run with none cannot be judged');
  const differing = [];
  for (const query of names) {
    const o = rowsOf(oxigraph[query]);
    const y = rowsOf(ythril[query]);
    if (o === null || y === null || o !== y) { differing.push({ query, oxigraph: o, ythril: y }); continue; }
    // Run k of a query asks both engines the same question, so a record that holds the count of every run is
    // compared run by run: the first run's count agreeing says nothing of the other twenty-two.
    const po = oxigraph[query].rowsPerRun;
    const py = ythril[query].rowsPerRun;
    if (Array.isArray(po) && Array.isArray(py)) {
      const at = Array.from({ length: Math.max(po.length, py.length) }, (_, i) => i).find((i) => !Number.isInteger(po[i]) || po[i] !== py[i]);
      if (at !== undefined) differing.push({ query, oxigraph: po[at] ?? null, ythril: py[at] ?? null, run: at });
    }
  }
  return { valid: differing.length === 0, differing };
}
