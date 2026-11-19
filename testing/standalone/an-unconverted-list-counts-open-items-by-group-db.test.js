/**
 * The unconverted list answers `counts.openBy`: the open items of the space per kind, type and reason (bundle-285 slice 1, Q-938, plan section 4
 * first row and section 9 "Server (S1)").
 *
 * ## The rule
 *
 * - `counts.openBy` is a list of `{ kind, type, reason, n }`, one group for each (kind, type, reason) that holds an OPEN item, ordered by kind,
 *   then type, then reason. A group of dismissed items only is not in it. The sum of the `n` is `counts.open`.
 * - It is the whole space's, whatever the request narrows by: `kind`, `type`, `reason` (one or a list), `status`, `skip` and `limit` leave it as it
 *   was, as they leave `counts.open` and `counts.dismissed`.
 * - Through a personal view it is summed over the members the view reads: one group for a (kind, type, reason) several members hold, its `n` the sum.
 * - It holds at most 500 groups. Past that the answer carries the first 500 in that order and `counts.openByCut: true`; with 500 or fewer groups
 *   `openByCut` is absent and the sum is `counts.open`. A cut list does not sum to `counts.open`, and says so.
 * - It adds no unbounded scan. The items of a space are local to this instance, one for each record a conversion could not convert and swept when
 *   the record changes, and a run lists at most 10,000 of them (`UNCONVERTED_ITEMS_PER_RUN_MAX`); the collection has no index, and the list's own
 *   `counts` already read it twice. One grouped read of the open items per member answers it, and the group count the read returns is bounded by 501
 *   before it leaves the database.
 *
 * ## Why it matters
 *
 * The Review page shows one pill for each class of reasons, with the number of open items under it, and the record type filter offers the types that
 * hold open items. The page cannot get those numbers from `total` of a filtered list: that is the filter's, and the pills must not move when a pill
 * is chosen.
 *
 * ## What was wrong
 *
 * `counts` held only `open` and `dismissed`.
 *
 * Run: node --test testing/standalone/an-unconverted-list-counts-open-items-by-group-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';
import { openMountedDoor } from './_mounted-door.mjs';
import { itemRow, plant, ADMIN } from './_unconverted-fixture.mjs';

const skip = await mongoSkipReason();
const A = 'unconv-by-a';
const B = 'unconv-by-b';
const C = 'unconv-by-c';
const OPEN_BY_MAX = 500;

const BUDGET_KEYS = ['budgetChars', 'budgetBytes', 'charsReturned', 'bytesReturned'];
const withoutBudget = (body) => { const b = structuredClone(body); for (const k of BUDGET_KEYS) delete b[k]; return b; };
const sum = (groups) => groups.reduce((n, g) => n + g.n, 0);
const g = (kind, type, reason, n) => ({ kind, type, reason, n });

/** The rows of space A: nine open items in five groups, and dismissed ones in two groups of which one holds no open item. */
const rowsA = () => {
  let n = 0;
  const some = (count, over) => Array.from({ length: count }, () => itemRow(++n, over));
  return [
    ...some(3, { kind: 'entity', type: 'person', reason: 'not_conforming' }),
    ...some(1, { kind: 'entity', type: 'person', reason: 'fork' }),
    ...some(2, { kind: 'entity', type: 'org', reason: 'not_conforming' }),
    ...some(2, { kind: 'fact', type: 'claim', reason: 'no_case_matched' }),
    ...some(1, { kind: 'edge', type: 'knows', reason: 'relationship_exists' }),
    // Dismissed: they join no group, and a group of them alone is not listed.
    ...some(2, { kind: 'entity', type: 'person', reason: 'not_conforming', status: 'dismissed' }),
    ...some(1, { kind: 'entity', type: 'person', reason: 'step_refused', status: 'dismissed' }),
  ];
};
const GROUPS_A = [g('edge', 'knows', 'relationship_exists', 1), g('entity', 'org', 'not_conforming', 2), g('entity', 'person', 'fork', 1),
  g('entity', 'person', 'not_conforming', 3), g('fact', 'claim', 'no_case_matched', 2)];

/** `count` groups of one open item each: kind entity, reason not_conforming, types `<prefix>0000`... */
const manyGroups = (prefix, count, from = 0) => Array.from({ length: count }, (_, i) => itemRow(from + i + 1, {
  recordId: `${prefix}-${i}`, kind: 'entity', type: `${prefix}${String(from + i).padStart(4, '0')}`, reason: 'not_conforming',
}));

describe('the unconverted list counts the open items per kind, type and reason (real MongoDB)', { skip }, () => {
  let door, mounted, admin, acts;
  const list = async (space, params = {}, viewRead) => {
    const r = await acts.listUnconvertedAct(space, params, { rights: ADMIN, transport: 'rest' }, viewRead);
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.body;
  };
  const rest = (space, query = '') => mounted.rest(admin.key, 'GET', `/api/spaces/${space}/schema-convert/items${query}`);

  before(async () => {
    door = await openConvertDoor({ name: 'b285s1openby', spaces: [A, B, C] });
    acts = await import('../../server/dist/spaces/unconverted-acts.js');
    mounted = await openMountedDoor();
    admin = await mounted.mint('openby-admin', 'admin');
  });
  after(async () => { await mounted?.close(); await door?.close(); });

  it('lists one group for each kind, type and reason that holds an open item, in that order, and the groups sum to counts.open', async () => {
    await plant(door, A, rowsA());
    const body = await list(A);
    assert.deepEqual(body.counts.openBy, GROUPS_A, 'the groups of the open items, ordered by kind, type and reason');
    assert.equal(sum(body.counts.openBy), body.counts.open, 'the groups do not sum to counts.open');
    assert.deepEqual([body.counts.open, body.counts.dismissed], [9, 3]);
    assert.equal('openByCut' in body.counts, false, 'a list of five groups is not cut');
    assert.deepEqual(Object.keys(body.counts.openBy[0]).sort(), ['kind', 'n', 'reason', 'type'], 'a group names exactly its three keys and its count');
  });

  it('leaves dismissed items out: a group of dismissed items alone is not listed, and one dismissal moves exactly its group', async () => {
    await plant(door, A, rowsA());
    const before = await list(A);
    assert.ok(!before.counts.openBy.some(x => x.reason === 'step_refused'), 'a group of dismissed items alone is listed');
    assert.equal(before.counts.openBy.find(x => x.type === 'person' && x.reason === 'not_conforming').n, 3, 'the two dismissed items of that group were counted');
    const one = before.items[0];
    const done = await acts.dismissUnconvertedAct(A, one.itemId, { rights: ADMIN, transport: 'rest' });
    assert.equal(done.status, 200);
    const after = await list(A);
    const moved = before.counts.openBy.map(x => (x.kind === one.kind && x.type === one.type && x.reason === one.reason ? { ...x, n: x.n - 1 } : x)).filter(x => x.n > 0);
    assert.deepEqual(after.counts.openBy, moved, 'a dismissal moved a group that is not the item\'s');
    assert.equal(sum(after.counts.openBy), after.counts.open);
    assert.equal(after.counts.open, before.counts.open - 1);
  });

  it('is the whole space\'s whatever the request narrows by: kind, type, reason, a list of reasons, status, skip and limit', async () => {
    await plant(door, A, rowsA());
    const whole = (await list(A)).counts;
    for (const params of [
      { kind: 'entity' }, { type: 'org' }, { reason: 'fork' }, { reason: ['fork', 'no_case_matched'] }, { reason: 'not_conforming,fork' }, { status: 'dismissed' },
      { kind: 'fact', type: 'claim', reason: 'no_case_matched' }, { kind: 'edge', status: 'dismissed' }, { limit: 1 }, { skip: 4, limit: 2 }, { skip: 100 },
      { kind: 'chrono' },
    ]) {
      const body = await list(A, params);
      assert.deepEqual(body.counts, whole, `${JSON.stringify(params)} changed the counts`);
    }
    for (const query of ['?kind=entity&reason=fork,not_conforming', '?status=dismissed', '?type=nothing-has-this']) {
      const a = await rest(A, query);
      assert.deepEqual(a.body.counts, whole, `${query} on REST changed the counts`);
    }
    const empty = await list(A, { type: 'nothing-has-this' });
    assert.deepEqual([empty.items, empty.total], [[], 0], 'the narrowing took effect');
  });

  it('is the same on REST and on MCP, and a space with no items says an empty list', async () => {
    await plant(door, A, rowsA());
    const viaRest = await rest(A);
    const viaTool = await mounted.mcp(admin.key, 'list_unconverted', { space: A });
    assert.equal(viaTool.isError, false, viaTool.text);
    assert.deepEqual(viaRest.body.counts.openBy, GROUPS_A);
    assert.deepEqual(withoutBudget(viaTool.body), withoutBudget(viaRest.body), 'the two doors answered different bodies');
    await plant(door, C, []);
    const none = await list(C);
    assert.deepEqual(none.counts, { open: 0, dismissed: 0, openBy: [] }, 'a space with no item answers an empty list of groups, never an absent one');
  });

  it('through a personal view it sums the members: a group two members hold is one group with the sum, and the sum is counts.open', async () => {
    await plant(door, A, rowsA());
    await plant(door, B, [
      itemRow(100, { recordId: 'b1', kind: 'entity', type: 'person', reason: 'not_conforming' }),
      itemRow(101, { recordId: 'b2', kind: 'entity', type: 'person', reason: 'not_conforming' }),
      itemRow(102, { recordId: 'b3', kind: 'entity', type: 'person', reason: 'conversion_failed' }),
      itemRow(103, { recordId: 'b4', kind: 'chrono', type: 'event', reason: 'version_ceiling' }),
      itemRow(104, { recordId: 'b5', kind: 'fact', type: 'claim', reason: 'no_case_matched', status: 'dismissed' }),
    ]);
    const body = await list(A, {}, [A, B]);
    assert.deepEqual(body.counts.openBy, [
      g('chrono', 'event', 'version_ceiling', 1), g('edge', 'knows', 'relationship_exists', 1), g('entity', 'org', 'not_conforming', 2),
      g('entity', 'person', 'conversion_failed', 1), g('entity', 'person', 'fork', 1), g('entity', 'person', 'not_conforming', 5),
      g('fact', 'claim', 'no_case_matched', 2),
    ], 'the view\'s groups are the members\' groups added by (kind, type, reason)');
    assert.equal(sum(body.counts.openBy), body.counts.open);
    assert.deepEqual([body.counts.open, body.counts.dismissed], [13, 4]);
    // The member order of the view does not change the answer, and the filters still do not.
    assert.deepEqual((await list(A, {}, [B, A])).counts, body.counts);
    assert.deepEqual((await list(A, { kind: 'chrono', reason: 'version_ceiling' }, [A, B])).counts, body.counts);
    // One member alone is its own.
    assert.deepEqual((await list(A, {}, [A])).counts.openBy, GROUPS_A);
  });

  it('holds at most 500 groups: with exactly 500 it is whole, with 501 it is the first 500 in order and says it was cut', async () => {
    await plant(door, A, manyGroups('t', OPEN_BY_MAX));
    const whole = await list(A);
    assert.equal(whole.counts.openBy.length, OPEN_BY_MAX);
    assert.equal('openByCut' in whole.counts, false, 'exactly 500 groups were reported as cut');
    assert.equal(sum(whole.counts.openBy), whole.counts.open);

    await plant(door, A, manyGroups('t', OPEN_BY_MAX + 1));
    const cut = await list(A);
    assert.equal(cut.counts.openBy.length, OPEN_BY_MAX, 'a list past the bound was not held to it');
    assert.equal(cut.counts.openByCut, true, 'a cut list does not say so');
    assert.deepEqual([cut.counts.openBy[0].type, cut.counts.openBy.at(-1).type], ['t0000', `t${String(OPEN_BY_MAX - 1).padStart(4, '0')}`], 'the groups kept are the first in order');
    assert.equal(cut.counts.open, OPEN_BY_MAX + 1, 'counts.open is the whole space\'s even when the groups are cut');
    assert.ok(sum(cut.counts.openBy) < cut.counts.open, 'a cut list sums to what it lists, not to counts.open');
    const viaRest = await rest(A);
    assert.equal(viaRest.body.counts.openByCut, true);
    assert.equal(viaRest.body.counts.openBy.length, OPEN_BY_MAX);
  });

  it('holds at most 500 groups through a view too: members of 300 groups each are cut at 500, and a member alone is not', async () => {
    await plant(door, A, manyGroups('a', 300));
    await plant(door, B, manyGroups('b', 300));
    const merged = await list(A, {}, [A, B]);
    assert.equal(merged.counts.openBy.length, OPEN_BY_MAX, 'the merged groups are held to the bound');
    assert.equal(merged.counts.openByCut, true);
    assert.equal(merged.counts.open, 600);
    const alone = await list(A, {}, [A]);
    assert.equal(alone.counts.openBy.length, 300);
    assert.equal('openByCut' in alone.counts, false, 'a member of 300 groups was reported as cut');
    // Members that share every group do not cut: 300 groups held by both are 300 groups.
    await plant(door, B, manyGroups('a', 300));
    const shared = await list(A, {}, [A, B]);
    assert.equal(shared.counts.openBy.length, 300);
    assert.equal('openByCut' in shared.counts, false);
    assert.equal(sum(shared.counts.openBy), 600);
  });

  it('a list reads and writes nothing it did not: the items are as they were after every list above', async () => {
    await plant(door, A, rowsA());
    const state = async () => JSON.stringify(await door.mongo.col(door.spaceCollection(A, 'schemaConvertItems')).find({}).sort({ _id: 1 }).toArray());
    const before = await state();
    for (const params of [{}, { status: 'dismissed' }, { reason: ['fork', 'not_conforming'] }]) await list(A, params);
    assert.equal(await state(), before);
  });
});
