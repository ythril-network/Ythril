/**
 * Preflight's concurrent pure units together never run more offline test files at once than the cap (Q-863, bundle-310).
 *
 * ## What it prevents
 *
 * The flows' rule: a project's offline test files run concurrently, at most 8 at a time (convention-offline-tests-run-in-parallel).
 * Preflight runs several `node --test` units at once, each with its own `--test-concurrency`, so the files alive together are the units
 * times the workers per unit. The first pooled shape gave each unit `ceil(cores / units)` workers, which on this 8-core machine was three
 * units of three: one file past the cap, and more on any machine with more cores. The arithmetic lives in
 * `testing/_shared/offline-test-width.mjs` (`workersPerUnit`), so these cases hold it there, and a source case holds that preflight takes
 * its worker count from it rather than computing its own.
 *
 * Run: node --test testing/standalone/offline-test-files-run-at-most-the-cap-at-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const width = () => import('../_shared/offline-test-width.mjs');

describe('the workers each concurrent unit gets', () => {
  it('keeps units times workers within the cap and the cores, for every machine size and unit count', async () => {
    const { workersPerUnit, OFFLINE_TEST_FILE_CAP } = await width();
    assert.equal(OFFLINE_TEST_FILE_CAP, 8, 'the cap is the flows rule: at most 8 offline test files at a time');
    for (let cores = 1; cores <= 128; cores++) {
      for (let units = 1; units <= OFFLINE_TEST_FILE_CAP; units++) {
        const w = workersPerUnit(units, cores);
        assert.ok(Number.isInteger(w) && w >= 1, `${units} unit(s) on ${cores} core(s) got ${w} workers`);
        const ceiling = Math.max(units, Math.min(OFFLINE_TEST_FILE_CAP, cores));
        assert.ok(units * w <= ceiling, `${units} unit(s) of ${w} on ${cores} core(s) run ${units * w} files at once, past ${ceiling}`);
      }
    }
  });

  it('uses the whole cap when the machine has the cores for it', async () => {
    const { workersPerUnit } = await width();
    assert.equal(workersPerUnit(4, 8), 2);
    assert.equal(workersPerUnit(2, 16), 4);
    assert.equal(workersPerUnit(1, 64), 8);
  });

  it('refuses a unit count that is not an integer from 1 to the cap', async () => {
    const { workersPerUnit } = await width();
    for (const units of [0, -1, 1.5, 9, NaN, Infinity, '2', undefined]) {
      assert.throws(() => workersPerUnit(units, 8), RangeError, `units ${String(units)} was accepted`);
    }
  });
});

describe('preflight', () => {
  it('takes each pure unit\'s --test-concurrency from workersPerUnit and computes none of its own', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'preflight.mjs'), 'utf8');
    assert.match(src, /import \{[^}]*\bworkersPerUnit\b[^}]*\} from '\.\.\/testing\/_shared\/offline-test-width\.mjs'/,
      'scripts/preflight.mjs does not import workersPerUnit from testing/_shared/offline-test-width.mjs');
    const settings = [...src.matchAll(/--test-concurrency=\$\{([^}]*)\}/g)].map(m => m[1].trim());
    // Two stages run units (Q-870): the text stage and the pure stage. Each sets its own --test-concurrency, and each must take it from workersPerUnit, so
    // the files alive at once are the cap in whichever stage is running (the stages run one after the other, never beside each other).
    assert.ok(settings.length >= 2, `scripts/preflight.mjs sets ${settings.length} --test-concurrency value(s): the text stage and the pure stage each set one for their units`);
    for (const s of settings) {
      // A unit the recorded times put alone (Q-869, `.slow`) runs with one worker, the only other setting; every other unit takes workersPerUnit.
      assert.match(s, /^(?:[\w.[\]]+\.slow\s*\?\s*1\s*:\s*)?workersPerUnit\(\s*UNIT_WIDTH\s*\)$/, `preflight sets --test-concurrency=\${${s}}, not \${workersPerUnit(UNIT_WIDTH)} (or one worker for a unit that runs alone)`);
    }
  });
});
