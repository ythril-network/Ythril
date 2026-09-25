#!/usr/bin/env node
/**
 * A change to shipped code needs a CHANGELOG entry under `[Unreleased]`.
 *
 * ## Why this exists
 *
 * The rule was already the house rule, and it was followed — 28 PRs in the batch that added this check, every one
 * with an entry. Nothing enforced it. A rule kept alive by memory alone is one distracted afternoon from lapsing,
 * and the lapse is invisible: nobody notices the entry that was never written.
 *
 * ## What counts
 *
 * A diff that touches `server/src/` or `client/src/` — the code that ships — must also add at least one line inside
 * the `[Unreleased]` section of `CHANGELOG.md`.
 *
 * Deliberately NOT required for: tests, `testing/`, `docs/`, workflows, `scripts/`, `todo/`, or a `*.spec.ts`
 * anywhere. Those change without changing what a user gets. The exemption is **by path**, with no "skip changelog"
 * escape hatch: if a source change genuinely has no user-facing effect, saying so in one CHANGELOG line is cheap and
 * leaves a record, whereas a marker in a PR title leaves nothing and is used the moment it is inconvenient.
 *
 * ## Why "inside `[Unreleased]`" rather than "the file changed"
 *
 * Touching `CHANGELOG.md` is easy to satisfy accidentally — a released section gets a typo fix and the check passes
 * while the actual change goes unrecorded. The added line has to land in the section that describes what is not
 * shipped yet.
 *
 * Usage: node scripts/check-changelog.mjs <base-ref>
 *   e.g. node scripts/check-changelog.mjs origin/main
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { linesUnderUnshippedSections } from './_changelog-sections.mjs';

const base = process.argv[2] ?? 'origin/main';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

/** Paths whose change never needs a user-facing note. */
const EXEMPT = [
  /^testing\//,
  /^docs\//,
  /^scripts\//,
  /^todo\//,
  /^\.github\//,
  /\.spec\.ts$/,
  /\.test\.js$/,
];

/** Paths that ship to a user, and therefore need one. */
const SHIPPED = [/^server\/src\//, /^client\/src\//, /^client\/public\//];

let changed;
try {
  // Committed work UNION the working tree, and the union is the point.
  //
  // `${base}...HEAD` alone is committed-only, which is correct in CI and useless in a local pre-push run: the usual
  // order is `git add` → preflight → commit → push, so the change being checked is not committed yet and the gate
  // sees nothing. It would then report "nothing to require" and pass — vacuously, on exactly the push it exists to
  // stop. That is how this was missed on the one PR in eleven that had no entry.
  //
  // `git diff --name-only ${base}` compares the working tree to the base, so it catches uncommitted and staged files.
  // In CI the two produce the same set, because there is nothing uncommitted there.
  const committed = git('diff', '--name-only', `${base}...HEAD`).split('\n');
  const working = git('diff', '--name-only', base).split('\n');
  changed = [...new Set([...committed, ...working].map(s => s.trim()).filter(Boolean))];
} catch (err) {
  // A diff that cannot run must NOT look like a pass. In CI that is an environment fault worth stopping for — a
  // shallow clone with no merge base would otherwise turn this check into a no-op that reports success, which is
  // precisely the failure mode the check exists to prevent. Locally, skipping is fine.
  const why = err.message.split('\n')[0];
  if (process.env['CI']) {
    console.error(`check-changelog: cannot diff against ${base} (${why}).`);
    console.error('In CI this is a hard failure: a check that cannot run must not report success. Ensure the base ref');
    console.error('is fetched — actions/checkout needs `fetch-depth: 0` for a merge base to exist.');
    process.exit(1);
  }
  console.log(`check-changelog: cannot diff against ${base} (${why}) — skipping (not CI).`);
  process.exit(0);
}

const shipped = changed.filter(f => SHIPPED.some(re => re.test(f)) && !EXEMPT.some(re => re.test(f)));

if (shipped.length === 0) {
  console.log(`check-changelog: no shipped-code changes in ${changed.length} changed file(s) — nothing to require.`);
  process.exit(0);
}

/** Line numbers added to CHANGELOG.md in this diff. */
function addedChangelogLines() {
  // `${base}` and NOT `${base}...HEAD`, to match how the changed-FILE list is built above.
  //
  // The two were inconsistent for exactly one commit: the file list was widened to include the working tree, and this
  // was left committed-only. So an uncommitted change to shipped code was SEEN while the uncommitted CHANGELOG entry
  // answering it was not — and the gate failed on correct code, on its own first real use. Half-widening a comparison
  // is worse than not widening it, because the halves disagree in the direction that reports a defect.
  //
  // Line numbers here are compared against the CURRENT file (`unreleasedRange` reads it from disk), so a working-tree
  // diff is the consistent choice rather than a convenience.
  let patch;
  try {
    patch = git('diff', '-U0', base, '--', 'CHANGELOG.md');
  } catch {
    return [];
  }
  const lines = [];
  // Hunk headers look like `@@ -12,0 +13,4 @@` — the `+start,count` is what we need.
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.push(start + i);
  }
  return lines;
}

/** The line range of the `[Unreleased]` section in the CURRENT file. */
function unreleasedRange() {
  const src = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/);
  const start = src.findIndex(l => /^##\s*\[Unreleased\]/i.test(l));
  if (start < 0) return null;
  let end = src.length;
  for (let i = start + 1; i < src.length; i++) {
    if (/^##\s*\[/.test(src[i])) { end = i; break; }
  }
  return { start: start + 1, end };   // 1-based, end exclusive
}

const range = unreleasedRange();
if (!range) {
  console.error('check-changelog: CHANGELOG.md has no "## [Unreleased]" section — add one.');
  process.exit(1);
}

// Under [Unreleased], or under a version section this change adds — a patch PR into a release branch writes its
// entry under its own new `## [X.Y.Z]` (Q-56). A section that already existed is released and never counts.
const added = linesUnderUnshippedSections(readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/), addedChangelogLines());

if (added.length === 0) {
  console.error('check-changelog: FAILED\n');
  console.error(`These files change what ships, and CHANGELOG.md gained no line under [Unreleased]:\n`);
  for (const f of shipped.slice(0, 20)) console.error(`  ${f}`);
  if (shipped.length > 20) console.error(`  … and ${shipped.length - 20} more`);
  console.error('\nAdd an entry describing the change from a user\'s point of view. If it genuinely has no');
  console.error('user-facing effect, say that in one line — it is cheap, and it leaves a record that someone');
  console.error('considered the question.');
  process.exit(1);
}

console.log(`check-changelog: OK — ${shipped.length} shipped file(s) changed, `
  + `${added.length} line(s) added under [Unreleased].`);
