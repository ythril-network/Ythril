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
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { pageList } = await import('../../server/dist/brain/list-page.js').catch(() => ({
  pageList: () => assert.fail('server/dist/brain/list-page.js does not exist — the shared page rule is missing'),
}));

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

  it('numeric strings from a query string are read as numbers', () => {
    const r = pageList(rows(10), { limit: '4', skip: '2' }, { defaultLimit: 50 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows.map(x => x.i), [2, 3, 4, 5]);
  });
});

/**
 * The lists 5.6.x carries the rule for (`Q-130`, `Q-129`) answer through it, rather than through a slice of their own.
 *
 * Read from source, with comments stripped, because the cut these replaced was a one-line `.slice(0, N)` in the
 * route and the regression is that line coming back. Each route's slice is located by the route's own path, so a
 * moved handler fails here rather than passing on nothing.
 */
describe('the notify event list and the schema dry-run answer through the page rule', () => {
  const handler = (file, anchor) => {
    const src = stripComments(readFileSync(file, 'utf8'));
    const at = src.indexOf(anchor);
    assert.ok(at > 0, `${anchor} is gone from ${file} — re-anchor this gate`);
    const next = src.indexOf('Router.', at + anchor.length);
    return src.slice(at, next > 0 ? next : src.length);
  };

  it('GET /api/notify pages through pageList and answers its fields (Q-130)', () => {
    const h = handler('server/src/api/notify.ts', "notifyRouter.get('/'");
    assert.match(h, /\bpageList\(/, 'the notify event list must page through brain/list-page.ts');
    assert.match(h, /\.\.\.page\.fields/, 'and answer the fields that say where it stands');
    assert.doesNotMatch(h, /\.slice\(0,/, 'a slice from 0 is the silent cut this replaced');
  });

  it('the schema dry-run pages its violations and says how much it checked (Q-129)', () => {
    const h = handler('server/src/api/spaces.ts', "'/:id/validate-schema'");
    assert.match(h, /\bpageList\(/, 'the violation list must page through brain/list-page.ts');
    assert.match(h, /\.\.\.page\.fields/, 'and answer the fields that say where it stands');
    assert.match(h, /\bchecked\b/, 'the answer must say how much of each collection was checked');
    assert.match(h, /\bcomplete:/, 'and whether that was all of it');
    assert.doesNotMatch(h, /violations\.slice\(0,/, 'a slice from 0 is the silent cut this replaced');
  });
});
