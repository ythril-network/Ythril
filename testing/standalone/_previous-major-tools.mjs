/**
 * Which MCP tool names the EARLIER MAJORS offered — read from the last release tag of each, never listed.
 *
 * ## Why a module
 *
 * Two gates need the same fact. `no-live-text-names-a-retired-tool` asks it of the text a caller reads, and
 * `the-guide-tables-are-generated-from-code` asks it of the guide's headings and tool tables. A hand-written
 * list of retired names is missing whichever name was retired most recently, so both derive the set from the
 * last release of every major below ours and subtract what is live; a second copy of the derivation would be the
 * place the two disagree about what "retired" means.
 *
 * **Every earlier major, not only the one below.** Read one major back, a 6.0 cut stopped holding the names 5.0
 * retired (nothing was retired between 5.6.10 and 6.0), and both gates failed as vacuous at the moment they
 * should have kept working.
 *
 * ## What it prevents
 *
 * **An unreadable history must not look like "nothing was retired".** `fetch-depth: 0` in CI is what makes the
 * tag reachable. When it is not, this THROWS (an assertion naming the checkout step) rather than returning an
 * empty set, which would pass every loop written over it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/** The last release tag of every major below ours, newest first — what callers were offered before this one. */
export function earlierMajorTags() {
  const major = Number(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version.split('.')[0]);
  const lastOf = new Map();
  for (const t of git('tag', '--sort=-v:refname').split('\n').map(s => s.trim()).filter(s => /^v\d+\.\d+\.\d+$/.test(s))) {
    const m = Number(t.slice(1).split('.')[0]);
    if (m < major && !lastOf.has(m)) lastOf.set(m, t);
  }
  const tags = [...lastOf.values()];
  assert.ok(tags.length > 0,
    `no release tag below major ${major} is reachable. In CI that means the checkout lost its tags — the `
    + 'workflow sets `fetch-depth: 0` for the CHANGELOG diff and this needs the same. This fails rather '
    + 'than reporting that nothing has been retired, which is what an unreadable history would otherwise '
    + 'look like.');
  return tags;
}

/** Every tool name an earlier major offered at its last release, with the newest such tag that offered it. */
export function toolNamesOfEarlierMajors() {
  const at = new Map();
  for (const tag of earlierMajorTags()) for (const name of toolNamesAt(tag)) if (!at.has(name)) at.set(name, tag);
  return at;
}

/** Every MCP tool name declared in a tree, read out of the registry files rather than listed. */
export function toolNamesAt(ref) {
  const files = git('ls-tree', '-r', '--name-only', ref, 'server/src/mcp/tools').split('\n').filter(Boolean);
  const names = new Set();
  for (const f of files) {
    for (const m of git('show', `${ref}:${f}`).matchAll(/^\s*name:\s*'([a-z][a-z0-9_]*)',/gm)) names.add(m[1]);
  }
  return names;
}
