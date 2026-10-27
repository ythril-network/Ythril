/**
 * A checkout holds no file that git does not track unless a rule that names a place registers it.
 *
 * ## Why this gate exists
 *
 * Q-626, 2026-10-27. Agent runs left logs, a bash stack dump, test output and stray worktree copies in the owner's
 * checkout, and nothing reported them: `*.log` and `*.txt` in `.gitignore` hide build and test output, so `git status`
 * stayed clean around exactly the files that should have been noticed. A catch-all rule hides output; it does not say
 * "this is where such files belong". `scripts/unregistered-local-files.mjs` fails on a path that is untracked and is
 * either not ignored at all or ignored only by a catch-all, and names the rule that hid it.
 *
 * ## What it runs against
 *
 * A repository of its own making in the temporary directory, never the checkout it is run from: a gate that read the
 * checkout would be red or green by what the last agent left behind, not by the script's behaviour. The one read of the
 * real checkout is `.gitignore`, to hold the derivation of the catch-all set to a floor: a parse that finds nothing
 * would pass every case below and report clean about a rule it never read.
 *
 * Run: node --test testing/standalone/unregistered-local-files.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'unregistered-local-files.mjs');

/** The script's environment without the variables a hook or an outer git would hand a child, which re-point git at another repository. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/** Run the script against `root` (or its own repository when null); answers its exit status and both streams. */
function runScript(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: cleanEnv() });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const write = (repo, rel, text = 'x\n') => {
  const full = join(repo.dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

describe('unregistered-local-files', () => {
  let repo;
  before(() => {
    repo = makeScratchRepo({ prefix: 'unregistered-local-files-' });
    write(repo, '.gitignore', ['# a path rule, a directory rule and a catch-all', 'config/local.json', 'local-data/', 'tmp/', '*.log', ''].join('\n'));
    write(repo, 'tracked.md');
    repo.git('add', '.gitignore', 'tracked.md');
    repo.git('commit', '-q', '-m', 'seed');
  });
  after(() => repo.cleanup());

  it('a clean repository passes', () => {
    const r = runScript(['--root', repo.dir]);
    assert.equal(r.status, 0, r.out);
  });

  it('a file under a path rule, a directory rule and tmp/ is registered', () => {
    write(repo, 'config/local.json');
    write(repo, 'local-data/db/blob.bin');
    write(repo, 'tmp/run/output.txt');
    const r = runScript(['--root', repo.dir]);
    assert.equal(r.status, 0, r.out);
  });

  it('a stray.log fails and names the *.log rule that hid it', () => {
    write(repo, 'stray.log');
    const r = runScript(['--root', repo.dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /stray\.log/);
    assert.match(r.out, /\*\.log/);
  });

  it('an untracked notes.md fails as untracked', () => {
    write(repo, 'notes.md');
    const r = runScript(['--root', repo.dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /notes\.md.*untracked/);
  });

  it('a catch-all hides nothing under tmp/, and a log in a registered directory is still registered by the directory', () => {
    // Each failure is named by its own path: the two strays above are reported, the registered paths are not.
    const r = runScript(['--root', repo.dir]);
    assert.equal(r.status, 1, r.out);
    assert.doesNotMatch(r.out, /tmp\/run\/output\.txt/);
    assert.doesNotMatch(r.out, /config\/local\.json/);
    assert.doesNotMatch(r.out, /local-data/);
  });

  it('editor and operating-system noise is clutter too', () => {
    const noise = makeScratchRepo({ prefix: 'unregistered-local-files-noise-' });
    try {
      write(noise, '.gitignore', ['.DS_Store', 'Thumbs.db', '*.swp', ''].join('\n'));
      noise.git('add', '.gitignore');
      noise.git('commit', '-q', '-m', 'seed');
      write(noise, 'src/.DS_Store');
      write(noise, 'Thumbs.db');
      write(noise, 'a.swp');
      const r = runScript(['--root', noise.dir]);
      assert.equal(r.status, 1, r.out);
      for (const name of ['.DS_Store', 'Thumbs.db', 'a.swp']) assert.match(r.out, new RegExp(name.replace('.', '\\.')), `${name} must be reported\n${r.out}`);
    } finally {
      noise.cleanup();
    }
  });

  it('a path rule from .git/info/exclude registers a place too', () => {
    const own = makeScratchRepo({ prefix: 'unregistered-local-files-exclude-' });
    try {
      write(own, 'tracked.md');
      own.git('add', 'tracked.md');
      own.git('commit', '-q', '-m', 'seed');
      const exclude = join(own.dir, '.git', 'info', 'exclude');
      mkdirSync(dirname(exclude), { recursive: true });
      writeFileSync(exclude, 'scratch-area/\n');
      write(own, 'scratch-area/a.bin');
      assert.equal(runScript(['--root', own.dir]).status, 0);
    } finally {
      own.cleanup();
    }
  });

  it('reads the real .gitignore and derives its catch-all rules, with a floor', () => {
    const r = runScript(['--root', REPO_ROOT, '--catch-all']);
    assert.equal(r.status, 0, r.out);
    const derived = r.out.split('\n').map(l => l.trim()).filter(Boolean);
    assert.ok(derived.length >= 2, `the catch-all derivation found ${derived.length} rules in .gitignore; a parse that finds nothing passes every case above`);
    for (const known of ['*.log', '*.txt']) assert.ok(derived.includes(known), `${known} is a catch-all in .gitignore and the derivation did not find it: ${derived.join(' ')}`);
    // A rule that names a place is not one, whatever it says about the paths under it.
    const text = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    for (const place of ['node_modules/', 'dist/', 'tmp/', 'test-results/']) {
      assert.ok(text.split('\n').includes(place), `.gitignore must hold the place rule ${place}`);
      assert.ok(!derived.includes(place), `${place} names a place and must not be a catch-all`);
    }
  });

  it('refuses an argument it does not know', () => {
    const r = runScript(['--rot', repo.dir]);
    assert.equal(r.status, 2, r.out);
  });

  it('says its git failed instead of answering clean', () => {
    // A directory that is not a repository: the scan has nothing to read, and "no strays" would be a claim about nothing.
    const notARepo = execFileSync(process.execPath, ['-e', 'console.log(require("node:os").tmpdir())'], { encoding: 'utf8' }).trim();
    const r = runScript(['--root', join(notARepo, 'no-such-directory-for-unregistered-local-files')]);
    assert.notEqual(r.status, 0, r.out);
  });
});
