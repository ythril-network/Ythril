/**
 * What a server source imports, and everything it reaches through its imports.
 *
 * ## The question it answers
 *
 * "What code runs inside this process?" — for the inference child, which must not reach the server's logger, config
 * or database. A gate that named the child's files by hand would pass the day somebody added a fourth one that
 * imported them; the closure is derived from the entry, so a new import is in it the moment it is written.
 *
 * Comments are stripped first (a sentence that mentions `import` is not one), and a relative import that resolves to
 * no file THROWS rather than being skipped: a closure computed over a broken graph is a smaller set that every
 * assertion over it would quietly pass on.
 *
 * `.js` specifiers name `.ts` sources, as they do everywhere in `server/src`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import assert from 'node:assert/strict';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const read = (f) => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
const exists = (f) => existsSync(join(REPO_ROOT, f));

/** Relative imports of a file (static, dynamic and re-exported), resolved to repo paths. */
export function relativeImports(file) {
  const out = [];
  for (const m of read(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    out.push(posix.normalize(posix.join(posix.dirname(file), m[1])).replace(/\.js$/, '.ts'));
  }
  return out;
}

/** Bare imports of a file: packages and `node:` built-ins. */
export function bareImports(file) {
  const out = [];
  for (const m of read(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^./'"][^'"]*)['"]/g)) out.push(m[1]);
  return out;
}

/** `entry` and everything it imports, transitively, sorted. */
export function importClosure(entry) {
  assert.ok(exists(entry), `${entry} does not exist — re-anchor this gate`);
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    assert.ok(exists(f), `${f} is imported but does not exist — the closure is being computed over a broken graph`);
    seen.add(f);
    for (const dep of relativeImports(f)) queue.push(dep);
  }
  return [...seen].sort();
}

/** The comment-stripped text of every file in the closure, joined. For "somewhere in what runs there" assertions. */
export function closureCode(entry) {
  return importClosure(entry).map(read).join('\n');
}
