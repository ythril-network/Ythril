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
 * ## What is hunted below (Q-350 a, bundle-70 S1)
 *
 * `existsSync` swallows every failure by its own definition, and "its callers read config and backup paths, never a stored file's
 * bytes" was the reason it was not hunted. That was a reason about WHICH file, and the defect does not care: a backup that skips
 * the users' files, a restore that condemns a whole backup as "holds no file", a config that opens first-run setup, were all the
 * same answer, "unreadable" read as "not there", given to a caller that could not tell. So the other half of the rule is gated
 * here too: no source under `server/src` asks `existsSync` / `accessSync` / `fs.exists` (use `pathPresentSync`, `util/path-present.ts`,
 * which throws what is not a missing path), and none walks a directory with a `readdir` whose failure it swallows (a partial list
 * read as the whole). A caller that really means "absent or unreadable are the same to me" is in the exemption table below WITH
 * the reason, and a row whose file no longer holds the shape fails the gate as stale, so the table cannot outlive its cause.
 */
const ARROW = String.raw`(?:\(\s*(?:\w+(?:\s*:\s*[\w.]+)?)?\s*\)|\w+)\s*=>\s*`;
const SWALLOWED_STAT_SPELLINGS = () => [
  /try\s*\{[^{}]*?\b(?:stat|lstat|statSync|lstatSync|access)\([^{}]*?\}\s*catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*return false;?\s*\}/g,
  new RegExp(String.raw`\b(?:stat|lstat|access)\([^;{}]*?\.catch\(\s*${ARROW}(?:false|null|undefined|true)\s*\)`, 'g'),
  new RegExp(String.raw`\b(?:stat|lstat|access)\([^;{}]*?\.then\(\s*${ARROW}(?:true|false)\s*,\s*${ARROW}(?:true|false|null|undefined)\s*\)`, 'g'),
];
/** Every match of every spelling in `code`, by index. */
const swallowedStats = (code) => SWALLOWED_STAT_SPELLINGS().flatMap(re => [...code.matchAll(re)].map(m => m.index));

/**
 * Every spelling of a synchronous "is it there" whose only answers are yes and no: the call, a named import
 * (`import { existsSync } from 'node:fs'`), a renamed one (`existsSync as exists`), `accessSync`, and the callback `fs.exists`.
 */
const EXISTENCE_CHECK_SPELLINGS = () => [/\bexistsSync\b/g, /\baccessSync\b/g, /\bfs\.exists\b/g];

/**
 * Every spelling of a directory read whose failure is swallowed, so a partial or empty list stands for the directory:
 * a `try` holding a `readdir` / `readdirSync` / `opendir` whose `catch` is empty, comment-only, or only `return …;` /
 * `continue` / `break`; and a read ending `.catch(() => [])` (or null / undefined / 0). The `try` body may hold one level of
 * braces (the options object of `readdir(dir, { withFileTypes: true })`).
 */
const SWALLOWING_CATCH = String.raw`catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*(?:return\b[^;}]*;?|continue\s*;?|break\s*;?)?\s*\}`;
const TRY_BODY = String.raw`(?:[^{}]|\{[^{}]*\})*?`;
const SWALLOWED_READDIR_SPELLINGS = () => [
  new RegExp(String.raw`try\s*\{${TRY_BODY}\b(?:readdir|readdirSync|opendir|opendirSync)\(${TRY_BODY}\}\s*${SWALLOWING_CATCH}`, 'g'),
  new RegExp(String.raw`\b(?:readdir|readdirSync|opendir)\([^;]*?\.catch\(\s*${ARROW}(?:\[\]|null|undefined|0)\s*\)`, 'g'),
];

/**
 * Callers that mean "absent and unreadable are the same to me", by file, with the reason. A row is STALE (and fails) when its file
 * no longer holds the shape: the table lists what is left to justify, and never a place the defect used to be.
 */
const EXISTENCE_CHECK_EXEMPT = {
  'server/src/local-agent-connector/index.ts': 'a separate process\'s own files (its token, tunnel pid and cloudflared credentials in its own home): absent and unreadable both mean "set it up again", and it reads no instance state',
  'server/src/brain/local-pipeline.ts': 'the local model cache: absent and unreadable both mean "download the model", and a download that cannot write fails loudly',
  'server/src/util/entry-path.ts': 'chooses which of this install\'s two entry files to spawn: a refused look falls to the next candidate and the spawn itself fails loudly',
};
const SWALLOWED_READDIR_EXEMPT = {
  'server/src/files/stored-bytes.ts': 'sweepStoredTmp: a best-effort boot sweep of orphaned temp files; an unreadable temp directory leaves them for the next boot and no reader depends on the list',
};

/**
 * The hits of `spellings` over `sources` (`{ file, code }`, comments already blanked), minus the exempt files; and the exempt files
 * that hold no hit (stale). Takes the sources as data so a planted copy of the defect is proven through the same function.
 */
function gateOver(sources, spellings, exempt) {
  const hits = [];
  const hitFiles = new Set();
  for (const { file, code } of sources) {
    for (const re of spellings()) {
      for (const m of code.matchAll(re)) {
        hitFiles.add(file);
        if (!(file in exempt)) hits.push(`${file}:${code.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  const stale = Object.keys(exempt).filter(f => !hitFiles.has(f));
  return { hits, stale };
}
const tracked = () => trackedSources('server/src').map(f => ({ file: f, code: blankComments(readFileSync(path.join(REPO_ROOT, f), 'utf8')) }));

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
    const owner = 'server/src/util/path-present.ts';
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

  describe('an unreadable path is not read as absent by a synchronous check or a swallowed readdir (Q-350 a)', () => {
    it('the existence-check patterns match every spelling, and the one answer matches none', () => {
      const spellings = [
        'if (!fs.existsSync(p)) return null;',
        'import { existsSync } from \'node:fs\';',
        'import { existsSync as exists } from \'fs\';',
        'if (fsSync.existsSync(path.join(dir, \'manifest.json\'))) {}',
        'try { fs.accessSync(p); return true; } catch { return false; }',
        'fs.exists(p, cb);',
      ];
      for (const s of spellings) {
        const n = EXISTENCE_CHECK_SPELLINGS().flatMap(re => [...s.matchAll(re)]).length;
        assert.ok(n >= 1, `the patterns do not match this spelling — fix them first:\n${s}`);
      }
      for (const answer of ['if (pathPresentSync(p)) return 1;', 'const gone = isMissingPath(err);', 'await bytesPresent(abs);']) {
        assert.deepEqual(EXISTENCE_CHECK_SPELLINGS().flatMap(re => [...answer.matchAll(re)]), [], `the patterns match the one answer: ${answer}`);
      }
    });

    it('the swallowed-readdir patterns match every spelling, and a readdir that rethrows or reports matches none', () => {
      const spellings = [
        'let names;\n  try {\n    names = await fs.readdir(dir);\n  } catch {\n    return;\n  }',
        'let entries;\n    try {\n      entries = await fs.readdir(dir, { withFileTypes: true });\n    } catch {\n      return;\n    }',
        'try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }',
        'try { names = fs.readdirSync(dir); } catch (err) { continue; }',
        'try { names = fs.readdirSync(dir); } catch { }',
        'const names = await fs.readdir(dir).catch(() => []);',
        'const names = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);',
      ];
      for (const s of spellings) {
        const n = SWALLOWED_READDIR_SPELLINGS().flatMap(re => [...s.matchAll(re)]).length;
        assert.ok(n >= 1, `the patterns do not match this spelling — fix them first:\n${s}`);
      }
      const answers = [
        'try { names = await fs.readdir(dir); } catch (err) { if (isMissingPath(err)) return; throw err; }',
        'try { names = await fs.readdir(dir); } catch (err) { unreadable.push(dir); return; }',
        'const names = await fs.readdir(dir);',
        'try { await fs.writeFile(p, x); } catch { return; }',
      ];
      for (const answer of answers) {
        assert.deepEqual(SWALLOWED_READDIR_SPELLINGS().flatMap(re => [...answer.matchAll(re)]), [], `the patterns match an answer that is not the defect: ${answer}`);
      }
    });

    it('the gate finds a planted copy of each defect, honours an exemption, and fails a stale one', () => {
      const planted = [
        { file: 'server/src/x/planted-exists.ts', code: 'export const here = (p: string) => fs.existsSync(p);\n' },
        { file: 'server/src/x/planted-readdir.ts', code: 'async function walk(d: string) {\n  let e;\n  try { e = await fs.readdir(d, { withFileTypes: true }); } catch { return; }\n}\n' },
        { file: 'server/src/x/exempt.ts', code: 'const a = fs.existsSync(p);\n' },
        { file: 'server/src/x/clean.ts', code: 'const a = pathPresentSync(p);\n' },
      ];
      const exists = gateOver(planted, EXISTENCE_CHECK_SPELLINGS, { 'server/src/x/exempt.ts': 'a reason', 'server/src/x/gone.ts': 'a reason' });
      assert.deepEqual(exists.hits, ['server/src/x/planted-exists.ts:1'], 'the planted existsSync was not found, or the exemption was not honoured');
      assert.deepEqual(exists.stale, ['server/src/x/gone.ts'], 'an exemption row whose file holds no such check was not reported stale');
      const dirs = gateOver(planted, SWALLOWED_READDIR_SPELLINGS, {});
      assert.deepEqual(dirs.hits, ['server/src/x/planted-readdir.ts:3'], 'the planted swallowed readdir was not found');
    });

    it('every exemption row names a reason and a tracked file', () => {
      const trackedFiles = new Set(trackedSources('server/src'));
      for (const table of [EXISTENCE_CHECK_EXEMPT, SWALLOWED_READDIR_EXEMPT]) {
        for (const [file, reason] of Object.entries(table)) {
          assert.ok(trackedFiles.has(file), `${file} is exempted and is not a tracked source`);
          assert.ok(reason.length > 40, `${file} is exempted without a reason`);
        }
      }
    });

    it('no source under server/src asks existsSync / accessSync / fs.exists, outside the exemption table', () => {
      const { hits, stale } = gateOver(tracked(), EXISTENCE_CHECK_SPELLINGS, EXISTENCE_CHECK_EXEMPT);
      assert.deepEqual(stale, [], 'these exempted files no longer ask an existence check: delete their rows');
      assert.deepEqual(hits,  [],
        'these answer "is it here" with a call that reads ANY failure (a permission refusal, a path on the way that cannot be searched) as "no" — '
        + 'use pathPresentSync (util/path-present.ts), which throws what is not a missing path; or add the file to EXISTENCE_CHECK_EXEMPT with the reason');
    });

    it('no source under server/src walks a directory with a readdir whose failure it swallows, outside the exemption table', () => {
      const { hits, stale } = gateOver(tracked(), SWALLOWED_READDIR_SPELLINGS, SWALLOWED_READDIR_EXEMPT);
      assert.deepEqual(stale, [], 'these exempted files no longer swallow a readdir: delete their rows');
      assert.deepEqual(hits, [],
        'these read a directory whose failure they swallow, so an unreadable subtree is a shorter list (a delete or a move acts on part of a tree) — '
        + 'rethrow what is not a missing directory, or report the subtree and go on; or add the file to SWALLOWED_READDIR_EXEMPT with the reason');
    });
  });
});
