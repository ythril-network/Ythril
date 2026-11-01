/**
 * No shipped document grows past 900 lines.
 *
 * ## The rule was already agreed; this is what makes it hold
 *
 * Five documents had crossed 1,000 lines before anyone noticed, and the largest was 2,037 — the biggest file
 * in the repository, roughly twice the next. Splitting them (Q-7, #796-#800) fixed the instances. It does not
 * fix the mechanism, which is that a document grows one paragraph at a time and no single commit ever looks
 * like the one that made it unreadable.
 *
 * Three concrete costs, all of them measured rather than asserted:
 *
 *  1. **Retrieval.** The canary reads our documentation INTO Ythril. `04-brain-api.md` at 57,642 B chunked
 *     into TWO pieces, and they could not retrieve anything specific from it — a whole API reference reduced
 *     to two undifferentiated blobs. `chunk-size-bounded.test.js` guards the chunker; this guards the input.
 *  2. **Drift inside one file.** `Sorting (all brain list endpoints)` sat as an H4 under `List Entities` while
 *     being linked from the chrono and file-metadata tables. A cross-cutting rule filed under one resource is
 *     the shape long files produce, because there is nowhere else to put it that a reader would find.
 *  3. **Silent loss on the eventual split.** The Brain API reference carried `ation naming the missing
 *     capability — diagnostic, not display copy.` for THIRTEEN releases: the tail of a 20-line block cut off
 *     mid-word by an earlier split. The bigger the file, the less likely anyone reads the seam.
 *
 * ## Why 900 and not 1,000
 *
 * MEASURED, not chosen for roundness. With all five splits in, the largest surviving document is
 * `02-hosting.md` at 817 lines and the next is 611. A limit of 1,000 could not fire against anything that
 * exists — it would be a gate that passes forever and reads like protection. 900 leaves 02-hosting room to
 * grow and still catches the next file heading for four figures.
 *
 * Raising the limit is a legitimate move if a document genuinely needs it. Doing so in the same commit that
 * makes a file too long is not, which is why the number is here and not in a config file.
 *
 * ## `git ls-files`, not the filesystem
 *
 * What ships is what git tracks. `docs/docker-build-protocol.md` is gitignored — it exists on a maintainer's
 * disk and in no clone, no image and no build — and a filesystem walk once made a different docs gate demand
 * a Help entry for it, which would have 404'd for every user.
 *
 * Run: node --test testing/standalone/no-oversized-docs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LIMIT = 900;

/**
 * The tracked docs and their line counts.
 *
 * Several patterns because git's pathspec is not a shell glob: a single-star pattern does not descend, and a
 * double-star one does not mean what a shell means by it. The repo has one level of nesting under `docs/`
 * (the split guides); a third, two-deep pattern is cheaper than a wrong assumption, so it is included too.
 *
 * (Written without the literal patterns because a nesting glob inside a block comment ends the comment — the
 * error points at the following line and reads as a syntax error in ordinary code.)
 */
function trackedDocs() {
  const out = execFileSync('git', ['ls-files', 'docs/*.md', 'docs/*/*.md', 'docs/*/*/*.md'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((path) => ({
    path,
    // `split` rather than a match count: a file with no trailing newline still has a last line, and a file
    // of N newlines has N lines, which is what `wc -l` reports and what every measurement in the tracker used.
    lines: readFileSync(path, 'utf8').split(/\r?\n/).length - 1,
  }));
}

/** The predicate, separated so it can be tested against input this repo does not contain. */
export function oversized(docs, limit = LIMIT) {
  return docs.filter((d) => d.lines > limit).sort((a, b) => b.lines - a.lines);
}

describe('the check itself works before it is trusted', () => {
  it('finds the tracked docs', () => {
    // A `git ls-files` that returned nothing would make the assertion below vacuously true — the specific
    // way a size gate becomes decoration.
    const docs = trackedDocs();
    assert.ok(docs.length >= 20, `only found ${docs.length} tracked docs under docs/ — the gate is measuring nothing`);
    assert.ok(docs.some((d) => d.path === 'docs/userguide.md'), 'docs/userguide.md was not among them');
    assert.ok(docs.some((d) => d.path.startsWith('docs/integration-guide/')), 'the split integration guide was not walked');
  });

  it('counts lines the way every measurement in this repo did', () => {
    // Pinned against a file whose length is asserted elsewhere, so a counting change shows up here rather
    // than as a mysteriously passing gate.
    const docs = trackedDocs();
    const ug = docs.find((d) => d.path === 'docs/userguide.md');
    assert.ok(ug.lines > 0 && ug.lines < 200,
      `docs/userguide.md measured ${ug.lines} lines; it is a contents page and should be well under 200`);
  });

  it('REPORTS an oversized document when given one', () => {
    // Mutation-check on the predicate rather than on the repo. Without this, a gate that can never fire
    // looks exactly like a gate with nothing to report.
    const fabricated = [{ path: 'docs/fake.md', lines: LIMIT + 1 }, { path: 'docs/fine.md', lines: LIMIT }];
    assert.deepEqual(oversized(fabricated).map((d) => d.path), ['docs/fake.md'],
      'the predicate must flag a file one line over and leave one exactly at the limit alone');
  });

  it('orders its report worst-first', () => {
    const fabricated = [{ path: 'a', lines: 950 }, { path: 'b', lines: 1200 }, { path: 'c', lines: 1000 }];
    assert.deepEqual(oversized(fabricated).map((d) => d.path), ['b', 'c', 'a']);
  });
});

describe('no shipped document is oversized', () => {
  it(`every tracked doc is at most ${LIMIT} lines`, () => {
    const over = oversized(trackedDocs());
    assert.deepEqual(over.map((d) => `${d.path} (${d.lines})`), [],
      `These documents are over ${LIMIT} lines:\n  ${over.map((d) => `${d.path} — ${d.lines}`).join('\n  ')}\n\n`
      + 'Split by topic rather than trimming prose. The Q-7 tooling no longer ships with the repo; a split script\n'
      + 'moves sections by LINE RANGE, asserts the first line of every range, checks a conserved total, and compares\n'
      + 'the multiset of prose lines before and after. A hand-split of this guide once lost twenty lines\n'
      + 'mid-word and shipped the remains for thirteen releases.\n\n'
      + 'Splitting also means: add the new parts to HELP_DOCS, link them from the index, and re-point every\n'
      + 'gate that pins a path or an anchor into the moved section — each must still assert it FOUND its block.');
  });

  it('the limit is close enough to reality to be able to fire', () => {
    // A limit far above every real file is indistinguishable from no limit. If the largest doc ever drops
    // well below this, the number should come down with it rather than sit here looking like protection.
    const largest = trackedDocs().sort((a, b) => b.lines - a.lines)[0];
    assert.ok(largest.lines > LIMIT / 2,
      `the largest tracked doc is ${largest.path} at ${largest.lines} lines against a limit of ${LIMIT} — `
      + 'that gap makes this gate unfireable; lower the limit to something the documentation can actually reach');
  });
});
