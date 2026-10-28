/**
 * Positions continue above every position this instance has handed out, whatever was lost or set back across a start
 * (bundle-81, plan rev 8 §1b "The seed", §4, decision 4, §9 test 11).
 *
 * ## The rule
 *
 * A position is `max(now() * 1000, last + 1)` and `last` is seeded at the first stamp of a space in this process from `positionFloor`:
 * the stored maximum `pos`, the wall clock, and the capped marks. A peer holds marks in OUR position space, so a stamp below one this
 * instance already handed out is the one thing the clock promises never to do. Cases:
 *
 *  1. **Database replaced** (a restore whose rows carry positions ahead of the wall clock): the first local stamp is above the stored max.
 *  2. **Database and config lost**: nothing stored, nothing marked: the wall clock alone, at or above `now() * 1000` and above 2^50.
 *  3. **Wall clock set back across a restore** (through `setPositionClockSourceForTest`, never a lowered stored maximum): still above
 *     the stored max, and stamps keep strictly increasing.
 *  4. **A failed seed read with the wall clock behind the stored maximum REFUSES the write** (`positions_seed_unavailable`, the
 *     store-down answer), writes nothing, and a later write once the store answers is above the stored max. The file-tombstone clock
 *     stamps from `{last: 0}` on a failed seed; the records stream must not (rev 8 §1b, reliability S6).
 *  5. **A puller sending `afterPos = Number.MAX_SAFE_INTEGER`** leaves the seed at our own cap (decision 4): `ownPositionMark` records at
 *     most `settledPositionCap`, and the next stamp is not driven toward 2^53.
 *
 * NOT written here, and why: the `head` guard's recovery (a puller whose mark is above a member's `head` forgets it and re-reads, counted
 * PARTIAL and not a member failure, §4). It needs a member and a fake peer that serves a `head` (`_pull-door.mjs`) and the engine's turn;
 * it is the remaining half of this plan row and wants its own file.
 *
 * ## Assumptions, in one place
 *
 * Cases 1 and 2 read the stored `pos` of rows the real writers create and assume nothing about module names. Cases 3 to 5 assume the plan's
 * names and these shapes: `sync/record-position-stream.js` exports the records stream as its one object export; `util/position-clock.js`
 * exports `setPositionClockSourceForTest(stream, fn)` and `settledPositionCap(stream, spaceId)`; `sync/served-watermark.js` exports
 * `ownPositionMark(spaceId, value)`. `streamOf` below is the one place the stream is found.
 *
 * Database `b81tC_posstart`, dropped on entry and exit.
 *
 * Run: node --test testing/standalone/positions-continue-above-every-start-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor, moduleOrNull } from './_b81c-door.mjs';
import { build } from './_push-door.mjs';
import { failTheSeedRead } from './_b81c-seed-fault.mjs';

const skip = await mongoSkipReason();
const HOUR_MS = 3_600_000;
const MAX_SYNC_SEQ = 2 ** 50;
const SPACES = ['s-replaced', 's-lost', 's-setback', 's-seedfail', 's-afterpos'];
const STORED_ID = 'bbbbbbbb-0000-4000-8000-0000000000e1';

describe('positions continue above every start', { skip }, () => {
  let door, fact, clockMod, streamMod, served;

  before(async () => {
    door = await openB81cDoor({ name: 'posstart', spaces: SPACES });
    fact = await import('../../server/dist/brain/fact.js');
    clockMod = await moduleOrNull('util/position-clock.js');
    streamMod = await moduleOrNull('sync/record-position-stream.js');
    served = await moduleOrNull('sync/served-watermark.js');
  });
  after(async () => { await door?.close(); });

  /** The stored position an hour AHEAD of the wall clock, in microseconds: a database restored from a machine whose clock ran ahead. */
  const aheadPos = () => (Date.now() + HOUR_MS) * 1000;
  /** A stored row with a position, written directly: the state a restore leaves. */
  async function seedStored(space, pos) {
    await door.coll(space, 'facts').insertOne(build.fact(space, STORED_ID, 3, { pos, posAtSeq: 3, writtenHere: true }));
    await door.setCounter(space, 3);
  }
  const newest = (space) => door.coll(space, 'facts').find({ _id: { $ne: STORED_ID } }).sort({ pos: -1 }).limit(1).next();
  const stream = () => {
    assert.ok(streamMod, 'server/dist/sync/record-position-stream.js is missing: the records stream is declared there (rev 8 §1b)');
    const found = Object.values(streamMod).find(v => v && typeof v === 'object');
    assert.ok(found, 'sync/record-position-stream.js exports no stream object');
    return found;
  };

  it('1. database replaced: the first local stamp is above the stored maximum', async () => {
    const stored = aheadPos();
    await seedStored('s-replaced', stored);
    await fact.saveFact('s-replaced', 'first write after the restore', [], [], undefined, undefined, 'note');
    const row = await newest('s-replaced');
    assert.equal(typeof row?.pos, 'number', 'the local write carries no position: this build stamps none');
    assert.ok(row.pos > stored, `the stamp ${row.pos} is not above the stored maximum ${stored}: a peer's mark in our space could already be above it`);
  });

  it('2. database and config lost: the stamp comes from the wall clock alone, at or above now() * 1000 and above 2^50', async () => {
    const before = Date.now();
    await fact.saveFact('s-lost', 'first write on an empty database', [], [], undefined, undefined, 'note');
    const row = await newest('s-lost');
    assert.equal(typeof row?.pos, 'number', 'the local write carries no position: this build stamps none');
    assert.ok(row.pos >= before * 1000 && row.pos > MAX_SYNC_SEQ, `the stamp ${row.pos} is below the wall clock (${before * 1000}) or inside the legacy band`);
  });

  it('3. wall clock set back across the restore: still above the stored maximum, strictly increasing', async () => {
    assert.ok(clockMod, 'server/dist/util/position-clock.js is missing');
    assert.equal(typeof clockMod.setPositionClockSourceForTest, 'function', 'util/position-clock.js exports no setPositionClockSourceForTest(stream, fn): the clock-set-back case is driven through it (decision 24)');
    const stored = aheadPos();
    await seedStored('s-setback', stored);
    clockMod.setPositionClockSourceForTest(stream(), () => Date.now() - HOUR_MS);
    try {
      const stamps = [];
      for (let i = 0; i < 3; i++) {
        await fact.saveFact('s-setback', `write ${i} with the clock set back`, [], [], undefined, undefined, 'note');
        stamps.push((await newest('s-setback')).pos);
      }
      assert.ok(stamps.every(p => p > stored), `a stamp ${stamps} is at or below the stored maximum ${stored} with the wall clock an hour behind it`);
      assert.deepEqual([...stamps].sort((a, b) => a - b), stamps, 'stamps are not strictly increasing');
      assert.equal(new Set(stamps).size, stamps.length);
    } finally { clockMod.setPositionClockSourceForTest(stream(), undefined); }
  });

  it('4. a failed seed read with the wall clock behind the stored maximum refuses the write; once the store answers it is above the maximum', async () => {
    assert.ok(clockMod, 'server/dist/util/position-clock.js is missing');
    const stored = aheadPos();
    await seedStored('s-seedfail', stored);
    clockMod.setPositionClockSourceForTest(stream(), () => Date.now() - HOUR_MS);
    const restore = failTheSeedRead(door.mongo, 's-seedfail');
    try {
      await assert.rejects(fact.saveFact('s-seedfail', 'a write with an unreadable seed', [], [], undefined, undefined, 'note'),
        (err) => { assert.equal(err.code ?? err.name, 'positions_seed_unavailable'); return true; });
      assert.equal(await door.coll('s-seedfail', 'facts').countDocuments({ _id: { $ne: STORED_ID } }), 0,
        'a write landed although the seed could not be read: it was stamped from the wall clock, an hour below a position already handed out');
    } finally { restore(); }
    try {
      await fact.saveFact('s-seedfail', 'a write once the store answers', [], [], undefined, undefined, 'note');
      assert.ok((await newest('s-seedfail')).pos > stored, 'the write after the failed seed is not above the stored maximum');
    } finally { clockMod.setPositionClockSourceForTest(stream(), undefined); }
  });

  it('5. a puller sending afterPos = Number.MAX_SAFE_INTEGER leaves the seed at our own cap', async () => {
    assert.ok(clockMod && served, 'util/position-clock.js or sync/served-watermark.js is missing');
    assert.equal(typeof served.ownPositionMark, 'function', 'sync/served-watermark.js exports no ownPositionMark(spaceId, value)');
    assert.equal(typeof clockMod.settledPositionCap, 'function', 'util/position-clock.js exports no settledPositionCap(stream, spaceId)');
    const recorded = await served.ownPositionMark('s-afterpos', Number.MAX_SAFE_INTEGER);
    // Read AFTER the mark: the cap grows with the clock, so one read before it can sit below a mark capped a moment later (Q-630).
    const cap = await clockMod.settledPositionCap(stream(), 's-afterpos');
    assert.equal(typeof recorded, 'number', 'the mark of an over-large afterPos was not recorded at all: it must be capped, not dropped');
    assert.ok(recorded <= cap, `the mark ${recorded} is above our own settled cap ${cap}: a puller can drive the seed to the ceiling`);
    await fact.saveFact('s-afterpos', 'a write after the over-large afterPos', [], [], undefined, undefined, 'note');
    const row = await newest('s-afterpos');
    assert.ok(row.pos < Date.now() * 1000 + 3_600_000_000, `the next stamp ${row.pos} was driven far above the wall clock by a peer-supplied number`);
  });
});
