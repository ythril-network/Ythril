/**
 * Every move of a space's directory goes through `moveTree` (`files/remove-tree.ts`), never a bare `fs.rename` (Q-171).
 *
 * ## What it prevents
 *
 * `removeTree` retries what a concurrent holder causes (`EPERM`, `EBUSY`, `EACCES`, `EMFILE`, `ENFILE`), and a rename that
 * did not: on Windows any open handle under a directory makes `fs.rename` of it answer `EPERM` at once, so a space rename failed
 * on a file a download or an indexer still held, and the `.chunks` move sat in a bare `catch {}` and left the chunks behind
 * under the old id while the rename answered success. One retry rule, in one module, is what keeps the two directions alike.
 *
 * ## What it holds
 *
 *  - no module under `server/src/spaces/` renames a path through the file system (`fs.rename`, `fsp.rename`, `renameSync`, or
 *    a named import of `rename` from a file-system module). The set is derived from the tracked sources, with a floor. A
 *    collection's `.rename(` is not a file-system rename and is not matched: the receiver has to be a file-system module's name;
 *  - the floor on the other side: `spaces/rename.ts` calls `moveTree` for both of its directories (files and chunks), so the
 *    gate cannot pass by the moves having been deleted;
 *  - `moveTree` and `removeTree` share one retry rule, read from the module: one set of retried codes and one pair of constants.
 *
 * ## Seen red
 *
 * At the base (a71370b0d) `rename.ts` holds two bare `fs.rename` calls and no `moveTree`. A bare `fs.rename` put back in
 * `rename.ts` by hand fails the first case.
 *
 * Run: node --test testing/standalone/every-space-directory-move-goes-through-move-tree.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const SPACES_FLOOR = 30;
const FS_MODULE = /from\s+['"](?:node:)?fs(?:\/promises)?['"]/;
/** The names a file gives the file-system module: `import X from 'fs'`, `import * as X from 'fs'`, `import { promises as X } from 'fs'`. */
const FS_LOCAL_NAMES = /import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*['"](?:node:)?fs(?:\/promises)?['"]|\bpromises\s+as\s+(\w+)/g;
const NAMED_RENAME_IMPORT = /import\s*\{[^}]*\brename(?:Sync)?\b[^}]*\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/;

const read = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const lineOfIndex = (text, i) => text.slice(0, i).split('\n').length;

describe('every space directory move goes through moveTree', () => {
  const spaces = trackedSources('server/src/spaces', { floor: SPACES_FLOOR });

  it('no module under server/src/spaces renames a path through the file system', () => {
    const found = [];
    for (const file of spaces) {
      const text = read(file);
      if (!FS_MODULE.test(text)) continue;
      // The receiver is whatever name the file gave the module, so `import fsx from 'fs/promises'` is read as `fs` is: a collection's own `.rename(` has no such receiver.
      const names = new Set(['fs', 'fsp']);
      for (const m of text.matchAll(FS_LOCAL_NAMES)) names.add(m[1] ?? m[2]);
      const call = new RegExp(String.raw`\b(?:${[...names].join('|')})\s*\.\s*rename(?:Sync)?\s*\(`, 'g');
      for (const m of text.matchAll(call)) found.push(`${file}:${lineOfIndex(text, m.index)} ${m[0]}`);
      if (NAMED_RENAME_IMPORT.test(text)) found.push(`${file}: imports rename from a file-system module`);
    }
    assert.deepEqual(found, [], `a space directory is moved by a bare rename, which does not retry what a holder causes; use moveTree (files/remove-tree.ts): ${found.join('; ')}`);
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
