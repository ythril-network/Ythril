/**
 * Every file-system rename in the server is `moveTree` or a named exemption with its reason: a space's directory is never moved by a
 * bare `fs.rename` (Q-171; widened from `server/src/spaces/` to every tracked server source, bundle-95 review D5).
 *
 * ## What it prevents
 *
 * `removeTree` retries what a concurrent holder causes (`EPERM`, `EBUSY`, `EACCES`, `EMFILE`, `ENFILE`), and a rename that
 * did not: on Windows any open handle under a directory makes `fs.rename` of it answer `EPERM` at once, so a space rename failed
 * on a file a download or an indexer still held, and the `.chunks` move sat in a bare `catch {}` and left the chunks behind
 * under the old id while the rename answered success. One retry rule, in one module, is what keeps the two directions alike.
 *
 * The first version of this gate was titled "every" and read `server/src/spaces/` only, so a directory move written in `files/`, `api/`
 * or `sync/` (where the bytes of a space are handled) was outside what it concluded about.
 *
 * ## What it holds
 *
 *  - every call that renames a path through the file system (`fs.rename`, `fsp.rename`, `renameSync`, `promises.rename`, or a named import
 *    of `rename` from a file-system module) in ANY tracked file under `server/src` is in `files/remove-tree.ts` (`moveTree`'s own) or in a
 *    file named in `EXEMPT_RENAMES` with the reason its renames are not a space's directory. The set is derived from the tracked sources,
 *    with a floor. A collection's `.rename(` is not a file-system rename and is not matched: the receiver has to be a file-system module's
 *    name;
 *  - every exemption is live: its file still renames, so a reason never outlives its subject, and the scan finds the exempt calls at all
 *    (a scan that found none would pass every file);
 *  - the floor on the other side: `spaces/rename.ts` calls `moveTree` for both of its directories (files and chunks), so the
 *    gate cannot pass by the moves having been deleted;
 *  - `moveTree` and `removeTree` share one retry rule, read from the module: one set of retried codes and one pair of constants.
 *
 * ## Seen red
 *
 * At the base (a71370b0d) `rename.ts` holds two bare `fs.rename` calls and no `moveTree`. A bare `fs.rename` put in `rename.ts` by hand,
 * and (bundle-95 review) one put in `server/src/api/` or `server/src/sync/` by hand, fails the first case.
 *
 * Run: node --test testing/standalone/every-space-directory-move-goes-through-move-tree.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const SRC_FLOOR = 300;
const FS_MODULE = /from\s+['"](?:node:)?fs(?:\/promises)?['"]/;
/** The names a file gives the file-system module: `import X from 'fs'`, `import * as X from 'fs'`, `import { promises as X } from 'fs'`. */
const FS_LOCAL_NAMES = /import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*['"](?:node:)?fs(?:\/promises)?['"]|\bpromises\s+as\s+(\w+)/g;
const NAMED_RENAME_IMPORT = /import\s*\{[^}]*\brename(?:Sync)?\b[^}]*\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/;

/** The one module that moves a directory tree, and so the one place a bare rename of one stands. */
const MOVE_TREE_MODULE = 'server/src/files/remove-tree.ts';
/**
 * Files whose renames are not a space's directory, and why. A file is listed, not a line: a rename written into one of them is covered by
 * its reason, so a reason has to say what the file's renames are, and the entry is read again when the file's use of rename changes.
 */
const EXEMPT_RENAMES = new Map([
  ['server/src/util/rename-over.ts', 'the atomic replace of a config, secrets or schema-library file from its own `.tmp` sibling, for `config/loader.ts`: one regular file in the config directory, never a tree and never under the data root; it retries what a holder causes itself, synchronously, because the config flush must not await between its generation check and its rename'],
  ['server/src/files/stored-bytes.ts', 'a stored FILE, one path and one inode under per-path locks: the finish of an atomic write (`<tmp>` onto its path), `moveStored`, and the steps of a no-clobber file move; a space\'s directory tree is `moveTree`\'s'],
]);

const read = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const lineOfIndex = (text, i) => text.slice(0, i).split('\n').length;

/** Every file-system rename in `file`: `[line, text]` pairs. */
function fsRenamesOf(file) {
  const text = read(file);
  if (!FS_MODULE.test(text)) return [];
  // The receiver is whatever name the file gave the module, so `import fsx from 'fs/promises'` is read as `fs` is: a collection's own `.rename(` has no such receiver.
  const names = new Set(['fs', 'fsp']);
  for (const m of text.matchAll(FS_LOCAL_NAMES)) names.add(m[1] ?? m[2]);
  const call = new RegExp(String.raw`\b(?:${[...names].join('|')})\s*\.\s*(?:promises\s*\.\s*)?rename(?:Sync)?\s*\(`, 'g');
  const found = [...text.matchAll(call)].map(m => [lineOfIndex(text, m.index), m[0]]);
  if (NAMED_RENAME_IMPORT.test(text)) found.push([0, 'imports rename from a file-system module']);
  return found;
}

describe('every file-system rename is moveTree or a named exemption', () => {
  const sources = trackedSources('server/src', { floor: SRC_FLOOR });

  it('no module under server/src renames a path through the file system outside moveTree and the named exemptions', () => {
    const found = [];
    for (const file of sources) {
      if (file === MOVE_TREE_MODULE || EXEMPT_RENAMES.has(file)) continue;
      for (const [line, what] of fsRenamesOf(file)) found.push(`${file}:${line} ${what}`);
    }
    assert.deepEqual(found, [], `a path is renamed by a bare rename, which does not retry what a holder causes; a space's directory goes through moveTree (files/remove-tree.ts), and a rename of one regular file needs an entry in EXEMPT_RENAMES with its reason: ${found.join('; ')}`);
  });

  it('the scan sees the renames it exempts and the one moveTree makes, and every exemption is live', () => {
    assert.ok(fsRenamesOf(MOVE_TREE_MODULE).length >= 1, 'the scan does not see moveTree\'s own rename: it would pass every file');
    for (const [file, why] of EXEMPT_RENAMES) {
      assert.ok(sources.includes(file), `the exemption for ${file} names a file that is not tracked under server/src`);
      assert.ok(fsRenamesOf(file).length >= 1, `the exemption for ${file} is stale: it no longer renames anything (${why})`);
    }
  });

  it('the rename moves both its directories through moveTree', () => {
    const text = read('server/src/spaces/rename.ts');
    assert.match(text, /import\s*\{[^}]*\bmoveTree\b[^}]*\}\s*from\s*['"]\.\.\/files\/remove-tree\.js['"]/, 'rename.ts does not import moveTree');
    const calls = [...text.matchAll(/\bmoveTree\s*\(/g)].length;
    assert.ok(calls >= 2, `rename.ts calls moveTree ${calls} time(s): the files directory and the chunk directory are both moved through it`);
  });

  it('moveTree and removeTree share one retry rule', () => {
    const text = read('server/src/files/remove-tree.ts');
    const codeSets = [...text.matchAll(/new Set\(\s*\[([^\]]*)\]/g)].map(m => m[1].replace(/\s+/g, ' ').trim());
    assert.equal(codeSets.length, 1, `the retried error codes are written ${codeSets.length} times in remove-tree.ts, not once`);
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']) assert.match(codeSets[0], new RegExp(code), `the retry rule does not name ${code}`);
    for (const name of ['TREE_RETRIES', 'TREE_RETRY_DELAY_MS']) {
      assert.ok(new RegExp(`export const ${name}\\b`).test(text), `remove-tree.ts does not export ${name}`);
      const uses = [...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
      assert.ok(uses >= 3, `${name} is used ${uses - 1} time(s) outside its declaration: removeTree and moveTree both read it`);
    }
  });
});
