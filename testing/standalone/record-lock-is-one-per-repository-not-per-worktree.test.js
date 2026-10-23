/**
 * `scripts/_shared/record-lock.mjs`: the lock a recorder holds around find-plus-write lives in the git COMMON dir, so two
 * worktrees of one repository share it (Q-590, design rev 2 item 2, vet V6).
 *
 * ## What this prevents
 *
 * The lock was `test-results/.record.lock` relative to the working directory. `test-results/` is per checkout, so two worktrees of
 * one repository (this project's normal way of working) each held a lock the other never saw, and "one writer per machine" held
 * only inside one checkout: two recorders found the same key empty and inserted it twice. The common dir (`git rev-parse
 * --git-common-dir`) is the one place every worktree of a repository shares. The test holds the PATH, not a race: a race that
 * passes by luck proves nothing, and the path is the whole of the decision.
 *
 * ## The contract this file pins
 *
 * `recordLockPath(cwd = process.cwd())` returns an absolute path in the git common dir of the repository `cwd` is in, the same
 * from every worktree of it. `withRecordLock(fn, { cwd, waitMs })` is the lock itself: it resolves `null` when the lock stays held
 * past the wait (default `YTHRIL_TEST_RUNS_LOCK_WAIT_MS`, a positive whole number or a refusal naming it), releases only a lock
 * that still names this process, and leaves no signal or exit handler on the process once the function has finished.
 *
 * Run: node --test testing/standalone/record-lock-is-one-per-repository-not-per-worktree.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';

const MODULE = '../../scripts/_shared/record-lock.mjs';
let mod = null;
let loadError = null;
try { mod = await import(MODULE); } catch (error) { loadError = error; }
const lockPathOf = (cwd) => {
  assert.ok(mod, `scripts/_shared/record-lock.mjs cannot be imported: ${loadError?.message}`);
  assert.equal(typeof mod.recordLockPath, 'function', 'the module does not export recordLockPath');
  return mod.recordLockPath(cwd);
};

describe('the record lock is one per repository', () => {
  let main;
  let worktreeDir;
  before(() => {
    main = makeScratchRepo({ prefix: 'record-lock-' });
    writeFileSync(join(main.dir, 'a.txt'), 'one\n');
    main.git('add', '-A');
    main.git('commit', '-q', '-m', 'initial');
    worktreeDir = join(mkdtempSync(join(tmpdir(), 'record-lock-wt-')), 'side');
    main.git('worktree', 'add', '-q', '-b', 'side', worktreeDir);
  });
  after(() => {
    rmSync(dirname(worktreeDir), { recursive: true, force: true, maxRetries: 5 });
    main.cleanup();
  });

  it('two worktrees of one repository resolve the same lock path', () => {
    const fromMain = lockPathOf(main.dir);
    const fromWorktree = lockPathOf(worktreeDir);
    assert.ok(isAbsolute(fromMain), `${fromMain} is not absolute`);
    assert.equal(realpathSync(dirname(fromWorktree)), realpathSync(dirname(fromMain)), 'the worktree holds a lock of its own');
    assert.equal(fromWorktree.split(/[\\/]/).pop(), fromMain.split(/[\\/]/).pop());
  });

  it('and it is in the git common dir, not in the worktree\'s own git dir and not in test-results', () => {
    const common = realpathSync(join(main.dir, '.git'));
    for (const cwd of [main.dir, worktreeDir]) {
      const path = lockPathOf(cwd);
      assert.equal(realpathSync(dirname(path)), common, `${path} is not directly in ${common}`);
      assert.doesNotMatch(path, /test-results/);
    }
  });

  it('a call with no argument asks about the working directory this process runs in', () => {
    assert.equal(lockPathOf(), lockPathOf(process.cwd()));
    assert.equal(resolve(lockPathOf()), lockPathOf(), 'the path is absolute and normalised');
  });

  const lockOf = () => {
    assert.equal(typeof mod?.withRecordLock, 'function', 'the module does not export withRecordLock');
    return { withLock: mod.withRecordLock, file: lockPathOf(main.dir) };
  };
  const listeners = () => ['SIGINT', 'SIGTERM', 'exit'].map(e => process.listenerCount(e));

  it('is taken for the length of the function and released after it, with no signal or exit handler left on the process', async () => {
    const { withLock, file } = lockOf();
    const before = listeners();
    const answer = await withLock(async () => { assert.ok(existsSync(file), 'held while the function runs'); return 42; }, { cwd: main.dir });
    assert.equal(answer, 42);
    assert.ok(!existsSync(file), 'released');
    assert.deepEqual(listeners(), before, 'a handler of the finished call stays on the process: it would unlink a lock this call no longer owns, and exit the process on a signal');
  });

  it('releases only a lock that still names this process: another recorder\'s lock is not deleted', async () => {
    const { withLock, file } = lockOf();
    await withLock(async () => { writeFileSync(file, JSON.stringify({ pid: process.pid + 1 })); }, { cwd: main.dir });
    try {
      assert.ok(existsSync(file), 'the lock another recorder took was deleted by this call\'s release');
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid + 1);
    } finally { rmSync(file, { force: true }); }
  });

  it('a lock held by a live process past the wait resolves null, without running the function, and leaves that lock alone', async () => {
    const { withLock, file } = lockOf();
    writeFileSync(file, JSON.stringify({ pid: process.pid }));
    try {
      let ran = false;
      const answer = await withLock(async () => { ran = true; return 1; }, { cwd: main.dir, waitMs: 200 });
      assert.equal(answer, null);
      assert.equal(ran, false);
      assert.ok(existsSync(file), 'the holder\'s lock is not this call\'s to remove');
    } finally { rmSync(file, { force: true }); }
  });

  it('the wait is YTHRIL_TEST_RUNS_LOCK_WAIT_MS when the call gives none, and a value that is no positive whole number is refused naming it', async () => {
    const { withLock, file } = lockOf();
    const saved = process.env.YTHRIL_TEST_RUNS_LOCK_WAIT_MS;
    writeFileSync(file, JSON.stringify({ pid: process.pid }));
    try {
      process.env.YTHRIL_TEST_RUNS_LOCK_WAIT_MS = '200';
      assert.equal(await withLock(async () => 1, { cwd: main.dir }), null, 'held past the 200 ms the variable names');
      for (const bad of ['soon', '0', '-5', '1.5', '1e3']) {
        process.env.YTHRIL_TEST_RUNS_LOCK_WAIT_MS = bad;
        await assert.rejects(() => withLock(async () => 1, { cwd: main.dir }), /YTHRIL_TEST_RUNS_LOCK_WAIT_MS/, bad);
      }
    } finally {
      if (saved === undefined) delete process.env.YTHRIL_TEST_RUNS_LOCK_WAIT_MS; else process.env.YTHRIL_TEST_RUNS_LOCK_WAIT_MS = saved;
      rmSync(file, { force: true });
    }
  });
});
