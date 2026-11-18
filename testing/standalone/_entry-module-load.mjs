/**
 * Load one built server module as the first and only import of a fresh node process, and cut the whole tree into shards (Q-871, bundle-316).
 *
 * ## What it prevents
 *
 * The entry-module gate imports each of the server's modules in a process of its own (866 at the time of writing) and took 120 to 204 s on CI in one test
 * file, past the 60 s a file may take. This module is what the shard files share, so the work could be cut without a second copy of the loader:
 *
 * - **A module dropped between shards, or loaded twice.** {@link shardOf} is one function of the SORTED list, so every shard computes the same cut whatever
 *   order a listing came in, and the slices are a partition of the list. A shard that holds nothing would pass and test nothing, so the cut refuses a count
 *   larger than the list.
 * - **A hang that is not a finding.** {@link loadInFreshProcess} ends a child at its bound with SIGKILL and answers at once. A polite kill (SIGTERM) left a
 *   module that registers a handler for it, and keeps a handle open, holding the child's stderr pipe: the test file then waited until the batch's own bound
 *   killed the whole file, and the answer was a killed batch, not a finding.
 * - **A cold compile cache in every child.** Each child compiles the server's modules again, and most of a module's load is that. {@link loadAll} gives its
 *   children one `NODE_COMPILE_CACHE` directory (node 22.1 or later; an older node ignores the variable, and the gate is only slower), made for the run under
 *   the scratch root and removed afterwards, so a stale entry cannot be read. A run the batch bound SIGKILLs never reaches the removal, so each `loadAll` first
 *   sweeps the folders of its own prefix older than `CACHE_MAX_AGE_MS` (a younger one belongs to a shard running beside it).
 *
 * One question: *"does this module load as the first import of a process, and which modules does this shard load?"*. What a shard file asserts about the
 * tree (the floor, the leaves, the exemption check) is `_entry-module-shard-cases.mjs`'s.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scratchRoot } from '../../scripts/_shared/scratch-root.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { poolEach } from '../_shared/pool.mjs';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';

/** How long one child may take to load one module before it is a finding. */
export const LOAD_BOUND_MS = 30_000;

/**
 * How many shard files the gate is cut into, fixed by measurement and not by guess: the work is CPU-bound, so the files a node batch runs together
 * (three at once on four CPUs) each take a share of the whole gate's time that falls with the shard count. Four shards took 66 to 69 s each in the
 * measuring runner. Eight took 44 to 55 s each on CI's own runner, under the 60 s a file may take but with no margin for the run-to-run variation of a
 * tenth, and the schema package's modules were added to the gate after eight was chosen. Twelve aim at about two thirds of that, with real margin,
 * and a runner with fewer CPUs runs the shards one at a time. The number of shard files is asserted equal to it.
 */
export const SHARDS = 12;

/** A module that is a process's own program and is not importable as a library: `file` (as `server/src/...ts`) -> why. */
export const NOT_IMPORTABLE = {
  'server/src/brain/embed-process.ts': 'the embedding child: the server starts it with an IPC channel, and it says "not a command" and exits without one',
};

/**
 * Import `specifier` as the only import of a fresh process. Resolves `{ ok, reason }`; never rejects.
 *
 * @param {string} specifier a file URL, or a `data:` module
 * @param {object} [options]
 * @param {number} [options.boundMs] the child is killed (SIGKILL) and the answer is a finding when it has not exited by then
 * @param {Record<string, string>} [options.env] added to the child's environment (the compile cache directory)
 */
export function loadInFreshProcess(specifier, { boundMs = LOAD_BOUND_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)}); process.exit(0)`],
      { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: testChildEnv(env) });
    let stderr = '';
    let answered = false;
    const answer = (result) => { if (!answered) { answered = true; clearTimeout(timer); resolve(result); } };
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stderr.destroy();
      // What the child had said by then, so a hang names where it was (a module that waits on something) and not only that it was cut off.
      const said = stderr.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 200);
      answer({ ok: false, reason: `did not finish loading in ${boundMs} ms${said ? ` (stderr: ${said})` : ''}` });
    }, boundMs);
    child.on('error', (error) => answer({ ok: false, reason: `could not start a process: ${error.message}` }));
    child.on('exit', (code) => {
      // The line that says what was thrown (`Error: …`, `ReferenceError: …`), not the source line node prints above it.
      const lines = stderr.split(/\r?\n/);
      const line = lines.find(l => /^[A-Za-z]*Error\b/.test(l)) ?? lines.find(l => /\bError\b/.test(l)) ?? stderr.trim().split(/\r?\n/)[0] ?? '';
      answer(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code}: ${line.slice(0, 200)}` });
    });
  });
}

/**
 * The built module of each tracked source, in its own package's build: `server/src/a/b.ts` -> `server/dist/a/b.js`, `schema/src/a.ts` -> `schema/dist/a.js`
 * (each root of SERVER_CODE_ROOTS builds `src` into its sibling `dist`). Listed, never read: the question is which modules exist.
 */
export function entryModules() {
  return trackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], floor: 300, specs: false, untracked: true })
    .map(file => ({ file, built: file.replace(/^([^/]+)\/src\//, '$1/dist/').replace(/\.ts$/, '.js') }));
}

/** What names a module in a list: its source path, or the item itself when the list holds plain strings. */
const idOf = (m) => (typeof m === 'string' ? m : m.file);

/**
 * Shard `index` (0-based) of `count`: every `count`th module of the list SORTED by name, starting at `index`. Round robin over the sorted list, so one
 * directory's heavy modules do not all land in one shard, and the cut is a function of the set, never of the order a listing came in.
 *
 * Not `planDbShards` (`testing/_shared/db-shard-plan.mjs`), which answers a different question: it gives a database file the shard its NAME hashes to, so the
 * file keeps its Mongo when others are added, and a small list can leave a shard empty. The load gate has no state to keep, and wants balanced slices that
 * are never empty, so each takes about the same time.
 */
export function shardOf(list, index, count) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) throw new Error(`shard ${index} of ${count} is not a shard`);
  if (count > list.length) throw new Error(`${count} shards for ${list.length} module(s): a shard would hold nothing, pass, and test nothing`);
  return [...list].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0)).filter((_, n) => n % count === index);
}

/** How many modules one shard loads at a time: half the CPUs, so the shards a batch starts together do not overload the runner. */
export const childWidth = (cpus) => Math.max(1, Math.floor(cpus / 2));

/** The name every compile-cache folder of a run starts with, and how old one must be before the next run takes it for a killed run's. */
const CACHE_PREFIX = 'entry-module-compile-cache-';
const CACHE_MAX_AGE_MS = 6 * 3_600_000;

/**
 * Remove the compile-cache folders under `root` that a killed run left (older than `CACHE_MAX_AGE_MS`). Best effort by design: a folder that vanishes between
 * the listing and the removal is another shard's finishing, and one that cannot be removed costs disk, never a verdict, so neither fails a gate.
 */
function sweepOldCaches(root) {
  for (const name of readdirSync(root)) {
    if (!name.startsWith(CACHE_PREFIX)) continue;
    const dir = join(root, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > CACHE_MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* see above */ }
  }
}

/**
 * Load every module of `modules` (each `{ file, built }`), `parallel` at a time, in children that share one compile cache. Resolves a Map of
 * `file -> { ok, reason }`.
 */
export async function loadAll(modules, { parallel, boundMs = LOAD_BOUND_MS } = {}) {
  mkdirSync(scratchRoot(), { recursive: true });
  sweepOldCaches(scratchRoot());
  const cacheDir = mkdtempSync(join(scratchRoot(), CACHE_PREFIX));
  const results = new Map();
  try {
    // The pool is `poolEach`'s (`testing/_shared/pool.mjs`), which refuses a width that would start nothing.
    await poolEach(modules, parallel, async (m) => {
      results.set(m.file, await loadInFreshProcess(pathToFileURL(join(REPO_ROOT, m.built)).href, { boundMs, env: { NODE_COMPILE_CACHE: cacheDir } }));
    });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
  return results;
}
