/**
 * The standalone runner refuses a `dist` older than its source, or absent, for the schema package as it does for the server (Q-685, R1).
 *
 * ## What it prevents
 *
 * `testing/_init/run-standalone.mjs` refused a stale `server/dist` and nothing else. The standalone files import `server/dist`, which imports
 * the schema package, which resolves to `schema/dist`. After editing `schema/src`, `npm run test:standalone` ran the OLD package build and
 * reported on code nobody had written, and `tsx watch` never rebuilds it either. The runner's answer is a refusal that names the build to run.
 *
 * ## What it holds
 *
 * `staleBuilds(root)` (`testing/_shared/stale-build.mjs`) answers for every root of `SERVER_CODE_ROOTS`, each against `<package>/dist/index.js`:
 * a fresh build and a build newer than its source answer nothing; a source file newer than the build, or no build, answers a message naming the
 * dist and the command that builds it. The runner calls it, so a root added to `SERVER_CODE_ROOTS` is refused stale with no second list.
 *
 * Run: node --test testing/standalone/the-standalone-runner-refuses-a-stale-or-missing-server-code-build.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_CODE_ROOTS, REPO_ROOT } from './_sources.mjs';
import { staleBuilds } from '../_shared/stale-build.mjs';

let root;
const at = (rel, seconds) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, 'x');
  utimesSync(p, seconds, seconds);
};
const NOW = Math.floor(Date.now() / 1000);

before(() => { root = mkdtempSync(join(tmpdir(), 'stale-build-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

/** A tree where every root's build is newer than its source, built from the constant. */
function freshTree() {
  for (const src of SERVER_CODE_ROOTS) rmSync(join(root, src.replace(/\/src$/, '')), { recursive: true, force: true });
  for (const src of SERVER_CODE_ROOTS) {
    at(`${src}/a/b.ts`, NOW - 100);
    at(`${src.replace(/\/src$/, '')}/dist/index.js`, NOW - 50);
  }
}

describe('staleBuilds', () => {
  it('answers nothing when every build is newer than its source', () => {
    freshTree();
    assert.deepEqual(staleBuilds(root), []);
  });

  it('refuses each root whose source is newer than its build, naming the dist and the build', () => {
    for (const src of SERVER_CODE_ROOTS) {
      freshTree();
      at(`${src}/a/c.ts`, NOW);
      const out = staleBuilds(root);
      assert.equal(out.length, 1, `${src}: exactly its own build is refused`);
      assert.match(out[0], new RegExp(`${src.replace(/\/src$/, '')}/dist.*OLDER`), src);
      assert.match(out[0], /npm run build/, src);
    }
  });

  it('refuses each root whose build is absent', () => {
    for (const src of SERVER_CODE_ROOTS) {
      freshTree();
      rmSync(join(root, src.replace(/\/src$/, ''), 'dist'), { recursive: true, force: true });
      const out = staleBuilds(root);
      assert.equal(out.length, 1, src);
      assert.match(out[0], /missing/, src);
    }
  });
});

describe('the runner uses it', () => {
  it('run-standalone.mjs asks staleBuilds and keeps no second check of its own', () => {
    const runner = readFileSync(join(REPO_ROOT, 'testing/_init/run-standalone.mjs'), 'utf8');
    assert.match(runner, /staleBuilds\(/, 'the runner calls staleBuilds');
    assert.doesNotMatch(runner, /statSync\('server\/dist/, 'the runner stats no dist by hand');
  });
});
