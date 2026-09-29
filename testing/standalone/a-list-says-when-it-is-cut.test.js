/**
 * Every list the API answers says when it is cut, and can be read to the end (`bundle-34`).
 *
 * Owner rule, 2026-09-28: *"if i get a result i want to be sure i get what i asked for"* — whole rows, the cut
 * reported, the rest reachable. Five lists stopped at a number with nothing saying so: duplicates and contradictions at
 * 500, the notify event list at 200, the schema dry-run's violations at 500, a file's derived images at 200.
 *
 * `brain/list-page.ts` is the rule those lists answer through. This pins its contract; each list's own tests pin that
 * it uses it.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-list-says-when-it-is-cut.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageList, pageMemberList } from '../../server/dist/brain/list-page.js';

const rows = n => Array.from({ length: n }, (_, i) => ({ i, text: `row ${i}` }));

describe('a list says when it is cut', () => {
  it('a list that fits says so, and carries its total', () => {
    const r = pageList(rows(5), {}, { defaultLimit: 50 });
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 5);
    assert.equal(r.fields.total, 5);
    assert.equal(r.fields.truncated, false);
    assert.equal(r.fields.nextSkip, undefined);
  });

  it('a list longer than its limit is cut at a whole row, and nextSkip reaches every row', () => {
    const all = rows(123);
    const seen = [];
    let skip = 0;
    for (let pages = 0; pages < 20; pages++) {
      const r = pageList(all, { limit: 50, skip }, { defaultLimit: 50 });
      assert.equal(r.ok, true);
      seen.push(...r.rows.map(x => x.i));
      assert.equal(r.fields.total, 123);
      if (!r.fields.truncated) break;
      assert.equal(r.fields.nextSkip, skip + r.rows.length);
      skip = r.fields.nextSkip;
    }
    assert.deepEqual(seen, all.map(x => x.i), 'no row repeated, none missed');
  });

  it('the byte budget cuts at a whole row too, and says so the same way', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ i, text: 'x'.repeat(400) }));
    const r = pageList(big, { maxChars: 1000 }, { defaultLimit: 50 });
    assert.equal(r.ok, true);
    assert.ok(r.rows.length >= 1 && r.rows.length < 10);
    assert.equal(r.fields.truncated, true);
    assert.equal(r.fields.nextSkip, r.rows.length);
  });

  it('a limit above the ceiling is held to it and the answer says which limit applied', () => {
    const r = pageList(rows(10), { limit: 10_000 }, { defaultLimit: 50, maxLimit: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.fields.limit, 3);
    assert.equal(r.rows.length, 3);
    assert.equal(r.fields.truncated, true);
  });

  it('a bad skip or limit is refused, never floored to a default', () => {
    assert.equal(pageList(rows(3), { skip: -1 }, { defaultLimit: 50 }).ok, false);
    assert.equal(pageList(rows(3), { limit: 0 }, { defaultLimit: 50 }).ok, false);
    assert.equal(pageList(rows(3), { limit: 'abc' }, { defaultLimit: 50 }).ok, false);
  });

  it('a list across member spaces pages at the database and nextSkip reaches every row of every space', async () => {
    // Two spaces, sorted descending by score as the review lists are; 7 + 5 rows, pages of 4.
    const spaces = { s1: Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, score: 100 - i * 2 })),
      s2: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, score: 99 - i * 2 })) };
    const compare = (a, b) => (b.score - a.score) || a.id.localeCompare(b.id);
    const seen = [];
    let skip = 0;
    for (let pages = 0; pages < 10; pages++) {
      const r = await pageMemberList({
        members: ['s1', 's2'],
        readMember: async (m, limit, sk) => spaces[m].slice().sort(compare).slice(sk, sk + limit),
        countMember: async m => spaces[m].length,
        compare, req: { limit: 4, skip }, page: { defaultLimit: 50 }, ceiling: 100,
      });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.fields.total, 12);
      seen.push(...r.rows.map(x => x.id));
      if (!r.fields.truncated) break;
      skip = r.fields.nextSkip;
    }
    const all = [...spaces.s1, ...spaces.s2].sort(compare).map(x => x.id);
    assert.deepEqual(seen, all, 'in order, none repeated, none missed');
  });

  it('a merge deeper than its ceiling is refused with a sentence, not answered short', async () => {
    const r = await pageMemberList({ members: ['s1', 's2'], readMember: async () => [], countMember: async () => 0,
      compare: () => 0, req: { limit: 50, skip: 90 }, page: { defaultLimit: 50 }, ceiling: 100 });
    assert.equal(r.ok, false);
    assert.match(r.error, /must not exceed 100/);
  });

  it('numeric strings from a query string are read as numbers', () => {
    const r = pageList(rows(10), { limit: '4', skip: '2' }, { defaultLimit: 50 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows.map(x => x.i), [2, 3, 4, 5]);
  });
});
