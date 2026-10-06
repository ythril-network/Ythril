/**
 * The experiment "a write the bound ended never lands afterwards", as a function a test file calls once with the client it
 * wants it run on (`Q-372`).
 *
 * ## Why it is a module, and why one file cannot run both clients
 *
 * The rule is held on two clients: the harness's own, and one whose `MONGO_URI` carries a `timeoutMS` below the bound
 * (pre-ship finding F1). The server's modules are singletons of a PROCESS — `config/loader.js` fixes its `CONFIG_PATH` at
 * first import, `db/mongo.js` holds one client — so a second door cannot be opened in the process that opened the first,
 * and the second client has to be a file of its own. Two files that each carry the lanes, the stall, the release and the
 * settle window are two copies of the part a copy gets subtly wrong; this is the one copy, and the files differ only in the
 * options they pass.
 *
 * The rule, the lanes and what a lane proves are described in `a-write-the-bound-ended-never-lands-db.test.js`.
 *
 * ## The options
 *
 * - `title`: the suite's name;
 * - `suite`: the harness database slug (unique per FILE: `a-db-harness-name-is-unique`);
 * - `query`: extra `MONGO_URI` options for the server's client (`'&timeoutMS=600'`), `''` for the harness's own;
 * - `reps`: how many times each lane is run;
 * - `minReps`: the fewest `reps` may be (default 5). A variant that runs the SAME lanes at a second lateness and is red or
 *   green at a handful of repetitions says so here, instead of lowering the floor for every file;
 * - `lateByMs`: how late the relay makes a bounded write reach the server (default `LATE_BY_MS`, 80). A variant that holds
 *   the rule at a lateness DERIVED from the product (`SERVER_FIRST_MARGIN_MS` + a margin, `Q-380`) passes it, and asserts
 *   its own floor over the product's figure — this module does not know which figure it was derived from;
 * - `laneIndexes`: run only these lanes of the full table (default all), by index. A narrow run has fewer lanes than
 *   workers, which is the shape that exposed `runAll` starting a lane's next repetition while the last one's settle window was
 *   still open (`Q-380`); the full table is still derived and floored whatever is run;
 * - `boundMs`: the write bound and the hold deadline (default 1000). The client-timeout variant runs a longer bound so the
 *   client's clock, which every OTHER operation of the lane inherits too (reads, seeds, the door's own lookups), can sit
 *   well above how long those take under load and still below the bound;
 * - `clientTimeoutMs`: the `timeoutMS` the client is given in `query`, or `undefined`. When it is given the experiment also
 *   asserts that the client really carries it, below the bound, and that no answer came before the server's deadline —
 *   the ORDER the bound promises: the server's deadline first, never a driver clock of the client's.
 */
import assert from 'node:assert/strict';
import { mongoSkipReason, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { RECORD_PARTS, snapshotSpaceInOneRead, changedDocuments } from './_space-snapshot.mjs';
import { holdCounterLock, settleWithin, setWriteBoundForTest } from './_write-faults.mjs';
import { sawLiveWrite } from './_active-operations.mjs';
import { startDelayedWriteRelay } from './_delayed-write-relay.mjs';
import { openStalledWriteDoors, seedDoorSpace, stalledWriteDoors } from './_stalled-write-doors.mjs';
import { holderCases, loadHolderModules, seedHolderSpace } from './_seq-hold-cases.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

/** The least the bound may be set to (`config/env-num.ts`). */
let BOUND = { writeTimeoutMs: 1000, holdDeadlineMs: 1000 };
/** How late a bounded write reaches the server: the width of the window the defect lives in (see the docblock). */
const LATE_BY_MS = 80;
/**
 * How far past the CLIENT's clock an answer may come and still count as that clock's. The write that inherited the clock is
 * answered at about the clock (a bound that lets it through: ~1500 ms against a 3000 ms bound). Every other operation of a
 * lane inherits the same clock (the door's own lookups, the harness's reads) and, on a loaded machine, can be ended by it
 * too, later and at no fixed time; those are not the subject, so only an answer within this window of the clock is read as
 * the write's.
 */
const CLOCK_WINDOW_MS = 400;
/** How long, after a stall was released, a landing is waited for. */
const SETTLE_MS = 3000;
const POLL_MS = 250;
/** Lanes stalled at once: enough to keep the file's time down, few enough not to starve the driver's pool or the event loop. */
const WORKERS = 4;
/** How long past the bound a call may take to answer. */
let CAP_MS = BOUND.holdDeadlineMs + 2500;

/** The server's `answered 5xx` log lines with the time they were said (`before` fills it, `after` stops it). */
const answered5xx = [];

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
  let startedAt = 0;
  let answeredAt = 0;
  let watching = Promise.resolve(false);
  try {
    const started = Date.now();
    startedAt = started;
    watching = sawLiveWrite(env.door.mongo, lane.collection, () => answered);
    res = await settleWithin(Promise.resolve().then(lane.call), CAP_MS);
    answered = true;
    answeredAt = Date.now();
    res.elapsedMs = answeredAt - started;
    const reads = readLane(lane.space);
    const released = lock.release().then(() => null, err => err);
    atAnswer = await reads;
    releaseError = await released;
  } finally {
    answered = true;
    await lock.release().catch(() => {});
  }
  if (!res.settled) await res.rest;
  return { res, atAnswer, releaseError, sawStall: await watching, startedAt, answeredAt };
}

/** Wait the settle window out, reading the lane every `POLL_MS`; the documents that differ from the answer's, by identity. */
async function watchForLanding(lane, atAnswer) {
  const landed = new Set();
  const until = Date.now() + SETTLE_MS;
  do {
    await sleep(POLL_MS);
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
    // What the answer SAID, so a repetition the bound did not end is told apart from one it did (`notASample` reads it).
    said: [value?.body?.error ?? value?.text, value?.body?.codeName].filter(Boolean).join(' / ').slice(0, 240),
    // The server's own account of WHY it answered 5xx is in its log, never in the body: the lines said while this call waited.
    // Read only for a call answered with no write alive, which is the one a reader then has to explain.
    serverSaid: ran.res?.settled && !ran.sawStall
      ? answered5xx.filter(l => l.at >= ran.startedAt - 50 && l.at <= ran.answeredAt + 50 && new RegExp(`\\b${lane.space}\\b`).test(l.line)).map(l => l.line.slice(0, 300)) : [],
    thrown: ran.res?.settled && !ran.res.ok ? `${ran.res.error?.name}: ${String(ran.res.error?.message).slice(0, 200)}` : null,
    releaseError: ran.releaseError ? String(ran.releaseError.message ?? ran.releaseError) : null,
    landed: ran.atAnswer ? await watchForLanding(lane, ran.atAnswer) : [],
  };
}

/** How many times in all one repetition is run when the attempts before it proved nothing (see {@link notASample}). */
const MAX_ATTEMPTS = 4;

/**
 * Did this repetition prove nothing, because the thing it exists to hold up never happened?
 *
 * ## What it prevents
 *
 * The rule is "a write the bound ended never lands". A repetition says something about it only when a write was ALIVE behind
 * the lock while the call waited: the server was asked, every 50 ms, for the whole of the call. A call that was answered with
 * no write ever alive was ended by something that is not the bound ending a write — the door answered before it had a write to
 * stall (a store failure of the loaded machine, a connection the driver had to open again), so there is nothing the lock could
 * have held and nothing that could land. Counting it as a sample failed the lane on the machine's load rather than on the
 * rule; counting it as GREEN would be the opposite fault, a lane that passes having stalled nothing.
 *
 * So it is neither: it is run again, up to {@link MAX_ATTEMPTS} times, and when the attempts run out it is reported as it is
 * (the lane fails on "no write was ever alive", which is then a fact about the door and not about one unlucky moment).
 * An attempt discarded this way is still read for a landing: nothing it left may appear later.
 *
 * A repetition that did not answer, or whose fixture failed, is NOT this: those are the rule's own failures.
 */
const notASample = (r) => r.answered && !r.fixtureError && !r.sawStall;

/**
 * Every repetition of every lane, `WORKERS` stalls at a time. A lane's repetitions are in order, and its settle window
 * is waited out in the BACKGROUND of the next lanes' stalls — only the next repetition of the same lane waits for it.
 *
 * A repetition that proved nothing ({@link notASample}) is queued again for the next round, after every settle window of
 * this one has closed, so its seed never lands under another attempt's open window. `discarded[i]` holds the attempts
 * of lane `i` that were not samples; `results[i]` holds exactly one entry per repetition.
 */
async function runAll(lanes, results, reps, discarded) {
  let tasks = [];
  for (let rep = 0; rep < reps; rep++) lanes.forEach((lane, i) => tasks.push({ lane, i, rep, attempt: 1 }));
  const previous = lanes.map(() => Promise.resolve());
  while (tasks.length > 0) {
    const queue = tasks;
    tasks = [];
    await runRound(queue, previous, results, discarded, tasks);
  }
}

/** One pass over `tasks`: the repetitions that proved nothing are pushed onto `again` for the next. */
async function runRound(tasks, previous, results, discarded, again) {
  const watching = [];
  let next = 0;
  async function worker() {
    for (let t = tasks[next++]; t; t = tasks[next++]) {
      // The lane's NEXT repetition waits for THIS one's settle window, and is told so the moment this one is TAKEN — not after
      // its stall has run: a worker that pulls the lane's next repetition while this one is still stalling must find this one's
      // `done`, or it seeds the lane (wipe, insert, counter) under an open settle window, and the experiment reports its own
      // seed as a landing (`Q-380`).
      const before = previous[t.i];
      let done = () => {};
      previous[t.i] = new Promise(resolve => { done = resolve; });
      await before;
      const ran = await t.lane.seed().then(() => stallAndRelease(t.lane)).catch(error => ({ error }));
      const finished = finishOnce(t.lane, t.rep, ran)
        .catch(error => ({ rep: t.rep, fixtureError: String(error?.stack ?? error), landed: [], serverSaid: [] }))
        .then(r => {
          if (notASample(r) && t.attempt < MAX_ATTEMPTS) {
            discarded[t.i].push({ ...r, attempt: t.attempt });
            again.push({ ...t, attempt: t.attempt + 1 });
          } else {
            results[t.i].push({ ...r, attempts: t.attempt });
          }
        });
      finished.then(done);
      watching.push(finished);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  await Promise.all(watching);
}


// ── The experiment, then one case per lane ───────────────────────────────────────────────────────────────────

/**
 * The experiment for one client, as data the test file declares: its title and skip, the `before`/`after` that run it, and
 * one case per check. Call it ONCE per test file (see the docblock for why).
 *
 * ## Why it returns cases instead of calling `describe` and `it` itself
 *
 * Node records a test against the file that CALLED `it`, not the file it ran. While this module declared the suite, all of
 * its cases were recorded under `_write-landing-experiment.mjs`, and the two test files that run it reported no test of
 * their own — so the CI gate that proves every test file ran (`scripts/executed-tests.mjs`) named both as never run, and
 * their durations went to a helper. The test file declares: `describe(x.title, { skip: x.skip }, () => { before(x.before,
 * { timeout: x.timeout }); after(x.after); for (const c of x.cases) it(c.name, c.fn); })`. `a-test-is-declared-where-it-runs`
 * holds that no helper module declares a test.
 *
 * @param {{ title: string, suite: string, query: string, reps: number, clientTimeoutMs?: number, boundMs?: number, holdMs?: number }} o
 *   `boundMs`: the write bound the experiment sets (default 1000, the least it may be); `holdMs`: the hold deadline (default
 *   the same). A variant that asserts WHEN an answer came gives the hold more than the bound: an operation late in a hold is
 *   bounded by what is left of the hold, which is less than the bound, and would read as an early answer
 * @returns {{ title: string, skip: string | false | undefined, lateByMs: number, laneCount: number, timeout: number, before: () => Promise<void>, after: () => Promise<void>, cases: Array<{ name: string, fn: () => void }> }}
 */
export function landingExperiment({ title, suite, query, reps, minReps = 5, lateByMs = LATE_BY_MS, laneIndexes, clientTimeoutMs, boundMs = 1000, holdMs = boundMs }) {
  const REPS = reps;
  BOUND = { writeTimeoutMs: boundMs, holdDeadlineMs: holdMs };
  CAP_MS = holdMs + 2500;
  if (laneIndexes !== undefined && !laneIndexes.every(i => Number.isInteger(i) && i >= 0 && i < LANES.length)) {
    throw new Error(`landingExperiment: laneIndexes [${laneIndexes}] names a lane outside the table of ${LANES.length}`);
  }
  /** The lanes this run walks: the whole table unless it was narrowed. Its spaces are the only ones opened. */
  const lanes = laneIndexes === undefined ? LANES : laneIndexes.map(i => LANES[i]);
  let doors;
  let relay;
  let seamError = null;
  let restoreBound = () => {};
  let stopListening = () => {};
  /** `results[laneIndex]` — one entry per repetition. */
  const results = lanes.map(() => []);
  /** `discarded[laneIndex]` — the attempts that proved nothing ({@link notASample}) and were run again. */
  const discarded = lanes.map(() => []);
  const cases = [];
  const it = (name, fn) => cases.push({ name, fn });

  {
    it('the write bound has a test seam (db/write-bound.ts setWriteBoundForTest)', () => {
      assert.equal(seamError, null, seamError?.message);
    });

    it('the lanes are derived and floored, so an empty table cannot pass', () => {
      assert.ok(DOOR_COUNT >= 4, `only ${DOOR_COUNT} door(s) in _stalled-write-doors.mjs — the table or its import is broken`);
      const holderCaseCount = HOLDERS.reduce((n, [, cases]) => n + cases.length, 0);
      assert.ok(holderCaseCount >= 15, `only ${holderCaseCount} holder case(s) in _seq-hold-cases.mjs — the table or its import is broken`);
      assert.equal(LANES.length, DOOR_COUNT + holderCaseCount);
      assert.equal(new Set(LANES.map(l => l.space)).size, LANES.length, 'two lanes share a space, so one lane would read the other\'s writes');
      assert.ok(REPS >= minReps && SETTLE_MS >= 3000 && BOUND.holdDeadlineMs >= 1000, 'the repetition, settle window and bound are what the rule is held at');
      assert.ok(lanes.length >= 1 && lanes.every(l => LANES.includes(l)), 'the narrowed run walks a lane the table does not have');
    });

    if (clientTimeoutMs !== undefined) {
      it('the client really carries the URI option, below the bound: the variant is not the harness\'s own client in disguise', () => {
        assert.ok(clientTimeoutMs < BOUND.writeTimeoutMs, `the URI timeoutMS (${clientTimeoutMs}) must be below the bound (${BOUND.writeTimeoutMs}) or it proves nothing`);
        assert.equal(env.door.mongo.getMongo().options.timeoutMS, clientTimeoutMs, 'MONGO_URI\'s timeoutMS did not reach the server\'s client');
      });
    }

    it('the relay held writes back, so the server\'s deadline really was later than the client\'s', () => {
      assert.ok(relay.delayedWrites() > 0,
        `the relay held back no bounded write in ${REPS * lanes.length} lane-repetitions — the lateness this file depends on was not produced`);
    });


    for (const [i, lane] of lanes.entries()) {
      it(`${lane.name}: nothing it would have written lands after the answer (${REPS} repetitions)`, (t) => {
        const rs = results[i];
        for (const r of discarded[i]) {
          t.diagnostic(`${lane.name}: attempt ${r.attempt} of #${r.rep} proved nothing and was run again — answered after ${r.elapsedMs} ms (${r.thrown ?? r.status}), no write alive on ${lane.collection}: ${r.said || r.thrown}; the server said: ${r.serverSaid.join(' | ') || 'nothing'}`);
        }
        assert.equal(rs.length, REPS, `only ${rs.length} of ${REPS} repetitions ran — ${seamError ? 'no seam' : 'the experiment stopped'}`);
        if (clientTimeoutMs !== undefined) {
          const early = rs.filter(r => r.answered && r.elapsedMs < clientTimeoutMs + CLOCK_WINDOW_MS);
          assert.deepEqual(early.map(r => `#${r.rep}: answered after ${r.elapsedMs} ms`), [],
            `${lane.name}: answered within ${CLOCK_WINDOW_MS} ms of the client's own clock (${clientTimeoutMs} ms), well before the server's deadline (${BOUND.writeTimeoutMs} ms) — a client-side clock, the \`timeoutMS\` this client inherited from `
            + 'MONGO_URI, ended the write first; the bound must carry the server\'s deadline and no driver clock of its own');
        }
        const broken = rs.filter(r => r.fixtureError);
        assert.deepEqual(broken.map(r => `#${r.rep}: ${r.fixtureError.slice(0, 300)}`), [],
          `${lane.name}: a repetition could not run. An E11000 from holdDocumentLock means a write of an EARLIER repetition `
          + 'landed after this one wiped its space, which is the defect itself, seen from the next case');
        const unanswered = rs.filter(r => !r.answered);
        assert.deepEqual(unanswered.map(r => `#${r.rep}`), [],
          `${lane.name}: still waiting ${CAP_MS} ms into a write stalled behind a lock — no bound ended it`);
        const unstalled = rs.filter(r => !r.sawStall);
        assert.deepEqual(unstalled.map(r => `#${r.rep}: answered after ${r.elapsedMs} ms (${r.thrown ?? r.status}: ${r.said}), ${r.attempts} attempt(s); the server said: ${r.serverSaid.join(' | ') || 'nothing'}`), [],
          `${lane.name}: no write was ever alive on ${lane.collection} while the call waited, in ${MAX_ATTEMPTS} attempts — the lock stalled nothing, so "nothing landed" proves nothing`);
        const notTimedOut = rs.filter(r => !(r.status === 503 || /Timeout|timed out/i.test(r.thrown ?? '')));
        assert.deepEqual(notTimedOut.map(r => `#${r.rep}: ${r.thrown ?? r.status}`), [],
          `${lane.name}: answered, but not with the bound's timeout — the write was not ended by the bound`);
        if (lane.expect503) {
          assert.deepEqual(rs.filter(r => r.status !== 503).map(r => `#${r.rep}: ${r.status ?? r.thrown}`), [], `${lane.name}: not answered 503`);
        }
        assert.deepEqual(rs.filter(r => r.releaseError).map(r => `#${r.rep}: ${r.releaseError}`), [],
          `${lane.name}: the lock could not be released cleanly`);
        // An attempt that proved nothing and was run again is read for a landing too: a write it left must not appear later.
        const landed = [...rs, ...discarded[i]].filter(r => r.landed.length > 0);
        assert.deepEqual(landed.map(r => `#${r.rep}: ${r.landed.join('; ')}`), [],
          `${lane.name}: in ${landed.length} of ${REPS} repetitions the write the caller was told had timed out LANDED after the answer — `
          + `the client's deadline passed before the server's, so the server operation outlived the answer and the hold`);
      });
    }
  }

  return {
    title,
    skip,
    lateByMs,
    laneCount: lanes.length,
    timeout: 120_000 + REPS * lanes.length * (CAP_MS + SETTLE_MS) / WORKERS,
    async before() {
      relay = await startDelayedWriteRelay({ host: TEST_MONGO_HOST, port: TEST_MONGO_PORT });
      doors = await openStalledWriteDoors({ suite, spaces: lanes.map(l => l.space), mongoPort: relay.port, mongoQuery: query });
      Object.assign(env, doors.env);
      Object.assign(ctx, { door: env.door, mods: await loadHolderModules() });
      try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seamError = err; return; }
      relay.setDelay(lateByMs);
      const { subscribeLogLines } = await import('../../server/dist/util/log.js');
      stopListening = subscribeLogLines((line) => {
        if (/answered 5\d\d/.test(line)) { answered5xx.push({ at: Date.now(), line }); if (answered5xx.length > 500) answered5xx.shift(); }
      });
      await runAll(lanes, results, REPS, discarded);
    },
    async after() {
      stopListening();
      restoreBound();
      await doors?.close();
      await relay?.close();
    },
    cases,
  };
}
