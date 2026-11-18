/**
 * What a test of "a refused index stops nothing else" reads after the refusal: which declared indexes are not standing, and
 * whether a log line names the space and the index (bundle-101, Q-445; the two files that hold the rule are
 * `a-failing-space-index-is-contained-and-named-db.test.js` and
 * `a-failing-space-index-in-the-background-pass-is-named-db.test.js`).
 *
 * ## What a hand-written copy drops
 *
 * **The best-effort index's absence.** `lexical_text` is best effort: a store that cannot build it leaves the space working,
 * so a copy that lists it as missing fails every run on a store without a text index, and a copy that skips every missing
 * index passes a pass that built nothing. {@link notStanding} excuses only the optional name, and reports every other index
 * as missing or as differing in the fields that decide whether two indexes are one ({@link specDifference}).
 *
 * **The quoting of the space.** The shared reporter writes the space as `'<space>'`; a copy that looks for the bare id matches
 * `reference_walked` for `walked` and passes a line that names another space.
 */
import { indexesOfSpace, specDifference } from './_space-index-declaration.mjs';

/** The one declared index a store may leave out: its policy is best effort. */
const OPTIONAL = 'lexical_text';

/**
 * The findings of `expected` (a map of index id to `{ spec }`) against what `space` carries now, the index `skipId` left out
 * (the one the test refused on purpose).
 *
 * @param {import('mongodb').Db} db
 * @param {string} space
 * @param {Map<string, { spec: { name: string } }>} expected
 * @param {string} [skipId]
 * @returns {Promise<string[]>} empty when every other declared index stands as declared
 */
export async function notStanding(db, space, expected, skipId) {
  const now = await indexesOfSpace(db, space);
  const out = [];
  for (const [id, { spec }] of expected) {
    if (id === skipId) continue;
    const got = now.get(id);
    if (!got) { if (spec.name !== OPTIONAL) out.push(`${id} missing`); continue; }
    const diff = specDifference(spec, got.spec);
    if (diff.length) out.push(`${id} differs in ${diff.join(', ')}`);
  }
  return out;
}

/** Whether one emitted line names the space (quoted as the reporter quotes it) and the index. */
export const named = (lines, space, name) => lines.some(l => l.includes(`'${space}'`) && l.includes(name));
