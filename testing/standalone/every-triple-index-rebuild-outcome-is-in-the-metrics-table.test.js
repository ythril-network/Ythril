/**
 * Every outcome a triple index rebuild can end with is named in the guide's row for `ythril_rdf_index_rebuilds_total` (bundle-385, Q-985).
 *
 * ## The defect it prevents
 *
 * The counter's `outcome` label takes each value of `RebuildResult['outcome']` (server/src/rdf/triple-index/rebuild.ts) and `failed`. The
 * guide's metrics table listed every outcome but `held` (a space act held the space), added to the code after the row was written, so an
 * operator reading a `held` series found no word for it. The list is read from the type itself, so an outcome added later fails here until
 * the guide names it.
 *
 * Run: node --test testing/standalone/every-triple-index-rebuild-outcome-is-in-the-metrics-table.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** The quoted members of the `outcome` union of `RebuildResult` in rebuild.ts. */
function rebuildOutcomes() {
  const source = read('server/src/rdf/triple-index/rebuild.ts');
  const decl = /export interface RebuildResult\s*\{\s*outcome:\s*([^;]+);/.exec(source);
  assert.ok(decl, 'rebuild.ts declares RebuildResult with an outcome union');
  const outcomes = [...decl[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(outcomes.length >= 2, `the outcome union was read: ${decl[1]}`);
  return outcomes;
}

describe('every triple index rebuild outcome is in the metrics table', () => {
  it('the guide\'s ythril_rdf_index_rebuilds_total row names each outcome, and failed', () => {
    const row = read('docs/integration-guide/11-setup-api.md').split(/\r?\n/).find(l => l.startsWith('| `ythril_rdf_index_rebuilds_total`'));
    assert.ok(row, 'the guide has a row for ythril_rdf_index_rebuilds_total');
    const missing = [...rebuildOutcomes(), 'failed'].filter(o => !row.includes(`\`${o}\``));
    assert.deepEqual(missing, [], 'an outcome the counter can carry has no word in the guide\'s row');
  });
});
