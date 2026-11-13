#!/usr/bin/env node
/**
 * Runs the TypeScript compiler the calling workspace depends on: the `typescript` package resolved from the directory npm runs
 * the script in, with the arguments passed through and its exit status returned.
 *
 * ## The question it answers
 *
 * *"Which compiler builds this workspace?"* Its own `typescript` dependency, by package name, and never whatever
 * `node_modules/.bin/tsc` points at.
 *
 * ## What it prevents
 *
 * `.bin/tsc` is a link any installed package may claim. The schema package's `typescript-6` devDependency (an alias of
 * `typescript@6`, which the from-typescript entry is tested against) declares the same `tsc` and `tsserver` bins as the
 * `typescript` every workspace builds with, and npm links whichever it reaches last. An incremental `npm install` left
 * `.bin/tsc` on TypeScript 6 and the schema build failed (Q-687). An image build that ran `npm ci` with the schema's dev
 * dependencies could build the server with the wrong compiler too. A package script that says `node ../scripts/tsc.mjs`
 * resolves the compiler by package name, so no bin link can change which one runs. The gate
 * `a-package-script-runs-its-own-typescript` refuses a bare `tsc` in a package script.
 *
 * ## The second question: is the install the lock's?
 *
 * *"Do the installed packages match package-lock.json?"* A checkout whose packages fell behind the lockfile failed the server build
 * with thirty-odd type errors that named code and never the install (a driver typed one way in the lock and another on disk). Before
 * the compiler runs, every lock entry that has a path under a `node_modules` folder is compared with the package installed there, and
 * the first difference stops the build with its name and the fix:
 *
 * - `installed mongodb 7.1.1, package-lock.json pins 7.8.0: run npm ci`
 * - `package-lock.json requires mongodb 7.8.0, which is not installed: run npm ci` (a package the workspace being built depends on,
 *   directly or through another, and the install does not hold at all).
 *
 * What it leaves alone, each because a healthy install differs from the lock there:
 *
 * - A lock entry that is optional (a platform binary for another platform) and not installed. One that is installed is compared.
 * - A package that only another workspace needs. The image's builder stage runs `npm ci --workspace=server --workspace=schema` with
 *   the whole lock beside the scripts, so the client's packages are in the lock and not on disk. Absence is judged along the
 *   dependencies of the workspace the build runs in (the lock entry for the folder npm ran the script in), never over the whole lock.
 * - Links (workspace folders) and entries with no version.
 * - A build with no package-lock.json beside the scripts folder: there is nothing to compare with.
 *
 * It stops on the first difference, so one refusal is one line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package name of a lock key: what follows its last `node_modules/`, or '' for a key with none (a workspace folder, the root). */
function nameOfKey(key) {
  const i = key.lastIndexOf('node_modules/');
  return i < 0 ? '' : key.slice(i + 'node_modules/'.length);
}

/** The lock keys npm would try, nearest first, for the dependency `name` of the package at `key` (its own node_modules, then each parent's). */
function* candidateKeys(key, name) {
  let base = key;
  for (;;) {
    yield `${base ? `${base}/` : ''}node_modules/${name}`;
    if (base === '') return;
    const i = base.lastIndexOf('node_modules/');
    base = i < 0 ? '' : base.slice(0, i).replace(/\/$/, '');
  }
}

/** The installed version at `dir`, or null when no package is installed there. */
function installedVersion(dir) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')).version ?? null;
}

/**
 * The first difference between the install and the lock, as the sentence to refuse with; null when there is none or no lock sits at
 * `root`. `workspaceKey` is the lock key of the folder the build runs in ('' for the root).
 */
function staleInstall(root, workspaceKey) {
  const lockFile = join(root, 'package-lock.json');
  if (!existsSync(lockFile)) return null;
  const packages = JSON.parse(readFileSync(lockFile, 'utf8')).packages ?? {};
  for (const [key, entry] of Object.entries(packages)) {
    const name = nameOfKey(key);
    if (!name || entry.link || typeof entry.version !== 'string') continue;
    const version = installedVersion(join(root, key));
    if (version !== null && version !== entry.version) return `installed ${name} ${version}, package-lock.json pins ${entry.version}: run npm ci`;
  }
  const seen = new Set();
  const queue = [workspaceKey];
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const own = packages[key] ?? {};
    const wanted = key === workspaceKey
      ? [...Object.keys(own.dependencies ?? {}), ...Object.keys(own.devDependencies ?? {})]
      : Object.keys(own.dependencies ?? {});
    for (const dep of wanted) {
      const found = [...candidateKeys(key, dep)].find(k => packages[k] !== undefined);
      if (found === undefined) continue;
      const entry = packages[found];
      if (entry.link || entry.optional || entry.devOptional || typeof entry.version !== 'string') continue;
      if (installedVersion(join(root, found)) === null) return `package-lock.json requires ${nameOfKey(found)} ${entry.version}, which is not installed: run npm ci`;
      queue.push(found);
    }
  }
  return null;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const refusal = staleInstall(root, relative(root, process.cwd()).split(sep).join('/'));
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

// `--clean <dir>`: empty the build's output folder, but only once the install is known good. A script that deleted it before this
// check left a stale checkout with no schema/dist at all when the check then refused (bundle-266's drive, 2026-11-13).
const args = process.argv.slice(2);
const cleanAt = args.indexOf('--clean');
if (cleanAt >= 0) {
  const dir = args[cleanAt + 1];
  if (!dir || dir.startsWith('-')) { console.error('tsc.mjs: --clean needs a folder'); process.exit(1); }
  rmSync(resolve(process.cwd(), dir), { recursive: true, force: true });
  args.splice(cleanAt, 2);
}

const from = createRequire(join(process.cwd(), 'package.json'));
const compiler = from.resolve('typescript/bin/tsc');
const run = spawnSync(process.execPath, [compiler, ...args], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
