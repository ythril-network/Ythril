/**
 * Every module of the server loads when it is the FIRST module a process imports (Q-624, design rev 4 section 2, section 16 test 19).
 *
 * ## The defect this prevents
 *
 * A static import cycle is harmless until a module reads a binding of the other while it is being evaluated, and whether it does depends on
 * which module the process imported first. A cycle through the space hash and the planner failed all 271 entry modules with a
 * temporal-dead-zone error (the Q-624 revision 2 probe), and not one existing test imports a module as its own entry: they all import
 * the one module under test, in a process that has often loaded half the server already. `no-runtime-import-cycles` finds the cycle in
 * the source graph; this finds what a cycle does, because a cycle that survives erasure and is never read at load is not a defect and a
 * check for cycles alone cannot tell.
 *
 * ## What it does
 *
 * Every built module that has a source in `server/src` (derived from the tracked tree, never listed) is imported in a FRESH node process,
 * as that process's only import, with a time bound. A load error or a hang is a finding, with the first line of the error.
 *
 * ## The one exemption, with its reason
 *
 * A module that is a process's own program and refuses to be imported (`brain/embed-process.ts` is started by the server over an IPC
 * channel and exits when it has none). A stale entry fails, and an entry that loads now fails too: an exemption outlives nothing.
 *
 * ## Red on the unchanged code
 *
 * It loads on b857da8f, which is the point: it is the guard for the change that moves the schemas and the hash into two leaves. What is red
 * there is the floor of what it must cover, `sync/incoming-schemas` and `sync/authored-content`, which do not exist yet. Seen red by hand
 * for the load rule (put back by hand): a `throw` added at the top of one built module, and an import cycle with a top-level read.
 *
 * Run: node --test testing/standalone/every-server-entry-module-loads.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';

const LOAD_BOUND_MS = 30_000;
const PARALLEL = 8;

/** A module that is a process's own program and is not importable as a library: `file` (as `server/src/...ts`) -> why. */
const NOT_IMPORTABLE = {
  'server/src/brain/embed-process.ts': 'the embedding child: the server starts it with an IPC channel, and it says "not a command" and exits without one',
};

/** Import `specifier` as the only import of a fresh process. Resolves `{ ok, detail }`; never rejects. */
export function loadInFreshProcess(specifier) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)}); process.exit(0)`],
      { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: `did not finish loading in ${LOAD_BOUND_MS} ms` }); }, LOAD_BOUND_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = stderr.split(/\r?\n/).find(l => /\bError\b/.test(l)) ?? stderr.trim().split(/\r?\n/)[0] ?? '';
      resolve(code === 0 ? { ok: true } : { ok: false, detail: `exit ${code}: ${line.slice(0, 200)}` });
    });
  });
}

/** The built module of each tracked source: `server/src/a/b.ts` -> `server/dist/a/b.js`. */
function entryModules() {
  const sources = readTrackedSources('server/src', { ext: ['.ts'], floor: 300, specs: false, untracked: true })
    .map(s => s.file).filter(f => !f.endsWith('.d.ts'));
  return sources.map(file => ({ file, built: file.replace(/^server\/src\//, 'server/dist/').replace(/\.ts$/, '.js') }));
}

async function loadAll(entries) {
  const results = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < entries.length) {
      const e = entries[next++];
      results.set(e.file, await loadInFreshProcess(pathToFileURL(join(REPO_ROOT, e.built)).href));
    }
  }));
  return results;
}

describe('the loader reports what it should', () => {
  it('a module that loads is ok, one that throws or hangs on load is a finding with its error', async () => {
    assert.equal((await loadInFreshProcess('data:text/javascript,export const a = 1;')).ok, true);
    const thrown = await loadInFreshProcess('data:text/javascript,throw new Error("temporal dead zone stand-in");');
    assert.equal(thrown.ok, false);
    assert.match(thrown.detail, /temporal dead zone stand-in/);
    assert.equal((await loadInFreshProcess('data:text/javascript,import "node:no-such-builtin";')).ok, false);
  });
});

describe('every module is a usable entry', () => {
  const entries = entryModules();

  it('the set is the whole built tree (floor), and holds the two leaves of the body hash', () => {
    assert.ok(entries.length >= 300, `only ${entries.length} server module(s) found: the derivation is broken`);
    const missing = entries.filter(e => !existsSync(join(REPO_ROOT, e.built))).map(e => e.built);
    assert.deepEqual(missing, [], 'tracked sources with no built module: run `npm run build:server` before this gate');
    for (const leaf of ['server/src/sync/incoming-schemas.ts', 'server/src/sync/authored-content.ts']) {
      assert.ok(entries.some(e => e.file === leaf), `${leaf} is not a module of the tree: the load order of the schema leaf and the hash leaf is not covered`);
    }
  });

  it('each one loads as the first and only import of a fresh process', { timeout: 600_000 }, async () => {
    const run = entries.filter(e => !(e.file in NOT_IMPORTABLE));
    const results = await loadAll(run);
    const failed = [...results].filter(([, r]) => !r.ok).map(([file, r]) => `${file.replace('server/src/', '')}: ${r.detail}`);
    assert.deepEqual(failed, [], 'these modules fail to load when they are the entry module: an import cycle whose binding is read at load, or a module that needs another to have been loaded first');
  });

  it('every exemption still names a module, and that module still refuses to load', async () => {
    for (const [file, why] of Object.entries(NOT_IMPORTABLE)) {
      assert.ok(why.length > 25, `${file}: an exemption owes its reason`);
      const e = entries.find(x => x.file === file);
      assert.ok(e, `${file} is exempt and no longer a module of the tree`);
      const r = await loadInFreshProcess(pathToFileURL(join(REPO_ROOT, e.built)).href);
      assert.equal(r.ok, false, `${file} loads now: drop its exemption`);
    }
  });
});
