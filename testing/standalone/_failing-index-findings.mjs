/**
 * What a test of "a refused index stops nothing else" reads after the refusal: which declared indexes are not standing, and
 * whether a log line names the space and the index (bundle-101, Q-445; the one file that holds the rule is
 * `a-failing-space-index-is-contained-and-named-db.test.js`).
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
 *
 * **The collection of the index.** Index names repeat across collections (`type_1` is declared on four of them, `pos_1__id_1`
 * on every position-carrying one), and the unit a line names is `index <name> on <collection suffix>`. A copy that looks for the
 * name alone passes a line that names the same-named index of another collection, which is what two refusals in one pass would
 * hide. {@link named} takes the suffix, so no caller can leave it out.
 */
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';
import { indexesOfSpace, specDifference } from './_space-index-declaration.mjs';

/** The one declared index a store may leave out: its policy is best effort. */
const OPTIONAL = 'lexical_text';

/**
 * The findings of `expected` (a map of index id to `{ spec }`) against what `space` carries now, the indexes in `skipIds` left out
 * (the ones the test refused on purpose).
 *
 * @param {import('mongodb').Db} db
 * @param {string} space
 * @param {Map<string, { spec: { name: string } }>} expected
 * @param {Iterable<string>} [skipIds]
 * @returns {Promise<string[]>} empty when every other declared index stands as declared
 */
export async function notStanding(db, space, expected, skipIds = []) {
  const skip = new Set(skipIds);
  const now = await indexesOfSpace(db, space);
  const out = [];
  for (const [id, { spec }] of expected) {
    if (skip.has(id)) continue;
    const got = now.get(id);
    if (!got) { if (spec.name !== OPTIONAL) out.push(`${id} missing`); continue; }
    const diff = specDifference(spec, got.spec);
    if (diff.length) out.push(`${id} differs in ${diff.join(', ')}`);
  }
  return out;
}

/**
 * Whether one emitted line names the space (quoted as the reporter quotes it) and the index on its collection: `index <name> on
 * <suffix>`, the suffix ending the word (`on files` is not `on file_tombstones`).
 *
 * @param {string[]} lines
 * @param {string} space
 * @param {string} suffix the collection's suffix as `SPACE_COLLECTIONS` spells it (an entry's `suffix`)
 * @param {string} name the index's name (an entry's `spec.name`)
 */
export function named(lines, space, suffix, name) {
  if (typeof suffix !== 'string' || suffix === '' || typeof name !== 'string' || name === '') {
    throw new Error(`named: a line names an index by its collection and its name (got suffix ${JSON.stringify(suffix)}, name ${JSON.stringify(name)})`);
  }
  const unit = new RegExp(`\\bindex ${escapeRegExp(name)} on ${escapeRegExp(suffix)}(?![A-Za-z0-9_])`);
  return lines.some(l => l.includes(`'${space}'`) && unit.test(l));
}
