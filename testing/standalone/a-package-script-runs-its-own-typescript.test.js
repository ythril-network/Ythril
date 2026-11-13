/**
 * A package script runs the TypeScript compiler its workspace depends on, through `scripts/tsc.mjs`, and never through a bin link.
 *
 * ## What it prevents
 *
 * `node_modules/.bin/tsc` belongs to whichever installed package npm linked last. The schema package's `typescript-6`
 * devDependency (an alias of `typescript@6`, the second compiler the from-typescript entry is tested against) declares the same
 * `tsc` and `tsserver` bins as the `typescript` every workspace builds with. An incremental `npm install` left `.bin/tsc` on
 * TypeScript 6 and the schema build failed (Q-687). The image's build stage installs the schema's dev dependencies too, so the
 * server could have been built by either compiler. `scripts/tsc.mjs` resolves `typescript` by package name from the workspace.
 *
 * ## What it holds
 *
 * - No tracked `package.json` has a script step that calls `tsc` or `tsserver` by its bin (bare, `npx`, `npm exec`).
 * - The runner resolves `typescript` from the directory npm runs the script in, passes the arguments through, and returns the
 *   compiler's exit status, whatever `.bin/tsc` points at.
 * - The image's build stage copies the runner before it runs a build script.
 *
 * Run: node --test testing/standalone/a-package-script-runs-its-own-typescript.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { binLinkCompilerSteps, COMPILER_RUN } from './_tsc-runner.mjs';

const RUNNER = join(REPO_ROOT, 'scripts', 'tsc.mjs');

describe('no package script calls the compiler by its bin link', () => {
  it('every tracked package.json runs tsc through scripts/tsc.mjs', () => {
    const manifests = trackedSources('.', { ext: ['package.json'], floor: 4 }).filter(f => f === 'package.json' || f.endsWith('/package.json'));
    const found = [];
    for (const file of manifests) {
      const scripts = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')).scripts ?? {};
      for (const [name, body] of Object.entries(scripts)) {
        for (const step of binLinkCompilerSteps(body)) found.push(`${file} "${name}": ${step}`);
      }
    }
    assert.deepEqual(found, [], `these steps run whatever node_modules/.bin/tsc points at; write node ../scripts/tsc.mjs instead:\n${found.join('\n')}`);
  });

  it('no package script deletes a build output before the runner has checked the install (it cleans with --clean)', () => {
    // A step that deleted dist and then ran a runner that refused a stale install left the checkout with no dist at all (bundle-266).
    const manifests = trackedSources('.', { ext: ['package.json'], floor: 4 }).filter(f => f === 'package.json' || f.endsWith('/package.json'));
    const found = [];
    for (const file of manifests) {
      const scripts = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')).scripts ?? {};
      for (const [name, body] of Object.entries(scripts)) {
        const at = body.search(/\bnode\s+(?:\.\.\/)?scripts\/tsc\.mjs\b/);
        if (at > 0 && /rmSync|rimraf|\brm\s+-[a-z]*r/.test(body.slice(0, at))) found.push(`${file} "${name}"`);
      }
    }
    assert.deepEqual(found, [], `these scripts delete before the install check; pass --clean <dir> to scripts/tsc.mjs instead:\n${found.join('\n')}`);
  });

  it('the reader finds every bin-link spelling and passes the runner', () => {
    for (const s of ['tsc', 'tsc -p x', 'npx tsc --noEmit', 'npm exec tsc', 'a && tsc', 'tsserver', 'x; npx -- tsc']) {
      assert.equal(binLinkCompilerSteps(s).length, 1, `${s} was not read as a bin-link call`);
    }
    for (const s of ['node ../scripts/tsc.mjs -p x', 'node scripts/tsc.mjs', 'ng build', 'node -e "tsconfig"', 'echo tscx']) {
      assert.deepEqual(binLinkCompilerSteps(s), [], `${s} was read as a bin-link call`);
    }
    assert.ok(COMPILER_RUN.test('node ../scripts/tsc.mjs -p tsconfig.json'));
  });
});

describe('scripts/tsc.mjs runs the workspace\'s own typescript', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-runner-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"ws","private":true}');
    const own = join(dir, 'node_modules', 'typescript', 'bin');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"0.0.0-own"}');
    writeFileSync(join(own, 'tsc'), 'console.log(JSON.stringify({ own: true, args: process.argv.slice(2) })); process.exit(3);\n');
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'tsc'), '#!/bin/sh\necho claimed-by-another-package\nexit 9\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves typescript by name from the calling directory, passes the arguments and returns the exit status', () => {
    const r = spawnSync(process.execPath, [RUNNER, '--noEmit', '-p', 'a b.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 3, `the runner's exit status is not the compiler's: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { own: true, args: ['--noEmit', '-p', 'a b.json'] });
    assert.doesNotMatch(r.stdout, /claimed-by-another-package/);
  });

  it('--clean <dir> empties that folder and is not passed to the compiler', () => {
    mkdirSync(join(dir, 'out', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'out', 'sub', 'old.js'), 'stale');
    const r = spawnSync(process.execPath, [RUNNER, '--clean', 'out', '-p', 'x.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 3, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()).args, ['-p', 'x.json']);
    assert.equal(existsSync(join(dir, 'out')), false, 'the --clean folder is still there');
  });

  it('fails when the workspace has no typescript, never falling back to a bin link', () => {
    const bare = mkdtempSync(join(tmpdir(), 'tsc-runner-bare-'));
    try {
      writeFileSync(join(bare, 'package.json'), '{"name":"bare","private":true}');
      const r = spawnSync(process.execPath, [RUNNER], { cwd: bare, encoding: 'utf8' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Cannot find module 'typescript\/bin\/tsc'/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('the image builds with the runner', () => {
  it('the build stage copies scripts/tsc.mjs before it runs a build script', () => {
    const lines = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8').split(/\r?\n/);
    const copy = lines.findIndex(l => /^COPY\s+scripts\/tsc\.mjs\s/.test(l));
    // The `build` script itself (server, and the schema through its prebuild), not `build:prod`, which is the client's ng build.
    const build = lines.findIndex(l => /^RUN\s+npm run build(?=\s|$)/.test(l));
    assert.ok(build >= 0, 'the Dockerfile runs no npm run build');
    assert.ok(copy >= 0 && copy < build, 'the Dockerfile builds before it copies scripts/tsc.mjs, so the build scripts cannot find the runner');
  });
});
