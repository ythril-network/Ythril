/**
 * The section still being appended to carries ONE heading per kind.
 *
 * ## The pile this prevents, measured before it was cleared
 *
 * `[Unreleased]` reached **4 303 lines, 212 entries and 54 `###` headings** on the way to 4.0.0 — twenty
 * `Fixed` blocks, eighteen `Changed`, seven `Added`. Nobody chose that. Each pull request added its own block
 * at the top of the section instead of merging into the one already there, and every one of those commits was
 * individually correct.
 *
 * What it cost the reader is the point: to find everything that changed about sync you read all 4 303 lines,
 * because sync entries sat in twenty separate `Fixed` blocks in whatever order the pull requests happened to
 * land. The section read as a merge log rather than as release notes.
 *
 * ## Why only `[Unreleased]`
 *
 * **A tagged release is history and is not rewritten.** Four sections in this file and four in the 2.x archive
 * already carry duplicates; correcting them would edit notes that have been published, which is a worse
 * failure than the untidiness. The rule bites where it changes something — on the section a pull request is
 * still appending to — and once that section is tagged it is frozen in the shape this gate held it to.
 *
 * ## The vocabulary half, and why it is not scope creep
 *
 * Uniqueness alone is walkable by accident: `### Fixes` beside `### Fixed` passes a uniqueness check and
 * rebuilds exactly the pile above. So the heading must also be one of the six this project uses. The archives
 * show what happens without it — `Breaking`, `Documentation` and `Testing` all appear as headings in older
 * releases, each a reasonable word, and together they are why a reader cannot guess where anything is.
 *
 * A gate cannot hold the ORDERING of entries inside a heading — grouping them by subject is judgement — so
 * that half is a release step in `todo/_THE_LOOP.md` beside `release:gate`, not a check here.
 *
 * Run: node --test testing/standalone/one-heading-per-kind-in-a-release-section.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANGELOG_KINDS as KINDS } from '../../scripts/changelog-section.mjs';

const CHANGELOG = 'CHANGELOG.md';

/** The body of `## [Unreleased]`, up to the first tagged release. */
function unreleasedBody(src) {
  const at = src.indexOf('## [Unreleased]');
  if (at < 0) return null;
  const rest = src.slice(at + 1);
  const next = rest.search(/^## \[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('the unreleased section carries one heading per kind', () => {
  const src = readFileSync(CHANGELOG, 'utf8');
  const body = unreleasedBody(src);

  it('there is an [Unreleased] section to check (the check itself works)', () => {
    // Without this the gate passes on a file it never found — the vacuity every coverage check here has had.
    assert.ok(body !== null, '`## [Unreleased]` is missing from CHANGELOG.md, so this gate checked nothing');
  });

  it('no kind appears twice', () => {
    const headings = [...body.matchAll(/^### (.+)$/gm)].map(m => m[1].trim());
    const seen = new Map();
    for (const h of headings) seen.set(h, (seen.get(h) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([h, n]) => `${h} x${n}`);
    assert.deepEqual(dupes, [],
      'the unreleased section has the same heading more than once: ' + dupes.join(', ')
      + '. Add your entry UNDER the block that is already there rather than opening a second one — a new '
      + 'block per pull request is what took this section to 54 headings before 4.0.0.');
  });

  it('and every heading is one of the six', () => {
    const headings = [...body.matchAll(/^### (.+)$/gm)].map(m => m[1].trim());
    const strays = [...new Set(headings.filter(h => !KINDS.includes(h)))];
    assert.deepEqual(strays, [],
      'unknown heading(s) in the unreleased section: ' + strays.join(', ')
      + `. Use one of ${KINDS.join(', ')} — a near-synonym passes the uniqueness check above and rebuilds `
      + 'the same pile under a different word.');
  });

  it('the headings are in the documented order', () => {
    /*
     * Order matters less than uniqueness and is nearly free to hold, but it is the thing that decays first:
     * once a heading may go anywhere, the natural place to add one is the top, which is how the pile started.
     */
    const headings = [...body.matchAll(/^### (.+)$/gm)].map(m => m[1].trim()).filter(h => KINDS.includes(h));
    const sorted = [...headings].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b));
    assert.deepEqual(headings, sorted,
      `headings out of order: ${headings.join(', ')} — expected ${sorted.join(', ')}`);
  });
});
