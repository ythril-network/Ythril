/**
 * A module that does not finish loading inside the bound is loaded once more, alone; one that throws is a finding at once (Q-871, bundle-316).
 *
 * ## The defect this refuses
 *
 * The entry-module gate was made CI-only because, run on a loaded machine, it "exceeded its own 30 s per-module bound and reported a load failure that was not
 * one". Cut into twelve shard files, two of the first three runs of all twelve together each lost one module to that bound and the next five lost none: a stall
 * of the machine, reported as a finding. A gate that fails on machine load is flaky, and one that retries without saying so hides a real slowdown.
 *
 * ## The rule, asserted on planted modules with a short bound passed as a parameter
 *
 * - A module that never settles is a finding, and its reason says it was tried twice (and keeps the child's last stderr lines).
 * - A module that stalls past the bound on its first load and loads at once on its second (a marker file decides which load it is) is NOT a finding, and the
 *   answer names it as retried, with both outcomes, so a stall is visible and countable.
 * - A module that throws is a finding after ONE load, never two (the loads are counted), and is not named as retried. So is one that cannot start (a module
 *   that is not there).
 *
 * Run: node --test testing/standalone/an-entry-module-load-retries-a-stall-once-and-a-throw-never.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { loadAll } from './_entry-module-load.mjs';

const BOUND_MS = 2500;

describe('loadAll retries a stall once, and a throw never', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'entry-retry-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** A planted module: written under the temporary folder, named the way a built module is (relative to the repository root). */
  const plant = (name, code) => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, code);
    return { file: `planted/${name}.ts`, built: relative(REPO_ROOT, path) };
  };
  const json = (text) => JSON.stringify(text);

  it('a module that never settles is a finding, and says it was tried twice', async () => {
    const loads = join(dir, 'never.count');
    const m = plant('never', `import { appendFileSync } from 'node:fs'; appendFileSync(${json(loads)}, 'x'); setInterval(() => {}, 1000); await new Promise(() => {});`);
    const results = await loadAll([m], { parallel: 1, boundMs: BOUND_MS });
    const r = results.get(m.file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /did not finish loading/);
    assert.match(r.reason, /twice/, 'the finding does not say the module was tried twice');
    assert.equal(readFileSync(loads, 'utf8').length, 2, 'a module that never settles was loaded other than twice');
    assert.deepEqual(results.retried.map(x => x.file), [m.file], 'the retry is not named');
  });

  it('a module that stalls on its first load and loads at once on its second is not a finding, and is named as retried with both outcomes', async () => {
    const marker = join(dir, 'stall.marker');
    const m = plant('stall', `import { existsSync, writeFileSync } from 'node:fs'; if (!existsSync(${json(marker)})) { writeFileSync(${json(marker)}, ''); setInterval(() => {}, 1000); await new Promise(() => {}); }`);
    const results = await loadAll([m], { parallel: 1, boundMs: BOUND_MS });
    assert.equal(results.get(m.file).ok, true, `a stall that loads the second time was a finding: ${results.get(m.file).reason}`);
    assert.equal(existsSync(marker), true);
    assert.equal(results.retried.length, 1, 'the retry is not named');
    const [retry] = results.retried;
    assert.equal(retry.file, m.file);
    assert.match(retry.first, /did not finish loading/, 'the first outcome is not said');
    assert.equal(retry.second, 'loaded', 'the second outcome is not said');
  });

  it('a module that throws is a finding after one load, never retried', async () => {
    const loads = join(dir, 'throws.count');
    const m = plant('throws', `import { appendFileSync } from 'node:fs'; appendFileSync(${json(loads)}, 'x'); throw new Error('planted failure');`);
    const results = await loadAll([m], { parallel: 1, boundMs: BOUND_MS });
    const r = results.get(m.file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /planted failure/);
    assert.doesNotMatch(r.reason, /twice/);
    assert.equal(readFileSync(loads, 'utf8').length, 1, 'a module that throws was loaded more than once');
    assert.deepEqual(results.retried, [], 'a throw was named as retried');
  });

  it('a module that is not there is a finding at once, never retried', async () => {
    const m = { file: 'planted/missing.ts', built: relative(REPO_ROOT, join(dir, 'missing.mjs')) };
    const results = await loadAll([m], { parallel: 1, boundMs: BOUND_MS });
    assert.equal(results.get(m.file).ok, false);
    assert.deepEqual(results.retried, []);
  });

  it('a stall is retried after the pool has drained: the retry runs alone', async () => {
    // Two stalling modules at width 1: a retry run inside the pool, right after its own stall, would come before the second module's first load. Run after the
    // pool has drained, both first loads come before either retry.
    const order = join(dir, 'order.log');
    const stalling = (name) => plant(name, `import { existsSync, writeFileSync, appendFileSync } from 'node:fs'; const marker = ${json(join(dir, `${name}.marker`))}; appendFileSync(${json(order)}, '${name}:' + (existsSync(marker) ? 'second' : 'first') + '\\n'); if (!existsSync(marker)) { writeFileSync(marker, ''); setInterval(() => {}, 1000); await new Promise(() => {}); }`);
    const a = stalling('alone-a');
    const b = stalling('alone-b');
    const results = await loadAll([a, b], { parallel: 1, boundMs: BOUND_MS });
    assert.equal(results.get(a.file).ok && results.get(b.file).ok, true);
    assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), ['alone-a:first', 'alone-b:first', 'alone-a:second', 'alone-b:second'], 'a retry ran before the pool had drained');
  });
});
