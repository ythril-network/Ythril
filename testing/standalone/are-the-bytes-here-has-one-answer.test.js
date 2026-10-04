/**
 * "Are a path's bytes on disk" has one answer, `bytesPresent` in `files/stored-bytes.ts`: absent only when the store
 * says the path does not exist, and any other failure to look is thrown — never read as "absent" (bundle-30 I15,
 * preship-3 P3-6). An existence question about the RECORDS at a path asks for one record, not the list (P3-7).
 *
 * ## The defect
 *
 * One diff answered the bytes question twice. `move-cascade.ts`'s `exists` swallowed every error, so a source the
 * server could not stat (a permission, a path it may not read) read as "absent" and could send a move into its
 * completion path — the branch that overwrites the destination's derived records. `delete-cascade.ts`'s
 * `bytesPresent` read only ENOENT as absent. A third copy, `files.ts`'s `fileExists`, swallowed everything and had
 * no caller left. And both completions asked "is anything recorded here" by loading every record id under a folder.
 *
 * ## What is asserted
 *
 * - `bytesPresent` answers true for bytes, false for a path that does not exist, and THROWS for a failure to look.
 * - No source under `server/src` answers the question by a stat whose failure is swallowed into `false` — the
 *   swallow-all shape, read out of every tracked source rather than the two files where it was found (the pattern is
 *   shown to match that shape first, so a pattern that matches nothing cannot pass the gate).
 * - The completions' existence questions do not load the list of records.
 *
 * Run: node --test testing/standalone/are-the-bytes-here-has-one-answer.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

/**
 * Every spelling of "a stat whose failure, whatever it was, becomes the answer" (bundle-30 I16, preship-4 P4-5). The
 * question has more spellings than the one this gate first hunted, and the one it missed (`worker.ts`'s
 * `.then(() => true, () => false)`) acted on its `false` by removing what a job wrote:
 *
 * - a `try` that stats, whose `catch` returns `false`;
 * - a stat promise ending `.catch(() => false | null | undefined | true)` — `null` is the same answer when the caller
 *   reads it as "nothing there", and `true` is the same answer asked the other way round ("gone");
 * - a stat promise ending `.then(ok, fail)` with both arms constant — `() => true, () => false` and the inverted
 *   `() => false, () => true`.
 *
 * Not hunted: `existsSync`, which swallows every failure by its own definition; its callers read config and backup
 * paths, never a stored file's bytes, so they do not ask this question.
 */
const ARROW = String.raw`(?:\(\s*(?:\w+(?:\s*:\s*[\w.]+)?)?\s*\)|\w+)\s*=>\s*`;
const SWALLOWED_STAT_SPELLINGS = () => [
  /try\s*\{[^{}]*?\b(?:stat|lstat|statSync|lstatSync|access)\([^{}]*?\}\s*catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*return false;?\s*\}/g,
  new RegExp(String.raw`\b(?:stat|lstat|access)\([^;{}]*?\.catch\(\s*${ARROW}(?:false|null|undefined|true)\s*\)`, 'g'),
  new RegExp(String.raw`\b(?:stat|lstat|access)\([^;{}]*?\.then\(\s*${ARROW}(?:true|false)\s*,\s*${ARROW}(?:true|false|null|undefined)\s*\)`, 'g'),
];
/** Every match of every spelling in `code`, by index. */
const swallowedStats = (code) => SWALLOWED_STAT_SPELLINGS().flatMap(re => [...code.matchAll(re)].map(m => m.index));

/** The one place a failure may be read as "this path does not exist" by its code. */
const MISSING_BY_CODE = () => /(['"])(?:ENOENT|ENOTDIR)\1/g;

describe('are the bytes here: one answer', () => {
  let dir, storedBytes;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bytes-present-'));
    storedBytes = await import('../../server/dist/files/stored-bytes.js');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('bytesPresent: true for bytes, false for a path that does not exist, and a failure to look is thrown', async () => {
    assert.equal(typeof storedBytes.bytesPresent, 'function', 'files/stored-bytes.js exports no bytesPresent');
    fs.writeFileSync(path.join(dir, 'here.txt'), 'x');
    assert.equal(await storedBytes.bytesPresent(path.join(dir, 'here.txt')), true);
    assert.equal(await storedBytes.bytesPresent(path.join(dir, 'not-here.txt')), false);
    // A path the filesystem refuses to look at: not "absent", and a caller that is told "absent" acts on it.
    await assert.rejects(storedBytes.bytesPresent(path.join(dir, 'bad\0name')), 'a failure to look was answered as "absent"');
  });

  it('a path through a regular file names nothing: missing, on every OS, by either code the OS gives it', async () => {
    // Linux (the deployment) fails `a.txt/child` with ENOTDIR where Windows says ENOENT, so a run on one OS cannot see
    // the other's code (preship-4 P4-1). The classifier is asked about both codes, and bytesPresent about the condition.
    const errno = (code) => Object.assign(new Error(code), { code });
    assert.equal(storedBytes.isMissingPath(errno('ENOENT')), true, 'ENOENT is not read as a missing path');
    assert.equal(storedBytes.isMissingPath(errno('ENOTDIR')), true,
      'ENOTDIR (a path through a regular file, on Linux) is read as "cannot look" — a move answers 400 carrying the data path');
    for (const code of ['EACCES', 'EPERM', 'EISDIR', 'EBUSY', 'EIO']) {
      assert.equal(storedBytes.isMissingPath(errno(code)), false, `${code} is read as "the path does not exist"`);
    }
    assert.equal(storedBytes.isMissingPath(null), false);
    assert.equal(storedBytes.isMissingPath(new Error('no code')), false);
    fs.writeFileSync(path.join(dir, 'a-file.txt'), 'x');
    assert.equal(await storedBytes.bytesPresent(path.join(dir, 'a-file.txt', 'child')), false,
      'a path through a regular file is not reported absent');
  });

  it('no source answers it by swallowing a stat\'s failure, in any spelling', () => {
    // Each spelling the patterns hunt, matched once, and the one answer (which rethrows) matched by none.
    const spellings = [
      'async function exists(p) {\n  try {\n    await fs.stat(p);\n    return true;\n  } catch {\n    return false;\n  }\n}',
      'const here = await fs.stat(abs).catch(() => false);',
      'const st = await fsp.stat(abs).catch(() => null);',
      'const st = await fsp.lstat(abs).catch((_e) => undefined);',
      'if (!(await fs.stat(absolutePath).then(() => true, () => false))) return;',
      'const ok = await fs.access(p).then(() => true).catch(() => false);',
      'const gone = await resolve(s, id).then(p => fs.stat(p)).then(() => false, () => true);',
    ];
    for (const s of spellings) {
      assert.equal(swallowedStats(s).length, 1, `the patterns do not match this spelling once — fix them first:\n${s}`);
    }
    const oneAnswer = 'try { await fsp.lstat(abs); return true; } catch (err) { if (isMissingPath(err)) return false; throw err; }';
    assert.deepEqual(swallowedStats(oneAnswer), [], 'the patterns match the one answer, which rethrows');

    const hits = [];
    for (const f of trackedSources('server/src')) {
      const code = blankComments(readFileSync(path.join(REPO_ROOT, f), 'utf8'));
      for (const at of swallowedStats(code)) hits.push(`${f}:${code.slice(0, at).split('\n').length}`);
    }
    assert.deepEqual(hits, [],
      'these read ANY failure to stat a path as an answer about its bytes — use bytesPresent (files/stored-bytes.ts), '
      + 'which throws what is not a missing path, or isMissingPath where the stat itself is needed');
  });

  it('"this path does not exist" is read from a failure\'s code in one place, isMissingPath', () => {
    // A second ENOENT test is a second answer, and it is the one that forgets ENOTDIR (preship-4 P4-1).
    assert.equal(['x === \'ENOENT\'', 'y !== "ENOTDIR"'].filter(s => MISSING_BY_CODE().test(s)).length, 2,
      'the pattern does not match the comparison it hunts — fix it first');
    const owner = 'server/src/files/stored-bytes.ts';
    const hits = [];
    let ownerFound = 0;
    for (const f of trackedSources('server/src')) {
      // LF, so the window `bodyOf` returns is found in it on a CRLF checkout too.
      const code = blankComments(readFileSync(path.join(REPO_ROOT, f), 'utf8')).replace(/\r\n/g, '\n');
      // The owner's own definition is the one place allowed, by position — not "any line of the owner's file".
      const body = f === owner ? bodyOf(code, 'isMissingPath') : null;
      const from = body ? code.indexOf(body) : -1;
      for (const m of code.matchAll(MISSING_BY_CODE())) {
        if (from > -1 && m.index >= from && m.index < from + body.length) { ownerFound++; continue; }
        hits.push(`${f}:${code.slice(0, m.index).split('\n').length}`);
      }
    }
    assert.ok(ownerFound > 0, `${owner} isMissingPath names no code — the owner moved; re-anchor this gate`);
    assert.deepEqual(hits, [], 'these decide "the path does not exist" by a code of their own — use isMissingPath');
  });

  it('the completions ask whether anything is recorded at a path, not for the list of everything recorded', () => {
    const at = (f) => blankComments(readFileSync(path.join(REPO_ROOT, f), 'utf8'));
    for (const [f, fn] of [['server/src/files/delete-cascade.ts', 'isUnfinishedDirectoryDelete'],
      ['server/src/files/move-cascade.ts', 'moveFileCascade']]) {
      assert.doesNotMatch(bodyOf(at(f), fn), /\bfileRecordPaths\(/,
        `${f} ${fn} loads every record id under a path to answer yes or no — ask hasLiveFileRecordAt/Under`);
    }
  });
});
