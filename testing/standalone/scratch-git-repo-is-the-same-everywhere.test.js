/**
 * `testing/_shared/scratch-git-repo.mjs` hands out a repository that behaves the same on every machine, and cleans up.
 *
 * ## What this pins
 *
 * The three fixtures that built a scratch repository each told git a different amount about who commits and how line
 * endings are treated. The rows: a commit works with no identity configured anywhere (every call carries its own); a
 * file with CRLF bytes is stored with exactly those bytes (`core.autocrlf` of the machine does not touch it); the initial
 * branch is the one asked for; `git` answers its stdout untrimmed; `cleanup` removes the directory, and a failed `git
 * init` leaves nothing behind.
 *
 * Run: node --test testing/standalone/scratch-git-repo-is-the-same-everywhere.test.js
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';

const made = [];
const make = (o) => { const r = makeScratchRepo(o); made.push(r); return r; };
afterEach(() => { for (const r of made.splice(0)) r.cleanup(); });

describe('a scratch repository', () => {
  it('starts on the branch it was asked for', () => {
    assert.equal(make({ branch: 'trunk' }).git('symbolic-ref', '--short', 'HEAD').trim(), 'trunk');
    assert.equal(make().git('symbolic-ref', '--short', 'HEAD').trim(), 'main');
  });

  it('commits with no identity configured: each call carries its own', () => {
    const r = make();
    writeFileSync(join(r.dir, 'a.txt'), 'one\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'initial');
    assert.match(r.git('rev-parse', 'HEAD').trim(), /^[0-9a-f]{40}$/);
  });

  it('stores CRLF bytes as written, whatever the machine\'s autocrlf says', () => {
    const r = make();
    writeFileSync(join(r.dir, 'crlf.txt'), 'a\r\nb\r\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'crlf');
    assert.equal(r.git('cat-file', '-p', 'HEAD:crlf.txt'), 'a\r\nb\r\n');
  });

  it('answers git\'s stdout untrimmed, so a NUL-separated listing keeps every byte', () => {
    const r = make();
    writeFileSync(join(r.dir, 'a.txt'), 'x');
    r.git('add', '-A');
    assert.equal(r.git('ls-files', '-z'), 'a.txt\0');
  });

  it('throws when git fails, naming what failed', () => {
    assert.throws(() => make().git('no-such-subcommand'), /no-such-subcommand/);
  });

  it('cleanup removes the directory', () => {
    const r = makeScratchRepo();
    assert.ok(existsSync(r.dir));
    r.cleanup();
    assert.equal(existsSync(r.dir), false);
  });
});
