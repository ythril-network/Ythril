/**
 * `0600` on a directory is not a tightening, it is a brick — and it killed the server.
 *
 * ## What happened
 *
 * Hardening the files tree added a `chmod` after every write, so that files predating the change heal on their next
 * write instead of needing a boot-time walk. `moveFile` got the same treatment — and `moveFile` moves **directories**
 * as well as files, so a moved directory was chmodded to `FILE_MODE`. A directory without its execute bit cannot be
 * opened at all.
 *
 * Nothing failed at the move. It failed later, in the next offsite backup, as:
 *
 *     terminate called after throwing an instance of 'std::filesystem::__cxx11::filesystem_error'
 *       what():  filesystem error: directory iterator cannot open directory: Permission denied
 *                [/data/files/general/meta-dir-mv-dst-.../nested]
 *
 * `fs.cpSync` walks the tree in C++. That error comes out of `std::filesystem`, not JavaScript, so it reached
 * `terminate()` and took the **whole process** down — container exit 139, 94 tests failed and 169 were cancelled
 * because every later request got `fetch failed`. One unreadable directory under the files root was enough.
 *
 * ## Why this test asserts the CHOICE and not the effect
 *
 * `chmod` is a no-op on Windows, which is where this is developed. A test that chmodded a directory and then tried
 * to read it would pass locally no matter what the code did — so `hardenPath` returns the mode it applied, and this
 * pins that. The observable effect is checked where it exists: `files.test.js` moves a real directory inside the
 * Linux container and lists it afterwards.
 *
 * Run: node --test testing/standalone/harden-path-picks-the-right-mode.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('../../server/dist/util/fs-modes.js');

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'ythril-modes-')); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('hardenPath picks a mode by what the path IS', () => {
  it('a file gets FILE_MODE', async () => {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'x');
    assert.equal(await mod.hardenPath(f), mod.FILE_MODE);
  });

  it('a directory gets DIR_MODE — it needs its execute bit to be openable at all', async () => {
    const d = join(dir, 'sub');
    mkdirSync(d);
    const applied = await mod.hardenPath(d);
    assert.equal(applied, mod.DIR_MODE);
    assert.notEqual(applied, mod.FILE_MODE,
      'a directory chmodded to 0600 cannot be opened; fs.cpSync then dies in C++ and takes the process with it');
  });

  it('a path that is already gone reports 0 rather than throwing', async () => {
    // `moveFile` can race a delete. A throw here would surface as a failed move of a file that did move.
    assert.equal(await mod.hardenPath(join(dir, 'never-existed')), 0);
  });

  it('DIR_MODE actually carries the owner execute bit', () => {
    // The bug in one line. 0o700 & 0o100 is the bit that makes a directory traversable; 0o600 does not have it.
    assert.ok((mod.DIR_MODE & 0o100) !== 0, 'DIR_MODE must include owner-execute or directories become unopenable');
    assert.equal(mod.FILE_MODE & 0o100, 0, 'FILE_MODE should not mark data files executable');
  });
});

describe('no caller applies a file mode to something that may be a directory', () => {
  it('the placing a move goes through hardens by path kind, not by assumption', () => {
    // Pinned at the call site as well as in the helper: the helper being correct does not help if a caller
    // reintroduces `harden(dst, FILE_MODE)`, which is exactly the line that caused the outage. The step is `placeIfFree`
    // (`moveFile` and a conflict resolution's placement both go through it, Q-466), so it is the step that is read, and
    // `moveFile` is held to calling it.
    const src = readFileSync('server/src/files/files.ts', 'utf8');
    const move = src.indexOf('export async function moveFile(');
    assert.ok(move > 0, 'moveFile is gone — re-anchor this gate');
    assert.match(src.slice(move, src.indexOf('\n}', move)), /placeIfFree\(/, 'moveFile no longer places its bytes through placeIfFree, the step that hardens'
      + ' what it placed: a directory move would no longer be hardened by path kind');
    const at = src.indexOf('export async function placeIfFree(');
    assert.ok(at > 0, 'placeIfFree is gone — re-anchor this gate');
    // Comments stripped before matching. The first version of this assertion failed against the fixed code,
    // because the comment explaining the bug quotes the very call it warns against — a gate that reads prose as
    // code is a gate that fires on its own documentation.
    const body = src.slice(at, src.indexOf('\n}', at))
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(body, /hardenPath\(/, 'placeIfFree must use hardenPath — a move places directories as well as files');
    assert.doesNotMatch(body, /harden\([^)]*FILE_MODE/,
      'placeIfFree must not force FILE_MODE: its destination can be a directory, and 0600 on a directory is a brick');
  });
});
