/**
 * One chunk directory that cannot be cleaned does not stop the cleanup of the others (Q-274, Q-317, bundle-53 G20).
 *
 * ## The defect
 *
 * `cleanupStaleChunks` walks `<data>/.chunks/<space>/<upload>` inside ONE `try`, and its `catch {}` read every failure
 * as "the `.chunks` directory may not exist yet — that's fine". So the first space directory whose listing failed, or
 * the first upload whose `stat` or removal failed, ended the whole pass silently: every directory after it kept its stale
 * uploads, the hourly timer said nothing, and the next hour did the same. A comment claimed an isolation the code
 * did not have.
 *
 * ## What is asserted
 *
 *  - A space directory that cannot be listed is reported once, by name, and the space directories AFTER it are cleaned
 *    (the faulty one sorts first, because a walk that stops at the first failure leaves exactly those unswept).
 *  - An upload that cannot be examined is that upload's failure: the others of the SAME space are still cleaned.
 *  - A missing `.chunks` root is not a failure: nothing is said. Any other failure of the root is thrown to the caller
 *    (the boot call and the interval job both say it), never answered as "nothing to clean".
 *  - The staleness threshold is unchanged: an upload older than `maxAgeMs` goes, a younger one stays, and a file lying
 *    among the directories is left alone.
 *  - The step is declared, so its failure counters exist at 0 before the first failure.
 *  - The hourly timer is an `intervalJob` (and the only way `index.ts` schedules the cleanup), not a bare `setInterval`.
 *
 * `fs.readdir` / `fs.stat` are patched to inject EACCES: `isMissingPath` counts ENOTDIR as "not there", so "a file where a
 * directory should be" is correctly NOT an error, and a real permission failure cannot be made portably.
 *
 * Run: node --test testing/standalone/a-bad-chunk-directory-does-not-stop-the-cleanup.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logLinesDuring } from './_log-lines.mjs';
import { stripComments } from './_strip-comments.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-chunk-cleanup-'));
process.env['DATA_ROOT'] = tmpDir;

const HOUR = 60 * 60 * 1000;
const STEP = 'Stale chunk cleanup';

let chunks, signals;
before(async () => {
  chunks = await import('../../server/dist/files/chunks.js');
  signals = await import('../../server/dist/util/housekeeping-signals.js');
});
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** A fresh data root per case, so one case's directories are never another's. */
function freshRoot() {
  const root = path.join(tmpDir, randomUUID());
  process.env['DATA_ROOT'] = root;
  fs.mkdirSync(root, { recursive: true });
  return { root, chunksDir: path.join(root, '.chunks') };
}

/** A space id no other case uses: the reporter's throttle is process-wide and would swallow a repeated line. */
const uniq = (stem) => `${stem}-${randomUUID().slice(0, 8)}`;

/** `<chunksDir>/<space>/<upload>/0-1.bin`, its mtime `ageMs` ago. */
function seedUpload(chunksDir, space, upload, ageMs) {
  const dir = path.join(chunksDir, space, upload);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0-1.bin'), 'x');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

/** Run `fn` with `fsp[method]` failing with EACCES for the paths `shouldFail` names. */
async function withFailing(method, shouldFail, fn) {
  const real = fsp[method];
  fsp[method] = (target, ...rest) => {
    if (shouldFail(String(target))) {
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, ${method} '${target}'`), { code: 'EACCES' }));
    }
    return real.call(fsp, target, ...rest);
  };
  try { return await fn(); } finally { fsp[method] = real; }
}

describe('a bad chunk directory does not stop the cleanup of the others', () => {
  it('a space directory that cannot be listed is reported once, by name, and the spaces after it are cleaned', async () => {
    const { chunksDir } = freshRoot();
    const bad = uniq('a-unreadable');
    const good = uniq('b-healthy');
    seedUpload(chunksDir, bad, 'u1', 48 * HOUR);
    const goodUpload = seedUpload(chunksDir, good, 'u1', 48 * HOUR);

    const { lines, result: cleaned } = await logLinesDuring(() =>
      withFailing('readdir', (p) => p === path.join(chunksDir, bad), () => chunks.cleanupStaleChunks()));

    assert.equal(fs.existsSync(goodUpload), false, 'the healthy space AFTER the faulty one still had its stale upload cleaned');
    assert.equal(cleaned, 1, 'the count is what was actually removed');
    const said = lines.filter((l) => l.includes(STEP) && l.includes(bad));
    assert.equal(said.length, 1, `the faulty directory is reported exactly once: ${JSON.stringify(lines)}`);
    assert.match(said[0], /EACCES/, 'the line carries the reason');
    assert.ok(!lines.some((l) => l.includes(STEP) && l.includes(good)), 'the healthy space is not reported');
  });

  it('an upload that cannot be examined is that upload\'s failure: the others of the same space are cleaned', async () => {
    const { chunksDir } = freshRoot();
    const space = uniq('one-space');
    const badDir = seedUpload(chunksDir, space, 'a-bad-upload', 48 * HOUR);
    const goodDir = seedUpload(chunksDir, space, 'b-good-upload', 48 * HOUR);

    const { lines, result: cleaned } = await logLinesDuring(() =>
      withFailing('stat', (p) => p === badDir, () => chunks.cleanupStaleChunks()));

    assert.equal(fs.existsSync(goodDir), false, 'the next upload of the same space was cleaned');
    assert.equal(fs.existsSync(badDir), true, 'the one that could not be examined is left for the next run');
    assert.equal(cleaned, 1);
    const said = lines.filter((l) => l.includes(STEP) && l.includes(space));
    assert.equal(said.length, 1, `reported once: ${JSON.stringify(lines)}`);
    assert.ok(said[0].includes('a-bad-upload'), `the line names the upload: ${said[0]}`);
  });

  it('an upload that vanishes between the listing and the stat is not a failure', async () => {
    const { chunksDir } = freshRoot();
    const space = uniq('vanishing');
    const gone = seedUpload(chunksDir, space, 'a-gone', 48 * HOUR);
    const kept = seedUpload(chunksDir, space, 'b-stale', 48 * HOUR);
    const real = fsp.stat;
    fsp.stat = (target, ...rest) => {
      if (String(target) === gone) return Promise.reject(Object.assign(new Error(`ENOENT: no such file, stat '${target}'`), { code: 'ENOENT' }));
      return real.call(fsp, target, ...rest);
    };
    let lines, cleaned;
    try { ({ lines, result: cleaned } = await logLinesDuring(() => chunks.cleanupStaleChunks())); } finally { fsp.stat = real; }

    assert.equal(fs.existsSync(kept), false, 'the other stale upload was cleaned');
    assert.equal(cleaned, 1);
    assert.ok(!lines.some((l) => l.includes(STEP)), `a directory that is already gone is silent: ${JSON.stringify(lines)}`);
  });
});

describe('what is NOT a failure, and what still is', () => {
  it('a missing .chunks root says nothing and cleans nothing', async () => {
    freshRoot();   // no `.chunks` inside
    const { lines, result } = await logLinesDuring(() => chunks.cleanupStaleChunks());
    assert.equal(result, 0);
    assert.deepEqual(lines.filter((l) => l.includes(STEP) || /chunk/i.test(l)), [], 'nothing was said');
  });

  it('a root that cannot be listed for any other reason is thrown to the caller, not read as "nothing to clean"', async () => {
    const { chunksDir } = freshRoot();
    fs.mkdirSync(chunksDir, { recursive: true });
    await assert.rejects(
      withFailing('readdir', (p) => p === chunksDir, () => chunks.cleanupStaleChunks()),
      /EACCES/,
    );
  });

  it('the stale threshold is unchanged: older than maxAgeMs goes, younger stays, and a stray file is left alone', async () => {
    const { chunksDir } = freshRoot();
    const space = uniq('threshold');
    const old = seedUpload(chunksDir, space, 'old', 25 * HOUR);
    const young = seedUpload(chunksDir, space, 'young', 23 * HOUR);
    const stray = path.join(chunksDir, 'stray.txt');
    fs.writeFileSync(stray, 'not a space directory');

    const { lines, result } = await logLinesDuring(() => chunks.cleanupStaleChunks());   // default: 24 h

    assert.equal(result, 1);
    assert.equal(fs.existsSync(old), false, 'a 25 h upload is stale by the default');
    assert.equal(fs.existsSync(young), true, 'a 23 h upload is not');
    assert.equal(fs.existsSync(stray), true, 'a file among the space directories is not touched');
    assert.ok(!lines.some((l) => l.includes(STEP)), 'none of that is a failure');

    const second = await chunks.cleanupStaleChunks(HOUR);   // a shorter age: the 23 h one is stale now
    assert.equal(second, 1);
    assert.equal(fs.existsSync(young), false);
    assert.equal(fs.existsSync(path.join(chunksDir, space)), false, 'an emptied space directory is removed');
  });

  it('the step is declared, so its failure counters start at 0', () => {
    assert.ok(signals.declaredSteps().includes(STEP), `declared steps: ${JSON.stringify(signals.declaredSteps())}`);
  });
});

describe('the cleanup is walked, and its hourly timer is an interval job', () => {
  const read = (rel) => stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));

  it('cleanupStaleChunks walks through eachSpace and carries no catch that reads every failure as "not there yet"', () => {
    const src = read('server/src/files/chunks.ts');
    const start = src.indexOf('export async function cleanupStaleChunks');
    assert.ok(start > 0, 'the function is found');
    const body = src.slice(start);
    assert.match(body, /eachSpace\(/, 'each space directory is a walked subject');
    assert.ok(!/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(body), 'no empty catch in the cleanup');
    assert.ok(!/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(body), 'no swallow-everything .catch in the cleanup');
    assert.match(body, /isMissingPath\(/, '"not there" is decided by the one predicate for it');
  });

  it('index.ts schedules the stale-chunk cleanup through intervalJob, hourly, and has no bare setInterval', () => {
    const src = read('server/src/index.ts');
    assert.ok(!/\bsetInterval\s*\(/.test(src), 'no bare setInterval in index.ts');
    assert.match(src, /intervalJob\(\s*['"`]Stale chunk cleanup['"`]\s*,\s*60\s*\*\s*60\s*\*\s*1000\s*,/, 'the hourly job is named and scheduled');
    assert.match(src, /cleanupStaleChunks\(\)/, 'and it runs the cleanup');
  });
});
