/**
 * A changelog entry counts where it describes what has not shipped: `[Unreleased]`, or a version section the same
 * change adds (`Q-56`).
 *
 * `check-changelog.mjs` required every shipped-code change to add a line under `[Unreleased]`. A patch on a release
 * branch writes its entry under its own new section — `## [5.1.5]`, added by that PR — so once CI runs on release-branch
 * pull requests the check would refuse every patch, and the fix for having no merge gate would be a gate nobody passes.
 * A section the change ADDS is as unshipped as `[Unreleased]`. A section that already existed is not: a line added
 * there is the typo fix in a released section the check was written to refuse.
 *
 * Run: node --test testing/standalone/a-patch-entry-counts-under-the-section-it-adds.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let linesUnderUnshippedSections;
before(async () => { ({ linesUnderUnshippedSections } = await import('../../scripts/_changelog-sections.mjs')); });

const FILE = [
  '# Changelog',            // 1
  '',                       // 2
  '## [Unreleased]',        // 3
  '',                       // 4
  '## [5.1.5] — 2026-09-25', // 5
  '',                       // 6
  '- the patch entry',      // 7
  '',                       // 8
  '## [5.1.4] — 2026-09-25', // 9
  '',                       // 10
  '- an old entry',         // 11
];

describe('where an added line counts', () => {
  it('under [Unreleased]', () => {
    const f = [...FILE]; f.splice(3, 0, '- new work');     // line 4
    assert.deepEqual(linesUnderUnshippedSections(f, [4]), [4]);
  });

  it('under a version section this change adds — the patch case', () => {
    assert.deepEqual(linesUnderUnshippedSections(FILE, [5, 6, 7]), [6, 7]);
  });

  it('NOT under a section that already existed — a released section stays released', () => {
    assert.deepEqual(linesUnderUnshippedSections(FILE, [11]), []);
    assert.deepEqual(linesUnderUnshippedSections(FILE, [7]), [], 'the entry alone, with its header already there, is an edit of a released section');
  });

  it('the header line itself is not an entry', () => {
    assert.deepEqual(linesUnderUnshippedSections(FILE, [5]), []);
  });

  it('a file with no [Unreleased] still counts a new section', () => {
    const f = FILE.filter(l => l !== '## [Unreleased]');
    assert.deepEqual(linesUnderUnshippedSections(f, [4, 5, 6]), [5, 6]);
  });
});
