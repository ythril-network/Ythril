/**
 * A write the bound answered as timed out NEVER LANDS afterwards — on every door a caller writes through and every
 * holder of a seq hold (`Q-372`, found by main's CI run 37231507558).
 *
 * ## The defect
 *
 * The write bound is a driver `timeoutMS` (`db/write-bound.ts`). The driver starts that timer when the operation
 * starts; the server's `maxTimeMS` is derived from what is left when the command is built, less the round-trip time,
 * and armed when the command ARRIVES. Normally the two deadlines are a millisecond apart. When the command is late —
 * a busy server, a slow link, a connection that had to be opened — the CLIENT's deadline passes first: the caller is
 * answered `503`, the seq hold is released, and the write is still alive in the server, waiting behind whatever
 * stalled it. When that goes (here: the lock is released) it retries, finds the way clear, and writes — after the
 * answer, after the hold, and in the CI run that found this, after the next case's wipe, so its fork collided with
 * the next case's lock (`E11000`).
 *
 * That breaks the promise `write-bound.ts` states and `docs/integration-guide/02-hosting.md` repeats: the bound ends the
 * operation on the client AND the server, so a hold is released when its write ENDS, never abandoned while the write is
 * alive. A record landing with a seq below a reader's cursor is exactly `Q-196`, the defect the hold exists for.
 *
 * ## The rule this file holds
 *
 * **Once a door has answered that a write timed out, nothing that write would have written ever lands.** Not a count
 * of documents: the identity of every document of the space (and its counter row) is read at the moment the door
 * answers, the stall is released AT ONCE, and the same documents are read again for a settle window. Anything added,
 * removed or rewritten in that window is named.
 *
 * ## The lateness is made, not hoped for (`_delayed-write-relay.mjs`)
 *
 * On a quiet machine the two deadlines are so close that the write is not alive long enough after the answer for a
 * release to reach it — which is why this was a one-in-N flake in CI and would be a one-in-N test here. So the server's
 * Mongo layer reaches the store through a relay that holds back every write carrying the bound's `maxTimeMS` by
 * `LATE_BY_MS`: the server's deadline is then that much later than the client's, on every run, and the defect is a
 * window of known width instead of a race. A bound that really ends the operation on the server first (a server
 * deadline earlier than the client's by more than `LATE_BY_MS`) is green however late the command is.
 *
 * ## Every door, and every holder — derived, never listed
 *
 * The lanes are `_stalled-write-doors.mjs`'s doors (the table `a-write-timeout-answers-503-on-every-door-db` walks) and
 * `_seq-hold-cases.mjs`'s holder cases (the table `a-write-inside-a-seq-hold-always-ends-db` walks), each with a space
 * of its own so several stall together. Floors on both sets: an empty table would pass every loop written over it.
 * A holder whose write runs inside a transaction is green for the right reason — a timed transaction that was aborted
 * cannot land anything — and only a plain bounded write can be red.
 *
 * ## Repeated, at the bound's minimum
 *
 * Each lane is run `REPS` times with the bound at its 1000 ms minimum (`setWriteBoundForTest`). Every repetition is its
 * own result; a lane is green only when none of them landed anything.
 *
 * ## What else a lane proves
 *
 * That it STALLED: the server is asked, while the call waits, whether a write is alive on the locked collection — a lock
 * that stalled nothing makes "nothing landed" a claim about nothing. That the door answered `503` where the door table says it must. That the release did not fail
 * (`_write-faults.mjs` makes it wait for the server to be quiet, and throw when it is not).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { RECORD_PARTS, snapshotSpaceInOneRead, changedDocuments } from './_space-snapshot.mjs';
import { holdCounterLock, settleWithin, setWriteBoundForTest } from './_write-faults.mjs';
import { sawLiveWrite } from './_active-operations.mjs';
import { startDelayedWriteRelay } from './_delayed-write-relay.mjs';
import { openStalledWriteDoors, seedDoorSpace, stalledWriteDoors } from './_stalled-write-doors.mjs';
import { holderCases, loadHolderModules, seedHolderSpace } from './_seq-hold-cases.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

/** The least the bound may be set to (`config/env-num.ts`). */
const BOUND = { writeTimeoutMs: 1000, holdDeadlineMs: 1000 };
/** How late a bounded write reaches the server: the width of the window the defect lives in (see the docblock). */
const LATE_BY_MS = 80;
/** How many times each lane is run. */
const REPS = 20;
/** How long, after a stall was released, a landing is waited for. */
const SETTLE_MS = 3000;
const POLL_MS = 250;
/** Lanes stalled at once: enough to keep the file's time down, few enough not to starve the driver's pool or the event loop. */
const WORKERS = 4;
/** How long past the bound a call may take to answer. */
const CAP_MS = BOUND.holdDeadlineMs + 2500;

/** Filled by `before`; the doors and the holder cases read them when they run. */
const env = {};
const ctx = {};

// ── The lanes ────────────────────────────────────────────────────────────────────────────────────────────────

/** One lane: a way to seed its own space, to stall it, and to call it. `expect503` — a door answers a status. */
const LANES = [];
const laneSpace = () => `landlane${LANES.length}`;

const DOOR_COUNT = stalledWriteDoors(env, 'x').length;
for (let i = 0; i < DOOR_COUNT; i++) {
  const space = laneSpace();
  const d = stalledWriteDoors(env, space)[i];
  LANES.push({ name: `door: ${d.name}`, space, collection: d.collection, expect503: true, seed: () => seedDoorSpace(env.door, space), lock: d.lock, call: d.call });
}
const HOLDERS = Object.entries(holderCases(ctx, 'x'));
for (const [holder, cases] of HOLDERS) {
  cases.forEach((c, k) => {
    const space = laneSpace();
    const mine = holderCases(ctx, space)[holder][k];
    const collection = mine.lock === 'counter' ? 'ythril_counters' : mine.collection;
    if (!collection) throw new Error(`holder case '${mine.label}' locks a document but names no collection in _seq-hold-cases.mjs`);
    LANES.push({
      name: `holder ${holder}: ${mine.label}`, space, collection, expect503: false,
      seed: () => seedHolderSpace(env.door, space),
      lock: mine.lock === 'counter' ? () => holdCounterLock(env.door.mongo, space) : mine.lock,
      call: mine.run,
    });
  });
}

// ── One repetition of one lane ───────────────────────────────────────────────────────────────────────────────

/** The space's documents by identity, and its counter row — one read, so lanes at once do not exhaust the driver's pool. */
const readLane = (space) => snapshotSpaceInOneRead(env.door.mongo, space, RECORD_PARTS);

/**
 * Stall one lane, call it, and the moment it answers read its documents AND release the stall — in that order, in one
 * tick, so the read is on the wire before the abort and nothing is waited for between them.
 */
async function stallAndRelease(lane) {
  const lock = await lane.lock();
  let res;
  let atAnswer = null;
  let releaseError = null;
  let answered = false;
  let watching = Promise.resolve(false);
  try {
    const started = Date.now();
    watching = sawLiveWrite(env.door.mongo, lane.collection, () => answered);
    res = await settleWithin(Promise.resolve().then(lane.call), CAP_MS);
    answered = true;
    res.elapsedMs = Date.now() - started;
    const reads = readLane(lane.space);
    const released = lock.release().then(() => null, err => err);
    atAnswer = await reads;
    releaseError = await released;
  } finally {
    answered = true;
    await lock.release().catch(() => {});
  }
  if (!res.settled) await res.rest;
  return { res, atAnswer, releaseError, sawStall: await watching };
}

/** Wait the settle window out, reading the lane every `POLL_MS`; the documents that differ from the answer's, by identity. */
async function watchForLanding(lane, atAnswer) {
  const landed = new Set();
  const until = Date.now() + SETTLE_MS;
  do {
    await new Promise(r => setTimeout(r, POLL_MS));
    for (const d of changedDocuments(atAnswer, await readLane(lane.space))) landed.add(d);
  } while (Date.now() < until);
  return [...landed].sort();
}

/** What a repetition reports, once its settle window is over. */
async function finishOnce(lane, rep, ran) {
  const value = ran.res?.settled && ran.res.ok ? ran.res.value : undefined;
  return {
    rep,
    fixtureError: ran.error ? String(ran.error?.stack ?? ran.error) : null,
    answered: !!ran.res?.settled,
    elapsedMs: ran.res?.elapsedMs,
    sawStall: !!ran.sawStall,
    status: value?.status ?? value?.code,
    thrown: ran.res?.settled && !ran.res.ok ? `${ran.res.error?.name}: ${String(ran.res.error?.message).slice(0, 200)}` : null,
    releaseError: ran.releaseError ? String(ran.releaseError.message ?? ran.releaseError) : null,
    landed: ran.atAnswer ? await watchForLanding(lane, ran.atAnswer) : [],
  };
}

/**
 * Every repetition of every lane, `WORKERS` stalls at a time. A lane's repetitions are in order, and its settle window
 * is waited out in the BACKGROUND of the next lanes' stalls — only the next repetition of the same lane waits for it.
 */
async function runAll(results) {
  const tasks = [];
  for (let rep = 0; rep < REPS; rep++) LANES.forEach((lane, i) => tasks.push({ lane, i, rep }));
  const previous = LANES.map(() => Promise.resolve());
  const watching = [];
  let next = 0;
  async function worker() {
    for (let t = tasks[next++]; t; t = tasks[next++]) {
      await previous[t.i];
      const ran = await t.lane.seed().then(() => stallAndRelease(t.lane)).catch(error => ({ error }));
      const finished = finishOnce(t.lane, t.rep, ran)
        .catch(error => ({ rep: t.rep, fixtureError: String(error?.stack ?? error), landed: [] }))
        .then(r => { results[t.i].push(r); });
      previous[t.i] = finished;
      watching.push(finished);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  await Promise.all(watching);
}

// ── The experiment, then one case per lane ───────────────────────────────────────────────────────────────────

describe('a write the bound ended never lands afterwards', { skip }, () => {
  let doors;
  let relay;
  let seamError = null;
  let restoreBound = () => {};
  /** `results[laneIndex]` — one entry per repetition. */
  const results = LANES.map(() => []);

  before(async () => {
    relay = await startDelayedWriteRelay({ host: TEST_MONGO_HOST, port: TEST_MONGO_PORT });
    doors = await openStalledWriteDoors({ suite: 'boundlands', spaces: LANES.map(l => l.space), mongoPort: relay.port });
    Object.assign(env, doors.env);
    Object.assign(ctx, { door: env.door, mods: await loadHolderModules() });
    try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seamError = err; return; }
    relay.setDelay(LATE_BY_MS);
    await runAll(results);
  }, { timeout: 120_000 + REPS * LANES.length * (CAP_MS + SETTLE_MS) / WORKERS });
  after(async () => {
    restoreBound();
    await doors?.close();
    await relay?.close();
  });

  it('the write bound has a test seam (db/write-bound.ts setWriteBoundForTest)', () => {
    assert.equal(seamError, null, seamError?.message);
  });

  it('the lanes are derived and floored, so an empty table cannot pass', () => {
    assert.ok(DOOR_COUNT >= 4, `only ${DOOR_COUNT} door(s) in _stalled-write-doors.mjs — the table or its import is broken`);
    const holderCaseCount = HOLDERS.reduce((n, [, cases]) => n + cases.length, 0);
    assert.ok(holderCaseCount >= 15, `only ${holderCaseCount} holder case(s) in _seq-hold-cases.mjs — the table or its import is broken`);
    assert.equal(LANES.length, DOOR_COUNT + holderCaseCount);
    assert.equal(new Set(LANES.map(l => l.space)).size, LANES.length, 'two lanes share a space, so one lane would read the other\'s writes');
    assert.ok(REPS >= 20 && SETTLE_MS >= 3000 && BOUND.holdDeadlineMs === 1000, 'the repetition, settle window and bound are what the rule is held at');
  });

  it('the relay held writes back, so the server\'s deadline really was later than the client\'s', () => {
    assert.ok(relay.delayedWrites() > 0,
      `the relay held back no bounded write in ${REPS * LANES.length} lane-repetitions — the lateness this file depends on was not produced`);
  });


  for (const [i, lane] of LANES.entries()) {
    it(`${lane.name}: nothing it would have written lands after the answer (${REPS} repetitions)`, () => {
      const rs = results[i];
      assert.equal(rs.length, REPS, `only ${rs.length} of ${REPS} repetitions ran — ${seamError ? 'no seam' : 'the experiment stopped'}`);
      const broken = rs.filter(r => r.fixtureError);
      assert.deepEqual(broken.map(r => `#${r.rep}: ${r.fixtureError.slice(0, 300)}`), [],
        `${lane.name}: a repetition could not run. An E11000 from holdDocumentLock means a write of an EARLIER repetition `
        + 'landed after this one wiped its space, which is the defect itself, seen from the next case');
      const unanswered = rs.filter(r => !r.answered);
      assert.deepEqual(unanswered.map(r => `#${r.rep}`), [],
        `${lane.name}: still waiting ${CAP_MS} ms into a write stalled behind a lock — no bound ended it`);
      const unstalled = rs.filter(r => !r.sawStall);
      assert.deepEqual(unstalled.map(r => `#${r.rep}: answered after ${r.elapsedMs} ms (${r.thrown ?? r.status})`), [],
        `${lane.name}: no write was ever alive on ${lane.collection} while the call waited — the lock stalled nothing, so "nothing landed" proves nothing`);
      const notTimedOut = rs.filter(r => !(r.status === 503 || /Timeout|timed out/i.test(r.thrown ?? '')));
      assert.deepEqual(notTimedOut.map(r => `#${r.rep}: ${r.thrown ?? r.status}`), [],
        `${lane.name}: answered, but not with the bound's timeout — the write was not ended by the bound`);
      if (lane.expect503) {
        assert.deepEqual(rs.filter(r => r.status !== 503).map(r => `#${r.rep}: ${r.status ?? r.thrown}`), [], `${lane.name}: not answered 503`);
      }
      assert.deepEqual(rs.filter(r => r.releaseError).map(r => `#${r.rep}: ${r.releaseError}`), [],
        `${lane.name}: the lock could not be released cleanly`);
      const landed = rs.filter(r => r.landed.length > 0);
      assert.deepEqual(landed.map(r => `#${r.rep}: ${r.landed.join('; ')}`), [],
        `${lane.name}: in ${landed.length} of ${REPS} repetitions the write the caller was told had timed out LANDED after the answer — `
        + `the client's deadline passed before the server's, so the server operation outlived the answer and the hold`);
    });
  }
});
