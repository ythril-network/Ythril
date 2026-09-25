/**
 * Which added CHANGELOG lines describe something not yet shipped (`Q-56`).
 *
 * A line counts when it sits under `## [Unreleased]`, or under a version section whose HEADER this same change added —
 * the patch case: a PR into `release/X.Y.x` writes its entry under the `## [X.Y.Z]` section it introduces. A line
 * added under a section that already existed does not count: that is an edit of a released section, the typo fix the
 * changelog check exists to refuse as a substitute for an entry. Header lines themselves are never entries.
 *
 * Pure, so the rule is tested on its own (`a-patch-entry-counts-under-the-section-it-adds.test.js`).
 *
 * @param {string[]} lines  the CURRENT file, one string per line
 * @param {number[]} added  1-based numbers of the lines this change added
 * @returns {number[]} the added lines that count, in order
 */
export function linesUnderUnshippedSections(lines, added) {
  const addedSet = new Set(added);
  const headers = [];
  lines.forEach((l, i) => { if (/^##\s*\[/.test(l)) headers.push(i + 1); });
  const counts = [];
  for (const n of added) {
    if (headers.includes(n)) continue;
    const header = [...headers].reverse().find(h => h < n);
    if (header === undefined) continue;
    const unreleased = /^##\s*\[Unreleased\]/i.test(lines[header - 1]);
    if (unreleased || addedSet.has(header)) counts.push(n);
  }
  return counts;
}
