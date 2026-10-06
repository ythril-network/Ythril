/**
 * `sweepCollection`: one collection of one space, swept so that a record that keeps failing to delete cannot starve the rest
 * (`Q-359`, bundle-53 G10). Pure: the store, the deleter and the clock are the function's seams, so every row runs in
 * milliseconds. The same rules against the real store are in `a-failing-expired-record-never-starves-the-rest-db.test.js`.
 *
 * ## The defect it prevents
 *
 * The sweep read ONE page of 500 expired ids per collection per cycle and deleted them in order. A head page whose deletes
 * all fail deleted nothing, and the next cycle read the same page: every expired record behind it waited for ever, with one
 * log line per failed record every cycle.
 *
 * ## What is held
 *
 *  - the head of failing records is passed over: the records behind it are deleted, and the throttle (500 SUCCESSFUL
 *    deletes per cycle) is kept;
 *  - a record is asked of the store once per cycle (the attempted set), the attempted set is capped, and reaching the cap says so;
 *  - a deleter's `false` is read: gone = deleted concurrently (not a failure), still there = a failure the loop must not repeat;
 *  - a files record that is NotFound is already gone: neither failed nor counted;
 *  - the collection's report is ONE line with the count and up to five sample ids, runs when the loop ends early, and is
 *    counted by the number of records;
 *  - a failure that is the store's, or a timeout of a bound, ends the collection by propagating (the walk decides what it means).
 *
 * Run: node --test testing/standalone/sweep-collection.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoNetworkError, MongoOperationTimeoutError } from 'mongodb';
import {
  sweepCollection, SWEEP_BATCH, ATTEMPT_CAP, SWEEP_INTERVAL_MS,
} from '../../server/dist/brain/ttl-sweep.js';
import { TTL_COLLECTIONS } from '../../server/dist/brain/ttl.js';
import { spaceFailureReporter } from '../../server/dist/util/space-failure.js';
import { onHousekeepingSignal, declaredSteps } from '../../server/dist/util/housekeeping-signals.js';
import { NotFoundError } from '../../server/dist/util/errors.js';

const NOW = new Date('2026-10-06T00:00:00Z');

/** A store of `n` expired ids, in the order a scan would return them. `failing(id)` says which deletes throw. */
function world(n, { failing = () => false, keepOnTrue = () => false } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `rec-${String(i).padStart(4, '0')}`);
  const left = new Set(ids);
  const calls = { pages: [], removes: 0 };
  const lines = [];
  const signals = [];
  const off = onHousekeepingSignal((e) => { if (e.type === 'records-failed') signals.push(e); });
  const reporter = spaceFailureReporter({ now: () => 0, warn: (l) => lines.push(l) });
  const deps = {
    reporter,
    storeAnswers: async () => true,
    page: async (_s, _c, _now, exclude, limit) => {
      calls.pages.push({ excluded: exclude.length, limit });
      const skip = new Set(exclude);
      return ids.filter((id) => left.has(id) && !skip.has(id)).slice(0, limit);
    },
    remove: async (_s, _c, id) => {
      calls.removes++;
      if (failing(id)) throw new Error('delete refused');
      if (!keepOnTrue(id)) left.delete(id);
      return true;
    },
    exists: async (_s, _c, id) => left.has(id),
  };
  return { deps, left, calls, lines, signals, off, ids };
}

describe('sweepCollection: a failing head cannot starve the rest', () => {
  it('passes over 500 failing records, deletes the 500 behind them and keeps the throttle', async () => {
    const w = world(1200, { failing: (id) => Number(id.slice(4)) < 500 });
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(out.deleted, SWEEP_BATCH, 'the throttle is 500 successful deletes per cycle');
      assert.equal(out.failed, 500);
      assert.equal(w.left.size, 700, 'the failing head stays, and 200 behind the throttle wait');
      assert.equal(w.calls.pages[0].limit, SWEEP_BATCH);
      assert.equal(w.calls.pages[1].limit, SWEEP_BATCH, 'nothing was deleted yet, so the second page is a full one');
      assert.equal(w.calls.pages[1].excluded, 500, 'the second page excludes every id already attempted');
    } finally { w.off(); }
  });

  it('says ONE line with the count and at most five sample ids, and counts the records, not the line', async () => {
    const w = world(1200, { failing: (id) => Number(id.slice(4)) < 500 });
    try {
      await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(w.lines.length, 1, `one line for 500 failures, got ${w.lines.length}`);
      assert.match(w.lines[0], /^TTL sweep: facts delete failed for space 's' \(facts\): .*\(count: 500\) — retried next cycle$/);
      const sampled = w.lines[0].match(/rec-\d{4}/g) ?? [];
      assert.ok(sampled.length >= 1 && sampled.length <= 5, `${sampled.length} sample ids in: ${w.lines[0]}`);
      assert.deepEqual(w.signals, [{ type: 'records-failed', step: 'TTL sweep: facts delete', count: 500 }]);
    } finally { w.off(); }
  });

  it('three cycles drain 1 200 once the fault is gone, nothing counted twice', async () => {
    const w = world(1200, { failing: (id) => Number(id.slice(4)) < 500 });
    try {
      const first = await sweepCollection('s', 'facts', NOW, w.deps);
      const fixed = { ...w.deps, remove: async (_s, _c, id) => { w.left.delete(id); return true; } };
      const second = await sweepCollection('s', 'facts', NOW, fixed);
      const third = await sweepCollection('s', 'facts', NOW, fixed);
      assert.deepEqual([first.deleted, second.deleted, third.deleted], [500, 500, 200]);
      assert.equal(w.left.size, 0);
      assert.equal(second.failed + third.failed, 0);
    } finally { w.off(); }
  });

  it('a mixed page never exceeds the throttle: every second record fails', async () => {
    const w = world(3000, { failing: (id) => Number(id.slice(4)) % 2 === 0 });
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(out.deleted, SWEEP_BATCH);
      assert.ok(w.calls.pages.every((p) => p.limit <= SWEEP_BATCH && p.limit > 0), JSON.stringify(w.calls.pages));
    } finally { w.off(); }
  });
});

describe('sweepCollection: the attempted set is capped, and the cap says so', () => {
  it('stops at ATTEMPT_CAP when every delete fails, and names the records that keep failing', async () => {
    const w = world(ATTEMPT_CAP + 500, { failing: () => true });
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(out.deleted, 0);
      assert.equal(out.failed, ATTEMPT_CAP);
      assert.equal(out.capped, true);
      assert.equal(w.calls.removes, ATTEMPT_CAP, 'a record is asked of the store once per cycle');
      assert.ok(w.calls.pages.at(-1).excluded < ATTEMPT_CAP, 'no page is read past the cap');
      assert.equal(w.lines.length, 1);
      assert.match(w.lines[0], new RegExp(`${ATTEMPT_CAP}\\+ records keep failing; the rest wait for the next cycle`));
      assert.deepEqual(w.signals.map((s) => s.count), [ATTEMPT_CAP]);
    } finally { w.off(); }
  });

  it('says nothing about a cap when the collection simply ran out', async () => {
    const w = world(10, { failing: (id) => id === 'rec-0003' });
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(out.capped, false);
      assert.equal(out.deleted, 9);
      assert.doesNotMatch(w.lines[0], /keep failing/);
    } finally { w.off(); }
  });
});

describe('sweepCollection: what a deleter\'s answer means', () => {
  it('a deleter that answers false for a record still stored is a failure, reported once, and the loop ends', async () => {
    const w = world(5);
    w.deps.remove = async () => false;
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(out.deleted, 0);
      assert.equal(out.failed, 5);
      assert.equal(w.lines.length, 1);
      assert.match(w.lines[0], /no record of this space matched/);
      assert.match(w.lines[0], /\(count: 5\)/);
      assert.equal(w.calls.pages.length, 2, 'the second read finds nothing new and the collection ends');
    } finally { w.off(); }
  });

  it('a deleter that answers false for a record that is gone was a concurrent delete: not failed, not counted, not said', async () => {
    const w = world(3);
    w.deps.remove = async (_s, _c, id) => { w.left.delete(id); return false; };
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.deepEqual([out.deleted, out.failed], [0, 0]);
      assert.deepEqual(w.lines, []);
      assert.deepEqual(w.signals, []);
    } finally { w.off(); }
  });

  it('a deleter that answers true and leaves the record is passed over: the others are still deleted', async () => {
    const w = world(6, { keepOnTrue: (id) => id === 'rec-0000' });
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(out.deleted, 6, 'the deleter said true for every record');
      assert.deepEqual([...w.left], ['rec-0000']);
      assert.equal(w.calls.removes, 6, 'the record that stayed was not asked again');
    } finally { w.off(); }
  });

  it('a page that holds no new id ends the collection (a store that ignores the exclusion cannot loop it)', async () => {
    const w = world(3, { keepOnTrue: () => true });
    w.deps.page = async () => ['rec-0000'];
    try {
      const out = await sweepCollection('s', 'facts', NOW, w.deps);
      assert.equal(out.deleted, 1);
      assert.equal(w.calls.removes, 1);
    } finally { w.off(); }
  });

  it('a files record that is NotFound is already gone: neither failed, nor counted, nor said', async () => {
    const w = world(4);
    w.deps.remove = async (_s, _c, id) => { throw new NotFoundError(`File '${id}' not found`); };
    try {
      const out = await sweepCollection('s', 'files', NOW, w.deps);
      assert.deepEqual([out.deleted, out.failed], [0, 0]);
      assert.deepEqual(w.lines, []);
      assert.deepEqual(w.signals, []);
    } finally { w.off(); }
  });
});

describe('sweepCollection: the report runs whatever ended the loop', () => {
  it('the store\'s own failure propagates, and the failures before it are still reported with their count', async () => {
    const w = world(20, { failing: (id) => id === 'rec-0000' || id === 'rec-0001' });
    const base = w.deps.remove;
    w.deps.remove = async (s, c, id) => {
      if (id === 'rec-0005') throw new MongoNetworkError('connection 1 to 127.0.0.1:27017 closed');
      return base(s, c, id);
    };
    try {
      await assert.rejects(sweepCollection('s', 'facts', NOW, w.deps), (e) => e instanceof MongoNetworkError);
      assert.equal(w.lines.length, 1, 'the two records that failed before the store went are reported');
      assert.match(w.lines[0], /\(count: 2\)/);
      assert.deepEqual(w.signals.map((s) => s.count), [2], 'the propagated error is the walk\'s to count, not a record\'s');
    } finally { w.off(); }
  });

  it('a timeout of a bound, on a store that answers, propagates too (it ends the space)', async () => {
    const w = world(5);
    let asked = 0;
    w.deps.remove = async () => { asked++; throw new MongoOperationTimeoutError('Timed out during socket read'); };
    try {
      await assert.rejects(sweepCollection('s', 'facts', NOW, w.deps), (e) => e instanceof MongoOperationTimeoutError);
      assert.equal(asked, 1,'the next record would only cost another bound against the same hung space');
      assert.deepEqual(w.lines, []);
    } finally { w.off(); }
  });

  it('a failing read is the walk\'s (it propagates, it is not swallowed as "no collection")', async () => {
    const w = world(5, { failing: () => true });
    let reads = 0;
    const page = w.deps.page;
    w.deps.page = async (...args) => { if (++reads === 2) throw new Error('the read failed'); return page(...args); };
    try {
      await assert.rejects(sweepCollection('s', 'facts', NOW, w.deps), /the read failed/);
      assert.equal(w.lines.length, 1, 'the five failed deletes before the read are still said');
      assert.match(w.lines[0], /\(count: 5\)/);
    } finally { w.off(); }
  });

  it('a collection that sweeps clean makes the next failure news again', async () => {
    const lines = [];
    const reporter = spaceFailureReporter({ now: () => 0, warn: (l) => lines.push(l) });
    const cycle = async (failing) => {
      const w = world(3, { failing: failing ? () => true : () => false });
      w.deps.reporter = reporter;
      try { await sweepCollection('s', 'facts', NOW, w.deps); } finally { w.off(); }
    };
    await cycle(true);
    assert.equal(lines.length, 1);
    await cycle(true);
    assert.equal(lines.length, 1, 'the same condition inside its window is said once');
    await cycle(false);
    await cycle(true);
    assert.equal(lines.length, 2, 'a clean cycle forgets the line, so the next failure is said');
  });
});

describe('the sweep\'s figures and step names', () => {
  it('exports the figures the docs cite', () => {
    assert.equal(SWEEP_BATCH, 500);
    assert.equal(ATTEMPT_CAP, 2000);
    assert.equal(SWEEP_INTERVAL_MS, 5 * 60_000);
  });

  it('every collection it sweeps has its read step and its delete step declared, so the counters start at 0', () => {
    assert.ok(TTL_COLLECTIONS.length >= 5, 'floor: the collections the sweep covers were not found');
    const declared = new Set(declaredSteps());
    for (const c of TTL_COLLECTIONS) {
      assert.ok(declared.has(`TTL sweep: ${c}`), `TTL sweep: ${c} is not declared`);
      assert.ok(declared.has(`TTL sweep: ${c} delete`), `TTL sweep: ${c} delete is not declared`);
    }
    assert.ok(declared.has('TTL sweep'), 'the walk\'s own step is not declared');
  });
});
