/**
 * A write inside a seq hold always ENDS — within the write bound, on every holder — and when it ends the hold is
 * released, so a seq-paged pull moves past it (`Q-213`, bundle-30 plan §A).
 *
 * ## The defect
 *
 * `withAllocatedSeqs` and `withSeqHorizonHeld` (`util/seq.ts`) register a floor that every seq-paged reader of the
 * space stops below — the pull routes, the push loop, the tombstone pages, the scanners — and release it in a
 * `finally` when the write settles. Nothing bounds the write. A write that never settles (a document lock held by
 * another session, a stalled socket, `withTransaction` retrying a conflict for its default 120 s) holds the floor
 * for as long as it waits, and every peer pulling that space is served nothing above it: replication of the space
 * stops, while every cycle reports success over an empty page.
 *
 * ## The rule this file holds
 *
 * **Every holder's write is bounded: it ends within the write bound, the hold is released when it ends, and a
 * pull then serves what committed above it.** "Released when it ENDS", never abandoned while the write is still
 * alive (a hold released under a write that lands later is `Q-196`, the defect the hold exists for) — so the
 * bound has to end the write itself, which only a driver bound can do.
 *
 * ## The holders — derived, never listed
 *
 * Every top-level function in `server/src` (outside `util/seq.ts`) that calls `withPositionHeld` (the file tombstones'
 * position instance of the same primitive, `util/horizon-holds.ts`; bundle-71) or `withAllocatedSeqs`,
 * `withSeqHorizonHeld` or `withSeq`. Each derived holder needs a case below; a holder added next year without one
 * fails the coverage test instead of going unchecked. A call outside any top-level function is reported as such,
 * so it cannot be missed either.
 *
 * ## The stall is REAL (`_write-faults.mjs`)
 *
 * Another session's open transaction holds a document lock, measured by the bundle-30 design probe (P1) to keep a
 * plain write waiting for as long as the transaction lives. For most holders the locked document is the space's
 * counter row: the `$inc` of every allocation waits on it, and it runs with the floor ALREADY registered
 * (`hold(s, floor)` precedes it in `withAllocatedSeqs`) — so a bound that covers only the callback and not the
 * allocation leaves this test red, correctly: that allocation holds the horizon exactly as long. The fork push
 * locks the fork's own id instead, because the door bumps the counter BEFORE its hold and that bump is not inside
 * any hold.
 *
 * ## The bound is test-settable
 *
 * `setWriteBoundForTest({ writeTimeoutMs, holdDeadlineMs })` (plan §A1, `db/write-bound.ts`) sets both to 2 s here.
 * On the unchanged code the seam does not exist (its own case fails for that reason) AND every holder hangs until
 * the test releases the lock (each holder case fails for that reason) — two independent reds, reported separately.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-inside-a-seq-hold-always-ends-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { topLevelFunctionSpans } from './_call-graph.mjs';
import { lineBefore } from './_structural-window.mjs';
import { holdDocumentLock, holdCounterLock, settleWithin, eventually, setWriteBoundForTest } from './_write-faults.mjs';
import { holderCases, loadHolderModules, seedHolderSpace, heldSeqAllocated, F } from './_seq-hold-cases.mjs';

const skip = await mongoSkipReason();
// A merge embeds its survivor inline unless the space suppresses it; never let a test fetch a model.
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

/** The space every holder case stalls in, and a second for the pull case (its counter row stays free). */
const S = 'holdends';
const R = 'holdresume';
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
/** How long past the bound a write may take to be reported ended: the driver ends a bound write within ~2 % (P1). */
const SLACK_MS = 1500;
const CAP_MS = BOUND.holdDeadlineMs + SLACK_MS;
/** How long a case may take to REACH its stall (the hold registered) before the fixture is called broken. */
const ENTER_MS = 5000;

// ── The derivation: every holder of a seq hold ───────────────────────────────────────────────────────────────
// The entry points of the shared hold primitive (`util/horizon-holds.ts`'s `heldWhile`): the seq instance's three and the
// file-tombstone position instance's one (bundle-71, Q-346). A function that calls one of them holds a horizon, and is owed a case.
const PRIMITIVE = /\b(withAllocatedSeqs|withSeqHorizonHeld|withSeq|withPositionHeld)\s*\(/g;
/** A match that is the DEFINITION of the entry point (`function withPositionHeld(`), which holds nothing itself. */
const isDefinition = (src, index) => /\bfunction$/.test(lineBefore(src, index, 'a holder match', { orEmpty: true }));
function holders() {
  const out = new Map();
  for (const file of trackedSources('server/src', { floor: 100 })) {
    if (file.replace(/\\/g, '/') === 'server/src/util/seq.ts') continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    const spans = [...topLevelFunctionSpans(src)];
    for (const m of src.matchAll(new RegExp(PRIMITIVE.source, 'g'))) {
      if (isDefinition(src, m.index)) continue;
      const enclosing = spans.find(([, s]) => m.index >= s.start && m.index < s.start + s.body.length);
      const key = `${file.replace(/\\/g, '/')}:${enclosing ? enclosing[0] : '(not inside a top-level function)'}`;
      out.set(key, [...(out.get(key) ?? []), m[1]]);
    }
  }
  return out;
}
const HOLDERS = holders();

let door, seq, mods;
/** Filled by `before`; the cases (`_seq-hold-cases.mjs`) read it when they run. */
const ctx = {};
const CASES = holderCases(ctx, S);

/**
 * Run `run` with its write stalled by `lock`, and report what happened while the lock was STILL held: whether the
 * hold was entered, whether the run settled within the cap, and whether the hold was released by then. The lock is
 * then released and the run allowed to finish, so a hang on the unchanged code cannot leak into the next case.
 */
async function stalled(space, c) {
  const { lock, run } = c;
  const held = lock === 'counter' ? await holdCounterLock(door.mongo, space) : await lock();
  let report;
  try {
    let done = false;
    const op = Promise.resolve().then(run).finally(() => { done = true; });
    // Which instance of the hold the case is about: the file tombstones' position (`positionHold`), or the seq horizon.
    const lowest = c.positionHold ? () => mods.fileTombstones.lowestUncommittedPosition(space) : () => seq.lowestUncommittedSeq(space);
    const entered = await eventually(() => done || lowest() !== undefined, ENTER_MS);
    // The floor, not an allocated seq, and that is enough: `heldAt` only goes into a message here, and most of these locks
    // are on the counter row itself, so the allocation is exactly what never answers (`heldSeqAllocated` is for a case that ACTS on the seq).
    const heldAt = lowest();
    const res = await settleWithin(op, CAP_MS);
    report = { entered: entered && heldAt !== undefined, heldAt, res, after: lowest() };
  } finally {
    await held.release();
  }
  if (!report.res.settled) await report.res.rest;
  return report;
}

describe('a write inside a seq hold always ends', { skip }, () => {
  let seamError = null;
  let restoreBound = () => {};

  before(async () => {
    // `completeLinkage`: the spaces' links are converted, as every space's are after its first boot — the cascade case
    // reads an entity's references through the link records, which refuse a space that was never converted.
    door = await openPushDoor({ suite: 'holdends', spaces: [S, R].map(id => ({ id, label: id, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } })) });
    seq = await import('../../server/dist/util/seq.js');
    mods = await loadHolderModules();
    Object.assign(ctx, { door, mods });
    try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seamError = err; }
  });
  after(async () => { restoreBound(); await door?.close(); });
  beforeEach(async () => { await seedHolderSpace(door, S); });

  it('the derivation finds the holders, so an empty set cannot pass', () => {
    assert.ok(HOLDERS.size >= 10, `only ${HOLDERS.size} holder(s) of a seq hold derived — the sweep is broken: ${[...HOLDERS.keys()]}`);
    assert.ok([...HOLDERS.values()].flat().includes('withSeqHorizonHeld'), 'no transaction holder derived — re-anchor');
  });

  it('every derived holder has a stalled-write case', () => {
    const missing = [...HOLDERS.keys()].filter(k => !CASES[k]);
    assert.deepEqual(missing, [], 'a seq holder with no case here is one nobody checked for a write that never ends');
    const stale = Object.keys(CASES).filter(k => !HOLDERS.has(k));
    assert.deepEqual(stale, [], 'a case for a holder that no longer holds — re-anchor it or remove it');
  });

  it('the write bound has a test seam (db/write-bound.ts setWriteBoundForTest)', () => {
    assert.equal(seamError, null, seamError?.message);
  });

  for (const [holder, cases] of Object.entries(CASES)) {
    for (const c of cases) {
      it(`${holder}: ${c.label} — ends within the bound and releases the hold`, { timeout: ENTER_MS + CAP_MS + 30_000 }, async () => {
        const r = await stalled(S, c);
        assert.ok(r.entered, `fixture: ${c.label} never entered a seq hold (it ${r.res.settled ? `settled first: ${r.res.ok ? 'ok' : r.res.error?.message}` : 'hung outside one'}) — re-anchor the case`);
        assert.ok(r.res.settled,
          `${c.label}: the write inside the hold on seq ${r.heldAt} was still waiting ${r.res.elapsedMs} ms later — no bound `
          + `(${BOUND.holdDeadlineMs} ms) ended it, so every seq-paged pull of space '${S}' was held below seq ${r.heldAt} for as long as the lock lived`);
        assert.equal(r.after, undefined,
          `${c.label}: the write ended after ${r.res.elapsedMs} ms but the hold on seq ${r.after} was not released — the horizon is stuck`);
      });
    }
  }

  it('a pull resumes past a hold whose write the bound ended, while the lock is still held', { timeout: ENTER_MS + CAP_MS + 30_000 }, async () => {
    await seedHolderSpace(door, R);
    const lock = await holdDocumentLock(door.mongo, `${R}_facts`, { filter: { _id: F } });
    let report;
    try {
      const op = Promise.resolve().then(() => mods.fact.updateFact(R, F, { fact: 'stalled edit' }));
      // The hold registers before the update's counter `$inc` is answered; the later save's own `$inc` must not be able to
      // overtake it (the save would take the update's seq, and "committed above the held seq" would not be true).
      const heldAt = await heldSeqAllocated(door, R, { ms: ENTER_MS });
      await mods.fact.saveFact(R, 'committed above the stalled edit', [], [], undefined, undefined, 'note');
      const later = await door.coll(R, 'facts').find({ seq: { $gt: heldAt } }).sort({ seq: -1 }).limit(1).next();
      assert.ok(later, 'fixture: the later fact did not commit above the held seq');
      const during = (await door.pull('/facts', { spaceId: R, sinceSeq: '0' })).items.map(i => i.seq);
      assert.ok(during.every(s => s < heldAt), `the hold did not hold the pull: ${JSON.stringify(during)} with ${heldAt} held`);
      const res = await settleWithin(op, CAP_MS);
      const after = (await door.pull('/facts', { spaceId: R, sinceSeq: '0' })).items.map(i => i.seq);
      report = { res, heldAt, later, after };
    } finally {
      await lock.release();
    }
    if (!report.res.settled) await report.res.rest;
    assert.ok(report.after.includes(report.later.seq),
      `${report.res.elapsedMs} ms after a write stalled inside the hold on seq ${report.heldAt}, a pull of '${R}' still does not `
      + `serve seq ${report.later.seq}, committed above it (served ${JSON.stringify(report.after)}). The bound `
      + `(${BOUND.holdDeadlineMs} ms) should have ended the stalled write and released the horizon.`);
  });
});
