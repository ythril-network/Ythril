/**
 * A personal view's merged page keeps its order under any projection (`Q-446` item 4, R8).
 *
 * ## The defect
 *
 * `filter` over a view with more than one member reads a window from each member and merges them with
 * `compareBySort(order)` — over the rows AS PROJECTED. A row missing a sort key sorts last, so a projection that
 * leaves the order keys out (`{fact: 1}`, `{seq: 0}`, `{_id: 0, ...}`) merges the members by whatever keys are left,
 * and the page comes back in an order the caller did not ask for, with a 200. Each member's own read is right; only
 * the merge is wrong, which is why a single-space test can never see it.
 *
 * ## The rule this holds
 *
 *  - in inclusion mode the order keys and `_id` are read for the merge; in exclusion mode a caller's exclusion of an
 *    order key or `_id` is lifted for it; either way they are stripped again before the page is answered, so the
 *    caller sees exactly what the projection asked for;
 *  - a caller path that shares an order key's FIRST segment (`type.x` under `sort: type`) is left alone, and the
 *    merge orders by the caller's value of that segment — documented, and asserted here as such.
 *
 * ## How it is asked
 *
 * A property test over projections x orders, on the REST tool door and MCP: the merged answer must equal every row of
 * both members, ordered by the requested order over the STORED rows (a literal comparator, never the code's), then
 * projected by the rule — and the same when the merge is paged. The fixture orders `_id`, `createdAt` and `seq`
 * differently from each other, and ties `seq` across members, so a merge by any wrong key is a visible reorder.
 *
 * Run: a Mongo the harness accepts (`npm run test:up`), then
 *      node --test testing/standalone/a-personal-view-merge-keeps-its-order-under-any-projection-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors, viewOf, rowsOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'q446-qa';
const OPS = 'q446-ops';
const N = 6;

let d, admin, WITHHELD;
const VIEW = '@q446merge';

/** `_id` ascending where `seq` descends, and `createdAt` on a third order: any wrong key reorders the page. */
const CREATED_ORDER = [3, 0, 5, 1, 4, 2];
function factsOf(space, salt) {
  return Array.from({ length: N }, (_, i) => ({
    _id: `q446-${String(N - i).padStart(2, '0')}-${space}`,
    spaceId: space, fact: `fact ${i} of ${space}`, type: ['a', 'b', 'c'][i % 3], tags: [], seq: i + 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, CREATED_ORDER[i] * 2 + salt)).toISOString(),
    updatedAt: '2026-01-01T00:00:00.000Z',
    // No withheld field on these rows: `a-withheld-field-is-never-answered-on-any-door-db` owns that rule, and a leak
    // here would make every case red for a reason other than the merge.
    author: { instanceId: 'q446', instanceLabel: 'q446' },
  }));
}

/** The orders the filter tool documents, literally: the default and `{field, _id}` for a chosen sort. */
const ORDERS = [
  ['default (newest first)', {}, [['seq', -1], ['updatedAt', -1], ['createdAt', -1], ['_id', -1]]],
  ['sort createdAt asc', { sort: 'createdAt', dir: 'asc' }, [['createdAt', 1], ['_id', 1]]],
  ['sort type desc', { sort: 'type', dir: 'desc' }, [['type', -1], ['_id', -1]]],
];

/** A row missing a key sorts last in either direction, as the documented merge does. */
const comparatorOf = (keys) => (a, b) => {
  for (const [k, dir] of keys) {
    const av = a[k]; const bv = b[k];
    if (av === bv) continue;
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    return (av < bv ? -1 : 1) * dir;
  }
  return 0;
};

const truthy = (v) => v === 1 || v === true || v === '1';

/** The rule's answer for one stored row: withheld fields never; then the caller's projection, `_id` by Mongo's rule. */
function project(doc, proj) {
  const visible = Object.fromEntries(Object.entries(doc).filter(([k]) => !WITHHELD.includes(k)));
  if (!proj || Object.keys(proj).length === 0) return visible;
  const nonId = Object.keys(proj).filter(k => k !== '_id' && !WITHHELD.includes(k.split('.')[0]));
  const include = nonId.length > 0 ? nonId.some(k => truthy(proj[k])) : truthy(proj._id);
  if (include) {
    const out = {};
    const paths = nonId.filter(k => truthy(proj[k]));
    if (paths.length === 0 || !('_id' in proj) || truthy(proj._id)) out._id = doc._id;
    for (const p of paths) {
      const segs = p.split('.');
      let v = visible;
      for (const s of segs) v = v !== null && typeof v === 'object' ? v[s] : undefined;
      if (v === undefined) continue;
      let dst = out;
      for (const s of segs.slice(0, -1)) { dst[s] ??= {}; dst = dst[s]; }
      dst[segs.at(-1)] = v;
    }
    return out;
  }
  const out = structuredClone(visible);
  for (const k of nonId) delete out[k];
  if ('_id' in proj && !truthy(proj._id)) delete out._id;
  return out;
}

/** What the merge orders a row by: the stored value, except an order key a caller path shares the first segment of. */
function mergeKeyRow(doc, proj, keys) {
  const row = { ...doc };
  const callerPaths = Object.keys(proj ?? {}).filter(k => k !== '_id' && k.includes('.'));
  for (const [k] of keys) if (callerPaths.some(p => p.split('.')[0] === k)) row[k] = project(doc, proj)[k];
  return row;
}

const PROJECTIONS = [
  ['absent', undefined],
  ['{fact:1}', { fact: 1 }],
  ['{_id:0, fact:1}', { _id: 0, fact: 1 }],
  ['{seq:0}', { seq: 0 }],
  ['{createdAt:0, type:0}', { createdAt: 0, type: 0 }],
  ['{_id:0}', { _id: 0 }],
  ['{_id:1}', { _id: 1 }],
  ['{fact:1, seq:1}', { fact: 1, seq: 1 }],
];

let stored = [];

const DOORS = [
  ['REST POST /api/filter', async (args) => {
    const a = await d.rest(admin.key, 'POST', '/api/filter', args);
    return { ok: a.status === 200, rows: rowsOf(a), text: a.text };
  }],
  ['MCP filter', async (args) => {
    const a = await d.mcp(admin.key, 'filter', args);
    return { ok: !a.isError, rows: rowsOf(a), text: a.text };
  }],
];

describe('a personal view merge keeps its order under any projection', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q446-view-merge', spaces: [QA, OPS] });
    ({ NEVER_RETURNED_FIELDS: WITHHELD } = await import('../../server/dist/brain/recall-shape.js'));
    admin = await d.mint('q446-admin', {}, { admin: true });
    const v = await d.rest(admin.key, 'POST', '/api/views', { name: VIEW.slice(1), members: [QA, OPS] });
    assert.equal(viewOf(v)?.id, VIEW, `POST /api/views answered ${v.status} ${v.text.slice(0, 200)}`);
    for (const [s, salt] of [[QA, 0], [OPS, 1]]) {
      const docs = factsOf(s, salt);
      await d.col(`${s}_facts`).insertMany(docs);
      stored.push(...docs);
    }
  });
  after(async () => { await d?.close(); });

  it('fixture check: _id, createdAt and seq order the rows three different ways, and seq ties across members', () => {
    const by = (keys) => [...stored].sort(comparatorOf(keys)).map(r => r._id).join();
    const orders = new Set([by([['seq', -1], ['_id', -1]]), by([['_id', -1]]), by([['createdAt', -1], ['_id', -1]])]);
    assert.equal(orders.size, 3, 'two of the orders coincide, so a merge by the wrong key could go unseen');
    assert.equal(new Set(stored.map(r => r.seq)).size, N, 'seq must tie across members');
    assert.ok(WITHHELD.length >= 3);
  });

  for (const [door, ask] of DOORS) {
    for (const [orderLabel, sortArgs, keys] of ORDERS) {
      it(`${door}, ${orderLabel}: every projection answers both members' rows in the requested order, projected and nothing more`, async () => {
        const wrong = [];
        for (const [label, proj] of PROJECTIONS) {
          const want = [...stored].sort(comparatorOf(keys)).map(r => project(r, proj));
          const a = await ask({ space: VIEW, collection: 'facts', filter: {}, limit: 2 * N, ...sortArgs, ...(proj ? { projection: proj } : {}) });
          if (!a.ok) { wrong.push(`${label}: failed: ${a.text.slice(0, 160)}`); continue; }
          try { assert.deepEqual(a.rows, want); }
          catch { wrong.push(`${label}: answered ${JSON.stringify(a.rows.map(r => r._id ?? r.fact))} keys ${JSON.stringify(Object.keys(a.rows[0] ?? {}).sort())}; the rule gives ${JSON.stringify(want.map(r => r._id ?? r.fact))} keys ${JSON.stringify(Object.keys(want[0] ?? {}).sort())}`); }
        }
        assert.deepEqual(wrong, []);
      });

      it(`${door}, ${orderLabel}: paged through the merge, the pages tile the same order`, async () => {
        const wrong = [];
        for (const [label, proj] of PROJECTIONS) {
          const want = [...stored].sort(comparatorOf(keys)).map(r => project(r, proj));
          const got = [];
          for (let skip_ = 0; skip_ < 2 * N; skip_ += 4) {
            const a = await ask({ space: VIEW, collection: 'facts', filter: {}, limit: 4, skip: skip_, ...sortArgs, ...(proj ? { projection: proj } : {}) });
            if (!a.ok) { wrong.push(`${label} skip ${skip_}: failed: ${a.text.slice(0, 160)}`); break; }
            got.push(...a.rows);
          }
          try { assert.deepEqual(got, want); } catch { wrong.push(`${label}: pages answered ${JSON.stringify(got.map(r => r._id ?? r.fact))}`); }
        }
        assert.deepEqual(wrong, []);
      });
    }

    it(`${door}: a caller path sharing an order key's first segment is left alone, and the merge orders by the caller's value of it (documented)`, async () => {
      const keys = [['type', -1], ['_id', -1]];
      const proj = { 'type.x': 1, fact: 1 };
      const want = [...stored].sort((a, b) => comparatorOf(keys)(mergeKeyRow(a, proj, keys), mergeKeyRow(b, proj, keys))).map(r => project(r, proj));
      const a = await ask({ space: VIEW, collection: 'facts', filter: {}, limit: 2 * N, sort: 'type', dir: 'desc', projection: proj });
      assert.ok(a.ok, a.text.slice(0, 200));
      assert.deepEqual(a.rows, want, 'the merge widened a caller path, or ordered by a value the caller did not receive');
    });
  }
});
