/**
 * A job killed while it holds a decrypted copy of an at-rest-encrypted file leaves nothing a next boot does not sweep (bundle-89,
 * Q-425 part 2, plan E5 items 1-2).
 *
 * ## The defect
 *
 * ffmpeg needs a file it can seek in (an mp4 with its index at the end is not readable from a pipe), so an encrypted audio or
 * video file has to be DECRYPTED to disk for the length of its job. Today that copy is `os.tmpdir()/ythril-audio-*` and
 * `ythril-video-*`, which nothing sweeps (`sweepStoredTmp` reads only `<DATA_ROOT>/.stored-tmp/*.tmp`, and not below it). Shutdown
 * calls `process.exit(0)` without awaiting media jobs, and an out-of-memory kill, the ticket's own trigger, runs nothing at
 * all: a full plaintext copy of a file the operator keeps encrypted at rest stays on the disk, under a name no boot looks at.
 *
 * ## The rule
 *
 * **After a process dies in the middle of a job, running the boot sweep (`sweepStoredTmp`) leaves no file anywhere the job could
 * have written that holds the file's plaintext.** It is stated over the OUTCOME and not over a path or a function: the copy may
 * live in a sub-directory of the stored-tmp directory (the sweep then has to reach it) or in a name the sweep matches; what
 * must not happen is a plaintext copy the sweep does not remove. Two things are asserted first so that the rule cannot pass
 * because nothing was ever there:
 *
 *  - **a control**: before the sweep, a decrypted copy EXISTS (the child was killed at the moment `ffmpeg` was reading it), so the
 *    scan is looking at the right disk;
 *  - **where it lives**: under `storedTmpDir()`, the one directory the boot sweeps, and not in `os.tmpdir()`.
 *
 * ## Modes
 *
 * The scratch file is 0600 in a 0700 directory (the repo's one definition: `util/fs-modes.ts`). `chmod` is a no-op on Windows
 * (`pitfall-file-modes-are-a-no-op-on-windows`), so the effect is asserted only where it can be observed, on a POSIX host: CI and
 * the container. On Windows these two assertions are skipped and SAY so, rather than passing.
 *
 * ## How the child is killed
 *
 * `SIGKILL`, with no handler, as the kernel's out-of-memory killer does. The child holds its `ffmpeg` call open (a stub that never
 * answers), says so, and is killed while the copy is on disk.
 *
 * Run: node --test testing/standalone/a-decrypted-media-scratch-copy-does-not-outlive-a-kill-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason, openFixtureMongo } from './_mongo-harness.mjs';
import { startMediaJobChild } from './_media-job-child-run.mjs';
import { MARKER } from './_media-job-door.mjs';

const skip = await mongoSkipReason();
const POSIX = process.platform !== 'win32';

/** Every regular file under `dir` (recursively) whose bytes contain `needle`. A directory that is not there holds none. */
function filesHolding(dir, needle) {
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { if (fs.readFileSync(p).includes(needle)) found.push(p); } catch { /* unreadable: it cannot be a copy we can show */ }
      }
    }
  };
  walk(dir);
  return found;
}

describe('a job killed mid-copy leaves no plaintext the boot sweep does not remove (real worker, real Mongo, a killed child)', { skip }, () => {
  const children = [];
  after(async () => {
    for (const c of children) c.cleanup();
    // The killed child could not drop its own harness database.
    const fixture = await openFixtureMongo('b89e5kill');
    try { await fixture.getDb().dropDatabase(); } finally { await fixture.close(); }
  });

  it('a decrypted copy exists while the job runs, lives under the swept directory, and is gone after the boot sweep', async () => {
    const child = startMediaJobChild({ scenario: 'wedge', suite: 'b89e5kill', secret: true });
    children.push(child);
    const ready = await child.waitForMessage('ready');
    await child.waitForMessage('wedged');
    await child.kill();

    // The data root belongs to the child. This process asks the SAME question the next boot asks of it.
    process.env['DATA_ROOT'] = path.join(ready.dataRoot);
    const stored = await import('../../server/dist/files/stored-bytes.js');
    const swept = stored.storedTmpDir();
    const needle = Buffer.from(MARKER);
    const roots = [child.tmp, ready.dataRoot];   // the child's own temp directory (where the unchanged code puts it), and its data root
    const holders = () => [...new Set(roots.flatMap(r => filesHolding(r, needle)))]
      // The stored FILE under files/ is ciphertext and holds no marker; anything found is a copy.
      .filter(p => !p.startsWith(path.join(ready.dataRoot, 'files') + path.sep));

    const before = holders();
    assert.ok(before.length > 0,
      'fixture: no decrypted copy was on disk when the child was killed, so the scan proves nothing (is the file encrypted, and was ffmpeg reading it?)');
    const underSwept = (p) => { const rel = path.relative(swept, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };
    const misplaced = before.filter(p => !underSwept(p));
    if (POSIX) {
      for (const p of before.filter(underSwept)) {
        assert.equal(fs.statSync(p).mode & 0o777, 0o600, `${p}: a decrypted copy is owner-read/write only`);
        for (let d = path.dirname(p); d !== path.dirname(swept) && d.startsWith(swept); d = path.dirname(d)) {
          assert.equal(fs.statSync(d).mode & 0o777, 0o700, `${d}: a directory holding a decrypted copy is owner-only`);
        }
      }
    }

    await stored.sweepStoredTmp();

    assert.deepEqual(holders(), [],
      'a plaintext copy of the encrypted file survived the boot sweep: a killed job leaves a decrypted file nobody removes');
    assert.deepEqual(misplaced, [],
      `a decrypted copy of an encrypted file was written outside ${swept}, the one directory the boot sweeps`);
  });

  it('the modes of the scratch copy are asserted only where a mode can be observed', { skip: POSIX ? false : 'chmod is a no-op on Windows: run this file in the container (pitfall-file-modes-are-a-no-op-on-windows)' }, () => {
    // The assertions live in the case above, behind `POSIX`; this row exists so a Windows run REPORTS that they were not made.
    assert.ok(POSIX);
  });
});
