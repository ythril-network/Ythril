/**
 * The build refuses an install that is behind package-lock.json, and says which package and what to run.
 *
 * ## What it prevents
 *
 * The main checkout's installed packages fell behind the lockfile (installed 2026-11-02, lock changed 2026-11-08) and the server
 * build failed with thirty-odd type errors that named code, never the install: a driver typed one way in the lock and another on
 * disk. Nobody reading those errors could tell the fix was `npm ci`. `scripts/tsc.mjs` is every package's build, so it compares each
 * installed package's version with the one package-lock.json pins and stops, before the compiler runs, on the first one that differs:
 * `installed mongodb 7.1.1, package-lock.json pins 7.8.0: run npm ci`.
 *
 * ## What it holds (each case builds a small repository: scripts/, package-lock.json, node_modules/, a workspace folder)
 *
 * - One installed package that differs from the lock is refused by name, with both versions and the fix, before the compiler runs,
 *   and the packages that agree are not named.
 * - A package the lock marks optional and the install does not hold (a platform binary for another platform) is not an error.
 * - A package under a nested `node_modules/<a>/node_modules/<b>` (and a scoped one) is read at its own path: stale there is
 *   refused by its own name, and two copies of one name that each agree with their own lock entry are accepted.
 * - A package the lock requires and the install does not hold is refused by name, judged along the dependencies of the workspace
 *   being built (directly or through another): a package of another workspace the install left out (the image copies the whole
 *   lock but installs only the server and the schema) and an optional dependency that is not installed are not errors.
 * - No package-lock.json beside the scripts folder means nothing to compare with, and never refuses.
 * - The repository's own lock and the tree installed for it are accepted, so the guard cannot refuse a healthy checkout
 *   (workspace links, bundled and platform-specific entries included).
 *
 * Run: node --test testing/standalone/the-build-refuses-a-stale-install-by-name.test.js
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const RUNNER_SOURCE = readFileSync(join(REPO_ROOT, 'scripts', 'tsc.mjs'), 'utf8');
const MARKER = 'fixture-compiler-ran';
const TS_VERSION = '5.9.9-fixture';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * A repository in a temp folder: the real scripts/tsc.mjs at scripts/, a workspace folder `ws` with its own package.json (where the
 * build runs), a fake `typescript` that prints MARKER, and one installed package per `installed` entry (path under the root -> version).
 * `locked` maps a lock key to its version, or to a lock entry object; `lock: false` writes no package-lock.json.
 */
function repo({ locked, installed, lock = true }) {
  const root = mkdtempSync(join(tmpdir(), 'stale-install-'));
  dirs.push(root);
  put(join(root, 'scripts', 'tsc.mjs'), RUNNER_SOURCE);
  put(join(root, 'package.json'), '{"name":"fixture-root","private":true,"workspaces":["ws"]}');
  put(join(root, 'ws', 'package.json'), '{"name":"ws","version":"1.0.0","private":true}');
  put(join(root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: TS_VERSION }));
  put(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), `console.log(${JSON.stringify(MARKER)} + ' ' + process.argv.slice(2).join(' '));\n`);
  for (const [path, version] of Object.entries(installed)) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    put(join(root, path, 'package.json'), JSON.stringify({ name, version }));
  }
  if (lock) {
    const packages = {
      '': { name: 'fixture-root', workspaces: ['ws'] },
      ws: { name: 'ws', version: '1.0.0' },
      'node_modules/ws-link': { resolved: 'ws', link: true },
      'node_modules/typescript': { version: TS_VERSION },
    };
    for (const [key, v] of Object.entries(locked)) packages[key] = typeof v === 'string' ? { version: v } : v;
    put(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture-root', lockfileVersion: 3, requires: true, packages }, null, 2));
  }
  return root;
}

/** The build step of the workspace: `node ../scripts/tsc.mjs <args>` run in ws. */
function build(root, ...args) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'tsc.mjs'), ...args], { cwd: join(root, 'ws'), encoding: 'utf8' });
}

function assertRefused(r, name, installedV, pinned) {
  assert.notEqual(r.status, 0, `the build went on with a stale install; stdout: ${r.stdout}`);
  assert.match(r.stderr, new RegExp(`installed ${name.replace(/[/@.]/g, '\\$&')} ${installedV.replace(/\./g, '\\.')}, package-lock\\.json pins ${pinned.replace(/\./g, '\\.')}: run npm ci`),
    `the refusal does not name the package, both versions and the fix; stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, new RegExp(MARKER), 'the compiler ran although the install is stale');
}

function assertAccepted(r) {
  assert.equal(r.status, 0, `the build was refused or failed; stderr: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(MARKER), 'the compiler did not run');
  assert.doesNotMatch(r.stderr, /package-lock\.json pins/);
}

describe('the build refuses an install that differs from package-lock.json, by name', () => {
  it('names the one stale package with both versions and the fix, and does not run the compiler', () => {
    const root = repo({
      locked: { 'node_modules/mongodb': '7.8.0', 'node_modules/zod': '4.1.0' },
      installed: { 'node_modules/mongodb': '7.1.1', 'node_modules/zod': '4.1.0' },
    });
    const r = build(root, '--noEmit');
    assertRefused(r, 'mongodb', '7.1.1', '7.8.0');
    assert.doesNotMatch(r.stderr, /zod/, 'a package that agrees with the lock is named in the refusal');
  });

  it('accepts an install that agrees with the lock, and passes the compiler its arguments', () => {
    const root = repo({
      locked: { 'node_modules/mongodb': '7.8.0', 'node_modules/zod': '4.1.0' },
      installed: { 'node_modules/mongodb': '7.8.0', 'node_modules/zod': '4.1.0' },
    });
    const r = build(root, '--noEmit', '-p', 'x.json');
    assertAccepted(r);
    assert.match(r.stdout, /--noEmit -p x\.json/);
  });

  it('does not count an optional package the install does not hold as an error', () => {
    const root = repo({
      locked: {
        'node_modules/mongodb': '7.8.0',
        'node_modules/@img/sharp-win32-x64': { version: '0.34.0', optional: true },
        'node_modules/fsevents': { version: '2.3.3', optional: true, os: ['darwin'] },
      },
      installed: { 'node_modules/mongodb': '7.8.0' },
    });
    assertAccepted(build(root));
  });

  it('refuses an optional package that is installed at another version', () => {
    const root = repo({
      locked: { 'node_modules/fsevents': { version: '2.3.3', optional: true } },
      installed: { 'node_modules/fsevents': '2.3.0' },
    });
    assertRefused(build(root), 'fsevents', '2.3.0', '2.3.3');
  });
});

describe('the build refuses a package the lock requires and the install does not hold', () => {
  function assertMissing(r, name, pinned) {
    assert.notEqual(r.status, 0, `the build went on with a package missing; stdout: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`package-lock\\.json requires ${name.replace(/[/@.]/g, '\\$&')} ${pinned.replace(/\./g, '\\.')}, which is not installed: run npm ci`),
      `the refusal does not name the package, its pinned version and the fix; stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, new RegExp(MARKER), 'the compiler ran although a required package is missing');
  }

  it('names a required package (one the workspace depends on, directly or through another) that is not installed at all', () => {
    const direct = repo({
      locked: {
        ws: { name: 'ws', version: '1.0.0', dependencies: { mongodb: '^7.0.0' } },
        'node_modules/mongodb': '7.8.0',
      },
      installed: {},
    });
    assertMissing(build(direct), 'mongodb', '7.8.0');
    const nested = repo({
      locked: {
        ws: { name: 'ws', version: '1.0.0', dependencies: { a: '^1.0.0' } },
        'node_modules/a': { version: '1.0.0', dependencies: { '@scope/pkg': '^3.0.0' } },
        'node_modules/@scope/pkg': '3.2.1',
      },
      installed: { 'node_modules/a': '1.0.0' },
    });
    assertMissing(build(nested), '@scope/pkg', '3.2.1');
  });

  it('does not count a package of another workspace that the install left out (the image installs only the server and the schema)', () => {
    const root = repo({
      locked: {
        ws: { name: 'ws', version: '1.0.0', dependencies: { mongodb: '^7.0.0' } },
        'node_modules/mongodb': '7.8.0',
        'node_modules/@angular/core': '20.0.0',
        'client/node_modules/left-pad': '1.3.0',
      },
      installed: { 'node_modules/mongodb': '7.8.0' },
    });
    assertAccepted(build(root));
  });

  it('does not count an optional dependency of the workspace that the install does not hold', () => {
    const root = repo({
      locked: {
        ws: { name: 'ws', version: '1.0.0', optionalDependencies: { fsevents: '^2.3.0' } },
        'node_modules/fsevents': { version: '2.3.3', optional: true },
      },
      installed: {},
    });
    assertAccepted(build(root));
  });
});

describe('the guard reads each package at its own path', () => {
  it('names a stale package under a nested node_modules by its own name', () => {
    const root = repo({
      locked: { 'node_modules/a': '1.0.0', 'node_modules/a/node_modules/b': '2.0.0' },
      installed: { 'node_modules/a': '1.0.0', 'node_modules/a/node_modules/b': '1.9.0' },
    });
    assertRefused(build(root), 'b', '1.9.0', '2.0.0');
  });

  it('names a stale scoped package with its scope', () => {
    const root = repo({
      locked: { 'node_modules/@scope/pkg': '3.2.1' },
      installed: { 'node_modules/@scope/pkg': '3.2.0' },
    });
    assertRefused(build(root), '@scope/pkg', '3.2.0', '3.2.1');
  });

  it('names a stale package of a workspace folder (ws/node_modules)', () => {
    const root = repo({
      locked: { 'ws/node_modules/c': '4.0.0' },
      installed: { 'ws/node_modules/c': '3.0.0' },
    });
    assertRefused(build(root), 'c', '3.0.0', '4.0.0');
  });

  it('accepts two copies of one name when each agrees with its own lock entry', () => {
    const root = repo({
      locked: { 'node_modules/b': '1.0.0', 'node_modules/a': '1.0.0', 'node_modules/a/node_modules/b': '2.0.0', 'ws/node_modules/b': '3.0.0' },
      installed: { 'node_modules/b': '1.0.0', 'node_modules/a': '1.0.0', 'node_modules/a/node_modules/b': '2.0.0', 'ws/node_modules/b': '3.0.0' },
    });
    assertAccepted(build(root));
  });
});

describe('a build with no package-lock.json to compare with never refuses', () => {
  it('runs the compiler when no lock sits beside the scripts folder, whatever is installed', () => {
    const root = repo({ lock: false, locked: {}, installed: { 'node_modules/mongodb': '7.1.1' } });
    assert.equal(existsSync(join(root, 'package-lock.json')), false, 'the fixture holds a lock');
    assertAccepted(build(root, '--noEmit'));
  });
});

describe('the repository\'s own lock and tree', () => {
  it('are accepted: the real build step runs the real compiler', () => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
    assert.ok(Object.keys(lock.packages).length > 100, 'the repository lock lists no packages, so acceptance proves nothing');
    const tsPin = lock.packages['node_modules/typescript'].version;
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'tsc.mjs'), '--version'], { cwd: join(REPO_ROOT, 'server'), encoding: 'utf8' });
    assert.equal(r.status, 0, `the repository's own build was refused or failed; stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /package-lock\.json pins/);
    assert.match(r.stdout, new RegExp(`Version ${tsPin.replace(/\./g, '\\.')}`), 'the compiler that ran is not the one the lock pins');
  });
});
