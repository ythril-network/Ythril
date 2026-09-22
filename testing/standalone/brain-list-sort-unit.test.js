/**
 * Pure-function tests for the brain list-sort validation and the proxy page-cap.
 *
 * These need no database — they pin the two decisions that a database test cannot see cleanly:
 *
 *   1. `parseSortParam` is the whole of the "reject an unknown sort with 400" contract. The route
 *      only maps its `{ error }` to a 400, so if the whitelist stops rejecting, the route silently
 *      falls back to natural order — the exact no-op-control dishonesty the feature exists to avoid.
 *   2. `capPage` is what keeps a PROXY overflow honest: when the merged result is re-sorted, it must
 *      use the field/direction the caller asked for, not always `createdAt`. A client-only sort could
 *      never reorder across members; a server sort that capPage then overrode would be a lie too.
 *
 * Run: node --test testing/standalone/brain-list-sort-unit.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSortParam, toMongoSort, SORTABLE_FIELDS } from '../../server/dist/brain/list-sort.js';
import { capPage } from '../../server/dist/util/pagination.js';

describe('parseSortParam — the 400-on-unknown-sort contract', () => {
  const allowed = SORTABLE_FIELDS.entities; // createdAt, name, type

  it('returns no sort when the param is absent — default order is preserved', () => {
    assert.deepEqual(parseSortParam(undefined, undefined, allowed), { sort: undefined });
    assert.deepEqual(parseSortParam('', 'asc', allowed), { sort: undefined });
  });

  it('accepts a whitelisted field and maps asc/desc to 1/-1', () => {
    assert.deepEqual(parseSortParam('name', 'asc', allowed), { sort: { field: 'name', dir: 1 } });
    assert.deepEqual(parseSortParam('createdAt', 'desc', allowed), { sort: { field: 'createdAt', dir: -1 } });
  });

  it('defaults an absent dir to descending (newest-first)', () => {
    assert.deepEqual(parseSortParam('createdAt', undefined, allowed), { sort: { field: 'createdAt', dir: -1 } });
  });

  it('also accepts numeric 1/-1 directions', () => {
    assert.deepEqual(parseSortParam('name', '1', allowed), { sort: { field: 'name', dir: 1 } });
    assert.deepEqual(parseSortParam('name', '-1', allowed), { sort: { field: 'name', dir: -1 } });
  });

  it('REJECTS a field outside the whitelist — not a silent natural-order fallback', () => {
    const r = parseSortParam('embedding', 'asc', allowed);
    assert.ok('error' in r, 'an un-whitelisted field must be an error the route turns into 400');
    assert.match(r.error, /Cannot sort by 'embedding'/);
  });

  it('rejects a malformed direction', () => {
    const r = parseSortParam('name', 'sideways', allowed);
    assert.ok('error' in r);
    assert.match(r.error, /dir/);
  });

  it('rejects a non-string field (repeated ?sort= param arrives as an array)', () => {
    const r = parseSortParam(['name', 'type'], 'asc', allowed);
    assert.ok('error' in r);
  });

  it('each collection whitelist contains createdAt', () => {
    for (const [name, set] of Object.entries(SORTABLE_FIELDS)) {
      assert.ok(set.has('createdAt'), `${name} must allow sorting by createdAt`);
    }
  });

  // Columns the tables render but could not sort by until now. Each needs BOTH the whitelist entry (or the
  // route 400s) and a client header — the whitelist half is what this pins.
  it('allows the late-added columns: edges weight, chrono endsAt/status', () => {
    assert.ok(SORTABLE_FIELDS.edges.has('weight'), 'edges.weight is numeric — a natural sort');
    assert.ok(SORTABLE_FIELDS.chrono.has('endsAt'), 'chrono renders an Ends column');
    assert.ok(SORTABLE_FIELDS.chrono.has('status'), 'chrono renders a Status column');
  });

  // A rejected-by-design list, asserted so it is not "corrected" into the whitelist later. `properties` is
  // a free-form JSON blob with no single orderable value; the id arrays order by nothing a reader can see.
  it('keeps unsortable-by-nature fields OUT of every whitelist', async () => {
    // set-claim: `properties` plus every LINK field name -- the literal half is one field whose
    // unsortability is a fact about JSON, not a member of any set the source enumerates.
    /*
     * The link names come from the modules that define them, not from a list written here. Two sets, and
     * both matter: what a caller sends TODAY (`linkEntities` and its siblings, which are instructions to
     * write link records rather than stored values) and what a caller sent BEFORE 5.0 (`entityIds` and
     * its two siblings, now refused). A retired name reappearing in a sort whitelist would be a promise
     * to order by a field no document has.
     */
    const { LINK_INPUT_NAMES } = await import('../../server/dist/brain/write-connections.js');
    const { RETIRED_WRITE_FIELDS } = await import('../../server/dist/brain/retired-write-fields.js');
    const retired = Object.keys(RETIRED_WRITE_FIELDS);
    assert.ok(LINK_INPUT_NAMES.length >= 4,
      `only ${LINK_INPUT_NAMES.length} link input field(s) — the import is stale and this checks less`);
    assert.ok(retired.length >= 3,
      `only ${retired.length} retired link field(s) — the import is stale and this checks less`);
    for (const [name, set] of Object.entries(SORTABLE_FIELDS)) {
      for (const field of ['properties', ...LINK_INPUT_NAMES, ...retired]) {
        assert.ok(!set.has(field), `${name}.${field} must not be sortable — it has no orderable value`);
      }
    }
  });
});

describe('toMongoSort — deterministic paging tiebreaker', () => {
  it('appends _id in the same direction so a page boundary is stable under ties', () => {
    assert.deepEqual(toMongoSort({ field: 'name', dir: 1 }), { name: 1, _id: 1 });
    assert.deepEqual(toMongoSort({ field: 'createdAt', dir: -1 }), { createdAt: -1, _id: -1 });
  });
});

describe('capPage — proxy overflow honors the requested sort', () => {
  const rows = [
    { _id: 'b', name: 'banana', createdAt: '2026-01-02' },
    { _id: 'a', name: 'apple', createdAt: '2026-01-03' },
    { _id: 'c', name: 'cherry', createdAt: '2026-01-01' },
  ];

  it('returns rows untouched when under the limit (single-space path)', () => {
    assert.deepEqual(capPage(rows, 50), rows);
  });

  it('with no requested sort, an overflow falls back to createdAt desc (unchanged behavior)', () => {
    const out = capPage(rows, 2);
    assert.deepEqual(out.map(r => r._id), ['a', 'b']); // newest createdAt first
  });

  it('with a requested name-asc sort, an overflow re-sorts by name asc — NOT createdAt', () => {
    const out = capPage(rows, 2, { field: 'name', dir: 1 });
    assert.deepEqual(out.map(r => r._id), ['a', 'b']); // apple, banana
  });

  it('with a requested name-desc sort, an overflow re-sorts by name desc', () => {
    const out = capPage(rows, 2, { field: 'name', dir: -1 });
    assert.deepEqual(out.map(r => r._id), ['c', 'b']); // cherry, banana
  });
});
