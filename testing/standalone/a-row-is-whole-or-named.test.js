/**
 * A traversed row is returned WHOLE or it is named as left out — exercised, not read.
 *
 * Owner, 2026-09-28: *"if the requested graph doesnt fit the whole resultrow including the root should be not
 * returned"*, *"if i get a result i want to be sure i get what i asked for"*, and *"all budgets and ceilings
 * should work that way on all doors"*.
 *
 * The integration suite (`a-traversed-row-is-whole-or-absent.test.js`) proves it on all four doors against a
 * real graph, but it cannot reach the bounds: a fixture with more than the per-row node ceiling, or a call that
 * spends the whole call's walk budget, is far too large to seed. So the two pure halves are driven here, and each
 * bound is seen to bite:
 *
 * 1. **`whyRowIsShort`** — the judgement of one finished walk. Every reason, and the probe boundary: exactly
 *    the ceiling is a WHOLE row, one more is not.
 * 2. **`rowGraphWalker`'s guards** — the ones that decide before any read, so they run with no database.
 * 3. **`budgetedRowsEnvelope`** — how rows become an answer: every row consumed exactly once across pages, the
 *    cut stated, nothing spilled unless asked.
 *
 * Run: node --test testing/standalone/a-row-is-whole-or-named.test.js   (after `npm run build` in server/)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { whyRowIsShort, rowGraphWalker, INCOMPLETE_ROW_REASONS } = await import('../../server/dist/brain/row-graphs.js');
const { overrideWalkBoundsForTest, walkBounds, MAX_ROW_GRAPH_NODES, MAX_CALL_WALK_NODES } =
  await import('../../server/dist/brain/search-bounds.js');
const { budgetedRowsEnvelope, MAX_NAMED_INCOMPLETE_ROWS } = await import('../../server/dist/brain/result-budget.js');

const nodes = (n, extra = {}) => Array.from({ length: n }, () => ({ ...extra }));

describe('whyRowIsShort: every reason bites, and the ceiling itself is whole', () => {
  it('exactly the ceiling is a whole row; one more is the probe firing', () => {
    assert.equal(whyRowIsShort({ neighbours: nodes(5), scanCapped: false }, 5), null,
      'a row of exactly the ceiling was left out — the probe is off by one');
    assert.equal(whyRowIsShort({ neighbours: nodes(6), scanCapped: false }, 5), 'walk_ceiling');
  });

  it('a scan that stopped reading leaves the row out', () => {
    assert.equal(whyRowIsShort({ neighbours: nodes(1), scanCapped: true }, 5), 'link_scan');
  });

  it('a node that lost routes leaves the row out', () => {
    assert.equal(whyRowIsShort({ neighbours: [{}, { altPathsTruncated: true }], scanCapped: false }, 5), 'paths');
  });

  it('an empty neighbourhood is whole', () => {
    assert.equal(whyRowIsShort({ neighbours: [], scanCapped: false }, 5), null);
  });

  it('every reason it can give is one the API names', () => {
    for (const r of ['walk_ceiling', 'link_scan', 'paths']) assert.ok(INCOMPLETE_ROW_REASONS.includes(r), r);
  });
});

describe('the walker decides before it reads', () => {
  afterEach(() => overrideWalkBoundsForTest(null));

  const seed = { _id: 's1', spaceId: 'alpha' };
  const live = () => 10_000;

  it('an empty space list walks nothing, even for the first row', async () => {
    const walk = rowGraphWalker({ memberIds: [], maxDepth: 2, deadline: live });
    assert.deepEqual(await walk(seed, true), { nodes: undefined });
  });

  it('a seed outside the caller\'s spaces is never walked', async () => {
    const walk = rowGraphWalker({ memberIds: ['beta'], maxDepth: 2, deadline: live });
    assert.deepEqual(await walk(seed, true), { nodes: undefined });
  });

  it('depth 0 walks nothing', async () => {
    const walk = rowGraphWalker({ memberIds: ['alpha'], maxDepth: 0, deadline: live });
    assert.deepEqual(await walk(seed, true), { nodes: undefined });
  });

  it('a spent deadline ends the answer at a later row rather than shortening it', async () => {
    const walk = rowGraphWalker({ memberIds: ['alpha'], maxDepth: 2, deadline: () => 0 });
    assert.deepEqual(await walk(seed, false), { stop: 'deadline' });
  });

  it('a spent call walk budget ends the answer at a later row', async () => {
    overrideWalkBoundsForTest({ callNodes: 0 });
    const walk = rowGraphWalker({ memberIds: ['alpha'], maxDepth: 2, deadline: live });
    assert.deepEqual(await walk(seed, false), { stop: 'walk_budget' });
  });

  it('the first row of a page is never stopped, so every page makes progress', async () => {
    // Out of both budgets, and the seed outside the spaces so nothing is read: a first row that were stopped
    // would come back `stop`, and a page could then be empty for ever.
    overrideWalkBoundsForTest({ callNodes: 0 });
    const walk = rowGraphWalker({ memberIds: ['beta'], maxDepth: 2, deadline: () => 0 });
    assert.ok(!('stop' in await walk(seed, true)), 'the first row was stopped');
  });

  it('the override is a test seam and nothing else — the real bounds are in force without it', () => {
    overrideWalkBoundsForTest(null);
    assert.deepEqual(walkBounds(), { rowNodes: MAX_ROW_GRAPH_NODES, callNodes: MAX_CALL_WALK_NODES });
    assert.ok(MAX_CALL_WALK_NODES > MAX_ROW_GRAPH_NODES, 'one row could spend the whole call');
  });
});

describe('budgetedRowsEnvelope: every row whole, consumed once, the cut stated', () => {
  const budget = (chars) => ({ chars, bytes: null });
  const row = (i) => ({ id: i, pad: 'x'.repeat(40) });
  const incomplete = (i) => ({ _id: `r${i}`, spaceId: 'alpha', type: 'entity', name: `r${i}`, reason: 'walk_ceiling' });
  const never = async () => { throw new Error('spilled without remainderDump'); };

  /** A fake walk: `kinds[i]` is 'row', 'incomplete' or a stop reason. */
  const builder = (kinds) => async (i) => kinds[i] === 'row' ? { row: row(i) }
    : kinds[i] === 'incomplete' ? { incomplete: incomplete(i) } : { stop: kinds[i] };

  it('everything fits: not truncated, no continuation, nothing named', async () => {
    const out = await budgetedRowsEnvelope({
      total: 3, budget: budget(10_000), build: builder(['row', 'row', 'row']), spillRemainder: never,
    });
    assert.equal(out.results.length, 3);
    assert.equal(out.fields.truncated, false);
    assert.ok(!('nextSkip' in out.fields) && !('truncatedBy' in out.fields) && !('incompleteCount' in out.fields));
  });

  it('the byte budget cuts between whole rows and says so', async () => {
    const out = await budgetedRowsEnvelope({
      total: 4, budget: budget(120), build: builder(['row', 'row', 'row', 'row']), spillRemainder: never,
    });
    assert.ok(out.results.length >= 1 && out.results.length < 4);
    assert.equal(out.fields.truncatedBy, 'budget');
    assert.equal(out.fields.nextSkip, out.results.length);
    for (const r of out.results) assert.equal(r.pad.length, 40, 'a row was shortened');
  });

  it('a row that cannot be whole is named, never returned; the count keeps counting past the names', async () => {
    const total = MAX_NAMED_INCOMPLETE_ROWS + 10;
    const out = await budgetedRowsEnvelope({
      total: total + 1, budget: budget(1_000_000),
      build: builder([...Array(total).fill('incomplete'), 'row']), spillRemainder: never,
    });
    assert.equal(out.fields.incompleteCount, total);
    assert.equal(out.fields.incompleteRows.length, MAX_NAMED_INCOMPLETE_ROWS);
    assert.deepEqual(out.results.map(r => r.id), [total]);
    assert.equal(out.fields.truncated, false, 'rows named as left out are consumed, not a truncation');
  });

  for (const stop of ['walk_budget', 'deadline']) {
    it(`a ${stop} stop ends the answer at that row, and writes nothing even when a dump was asked`, async () => {
      const out = await budgetedRowsEnvelope({
        total: 3, budget: budget(10_000), remainderDump: true,
        build: builder(['row', stop, 'row']), spillRemainder: never,
      });
      assert.equal(out.fields.truncatedBy, stop);
      assert.equal(out.fields.nextSkip, 1);
      assert.ok(!('remainder' in out.fields) && !('spillRefused' in out.fields));
    });
  }

  it('paging to the end consumes every row exactly once', async () => {
    const kinds = ['row', 'incomplete', 'row', 'row', 'incomplete', 'row', 'row', 'row'];
    const seen = [];
    let skip = 0;
    for (let guard = 0; guard < kinds.length + 1; guard++) {
      const out = await budgetedRowsEnvelope({
        total: kinds.length, budget: budget(120), skip, build: builder(kinds), spillRemainder: never,
      });
      seen.push(...out.results.map(r => r.id), ...(out.fields.incompleteRows ?? []).map(r => Number(r._id.slice(1))));
      const next = out.fields.nextSkip ?? kinds.length;
      assert.equal(out.results.length + (out.fields.incompleteCount ?? 0) + (kinds.length - next), kinds.length - skip,
        'a page lost or repeated a row');
      assert.ok(next > skip, 'a page made no progress');
      if (!out.fields.truncated) break;
      skip = next;
    }
    assert.deepEqual(seen.sort((a, b) => a - b), kinds.map((_, i) => i));
  });

  it('the dump carries whole rows from the cut on, only when asked', async () => {
    let handed;
    // One row fits 80 characters and two do not, so the cut falls at row 1 and the remainder is rows 1 and 3,
    // with row 2 named beside it rather than carried in it.
    const out = await budgetedRowsEnvelope({
      total: 4, budget: budget(80), remainderDump: true, build: builder(['row', 'row', 'incomplete', 'row']),
      spillRemainder: async (remainder, about) => { handed = { remainder, about }; return { spillId: 'x' }; },
    });
    assert.equal(out.fields.nextSkip, 1);
    assert.deepEqual(out.fields.remainder, { spillId: 'x' });
    assert.deepEqual(handed.remainder.map(r => r.id), [1, 3]);
    assert.equal(handed.about.incompleteCount, 1);
    assert.deepEqual(handed.about.incompleteRows.map(r => r._id), ['r2']);
  });

  it('a spill that throws is reported, and the answer stands', async () => {
    const out = await budgetedRowsEnvelope({
      total: 3, budget: budget(120), remainderDump: true, build: builder(['row', 'row', 'row']),
      spillRemainder: async () => { throw new Error('store down'); },
    });
    assert.equal(out.fields.spillRefused, 'failed');
    assert.ok(out.results.length >= 1);
  });
});
