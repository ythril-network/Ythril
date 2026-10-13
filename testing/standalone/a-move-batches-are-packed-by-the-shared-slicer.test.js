/**
 * A move's batches are packed by `inOneCommandChunks` (`db/one-command.ts`), the one greedy byte slicer, and keep the shape they had when
 * `batchesOf` packed by hand (bundle-44, S6).
 *
 * ## What is asserted
 *
 * - Over many random plans, `batchesOf` makes the batches the hand-written packing made: a group (a file and what derives from it) is
 *   kept whole when it fits, a group over the budget by itself is cut by row into slices that each fit, and a single row over the budget
 *   is a slice of its own. The reference is written out here, literally, from the rule in `batchesOf`'s docblock — a fixture may be
 *   literal; it is the code under test that must not carry a second copy.
 * - `inOneCommandChunks` takes the budget as `maxBytes`, defaults it to the one-command budget, and refuses one that is not a positive number.
 *
 * Run: node --test testing/standalone/a-move-batches-are-packed-by-the-shared-slicer.test.js   (requires a prior build of server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let batchesOf, oneCommand;
before(async () => {
  ({ batchesOf } = await import('../../server/dist/files/move-plan.js'));
  oneCommand = await import('../../server/dist/db/one-command.js');
});

/** A small seeded PRNG so a failing plan can be replayed. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The packing as `batchesOf` wrote it by hand: the rows of each batch, in order. */
function referenceSlices(rows, budget) {
  const groups = new Map();
  for (const r of rows) { const g = groups.get(r.group); if (g) g.push(r); else groups.set(r.group, [r]); }
  const slices = [];
  let open = [];
  let openBytes = 0;
  const seal = () => { if (open.length > 0) slices.push(open); open = []; openBytes = 0; };
  for (const group of groups.values()) {
    const total = group.reduce((n, r) => n + r.bytes, 0);
    if (total <= budget) {
      if (openBytes + total > budget) seal();
      open.push(...group); openBytes += total;
      continue;
    }
    seal();
    for (const r of group) {
      if (openBytes + r.bytes > budget) seal();
      open.push(r); openBytes += r.bytes;
    }
    seal();
  }
  seal();
  return slices;
}

const planOf = (rows) => ({
  src: 's', dst: 'd', kind: 'directory', rows, flaggedAtDestination: new Set(), replacedAtDestination: new Set(), linkFiles: [], jobIds: [],
});

describe('a move\'s batches are packed by the shared slicer', () => {
  it('make the batches the hand-written packing made, over random plans', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = seeded(seed);
      const budget = 50 + Math.floor(rand() * 400);
      const rows = [];
      const groups = 1 + Math.floor(rand() * 8);
      for (let g = 0; g < groups; g++) {
        const size = 1 + Math.floor(rand() * 6);
        for (let i = 0; i < size; i++) {
          // Rows of any size, some over the budget by themselves, sorted by group then id as `planMove` sorts them.
          rows.push({ from: `g${String(g).padStart(2, '0')}/r${String(i).padStart(2, '0')}`, to: `x`, group: `g${String(g).padStart(2, '0')}`, bytes: 1 + Math.floor(rand() * (budget * 1.4)), top: i === 0 });
        }
      }
      const got = batchesOf(planOf(rows), budget).map(b => b.rows.map(r => r.from));
      const want = referenceSlices(rows, budget).map(s => s.map(r => r.from));
      assert.deepEqual(got, want, `seed ${seed}, budget ${budget}`);
    }
  });

  it('keeps a group whole when it fits and cuts only a group that is over the budget by itself', () => {
    const rows = [
      { from: 'a/1', to: 'x', group: 'a', bytes: 40, top: true }, { from: 'a/2', to: 'x', group: 'a', bytes: 40, top: false },
      { from: 'b/1', to: 'x', group: 'b', bytes: 30, top: true },
      { from: 'c/1', to: 'x', group: 'c', bytes: 70, top: true }, { from: 'c/2', to: 'x', group: 'c', bytes: 70, top: false }, { from: 'c/3', to: 'x', group: 'c', bytes: 70, top: false },
    ];
    assert.deepEqual(batchesOf(planOf(rows), 100).map(b => b.rows.map(r => r.from)), [['a/1', 'a/2'], ['b/1'], ['c/1'], ['c/2'], ['c/3']]);
  });
});

describe('inOneCommandChunks takes the budget', () => {
  it('slices by `maxBytes`, and defaults it to the one-command budget', () => {
    const items = [30, 30, 30, 30];
    assert.deepEqual(oneCommand.inOneCommandChunks(items, { maxItems: 100, bytesOf: n => n, maxBytes: 70 }), [[30, 30], [30, 30]]);
    assert.deepEqual(oneCommand.inOneCommandChunks(items, { maxItems: 100, bytesOf: n => n }), [items], 'the default budget is far above these figures');
  });

  it('refuses a budget that is not a positive number', () => {
    for (const maxBytes of [0, -1, NaN, Infinity]) {
      assert.throws(() => oneCommand.inOneCommandChunks([1], { maxItems: 1, bytesOf: () => 1, maxBytes }), /maxBytes must be a positive number/, String(maxBytes));
    }
  });
});
