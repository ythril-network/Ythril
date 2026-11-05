/**
 * Text as a regular expression's literal (Q-683, the bundle-225 diff pass).
 *
 * ## The question it answers
 *
 * "How is this text written inside a pattern so that it matches itself and nothing else?" Scripts and gates build a pattern from a
 * name, a path or a code and need the answer.
 *
 * ## What it prevents
 *
 * Sites all over `scripts/` and `testing/` spelled `text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` by hand, each free to drift: a copy that left out the
 * backslash let a name with one end a pattern early, one that left out `|` or `(` turned a name into a group, and one that
 * added `-` or `/` broke under the `u` flag (`\-` outside a class is a SyntaxError there). The set is exactly the MDN one,
 * `[.*+?^${}()|[\]\\]`: it is valid with and without `u`. `testing/standalone/a-regex-escape-is-written-once.test.js` refuses the
 * inline spelling anywhere else in `scripts/` and `testing/`.
 *
 * It is not for a pattern that must escape a different set on purpose (a glob translator that keeps `*`, a class of two
 * characters): that is another question and keeps its own line.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
