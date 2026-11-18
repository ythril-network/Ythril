/**
 * The cases of one shard of the entry-module gate, as data (Q-871, bundle-316), so the shard files are one loop each and not copies of a suite.
 *
 * ## What it prevents
 *
 * Cutting one test file into shard files with each holding a copy of the suite would make the rule (every server module loads as the first import of a
 * process) one spelling per file, each free to drift. A shard file says WHICH slice it loads and how wide; this says what a slice must satisfy:
 *
 * - every module of the slice has a built file (run `npm run build:server` first) and loads;
 * - shard 0 alone also holds what is about the whole tree and needs asking once: the loader's own cases (three planted modules), the floor and the two
 *   leaves of the body hash, and the exemption check (a module named as not importable still refuses to load). That the shards together are the whole
 *   list is `an-entry-module-load-finds-a-hang-and-the-shards-partition-the-modules.test.js`'s, asked once over the real list.
 *
 * It returns the cases and declares none: node records a test a helper declares under the HELPER, not the file that ran it
 * (`a-test-is-declared-where-it-runs`), so the shard file declares them with `it`.
 *
 * The module that loads and cuts is `_entry-module-load.mjs`.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { entryModules, loadInFreshProcess, loadAll, NOT_IMPORTABLE } from './_entry-module-load.mjs';

/**
 * @param {object} shard
 * @param {number} shard.index  0-based; shard 0 also holds the whole-tree cases
 * @param {{file: string, built: string}[]} shard.modules  this shard's slice (`shardOf(entryModules(), index, SHARDS)`)
 * @param {number} shard.parallel  children at a time
 * @returns {Array<{ name: string, options: object, run: () => unknown }>} each declared as `it(name, options, run)`
 */
export function shardCases({ index, modules, parallel }) {
  const cases = [];
  const everything = index === 0 ? entryModules() : null;

  if (everything) {
    cases.push({
      name: 'the loader reports what it should: a module that loads is ok, one that throws is a finding with its error',
      options: {},
      run: async () => {
        assert.equal((await loadInFreshProcess('data:text/javascript,export const a = 1;')).ok, true);
        const thrown = await loadInFreshProcess('data:text/javascript,throw new Error("temporal dead zone stand-in");');
        assert.equal(thrown.ok, false);
        assert.match(thrown.reason, /temporal dead zone stand-in/);
        assert.equal((await loadInFreshProcess('data:text/javascript,import "node:no-such-builtin";')).ok, false);
      },
    });
    cases.push({
      name: 'the set is the whole built tree (floor), and holds the two leaves of the body hash',
      options: {},
      run: () => {
        assert.ok(everything.length >= 300, `only ${everything.length} server module(s) found: the derivation is broken`);
        for (const leaf of ['server/src/sync/incoming-schemas.ts', 'server/src/sync/authored-content.ts']) {
          assert.ok(everything.some(e => e.file === leaf), `${leaf} is not a module of the tree: the load order of the schema leaf and the hash leaf is not covered`);
        }
      },
    });
  }

  cases.push({
    name: 'the slice holds modules, and each has a built file',
    options: {},
    run: () => {
      assert.ok(modules.length > 0, `shard ${index + 1} holds no module: it would pass and test nothing`);
      const missing = modules.filter(e => !existsSync(join(REPO_ROOT, e.built))).map(e => e.built);
      assert.deepEqual(missing, [], 'tracked sources with no built module: run `npm run build:server` before this gate');
    },
  });

  cases.push({
    name: 'each one loads as the first and only import of a fresh process',
    options: { timeout: 600_000 },
    run: async (t) => {
      const results = await loadAll(modules.filter(e => !(e.file in NOT_IMPORTABLE)), { parallel });
      // A module that stalled and loaded the second time is not a finding, and is said here so a stall is visible and countable, never swallowed.
      for (const r of results.retried) t.diagnostic(`entry-module load retried: ${r.file}: first try ${r.first}; second try ${r.second}`);
      const failed = [...results].filter(([, r]) => !r.ok).map(([file, r]) => `${file.replace('server/src/', '')}: ${r.reason}`);
      assert.deepEqual(failed, [], 'these modules fail to load when they are the entry module: an import cycle whose binding is read at load, or a module that needs another to have been loaded first');
    },
  });

  if (everything) {
    cases.push({
      name: 'every exemption still names a module, and that module still refuses to load',
      options: {},
      run: async () => {
        for (const [file, why] of Object.entries(NOT_IMPORTABLE)) {
          assert.ok(why.length > 25, `${file}: an exemption owes its reason`);
          const e = everything.find(x => x.file === file);
          assert.ok(e, `${file} is exempt and no longer a module of the tree`);
          const r = await loadInFreshProcess(pathToFileURL(join(REPO_ROOT, e.built)).href);
          assert.equal(r.ok, false, `${file} loads now: drop its exemption`);
        }
      },
    });
  }
  return cases;
}
