/**
 * Shutdown lets a running sync cycle stop at its page, answers it, and closes the database only after (bundle-39 D5, `Q-228`).
 *
 * ## The defect
 *
 * Nothing awaited a sync cycle. SIGTERM ran the shutdown sequence (stop the schedulers, drain the HTTP server, flush the config, close the database)
 * while a cycle was mid-page: the page's write ran against a closing client, the member was counted a failure for a stop that was nobody's fault,
 * the waiting caller got a 500 or nothing, the history row of the cycle was lost, and a cycle a notice had started could begin AFTER the stop.
 *
 * ## The rule (design v2, v3, v5 and v6)
 *
 * Shutdown ends a running cycle at its next PAGE boundary and waits for it, bounded, before `flushConfig` and `closeMongo`:
 *
 *  - the page in flight lands whole (it is a write, never torn), and no further page is fetched, whichever door started the cycle (the REST network
 *    door, the REST peer door, a notice that wakes a cycle);
 *  - the waiting caller is answered: outcome `interrupted`, HTTP 503 `shutting_down`, every member `interrupted` (never `failed`, never `success`);
 *  - the member's failure counter does not move (nothing failed), the history row of a network cycle is written (`partial`, the errors name the
 *    shutdown) before the database closes, and the cycle wait resolves before the database closes;
 *  - the mark stays where the families not yet run start (v6 S1: a family the cycle never reached is pulled whole by the next cycle: here the entities
 *    sit BELOW the facts the interrupted cycle landed, so a mark that followed the facts would skip them for good);
 *  - a trigger that arrives after shutdown began (REST network and peer, MCP network / peer / all networks, the generic REST door, a notice) starts no
 *    cycle and answers 503 `shutting_down`, during the wait and after the database is closed.
 *
 * ## What it drives
 *
 * The REAL engine against the pull door's fake peer, the REAL shutdown sequence, and the one write of the page in flight parked behind a gate the
 * test opens (`parkWrites`), so "a page is in flight" is a state the test holds, not a timing it hopes for. The shutdown's HTTP server is a stub that
 * answers `close` at once; `exit` is a spy (the sequence ends the process in production).
 *
 * ## The contract this test names (the plan extracts the sequence from `index.ts` so it can be called; no path or signature was fixed)
 *
 * `server/src/shutdown.ts` exports `runShutdown({ signal, server, exit })`: the whole sequence of the old `const shutdown = async (signal) => { ... }` of
 * `index.ts`, with `server` anything that has `close(cb)` and `closeAllConnections()`, and `exit(code)` called once at the end, after `closeMongo`, in
 * place of `process.exit` (the default). `index.ts` calls it from its signal handlers. Its re-entry guard, and whatever `beginShutdown()` aborts or
 * closes (the shutdown signal, the in-flight registry), are restored by `resetLifecycleForTests()` of `lifecycle.ts`, which the test calls between
 * cases: one process, several shutdowns. If the module is placed or named otherwise, change `SHUTDOWN_MODULE` below: it is the only coupling.
 *
 * ## Red at a0efade0a
 *
 * `server/dist/shutdown.js` does not exist, so every case fails naming the missing export; written to assert behaviour once it does (a stand-in
 * that closes the database at once, kept in the notes of this change, fails the page, the counter and the history assertions, which is what a shutdown
 * that does not wait looks like).
 *
 * Run: node --test testing/standalone/shutdown-lets-a-running-sync-stop-at-its-page-db.test.js (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { clearPositionMarks, readMark, setMark, positioned } from './_b81b-positions.mjs';
import { parkWrites, settleWithin } from './_write-faults.mjs';
import { fakeRes } from './_vote-round-instance.mjs';
import { syncToolCtx } from './_sync-doors.mjs';
import { waitFor, holdsWithin } from '../_shared/wait-for.mjs';

// The sequence's own waits are read when it runs; none of them is the subject here.
process.env['SHUTDOWN_READY_GRACE_MS'] = '0';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** Where the shutdown sequence is exported (see the contract above). */
const SHUTDOWN_MODULE = '../../server/dist/shutdown.js';

const S = 'shutcycle';
const SENTINEL = 3;
/** Facts the peer holds (positions above the entities') and entities (positions BELOW them), so a mark that followed the facts would skip the entities. */
const FACT_POS = 100, FACT_COUNT = 6;
const ENTITY_POS = 10, ENTITY_COUNT = 2;

let door, runShutdown, shutdownMissing, lifecycle, engine, trigger, notifyHandler, syncTool, proto;


const need = () => assert.ok(runShutdown,
  `the shutdown sequence is not exported: ${SHUTDOWN_MODULE} exports no runShutdown (${shutdownMissing?.message ?? 'no module'}). `
  + 'Nothing can drive a shutdown with a cycle in flight until the sequence is a function; see the contract in this file\'s header');

/** `facts` pages of ONE record each from the real handler, so the cycle is mid-way when the shutdown begins; every other family unpaged. */
function pagedAtOne() {
  return async (req, res, family) => {
    if (family === 'facts') Object.defineProperty(req, 'query', { value: { ...req.query, limit: '1' }, writable: true, configurable: true, enumerable: true });
    await door.serveFamily(req, res, family);
  };
}
const unpaged = () => (req, res, family) => door.serveFamily(req, res, family);
const factRequests = () => door.state.familyRequests.filter(r => r.family === 'facts').length;
const entityRequests = () => door.state.familyRequests.filter(r => r.family === 'entities').length;
const factsHere = () => door.coll(S, 'facts').countDocuments();
const entitiesHere = () => door.coll(S, 'entities').countDocuments();

/** Is the server's database connection open? (`closeMongo` drops the client.) */
const dbOpen = () => { try { door.mongo.getMongo(); return true; } catch { return false; } };
/** After a shutdown closed the database: the connection back, for what the next case reads and the harness's own close. */
async function reopen() {
  if (dbOpen()) return;
  door.mongo._resetDbName?.();
  await door.mongo.connectMongo();
}

/** The history rows of the network, oldest first (read once the connection is open). */
const historyRows = async () => (await door.mongo.col('_sync_history').find({ networkId: door.NET }).sort({ completedAt: 1 }).toArray());

/** One shutdown, driven: its promise, the stub server and the spy `exit`. */
function beginTheShutdown() {
  const seen = { httpClosed: 0, exits: [] };
  const server = { close(cb) { seen.httpClosed++; cb?.(); }, closeAllConnections() { /* nothing is connected */ } };
  const down = runShutdown({ signal: 'SIGTERM', server, exit: (code) => { seen.exits.push(code); } });
  return { down, seen };
}

/** The same question put to every door a trigger can come through; each answers `{ door, answered: { status, ok, text } }`. */
function triggerDoors() {
  const rest = async (call) => { const res = fakeRes(); await call(res); return { status: res.code, body: res.body }; };
  const mcp = async (args, transport = 'mcp') => {
    try {
      const r = await syncTool.handle(syncToolCtx(args, transport));
      return { status: r.isError ? 'error' : 'ok', body: { text: r.content?.map(c => c.text).join(' ') ?? '', structured: r.structuredContent, isError: r.isError } };
    } catch (err) { return { status: 'threw', body: { text: String(err?.message ?? err) } }; }
  };
  const N = door.NET;
  return [
    ['REST network, wait', () => rest(res => trigger.triggerNetworkSync(res, N, { wait: true, timeoutMs: trigger.syncTimeoutMs(5_000) }))],
    ['REST network, no wait', () => rest(res => trigger.triggerNetworkSync(res, N, { wait: false, timeoutMs: trigger.syncTimeoutMs(undefined) }))],
    ['REST peer, wait', () => rest(res => trigger.triggerPeerSync(res, PEER, { wait: true }))],
    ['REST peer, no wait', () => rest(res => trigger.triggerPeerSync(res, PEER, { wait: false }))],
    ['MCP network', () => mcp({ networkId: N })],
    ['MCP peer', () => mcp({ peerId: PEER })],
    ['MCP all networks', () => mcp({})],
    ['generic REST door, network', () => mcp({ networkId: N, wait: true }, 'rest')],
  ];
}

/** A door's answer, bounded: a trigger that JOINS the running cycle waits for as long as the page is held, which is a failed case, not a hung one. */
async function answerOf(label, call) {
  const r = await settleWithin(call(), 5_000);
  assert.ok(r.settled, `${label}: no answer within 5 s: the trigger joined the running cycle (or started one) instead of refusing, because shutdown began`);
  assert.ok(r.ok, `${label}: the door threw instead of answering: ${r.error}`);
  return r.value;
}

/** What a refused trigger must say, on any door: 503 / an error that names the shutdown. */
function assertRefusedForShutdown(label, r) {
  const text = JSON.stringify(r.body ?? {});
  assert.ok(/shutting[ _]down/i.test(text), `${label}: the answer does not say the instance is shutting down: ${r.status} ${text.slice(0, 300)}`);
  if (typeof r.status === 'number') {
    assert.equal(r.status, 503, `${label}: a trigger during shutdown answered ${r.status}, not 503 shutting_down: ${text.slice(0, 300)}`);
    assert.equal(r.body?.code, 'shutting_down', `${label}: the 503 carries no code 'shutting_down': ${text.slice(0, 300)}`);
    assert.notEqual(r.body?.ok, true, `${label}: a refused trigger answered ok: true`);
  } else {
    assert.ok(r.status === 'error' || r.status === 'threw', `${label}: the MCP door did not refuse (${r.status}): ${text.slice(0, 300)}`);
  }
}

/**
 * Start a cycle, hold it with its first page IN FLIGHT (the write of the first facts page parked), begin the shutdown, and hand back what the case
 * needs to release the page and read the outcome. `start` returns the promise of the starting door's answer (or `null` for a door that gives none).
 */
async function cycleInFlight(start) {
  need();
  const park = parkWrites(proto);
  // Only the write that LANDS the page, by the records it carries (`sf-…`, whatever method lands them). Another write to the facts collection comes
  // first (the one-time re-read of a member's tombstones backfills `deliveredBy` with an `updateMany`), and parking that one would hold the cycle
  // before it asked for any page.
  const gate = park.arm(`${S}_facts`, { when: (_method, args) => /"sf-\d+"/.test(JSON.stringify(args)) });
  let held = false;
  gate.reached.then(() => { held = true; });
  const answered = start();
  await waitFor(() => held, 15_000, 20, undefined, { what: 'the first facts page to be landing (its write parked)' });
  const { down, seen } = beginTheShutdown();
  await waitFor(() => lifecycle.isShuttingDown(), 5_000, 10, undefined, { what: 'the shutdown to begin' });
  return { gate, park, answered, down, seen };
}

/** The outcome every door's cycle shares once the page is released: lands, stops, shutdown completes, database closed after. */
async function finish(c) {
  const early = await settleWithin(c.down, 600);
  const during = { settled: early.settled, dbOpen: dbOpen(), exits: [...c.seen.exits] };
  c.gate.release();
  // Bounded: a cycle that never ends (the database closed under it, a page that is never answered) is a failed case, not a hung one.
  const waited = c.answered ? await settleWithin(c.answered, 20_000) : { settled: true, ok: true, value: null };
  const answer = waited.settled && waited.ok ? waited.value : null;
  const dbOpenAtAnswer = dbOpen();
  const end = await settleWithin(c.down, 20_000);
  c.park.restore();
  return { during, answer, answeredInTime: waited.settled, answerError: waited.ok === false ? waited.error : null, dbOpenAtAnswer, shutdownSettled: end.settled, dbOpenAfter: dbOpen(), exits: [...c.seen.exits] };
}

describe('shutdown lets a running sync stop at its page', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'shutcycle', spaces: [S], direction: 'pull' });
    ({ runShutdown } = await import(SHUTDOWN_MODULE).catch((err) => { shutdownMissing = err; return {}; }));
    lifecycle = await import('../../server/dist/lifecycle.js');
    engine = await import('../../server/dist/sync/engine.js');
    trigger = await import('../../server/dist/sync/trigger.js');
    ({ network_syncTool: syncTool } = await import('../../server/dist/mcp/tools/sync.js'));
    const { notifyRouter } = await import('../../server/dist/api/notify.js');
    const layer = notifyRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
    notifyHandler = layer?.route.stack.at(-1).handle;
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  after(async () => {
    lifecycle?.resetLifecycleForTests();
    if (door) { await reopen(); await door.close(); }
  });
  beforeEach(async () => {
    lifecycle.resetLifecycleForTests();
    await reopen();
    await door.reset({ direction: 'pull' });
    // The previous case's next cycle wrote a history row of its own: the rows a case reads are its own interrupted cycle's.
    await door.mongo.col('_sync_history').deleteMany({ networkId: door.NET });
    clearPositionMarks(door);
    door.member().consecutiveFailures = 4;
    await door.seedPeerRecords(S, 'facts', Array.from({ length: FACT_COUNT }, (_, i) =>
      positioned(build.fact(S, `sf-${i + 1}`, FACT_POS + i, { author: PEER_AUTHOR }))));
    await door.seedPeerRecords(S, 'entities', Array.from({ length: ENTITY_COUNT }, (_, i) =>
      positioned(build.entity(S, `se-${i + 1}`, ENTITY_POS + i, { author: PEER_AUTHOR }))));
    setMark(door, 'received', S, SENTINEL);
    door.state.family = pagedAtOne();
    door.state.network = null;
  });

  /**
   * The assertions every starting door shares, once `finish` has run: the sequence called `exit` once, after the database closed; the page in
   * flight landed whole and nothing further was fetched; the counter did not move; the mark did not pass the entities the cycle never reached.
   */
  async function assertTheCycleStoppedAtItsPage(out, c) {
    assert.equal(out.during.settled, false, 'the shutdown finished while a page was in flight: it did not wait for the cycle');
    assert.equal(out.during.dbOpen, true, 'the database was closed while a page was in flight');
    assert.deepEqual(out.during.exits, [], 'the process was ended while a page was in flight');
    assert.equal(out.answeredInTime, true, 'the waiting caller was not answered within 20 s of the page being released');
    assert.equal(out.answerError, null, `the waiting caller's answer threw: ${out.answerError}`);
    assert.equal(out.dbOpenAtAnswer, true, 'the database was closed before the waiting cycle was answered: the cycle wait does not come before closeMongo');
    assert.equal(out.shutdownSettled, true, 'the shutdown did not finish within 20 s of the page being released');
    assert.equal(out.dbOpenAfter, false, 'the shutdown finished without closing the database: this is not the whole sequence');
    assert.deepEqual(out.exits, [0], `exit was called ${JSON.stringify(out.exits)}, not once with 0`);
    assert.equal(c.seen.httpClosed, 1, 'the HTTP server was not closed exactly once');
    await reopen();
    assert.equal(factRequests(), 1, `the cycle fetched ${factRequests()} facts pages: it went on to another page after the shutdown began`);
    assert.equal(await factsHere(), 1, 'the page in flight did not land whole: the receiver holds ' + await factsHere() + ' facts, expected exactly the one of the first page');
    assert.equal(entityRequests(), 0, 'the cycle fetched the next family after the shutdown began');
    assert.equal(door.member().consecutiveFailures, 4, `the member's failure count moved to ${door.member().consecutiveFailures}: a cycle stopped by shutdown is nobody's failure`);
    const mark = readMark(door, 'received', S);
    assert.ok(Number.isSafeInteger(mark) && mark >= SENTINEL && mark < ENTITY_POS,
      `lastPosReceived is ${String(mark)} after a cycle that never reached the entities at positions ${ENTITY_POS}+: it must stay where the families not run start (${SENTINEL}), or the next cycle skips them`);
  }

  /** The next cycle, after the lifecycle is reset: everything the interrupted one left is pulled, the entities included. */
  async function assertTheNextCycleCompletes() {
    lifecycle.resetLifecycleForTests();
    await reopen();
    door.state.family = unpaged();
    await door.sync();
    assert.equal(await factsHere(), FACT_COUNT, 'the next cycle did not pull the facts the interrupted one left');
    assert.equal(await entitiesHere(), ENTITY_COUNT, 'the next cycle did not pull the entities the interrupted cycle never reached (the family not yet run)');
    assert.ok((readMark(door, 'received', S) ?? 0) >= FACT_POS + FACT_COUNT - 1, `the mark is ${readMark(door, 'received', S)} after the cycle that read everything`);
  }

  it('the REST network door: the page in flight lands, no further page is fetched, the cycle is answered interrupted / 503 shutting_down, the history is written, and the database closes after', async () => {
    const res = fakeRes();
    const c = await cycleInFlight(() => trigger.triggerNetworkSync(res, door.NET, { wait: true, timeoutMs: trigger.syncTimeoutMs(120_000) }).then(() => res));
    const out = await finish(c);
    await assertTheCycleStoppedAtItsPage(out, c);
    const body = out.answer.body;
    assert.equal(out.answer.code, 503, `the waiting caller was answered ${out.answer.code} ${JSON.stringify(body)}`);
    assert.equal(body.code, 'shutting_down', `the answer's code is ${JSON.stringify(body?.code)}`);
    assert.equal(body.outcome, 'interrupted', `the answer's outcome is ${JSON.stringify(body?.outcome)}`);
    assert.equal(body.ok, false, 'an interrupted cycle was answered ok: true');
    assert.ok(Array.isArray(body.members) && body.members.length === 1, `the answer names ${body.members?.length} members, expected the one`);
    assert.deepEqual({ networkId: body.members[0].networkId, instanceId: body.members[0].instanceId, outcome: body.members[0].outcome },
      { networkId: door.NET, instanceId: PEER, outcome: 'interrupted' }, 'the member is not told interrupted (it is not failed, and it did not succeed)');
    assert.equal(typeof body.members[0].reason, 'string', 'the member carries no reason');
    const rows = await historyRows();
    assert.equal(rows.length, 1, `the cycle's history row was ${rows.length === 0 ? 'lost to the database closing' : 'written ' + rows.length + ' times'}`);
    assert.equal(rows[0].status, 'partial', `the history says ${rows[0].status}: a shutdown is not a sync result, it records partial`);
    assert.ok((rows[0].errors ?? []).some(e => /shutdown|shutting down/i.test(e)), `the history row does not name the shutdown: ${JSON.stringify(rows[0].errors)}`);
    await assertTheNextCycleCompletes();
  });

  it('the REST peer door: the same stop, answered interrupted / 503 shutting_down', async () => {
    const res = fakeRes();
    const c = await cycleInFlight(() => trigger.triggerPeerSync(res, PEER, { wait: true }).then(() => res));
    const out = await finish(c);
    await assertTheCycleStoppedAtItsPage(out, c);
    const body = out.answer.body;
    assert.equal(out.answer.code, 503, `the waiting caller was answered ${out.answer.code} ${JSON.stringify(body)}`);
    assert.equal(body.code, 'shutting_down');
    assert.equal(body.outcome, 'interrupted');
    assert.equal(body.ok, false);
    assert.equal(body.members?.[0]?.outcome, 'interrupted', `the member says ${JSON.stringify(body.members?.[0])}`);
    await assertTheNextCycleCompletes();
  });

  it('a cycle a notice started is waited for too: it stops at its page, and the shutdown does not close the database under it', async () => {
    assert.ok(notifyHandler, 'no POST / handler on the notify router: re-anchor this test');
    const res = fakeRes();
    const c = await cycleInFlight(async () => {
      await notifyHandler({ body: { networkId: door.NET, instanceId: PEER, event: 'sync_available', data: {} }, authToken: ADMIN_TOKEN,
        query: {}, params: {}, headers: {}, get: () => undefined, ip: '127.0.0.1' }, res);
      return null;
    });
    assert.ok(res.code >= 200 && res.code < 300, `the notice was refused: ${res.code} ${JSON.stringify(res.body)}`);
    const out = await finish(c);
    await assertTheCycleStoppedAtItsPage(out, c);
    const rows = await historyRows();
    assert.equal(rows.length, 1, `the notice's cycle left ${rows.length} history rows (a closed database loses the row)`);
    assert.equal(rows[0].status, 'partial');
    await assertTheNextCycleCompletes();
  });

  it('a trigger that arrives once shutdown began starts no cycle and answers 503 shutting_down on every door, while the page is held and after the database closed', async () => {
    const res = fakeRes();
    const c = await cycleInFlight(() => trigger.triggerNetworkSync(res, door.NET, { wait: true, timeoutMs: trigger.syncTimeoutMs(120_000) }).then(() => res));
    const fetchedBefore = factRequests();
    const doors = triggerDoors();

    // While the page is held and the shutdown waits: a trigger would otherwise JOIN the running cycle (or start the peer's own).
    for (const [label, call] of doors) assertRefusedForShutdown(`${label} (during)`, await answerOf(label, call));
    // A notice wakes no cycle either.
    await notifyHandler({ body: { networkId: door.NET, instanceId: PEER, event: 'sync_available', data: {} }, authToken: ADMIN_TOKEN,
      query: {}, params: {}, headers: {}, get: () => undefined, ip: '127.0.0.1' }, fakeRes());
    const woke = await holdsWithin(() => engine.syncCyclesInFlight() > 1 || factRequests() > fetchedBefore, 500, 25);
    assert.equal(woke, false, 'a notice that arrived during the shutdown started a cycle that fetched a page');

    const out = await finish(c);
    assert.equal(factRequests(), fetchedBefore, 'a refused trigger fetched a page');
    assert.equal(out.shutdownSettled, true, 'the shutdown did not finish');
    // The database is closed: a refusal needs none.
    assert.equal(dbOpen(), false, 'the database is still open: this is not the whole sequence');
    for (const [label, call] of doors) assertRefusedForShutdown(`${label} (after the database closed)`, await answerOf(label, call));
    assert.equal(factRequests(), fetchedBefore, 'a trigger after the database closed fetched a page');
  });

  it('a cycle held in a fetch BEFORE any page (the governance gossip, which the peer never answers) is cut by the shutdown, not by its own 10 s timeout: answered interrupted / 503 shutting_down, the member not failed', async () => {
    need();
    let asked = 0;
    // The peer takes the connection and says nothing: the first governance fetch of the cycle (our self-record to it) is held for as long as the fetch lives.
    door.state.network = () => { asked++; return new Promise(() => {}); };
    const res = fakeRes();
    const answered = trigger.triggerNetworkSync(res, door.NET, { wait: true, timeoutMs: trigger.syncTimeoutMs(120_000) }).then(() => res);
    await waitFor(() => asked > 0, 15_000, 20, undefined, { what: 'the cycle to be held in its first governance fetch' });
    const { down, seen } = beginTheShutdown();
    await waitFor(() => lifecycle.isShuttingDown(), 5_000, 10, undefined, { what: 'the shutdown to begin' });
    // The pre-sync fetches carry no page, so only the shutdown signal can end them early: well inside the cycle wait (5 s) and the fetch's own timeout (10 s).
    const r = await settleWithin(answered, 2_500);
    const dbOpenAtAnswer = r.settled ? dbOpen() : null;
    const end = await settleWithin(down, 8_000);
    await reopen();
    assert.equal(r.settled, true, 'the waiting caller was not answered within 2.5 s of the shutdown beginning: the cycle held in a pre-sync fetch outlives the shutdown (that fetch does not carry the shutdown signal)');
    assert.equal(dbOpenAtAnswer, true, 'the database was closed before the held cycle was answered');
    assert.equal(end.settled, true, 'the shutdown did not finish');
    assert.deepEqual(seen.exits, [0]);
    assert.equal(r.value.code, 503, `the waiting caller was answered ${r.value.code} ${JSON.stringify(r.value.body)}`);
    assert.equal(r.value.body.code, 'shutting_down');
    assert.equal(r.value.body.outcome, 'interrupted');
    assert.equal(r.value.body.members?.[0]?.outcome, 'interrupted', `the member says ${JSON.stringify(r.value.body.members?.[0])}: a fetch the shutdown aborted is nobody's failure`);
    assert.equal(door.member().consecutiveFailures, 4, `the member's failure count moved to ${door.member().consecutiveFailures}`);
    assert.equal(factRequests(), 0, 'the cycle fetched a page after the shutdown began');
  });
});
