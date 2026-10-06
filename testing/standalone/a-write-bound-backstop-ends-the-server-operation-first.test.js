/**
 * When the write bound's CLIENT BACKSTOP fires, the server operation is KILLED and confirmed gone before the caller is
 * answered — and, when it cannot be, the answer is given anyway and the log says so (`Q-380`).
 *
 * ## Why
 *
 * The backstop used to reject `StoreTimeout` and let the hold go on the claim "by now the server's deadline has passed, so the
 * write cannot land". That is true only when the command reached the server less than `SERVER_FIRST_MARGIN_MS` after the call:
 * the server's `maxTimeMS` starts on ARRIVAL, the backstop's on the call. A command that arrived later left the operation
 * alive, and the answer and the hold's release came while it could still land (`a-write-the-bound-ended-never-lands-when-the-
 * command-is-late-db.test.js` holds that against a real server). The rule is now the order the answer is given in: the
 * driver call is aborted, the operation is found by the `comment` the write carried, killed, and `$currentOp` is asked until
 * it is no longer there; only then is the caller answered.
 *
 * ## What is held here, with no database
 *
 * The driver call is a fake that never settles, and the server's operations are a fake `serverOperations` that answers
 * `$currentOp` and `killOp` the way a server does, so the ORDER and the guard rails are the subject: that the operation is
 * found by what the write carried, that the answer follows the kill, that an operation that cannot be confirmed gone still
 * gets the caller answered within the bound and is logged ONCE at error level naming the method, collection and space, that
 * the server answering first needs none of this, and that the one production door (`observeRecordWrites`) hands the
 * bound the means to do it.
 *
 * Run: node --test testing/standalone/a-write-bound-backstop-ends-the-server-operation-first.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { logLinesDuring } from './_log-lines.mjs';
import * as writeBound from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';
import { observeRecordWrites } from '../../server/dist/db/record-write-observer.js';

// A namespace import, so a build without `KILL_WAIT_MS` fails the cases that assert on behaviour and not the whole file at link time.
const { callBounded, withinWriteBound, setWriteBoundForTest, SERVER_FIRST_MARGIN_MS, KILL_WAIT_MS, PLAIN_WRITE_METHODS } = writeBound;
const BOUND_MS = 40;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BACKSTOP_MS = BOUND_MS + SERVER_FIRST_MARGIN_MS;

/**
 * A fake of the server's operation list. `alive` is the set of operations the "server" holds; `arrivesAfterLooks` makes the
 * operation appear only on the Nth look at `$currentOp` (a command still in flight when the first look was made).
 * `killable: false` is an operation `killOp` does not end (the measured upsert behind another session's insert).
 */
function fakeServer({ killable = true, arrivesAfterLooks = 0, commandLatencyMs = 0 } = {}) {
  const s = { calls: [], looks: 0, killed: [], comment: undefined, alive: false, ended: false };
  s.attach = (comment) => { s.comment = comment; s.alive = arrivesAfterLooks === 0; };
  s.command = async (command) => {
    s.calls.push(command);
    if (commandLatencyMs) await sleep(commandLatencyMs);
    if (command.aggregate === 1) {
      const stages = command.pipeline;
      assert.ok(stages[0].$currentOp, 'the first stage of a $currentOp pipeline must be $currentOp');
      assert.ok(stages[0].$currentOp.allUsers !== true, '$currentOp must ask for the connection\'s own operations only');
      const match = stages.find(st => st.$match)?.$match;
      assert.equal(typeof match?.['command.comment'], 'string', 'the operation must be found by the comment the write carried');
      s.looks += 1;
      if (!s.alive && !s.ended && arrivesAfterLooks > 0 && s.looks > arrivesAfterLooks) s.alive = true;
      const found = s.alive && match['command.comment'] === s.comment;
      return { cursor: { firstBatch: found ? [{ opid: 4242 }] : [] }, ok: 1 };
    }
    if (command.killOp === 1) {
      assert.equal(command.op, 4242);
      s.killed.push(command.op);
      if (killable) { s.alive = false; s.ended = true; }
      return { ok: 1 };
    }
    throw new Error(`unexpected command ${JSON.stringify(command)}`);
  };
  return s;
}

/** The options object the bound put on a driver call: the one carrying the server's deadline, wherever the method takes it. */
const optionsOf = (args) => args.find(a => a && typeof a === 'object' && typeof a.maxTimeMS === 'number');

/** The driver call: never answers; records the comment it was sent with and hands it to the fake server. */
function hangingDriver(server) {
  const sent = [];
  const driver = (args) => { sent.push(args); server?.attach(optionsOf(args)?.comment); return new Promise(() => {}); };
  driver.sent = sent;
  return driver;
}

const TARGET = (serverOperations) => ({ collection: 'sp1_facts', inheritedTimeoutMs: undefined, serverOperations });

async function bounded(method, driver, target) {
  return withinWriteBound(async () => {
    const started = Date.now();
    try { return { ok: true, value: await callBounded(method, [{ _id: 'x' }, {}], driver, target), ms: Date.now() - started }; }
    catch (error) { return { ok: false, error, ms: Date.now() - started }; }
  });
}

describe('the write bound\'s backstop ends the server operation before it answers', () => {
  let holdTheLoop;
  before(() => { setWriteBoundForTest({ writeTimeoutMs: BOUND_MS, holdDeadlineMs: 5000 }); holdTheLoop = setInterval(() => {}, 60_000); });
  after(() => { setWriteBoundForTest(null); clearInterval(holdTheLoop); });

  it('KILL_WAIT_MS is a figure, and a figure that leaves the margin room under what the hold deadline\'s ceiling allows', () => {
    assert.ok(Number.isInteger(KILL_WAIT_MS) && KILL_WAIT_MS > 0, `KILL_WAIT_MS is ${KILL_WAIT_MS}`);
  });

  it('a plain write carries a comment of its own, a different one per call', async () => {
    const seen = [];
    for (const method of PLAIN_WRITE_METHODS) {
      const server = fakeServer();
      const driver = hangingDriver(server);
      await bounded(method, driver, TARGET(server));
      const options = optionsOf(driver.sent[0]);
      assert.equal(typeof options.comment, 'string', `${method}: the write carries no comment, so the backstop cannot find its operation`);
      seen.push(options.comment);
    }
    assert.ok(seen.length >= 5, `only ${seen.length} plain write method(s) walked`);
    assert.equal(new Set(seen).size, seen.length, 'two calls carried the same comment: one kill would end the other\'s write');
  });

  it('the backstop finds the operation by its comment, kills it, looks again, and only THEN answers', async () => {
    const server = fakeServer();
    const driver = hangingDriver(server);
    const r = await bounded('updateOne', driver, TARGET(server));
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof StoreTimeout, `answered ${r.error}`);
    assert.deepEqual(server.killed, [4242], 'the operation was not killed');
    const kinds = server.calls.map(c => (c.killOp === 1 ? 'kill' : 'look'));
    assert.deepEqual(kinds.slice(0, 2), ['look', 'kill'], `the order of the server's operations calls was ${kinds}`);
    assert.equal(kinds.at(-1), 'look', 'the last thing done was not a look that found nothing: the operation was not confirmed gone');
    assert.equal(server.alive, false);
    assert.ok(r.ms >= BACKSTOP_MS, `answered at ${r.ms} ms, before the backstop's ${BACKSTOP_MS} ms`);
  });

  it('the caller is not answered while the operation is still being ended (the answer waits for the server)', async () => {
    const server = fakeServer({ commandLatencyMs: 60 });
    const r = await bounded('updateOne', hangingDriver(server), TARGET(server));
    assert.ok(r.error instanceof StoreTimeout);
    assert.ok(r.ms >= BACKSTOP_MS + 3 * 60, `answered at ${r.ms} ms: ahead of the server's operations calls (3 or more at 60 ms each after ${BACKSTOP_MS} ms)`);
  });

  it('a command still in flight at the first look is caught by the second', async () => {
    const server = fakeServer({ arrivesAfterLooks: 1 });
    const r = await bounded('updateOne', hangingDriver(server), TARGET(server));
    assert.ok(r.error instanceof StoreTimeout);
    assert.deepEqual(server.killed, [4242], 'an operation that appeared after the first look was not killed');
    assert.equal(server.alive, false);
  });

  it('the server\'s deadline already past: nothing to kill, no kill issued, still ONE warn line', async () => {
    const server = fakeServer();
    server.attach = () => { server.alive = false; };
    const { lines, result } = await logLinesDuring(() => bounded('insertOne', hangingDriver(server), TARGET(server)));
    assert.ok(result.error instanceof StoreTimeout);
    assert.deepEqual(server.killed, []);
    const said = lines.filter(l => /backstop/i.test(l));
    assert.equal(said.length, 1, JSON.stringify(lines));
    assert.match(said[0], /WARN/);
  });

  it('an operation that cannot be confirmed gone: answered within KILL_WAIT_MS anyway, and logged ONCE at error level naming method, collection and space', async () => {
    const server = fakeServer({ killable: false });
    const { lines, result } = await logLinesDuring(async () => {
      const r = await bounded('updateOne', hangingDriver(server), TARGET(server));
      await sleep(KILL_WAIT_MS + 200); // a second line from a late settle or a repeat would arrive in this window
      return r;
    });
    assert.ok(result.error instanceof StoreTimeout, 'the caller must be answered');
    assert.ok(result.ms < BACKSTOP_MS + KILL_WAIT_MS + 300, `answered at ${result.ms} ms, past the backstop plus KILL_WAIT_MS`);
    assert.ok(result.ms >= BACKSTOP_MS + KILL_WAIT_MS - 50, `answered at ${result.ms} ms: gave up before KILL_WAIT_MS`);
    const said = lines.filter(l => /backstop/i.test(l));
    assert.equal(said.length, 1, `expected one line, got ${JSON.stringify(lines)}`);
    assert.match(said[0], /ERROR/, 'an operation left alive is not a warning');
    assert.match(said[0], /updateOne/);
    assert.match(said[0], /sp1_facts/);
    assert.match(said[0], /\bsp1\b/);
    assert.match(said[0], /not (been )?confirm|could not be confirmed|unconfirmed/i, said[0]);
  });

  it('the server answering first (code 50) needs none of it: no look, no kill', async () => {
    const server = fakeServer();
    const driver = (args) => { server.attach(optionsOf(args)?.comment); return sleep(BOUND_MS).then(() => { throw Object.assign(new Error('operation exceeded time limit'), { code: 50, name: 'MongoServerError' }); }); };
    const r = await bounded('updateOne', driver, TARGET(server));
    assert.ok(r.error instanceof StoreTimeout);
    await sleep(SERVER_FIRST_MARGIN_MS + 100);
    assert.deepEqual(server.calls, []);
  });

  it('a write that succeeds needs none of it either', async () => {
    const server = fakeServer();
    const r = await bounded('insertOne', () => sleep(5).then(() => ({ acknowledged: true })), TARGET(server));
    assert.equal(r.ok, true);
    await sleep(SERVER_FIRST_MARGIN_MS + 100);
    assert.deepEqual(server.calls, []);
  });

  it('a call that states no means to kill with is still answered, and the line says nothing could be killed', async () => {
    const { lines, result } = await logLinesDuring(() => bounded('insertOne', hangingDriver(null), TARGET(undefined)));
    assert.ok(result.error instanceof StoreTimeout);
    const said = lines.filter(l => /backstop/i.test(l));
    assert.equal(said.length, 1);
    assert.match(said[0], /could not be killed|no means|cannot be killed|nothing to kill with/i, said[0]);
  });

  it('an error from the server\'s operations calls is an unconfirmed operation, answered and logged, not a throw', async () => {
    const broken = { command: async () => { throw new Error('not authorized on admin to execute command'); } };
    const { lines, result } = await logLinesDuring(() => bounded('deleteMany', hangingDriver(null), TARGET(broken)));
    assert.ok(result.error instanceof StoreTimeout, `answered ${result.error}`);
    assert.equal(lines.filter(l => /backstop/i.test(l)).length, 1);
  });

  it('through the one door every collection is reached by, the bound is handed the database\'s admin to kill with', async () => {
    const server = fakeServer();
    let driverOptions;
    const stalled = { updateOne: (...a) => { driverOptions = optionsOf(a); server.attach(driverOptions?.comment); return new Promise(() => {}); }, timeoutMS: undefined };
    const db = observeRecordWrites({ collection: () => stalled, timeoutMS: undefined, admin: () => ({ command: server.command }) }, () => false, () => {});
    let error;
    await withinWriteBound(async () => { try { await db.collection('spaceq_facts').updateOne({ _id: 'x' }, {}); } catch (e) { error = e; } });
    assert.ok(error instanceof StoreTimeout);
    assert.equal(typeof driverOptions.comment, 'string');
    assert.deepEqual(server.killed, [4242], 'observeRecordWrites did not hand the bound a way to kill the operation');
  });
});
