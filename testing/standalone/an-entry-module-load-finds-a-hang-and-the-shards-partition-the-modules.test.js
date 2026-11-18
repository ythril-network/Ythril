/**
 * The entry-module gate finds a hang within its bound, and its shard files together hold every module exactly once (Q-871, bundle-316).
 *
 * ## The defect this refuses
 *
 * `every-server-entry-module-loads.test.js` imports each of 866 server modules as the only import of a fresh node process: 120 to 204 s on CI in one
 * file, past the 60 s a file may take. The change cuts it into shard files that share one helper (`testing/standalone/_entry-module-load.mjs`:
 * `entryModules`, `loadInFreshProcess(specifier, { boundMs, env })`, `loadAll(modules, { parallel, boundMs })`, `shardOf(list, i, k)`, `SHARDS`,
 * `NOT_IMPORTABLE`), and gives the children a shared compile cache. Three things can go wrong quietly, and each is asserted:
 *
 * - **A module dropped between shards, or loaded twice.** The shards must partition `entryModules()`: the union is all of it, no two overlap, none is empty
 *   (a shard that holds nothing passes and tests nothing). Asserted over the real tree and over a plain list of any length.
 * - **A hang that is not reported as a finding.** The loader promised "or hangs" and no case planted one. A module that keeps the event loop alive and
 *   never settles must come back `ok: false`, "did not finish loading", within the bound. And one that also ignores `SIGTERM` must too: the bound kills
 *   with `SIGKILL`, because a polite kill leaves such a child holding its pipe open and the whole test file waits until the batch is killed, so the
 *   answer is a killed batch and not a finding. (A hang with no handle exits 13 on its own and reads as a load error, so the planted ones keep a handle.)
 * - **A cold cache in every child.** The children get `NODE_COMPILE_CACHE` (node 22.1 or later), a directory the run shares, which cut the load of the
 *   database driver from 161 to 95 ms: the helper takes `env` for the child and names the variable in its code.
 *
 * The helper does not exist on the unchanged code: each case imports it through `importOrFail`, so the red line names the missing module.
 *
 * Run: node --test testing/standalone/an-entry-module-load-finds-a-hang-and-the-shards-partition-the-modules.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { importOrFail } from '../_shared/import-or-fail.mjs';

const HELPER = 'testing/standalone/_entry-module-load.mjs';
const helper = () => importOrFail(HELPER, 'entryModules, loadInFreshProcess, loadAll, shardOf, SHARDS and NOT_IMPORTABLE for the entry-module shards');
/** A module as a data: URL, so a planted case needs no file. */
const dataModule = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
/** What names a module in a shard: a source path, or the module itself when the list holds plain strings. */
const idOf = (m) => (typeof m === 'string' ? m : m.file);

describe('the shards partition the modules', () => {
  it('SHARDS is a count of at least two, and the shards of the real module list are exactly the list, with no overlap and none empty', async () => {
    const { entryModules, shardOf, SHARDS } = await helper();
    assert.ok(Number.isInteger(SHARDS) && SHARDS >= 2, `SHARDS is ${SHARDS}`);
    const all = entryModules();
    assert.ok(all.length >= 300, `only ${all.length} entry module(s): the derivation is broken`);
    const shards = Array.from({ length: SHARDS }, (_, i) => shardOf(all, i, SHARDS).map(idOf));
    const seen = shards.flat();
    assert.equal(new Set(seen).size, seen.length, 'a module is in two shards: it loads twice');
    assert.deepEqual([...seen].sort(), all.map(idOf).sort(), 'the shards are not the whole module list: a module is in no shard and loads nowhere');
    shards.forEach((s, i) => assert.ok(s.length > 0, `shard ${i} holds no module: its file would pass and test nothing`));
  });

  it('over a plain list of any length and any shard count the slices are a partition of it, whatever order the list came in', async () => {
    const { shardOf } = await helper();
    for (const n of [7, 8, 23, 64, 101]) {
      const list = Array.from({ length: n }, (_, i) => `m-${String((i * 37) % n).padStart(3, '0')}-${i}`);
      for (const k of [1, 2, 3, 4, 5, 7]) {
        if (k > n) continue;
        const slices = Array.from({ length: k }, (_, i) => shardOf(list, i, k));
        const flat = slices.flat();
        assert.equal(new Set(flat).size, flat.length, `n ${n}, k ${k}: a module is in two slices`);
        assert.deepEqual([...flat].sort(), [...list].sort(), `n ${n}, k ${k}: the slices are not the list`);
        slices.forEach((s, i) => assert.ok(s.length > 0, `n ${n}, k ${k}: slice ${i} is empty`));
        const reversed = Array.from({ length: k }, (_, i) => shardOf([...list].reverse(), i, k));
        assert.deepEqual(reversed, slices, `n ${n}, k ${k}: the slices follow the order the list came in, not the sorted list`);
      }
    }
  });

  it('the one module that refuses to be imported stays named, with its reason', async () => {
    const { NOT_IMPORTABLE } = await helper();
    const entries = NOT_IMPORTABLE instanceof Map ? [...NOT_IMPORTABLE] : Object.entries(NOT_IMPORTABLE);
    const embed = entries.find(([file]) => file === 'server/src/brain/embed-process.ts');
    assert.ok(embed, 'the embedding child is no longer named as not importable');
    assert.ok(String(embed[1]).length > 25, 'the exemption owes its reason');
  });
});

describe('the loader reports a hang as a finding, within the bound', () => {
  const HANG = 'setInterval(() => {}, 1000); await new Promise(() => {});';
  const BOUND_MS = 2000;
  /** The answer and the time it took: a finding that arrives at the batch's bound is not one. */
  const timed = async (specifier, options) => {
    const { loadInFreshProcess } = await helper();
    const started = Date.now();
    const answer = await loadInFreshProcess(specifier, options);
    return { answer, ms: Date.now() - started };
  };

  it('a module that loads is ok, and one that throws or needs a builtin that is not there is a finding with its error', async () => {
    const { loadInFreshProcess } = await helper();
    assert.equal((await loadInFreshProcess(dataModule('export const a = 1;'), { boundMs: 10_000 })).ok, true);
    const thrown = await loadInFreshProcess(dataModule('throw new Error("temporal dead zone stand-in");'), { boundMs: 10_000 });
    assert.equal(thrown.ok, false);
    assert.match(thrown.reason, /temporal dead zone stand-in/);
    assert.equal((await loadInFreshProcess(dataModule('import "node:no-such-builtin";'), { boundMs: 10_000 })).ok, false);
  });

  it('a module that keeps the loop alive and never settles comes back ok:false, "did not finish loading", within the bound', async () => {
    const { answer, ms } = await timed(dataModule(HANG), { boundMs: BOUND_MS });
    assert.equal(answer.ok, false);
    assert.match(answer.reason, /did not finish loading/);
    assert.ok(ms < BOUND_MS + 6000, `the finding took ${ms} ms against a bound of ${BOUND_MS} ms`);
  });

  it('one that also ignores SIGTERM comes back the same way within the bound (the bound kills with SIGKILL)', async () => {
    const { answer, ms } = await timed(dataModule(`process.on('SIGTERM', () => {}); ${HANG}`), { boundMs: BOUND_MS });
    assert.equal(answer.ok, false);
    assert.match(answer.reason, /did not finish loading/);
    assert.ok(ms < BOUND_MS + 6000, `a child that ignores SIGTERM held the answer ${ms} ms against a bound of ${BOUND_MS} ms`);
  });
});

describe('the children share a compile cache', () => {
  it('the loader hands the child the environment it is given (so the run\'s cache directory reaches it)', async () => {
    const { loadInFreshProcess } = await helper();
    const answer = await loadInFreshProcess(
      dataModule('throw new Error("seen=" + process.env.B316_PLANT + " cache=" + process.env.NODE_COMPILE_CACHE);'),
      { boundMs: 10_000, env: { B316_PLANT: 'yes', NODE_COMPILE_CACHE: '/planted/cache/dir' } },
    );
    assert.equal(answer.ok, false);
    assert.match(answer.reason, /seen=yes/, 'the child did not get the environment it was handed');
    assert.match(answer.reason, /cache=\/planted\/cache\/dir/, 'the child did not get NODE_COMPILE_CACHE');
  });

  it('the helper names NODE_COMPILE_CACHE in its code, not only in a comment', async () => {
    await helper();
    assert.match(stripComments(readFileSync(join(REPO_ROOT, HELPER), 'utf8')), /NODE_COMPILE_CACHE/, 'no code of the helper sets the variable: every child compiles every module cold');
  });
});

describe('the gate is SHARDS files, each a CI-only shard of the one helper', () => {
  it('has exactly SHARDS tracked entry-module files, each @ci-only, each taking its slice by shardOf and its width from availableParallelism', async () => {
    const { SHARDS } = await helper();
    const files = trackedSources('testing/standalone', { ext: ['.test.js'], floor: 100 }).filter(f => /\/every-server-entry-module-loads[^/]*\.test\.js$/.test(f));
    assert.equal(files.length, SHARDS, `${files.length} entry-module test file(s) for ${SHARDS} shards: ${files.join(', ')}`);
    for (const file of files) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      assert.match(text, /^\s*\*\s*@ci-only/m, `${file} is not @ci-only: it would run in every preflight`);
      assert.match(stripComments(text), /\bshardOf\(/, `${file} does not take its slice by shardOf`);
      assert.match(stripComments(text), /\bavailableParallelism\(/, `${file} does not size its children from availableParallelism`);
      assert.doesNotMatch(stripComments(text), /\bPARALLEL\s*=\s*8\b/, `${file} still runs eight children`);
    }
  });

  /**
   * What is wrong with the shard indices a set of shard files declares (`const SHARD = <n>`), as sentences: each file names its own slice, and the slices
   * are exactly 0 to count-1, one file each. Two files with one index would load one slice twice and another never, and every file would be green.
   * @param {Array<{ file: string, text: string }>} files
   */
  const indexProblems = (files, count) => {
    const problems = [];
    const seen = new Map();
    for (const { file, text } of files) {
      const index = /^const SHARD = (\d+);/m.exec(stripComments(text))?.[1];
      const named = /-(\d+)-of-(\d+)\.test\.js$/.exec(file);
      if (index === undefined) { problems.push(`${file} declares no \`const SHARD = <n>;\``); continue; }
      if (named && Number(named[1]) !== Number(index) + 1) problems.push(`${file} loads slice ${index}, which is not the shard its name says (${Number(named[1]) - 1})`);
      if (named && Number(named[2]) !== count) problems.push(`${file} says it is one of ${named[2]}, not ${count}`);
      seen.set(index, [...(seen.get(index) ?? []), file]);
    }
    for (const [index, owners] of seen) if (owners.length > 1) problems.push(`slice ${index} is loaded by ${owners.length} files (${owners.join(', ')})`);
    for (let i = 0; i < count; i++) if (!seen.has(String(i))) problems.push(`no file loads slice ${i}: its modules are loaded nowhere`);
    for (const index of seen.keys()) if (Number(index) >= count) problems.push(`slice ${index} is outside 0 to ${count - 1}`);
    return problems;
  };

  it('has each shard file load its own slice: the indices are exactly 0 to SHARDS-1, one file each, and the name says the same', async () => {
    const { SHARDS } = await helper();
    const files = trackedSources('testing/standalone', { ext: ['.test.js'], floor: 100 }).filter(f => /\/every-server-entry-module-loads[^/]*\.test\.js$/.test(f));
    assert.deepEqual(indexProblems(files.map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') })), SHARDS), []);
  });

  it('flags two files that load one slice, a slice nobody loads and a name that disagrees with the index (a planted set)', () => {
    const file = (n, index) => ({ file: `testing/standalone/every-server-entry-module-loads-${n}-of-3.test.js`, text: `const SHARD = ${index};\n` });
    assert.deepEqual(indexProblems([file(1, 0), file(2, 1), file(3, 2)], 3), []);
    assert.match(indexProblems([file(1, 0), file(2, 1), file(3, 1)], 3).join('\n'), /slice 1 is loaded by 2 files/);
    assert.match(indexProblems([file(1, 0), file(2, 1), file(3, 1)], 3).join('\n'), /no file loads slice 2/);
    assert.match(indexProblems([file(1, 0), file(2, 2), file(3, 1)], 3).join('\n'), /not the shard its name says/);
    assert.match(indexProblems([file(1, 0), file(2, 1), file(3, 5)], 3).join('\n'), /outside 0 to 2/);
  });
});
