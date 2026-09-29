/**
 * `filter`'s `total` counts the same predicate its rows were read with (`Q-160`).
 *
 * The platform operator, 2026-09-29: `fromName` answered `count: 2, total: 86, truncated: false` on a space holding
 * 86 edges. The rows were read with the per-member predicate the names had resolved into; `total` was counted with
 * the caller's bare `filter`. Two predicates for one answer is the defect, whatever the conveniences are.
 *
 * The behaviour, on both doors, is `testing/integration/filter-answers-by-entity-name.test.js`. This is the part of
 * it a machine without the stack can see fail: the count and the read take the same predicate.
 *
 * Run: node --test testing/standalone/filter-total-counts-what-the-page-reads.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const src = stripComments(readFileSync('server/src/mcp/tools/filter.ts', 'utf8'));

describe('filter counts what the page reads', () => {
  it('the rows are read with the per-member predicate', () => {
    assert.match(src, /queryBrain\(mid, coll, await filterFor\(mid\)/, 're-point this gate: the read no longer calls filterFor');
  });

  it('and the total is counted with the same one', () => {
    // The argument list up to the end of its line: `[^)]*` would stop inside `filterFor(mid)` itself.
    const counts = [...src.matchAll(/countBrain\(([^\n]*)/g)].map(m => m[1]);
    assert.ok(counts.length >= 1, 'found no countBrain call — re-point this gate');
    for (const args of counts) {
      assert.match(args, /^mid, coll, await filterFor\(mid\)/, `total is counted with another predicate than the rows: countBrain(${args}`);
    }
  });
});
