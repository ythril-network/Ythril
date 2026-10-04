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

/** A `try` whose body stats the filesystem and whose `catch` answers `false` whatever was thrown. */
const SWALLOWED_STAT = () =>
  /try\s*\{[^{}]*?\b(?:stat|lstat|statSync|lstatSync|access)\([^{}]*?\}\s*catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*return false;?\s*\}/g;

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

  it('no source answers it by swallowing a stat\'s failure into false', () => {
    const shape = 'async function exists(p) {\n  try {\n    await fs.stat(p);\n    return true;\n  } catch {\n    return false;\n  }\n}';
    assert.equal([...shape.matchAll(SWALLOWED_STAT())].length, 1, 'the pattern does not match the shape it hunts — fix the pattern first');
    const hits = [];
    for (const f of trackedSources('server/src')) {
      const code = blankComments(readFileSync(path.join(REPO_ROOT, f), 'utf8'));
      for (const m of code.matchAll(SWALLOWED_STAT())) hits.push(`${f}:${code.slice(0, m.index).split('\n').length}`);
    }
    assert.deepEqual(hits, [],
      'these read ANY failure to stat a path as "the bytes are not there" — use bytesPresent (files/stored-bytes.ts), '
      + 'which throws what is not a missing path');
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
