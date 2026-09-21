/**
 * Which part of the split integration guide owns a given section — DERIVED, never named.
 *
 * ## The failure this exists to stop, which has now happened twice
 *
 * `docs/integration-guide/` is one document in thirty files, and every tracked doc is capped at 900 lines.
 * So a page that keeps growing eventually gets SPLIT, and a section moves to a filename nobody has written
 * down anywhere. `04g-links-api.md` came out of `04b` that way; `04h-graph-augmented-recall.md` came out of
 * `04a`.
 *
 * A gate that hard-codes the old path then has two futures and only one of them is loud:
 *
 *  - it asserts the section's rule is PRESENT, so it goes red on the split and somebody re-points it. That
 *    is what happened here — two gates named `04a-recall-api.md` and both failed the moment graph-augmented
 *    recall moved out of it.
 *  - it asserts something is ABSENT, or it greps for a spelling that the remaining page happens to keep, and
 *    it goes on passing about a page that no longer contains its subject. Nothing contradicts it, because a
 *    gate that passes is evidence of nothing in particular.
 *
 * The second is the one worth building against, and it is why this answers by derivation rather than by a
 * corrected constant. A corrected constant is the same defect with a later expiry date.
 *
 * ## The guard is the whole point of it being a module
 *
 * A hand-written `readdirSync(...).find(...)` returns `undefined` when the heading is reworded, and
 * `readFileSync(undefined)` is the loud case only by luck — the quiet case is a caller that spreads the
 * result into a list and asserts over nothing. So this THROWS on zero matches and on more than one, naming
 * what it looked for, and a caller cannot receive the failure quietly.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * What SHIPS is what git tracks. A page present only in a maintainer's working tree is in no clone, no
 * image and no build, so it must be invisible here too — the same correction `help-docs-coverage` paid for.
 */
function guideParts() {
  const files = execFileSync('git', ['ls-files', 'docs/integration-guide/*.md'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  if (files.length < 2) {
    throw new Error(`only ${files.length} integration-guide part(s) are tracked. The guide is split across `
      + 'dozens of files, so this is a failed listing rather than a small guide — every lookup below would '
      + 'answer about a set that is not the documentation.');
  }
  return files;
}

/**
 * The one part whose HEADINGS include `text`.
 *
 * Headings only, deliberately: the page a section moved OUT of keeps linking to it by name, so a whole-file
 * search answers with the page that refers to the section as readily as the page that contains it — and
 * would have returned `04a-recall-api.md` for graph-augmented recall the day after it stopped owning it.
 *
 * @param {string} text a distinctive fragment of the section's heading, matched case-insensitively
 * @returns {string} the repo-relative path of the part that owns it
 * @throws when no part owns it, or when more than one does
 */
export function guidePartOwning(text) {
  const needle = text.toLowerCase();
  const owners = guideParts().filter(f => readFileSync(f, 'utf8').split(/\r?\n/)
    .some(l => /^#{1,6}\s/.test(l) && l.toLowerCase().includes(needle)));

  if (owners.length === 0) {
    throw new Error(`no part of the integration guide has a heading containing '${text}'. Either the section `
      + 'was renamed — in which case this call names something that no longer exists and the gate above it '
      + 'has been asserting about the wrong page — or the guide moved. Grep the heading, not the filename.');
  }
  if (owners.length > 1) {
    throw new Error(`'${text}' matches a heading in ${owners.length} parts (${owners.join(', ')}), so there `
      + 'is no one owner to check. Narrow the fragment.');
  }
  return owners[0];
}
