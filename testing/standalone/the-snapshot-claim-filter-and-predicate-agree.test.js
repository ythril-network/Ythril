/**
 * The snapshot claim is ONE rule written twice (bundle-266, duplicated-rule pass, item 9): `claimFilters(fp, kept)` is the rule as the two Mongo filters
 * `claimKept` writes through, and `needsClaim(row, kept)` is the same rule as the predicate `ensureSchemaSnapshots` asks of a row it read before it
 * claims. Both in `server/src/spaces/schema-snapshot-store.ts`. A row the predicate passes over but a filter would claim is a mark the cycle never
 * clears (the sweep removes a current version); a row the predicate claims that no filter matches is a write per cycle that changes nothing.
 *
 * ## What it pins
 *
 * For every (current origin, target origin) pair, each with and without a sweep mark, the predicate answers exactly what the filters match: a row
 * needs a claim when either filter matches it. The filters are evaluated against a plain row by a matcher that knows exactly the operators they use
 * (equality, `$nin`, `$exists`) and throws on any other, so a filter that grows an operator fails here loud instead of being misread.
 *
 * ## Seen red
 *
 * With `needsClaim` mutated to let a layer row be claimed (`row.origin !== kept.origin` alone), the cases `layer -> own` and `layer -> fetched`
 * (unmarked) failed: the predicate said claim, no filter matches (log E:/TMP/Ythril/log/b266-merge-item9-red.log).
 *
 * Run: node --test testing/standalone/the-snapshot-claim-filter-and-predicate-agree.test.js (requires `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const FP = 'a'.repeat(64);
const ORIGINS = ['own', 'layer', 'fetched'];
const MARKS = [undefined, '2026-11-13T00:00:00.000Z'];

let store;
before(async () => { store = await import('../../server/dist/spaces/schema-snapshot-store.js'); });

/** Does `row` match the condition `cond` on one field? Only the operators the claim filters use; any other throws. */
function fieldMatches(value, cond) {
  if (cond === null || typeof cond !== 'object') return value === cond;
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$nin') return !arg.includes(value);
    if (op === '$exists') return (value !== undefined) === arg;
    throw new Error(`the claim filter uses ${op}, which this matcher does not know: teach it before trusting the comparison`);
  });
}

/** Does `row` match the filter `filter` (every field's condition)? */
const matches = (row, filter) => Object.entries(filter).every(([field, cond]) => fieldMatches(row[field], cond));

describe('the snapshot claim: the filters and the predicate are one rule', () => {
  for (const current of ORIGINS) for (const target of ORIGINS) for (const orphanSince of MARKS) {
    const name = `${current} -> ${target}${orphanSince ? ', marked' : ''}`;
    it(`a ${name} row: needsClaim answers what the filters match`, () => {
      const kept = { origin: target, links: null, ...(target === 'layer' ? { networkId: 'n1' } : {}) };
      const row = { _id: FP, origin: current, ...(orphanSince ? { orphanSince } : {}) };
      const filters = store.claimFilters(FP, kept);
      assert.ok(Array.isArray(filters) && filters.length > 0, 'claimFilters answers no filter');
      const byFilter = filters.some(f => matches(row, f));
      assert.equal(store.needsClaim(row, kept), byFilter,
        `${name}: needsClaim says ${!byFilter ? 'claim' : 'leave'}, the filters ${byFilter ? 'match' : 'match nothing'}`);
    });
  }

  it('a filter names the row it claims by its fingerprint, so another row is never claimed', () => {
    const kept = { origin: 'own', links: null };
    const other = { _id: 'b'.repeat(64), origin: 'fetched', orphanSince: MARKS[1] };
    assert.deepEqual(store.claimFilters(FP, kept).filter(f => matches(other, f)), []);
  });
});
