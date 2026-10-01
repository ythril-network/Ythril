/**
 * The supervised worker host: "run a request/response child that may die", on a clock the test drives.
 *
 * ## What this pins (Q-99 part 1)
 *
 * Local embedding used to run inside the server process, so an inference blocked every other request and a native
 * fault in onnxruntime took the server down with it. It now runs in a child process, and everything that can go
 * wrong with a child lives in ONE generic module, `util/supervised-worker.ts`, whose only question is *what does a
 * parent do about a child that dies, hangs, lies or idles*. These tests are that module's rules, on virtual time
 * (`_virtual-time.mjs`) and a scripted child (`_fake-child.mjs`), so a ten-minute idle exit and a day of crash
 * loops cost milliseconds and never depend on a timer's jitter.
 *
 * What a fake cannot tell you is whether the rules hold against `fork()`: that is the job of
 * `local-inference-runs-off-the-main-thread.test.js` and `local-inference-child-lifecycle.test.js`, which run the
 * real thing. Both halves are needed and neither replaces the other.
 *
 * ## The contract the tests hold the implementation to
 *
 *   createSupervisedWorker({ entry, spawn, now, scheduler, log, onEvent, lostError, loadError, backoffMs,
 *     idleMs, requestDeadlineMs, loadDeadlineMs, killGraceMs, maxVectorLength, maxErrorChars, envNames, env })
 *   worker.request({ input, lane: 'query' | 'document', modelId }) -> Promise<{ vector, modelId, inferenceMs }>
 *   worker.warm({ modelId })        -> Promise<void>   (spawn, handshake, load; no inference)
 *   worker.recycle()                -> Promise<void>   (a configuration change: drop the child, forget load failures)
 *   worker.forgetLoadFailures()
 *   worker.waitOutBackoff()         -> Promise<void>   (resolves now when not backing off)
 *   worker.stop({ budgetMs })       -> Promise<void>
 *   worker.state() -> { phase: 'none'|'starting'|'ready'|'backoff', modelId, pid, inFlight, queued, spawns,
 *     consecutiveLosses, backoffRemainingMs, loadFailure }
 *
 * `spawn({ entry, env, execArgv, generation })` returns a `fork()`-shaped child; the wire protocol is written out
 * in `_fake-child.mjs`. Events passed to `onEvent`: `{ type: 'spawn', modelId }`, `{ type: 'restart', reason }`
 * with `reason` one of `exit | killed | deadline | idle | model-change`, and `{ type: 'state', phase }`.
 *
 * Run: node --test testing/standalone/supervised-worker-host.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualTime, flush } from './_virtual-time.mjs';
import { createFakeSpawn, autopilot } from './_fake-child.mjs';

let createSupervisedWorker, PLATFORM_ENV;

before(async () => {
  ({ createSupervisedWorker, PLATFORM_ENV } = await import('../../server/dist/util/supervised-worker.js'));
});

const MIN = 60_000;

/** A host on virtual time with a scripted child; every knob a test may want is an override. */
function setup({ fake = { auto: true }, host: hostOpts = {}, noConstants = false } = {}) {
  const vt = createVirtualTime();
  const spawns = createFakeSpawn(fake);
  const logs = [];
  const events = [];
  const lostDetails = [];
  const constants = noConstants ? {} : {
    idleMs: 10 * MIN, requestDeadlineMs: 60_000, loadDeadlineMs: 15 * MIN, killGraceMs: 2_000,
  };
  const worker = createSupervisedWorker({
    entry: { cmd: process.execPath, args: ['/does/not/exist/child.js'] },
    spawn: spawns.spawn,
    now: vt.now,
    scheduler: vt.scheduler,
    log: (level, message) => logs.push({ level, message }),
    onEvent: e => events.push(e),
    lostError: (detail, info) => {
      lostDetails.push(detail);
      return Object.assign(new Error(`LOST(${detail})`), { lost: true, inFlight: info?.inFlight });
    },
    ...constants,
    ...hostOpts,
  });
  return { vt, worker, fake: spawns, logs, events, lostDetails };
}

/** Bring a manually scripted child to "model loaded". */
async function bringUp(child, modelId = 'm') {
  child.ready();
  await flush();
  child.loaded(modelId);
  await flush();
}

/** Answer the child's most recent request. */
async function answer(child, opts) {
  child.reply(child.lastRequestId(), opts);
  await flush();
}

/** Observe a promise's outcome without letting a rejection escape unhandled. */
function watch(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(v => { box.settled = true; box.value = v; }, e => { box.settled = true; box.error = e; });
  return box;
}

const req = (input, extra = {}) => ({ input, lane: 'document', modelId: 'm', ...extra });
const restartReasons = events => events.filter(e => e.type === 'restart').map(e => e.reason);

describe('spawning and the handshake', () => {
  it('spawns nothing until the first request, and then exactly one child', async () => {
    const { worker, vt, fake } = setup({ fake: {} });
    await vt.advance(60 * MIN);
    assert.equal(fake.children.length, 0, 'a host that has been asked for nothing has started nothing');
    assert.equal(worker.state().phase, 'none');

    const r = watch(worker.request(req('a')));
    await flush();
    assert.equal(fake.children.length, 1);
    assert.equal(worker.state().phase, 'starting');
    await bringUp(fake.last());
    await answer(fake.last());
    assert.equal(r.settled, true);
    assert.equal(fake.children.length, 1, 'one request, one child');
  });

  it('sends the model to load only after the child says it is ready, and the request only after it says loaded', async () => {
    const { worker, fake } = setup({ fake: {} });
    const r = watch(worker.request(req('a', { modelId: 'nomic/x' })));
    await flush();
    const child = fake.last();
    assert.deepEqual(child.sent, [], 'nothing is sent down a channel the child has not announced');

    child.ready();
    await flush();
    assert.deepEqual(child.sent.map(m => m.type), ['load']);
    assert.equal(child.sent[0].modelId, 'nomic/x');

    child.loaded('nomic/x');
    await flush();
    assert.deepEqual(child.sent.map(m => m.type), ['load', 'request'], 'the request follows the loaded acknowledgement');
    assert.equal(child.requests()[0].input, 'a');
    assert.equal(child.requests()[0].modelId, 'nomic/x');

    await answer(child, { vector: [0.25, 0.5], modelId: 'nomic/x', inferenceMs: 12 });
    assert.equal(r.settled, true);
    assert.deepEqual(r.value, { vector: [0.25, 0.5], modelId: 'nomic/x', inferenceMs: 12 },
      'the caller gets the vector, the model the child ECHOED, and the child\'s own measure of the inference');
  });

  it('warm() loads the model without running an inference, and a load failure rejects it', async () => {
    const { worker, fake } = setup({ fake: { auto: { failLoad: m => (m === 'bad' ? 'cannot load bad' : false) } } });
    await worker.warm({ modelId: 'good' });
    assert.equal(fake.last().requests().length, 0, 'warming is a load, not an embed');
    assert.equal(worker.state().phase, 'ready');
    await assert.rejects(worker.warm({ modelId: 'bad' }), /cannot load bad/);
  });

  it('passes the child a fork-shaped spec: the entry, no inherited execArgv, a generation', async () => {
    const { worker, fake } = setup({ fake: { auto: true } });
    await worker.request(req('a'));
    const spec = fake.last().spec;
    assert.deepEqual(spec.entry, { cmd: process.execPath, args: ['/does/not/exist/child.js'] });
    assert.deepEqual(spec.execArgv, [], 'an inspector or heap flag on the server must not reach the child');
    assert.equal(typeof spec.generation, 'number');
  });
});

describe('single flight, ids and lanes', () => {
  it('runs one inference at a time, each with its own id, each answer to its own caller', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    const c = watch(worker.request(req('c')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    assert.equal(child.requests().length, 1, 'the model is single-flight: a second request waits for the first');
    assert.deepEqual(worker.state().queued, 2);
    assert.equal(worker.state().inFlight, 1);

    await answer(child, { vector: [1] });
    assert.equal(child.requests().length, 2);
    await answer(child, { vector: [2] });
    await answer(child, { vector: [3] });

    const ids = child.requests().map(m => m.id);
    assert.equal(new Set(ids).size, 3, 'ids are unique, or a late reply could settle the wrong caller');
    assert.deepEqual([a.value.vector, b.value.vector, c.value.vector], [[1], [2], [3]]);
    assert.deepEqual(child.requests().map(m => m.input), ['a', 'b', 'c'], 'FIFO within a lane');
  });

  it('lets a query overtake queued documents and never pre-empts the inference already running', async () => {
    const { worker, fake } = setup({ fake: {} });
    worker.request(req('d1')).catch(() => {});
    await flush();
    const child = fake.last();
    await bringUp(child);
    // d1 is running. Everything else queues behind it.
    worker.request(req('d2')).catch(() => {});
    worker.request(req('d3')).catch(() => {});
    worker.request(req('q1', { lane: 'query' })).catch(() => {});
    worker.request(req('q2', { lane: 'query' })).catch(() => {});
    await flush();
    assert.deepEqual(child.requests().map(m => m.input), ['d1'], 'the running inference is never pre-empted');

    for (let i = 0; i < 4; i++) await answer(child);
    assert.deepEqual(child.requests().map(m => m.input), ['d1', 'q1', 'q2', 'd2', 'd3'],
      'a recall query waits for at most the one inference in flight, then goes ahead of every queued document');
  });

  it('reports, for each request it served, the time it queued and the child\'s own time for the inference', async () => {
    const { worker, fake, vt, events } = setup({ fake: {} });
    const a = worker.request(req('a'));
    const b = worker.request(req('b'));
    await flush();
    const child = fake.last();
    await bringUp(child);
    await vt.advance(3_000);
    await answer(child, { inferenceMs: 40 });
    await answer(child, { inferenceMs: 7 });
    await Promise.all([a, b]);

    const served = events.filter(e => e.type === 'served');
    assert.equal(served.length, 2);
    assert.equal(served[0].waitMs, 0, 'the first request went straight out once the child was up');
    assert.equal(served[1].waitMs, 3_000, 'the second waited while the first ran');
    assert.deepEqual(served.map(e => e.inferenceMs), [40, 7], 'the histogram is fed the child\'s figure, not the round trip');
    assert.deepEqual(served.map(e => e.lane), ['document', 'document']);
  });

  it('rejects a request naming no lane the host knows', async () => {
    const { worker } = setup({ fake: { auto: true } });
    await assert.rejects(worker.request({ input: 'a', lane: 'bogus', modelId: 'm' }));
  });

  it('one failed inference fails only its own request; the next runs on the same child', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    child.failInference(child.lastRequestId(), 'tokenizer exploded');
    await flush();
    assert.match(a.error?.message ?? '', /tokenizer exploded/);
    assert.equal(b.settled, false, 'the queued request was not touched');
    await answer(child);
    assert.equal(b.settled, true);
    assert.equal(b.error, undefined);
    assert.equal(fake.children.length, 1, 'a failed inference is the record\'s problem, not the process\'s: no respawn');
    assert.notEqual(a.error?.lost, true, 'and it is not reported as a lost process');
    assert.equal(worker.state().consecutiveLosses, 0);
  });

  it('bounds the text a child can put in an error', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    await flush();
    await bringUp(fake.last());
    fake.last().failInference(fake.last().lastRequestId(), 'x'.repeat(20_000));
    await flush();
    assert.ok(a.error, 'rejected');
    assert.ok(a.error.message.length <= 1_000, `the error text was ${a.error.message.length} characters`);
  });
});

describe('a child that dies', () => {
  it('rejects the request it was holding with a lost error that names the exit, and everything queued behind it', async () => {
    const { worker, fake, lostDetails } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    child.exit(3, null);
    await flush();
    assert.equal(a.error?.lost, true);
    assert.equal(b.error?.lost, true, 'nothing the lost child had not answered may hang');
    assert.match(lostDetails[0], /code=3\b/);
    // Only the request the child was HOLDING can have killed it. The one behind it was never sent, and a caller that
    // charges a loss to a record must be able to tell the two apart, or a bystander of a poison record ends failed.
    assert.equal(a.error.inFlight, true, 'the request that was in flight is told so');
    assert.equal(b.error.inFlight, false, 'a request that was never sent is told so');

    const c = fake.children.length;
    assert.equal(c, 1);
  });

  it('charges nobody for a child lost while it was still loading: no request had been sent', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    fake.last().ready();
    await flush();
    fake.last().exit(139, null);
    await flush();
    assert.equal(a.error?.lost, true);
    assert.equal(b.error?.lost, true);
    assert.equal(a.error.inFlight, false, 'the model load died, not a request');
    assert.equal(b.error.inFlight, false);
  });

  it('names a signal when that is how the child ended', async () => {
    const { worker, fake, lostDetails } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    await flush();
    await bringUp(fake.last());
    fake.last().exit(null, 'SIGKILL');
    await flush();
    assert.equal(a.error?.lost, true);
    assert.match(lostDetails[0], /signal=SIGKILL\b/);
  });

  it('logs the loss once, with the exit, what the child wrote to stderr and how big the last input was', async () => {
    const { worker, fake, logs } = setup({ fake: {} });
    const a = watch(worker.request(req('twelve chars')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    child.stderr.write('onnxruntime: out of memory in arena\n');
    await flush();
    child.exit(134, null);
    await flush();
    assert.equal(a.error?.lost, true);
    const lines = logs.filter(l => l.level === 'warn' && /code=134/.test(l.message));
    assert.equal(lines.length, 1, `one warning per loss, got ${lines.length}: ${JSON.stringify(logs)}`);
    assert.match(lines[0].message, /out of memory in arena/, 'the last words of the child are the diagnosis');
    assert.match(lines[0].message, /lastInputChars=12\b/);
  });

  it('keeps only the tail of what the child wrote, so a chatty child cannot grow the parent', async () => {
    const { worker, fake, logs } = setup({ fake: {} });
    worker.request(req('a')).catch(() => {});
    await flush();
    await bringUp(fake.last());
    fake.last().stderr.write(`FIRST-LINE${'.'.repeat(200_000)}LAST-LINE`);
    await flush();
    fake.last().exit(1, null);
    await flush();
    const line = logs.find(l => l.level === 'warn' && /code=1\b/.test(l.message));
    assert.ok(line, 'the loss was logged');
    assert.match(line.message, /LAST-LINE/);
    assert.doesNotMatch(line.message, /FIRST-LINE/);
    assert.ok(line.message.length < 16_384, `the log line was ${line.message.length} characters`);
  });

  it('answers a request made during the backoff at once with a lost error, never a hang, and respawns after it', async () => {
    const { worker, fake, vt } = setup({ fake: {}, host: { backoffMs: n => 1_000 * 2 ** (n - 1) } });
    worker.request(req('a')).catch(() => {});
    await flush();
    await bringUp(fake.last());
    fake.last().exit(1, null);
    await flush();

    assert.equal(worker.state().phase, 'backoff');
    assert.equal(worker.state().backoffRemainingMs, 1_000);
    await assert.rejects(worker.request(req('b')), e => e.lost === true && e.inFlight === false,
      'a caller arriving while the host is not allowed to spawn is told so, not queued behind a timer');
    assert.equal(fake.children.length, 1, 'still backing off, so still one child');

    await vt.advance(1_000);
    assert.notEqual(worker.state().phase, 'backoff');
    const c = watch(worker.request(req('c')));
    await flush();
    assert.equal(fake.children.length, 2, 'the backoff elapsed, so the next request spawns a fresh child');
    await bringUp(fake.last());
    await answer(fake.last());
    assert.equal(c.settled, true);
    assert.equal(c.error, undefined);
  });

  it('waitOutBackoff resolves at once when there is no backoff, and at its end when there is', async () => {
    const { worker, fake, vt } = setup({ fake: {}, host: { backoffMs: () => 5_000 } });
    await worker.waitOutBackoff();

    worker.request(req('a')).catch(() => {});
    await flush();
    await bringUp(fake.last());
    fake.last().exit(1, null);
    await flush();

    const w = watch(worker.waitOutBackoff());
    await vt.advance(4_999);
    assert.equal(w.settled, false, 'the brain worker must not claim a job while the host is refusing work');
    await vt.advance(1);
    assert.equal(w.settled, true);
  });

  it('spawns a bounded number of times over a day of a child that dies on arrival', async () => {
    const vt = createVirtualTime();
    const times = [];
    const fake = createFakeSpawn({ onSpawn: (c) => { times.push(vt.now()); queueMicrotask(() => c.exit(1, null)); } });
    const worker = createSupervisedWorker({
      entry: { cmd: process.execPath, args: ['x'] }, spawn: fake.spawn, now: vt.now, scheduler: vt.scheduler,
      log: () => {}, lostError: d => Object.assign(new Error(`LOST(${d})`), { lost: true }),
    });
    for (let t = 0; t < 24 * 60 * MIN; t += 5_000) {
      await worker.request(req('a')).catch(() => {});
      await vt.advance(5_000);
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(times.length >= 10, `only ${times.length} attempts in a day: the host gave up for good`);
    assert.ok(times.length < 5_000, `${times.length} spawns in a day: that is a tight loop with extra steps`);
    assert.ok(gaps.at(-1) >= 4 * gaps[0], `the gaps did not grow: first ${gaps[0]} ms, last ${gaps.at(-1)} ms`);
    assert.ok(Math.max(...gaps) <= 15 * MIN, 'the backoff has a cap, or a transient fault would silence the embedder for a day');
    assert.equal(worker.state().spawns, times.length);
  });

  it('resets the backoff only after a successful inference, not after a child merely starting', async () => {
    const { worker, fake, vt } = setup({ fake: {}, host: { backoffMs: n => 1_000 * 2 ** (n - 1) } });
    const crash = async () => {
      worker.request(req('x')).catch(() => {});
      await flush();
      await bringUp(fake.last());
      fake.last().exit(1, null);
      await flush();
    };

    await crash();
    assert.equal(worker.state().backoffRemainingMs, 1_000);
    await vt.advance(1_000);
    await crash();
    assert.equal(worker.state().backoffRemainingMs, 2_000, 'a child that loaded and died without answering is not a success');
    await vt.advance(2_000);
    await crash();
    assert.equal(worker.state().backoffRemainingMs, 4_000);
    await vt.advance(4_000);

    // Now one that works.
    const ok = watch(worker.request(req('y')));
    await flush();
    await bringUp(fake.last());
    await answer(fake.last());
    assert.equal(ok.settled, true);
    assert.equal(worker.state().consecutiveLosses, 0);

    fake.last().exit(1, null);
    await flush();
    assert.equal(worker.state().backoffRemainingMs, 1_000, 'after a success the schedule starts again from its first step');
  });

  it('reports why each child ended: exit, killed', async () => {
    const { worker, fake, events, vt } = setup({ fake: {}, host: { backoffMs: () => 100 } });
    worker.request(req('a')).catch(() => {});
    await flush();
    await bringUp(fake.last());
    fake.last().exit(2, null);
    await flush();
    await vt.advance(100);
    worker.request(req('b')).catch(() => {});
    await flush();
    await bringUp(fake.last());
    fake.last().exit(null, 'SIGKILL');
    await flush();
    assert.deepEqual(restartReasons(events), ['exit', 'killed']);
  });
});

describe('a child that stops answering', () => {
  it('kills it after the request deadline, counted from when the request was SENT, and rejects what it held', async () => {
    const { worker, fake, vt, events } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    const child = fake.last();
    await bringUp(child);

    await vt.advance(59_999);
    assert.equal(a.settled, false);
    assert.deepEqual(child.kills, []);
    await vt.advance(1);
    assert.ok(child.kills.includes('SIGKILL'), 'a wedged inference is killed, not waited for');
    assert.equal(a.error?.lost, true);
    assert.equal(b.error?.lost, true);
    assert.deepEqual(restartReasons(events), ['deadline']);
  });

  it('does not charge a request for the time it spent waiting in the queue', async () => {
    const { worker, fake, vt } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    await vt.advance(50_000);
    await answer(child);
    assert.equal(a.settled, true);
    await vt.advance(50_000);   // b has now existed for 100 s, but has been running for 50
    assert.deepEqual(child.kills, [], 'the deadline bounds an inference, not a queue');
    await answer(child);
    assert.equal(b.error, undefined);
  });

  it('allows a model load much longer than an inference, and still bounds it', async () => {
    const { worker, fake, vt } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    child.ready();
    await flush();
    assert.equal(child.loads().length, 1);

    await vt.advance(10 * MIN);
    assert.deepEqual(child.kills, [], 'a first-time download of a model legitimately takes minutes');
    await vt.advance(5 * MIN - 1);
    assert.deepEqual(child.kills, []);
    await vt.advance(1);
    assert.ok(child.kills.includes('SIGKILL'));
    assert.equal(a.error?.lost, true);
  });

  it('uses the documented limits when none are given: 60 s per inference, 15 min per load, 10 min idle', async () => {
    const { worker, fake, vt } = setup({ fake: {}, noConstants: true });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    child.ready();
    await flush();
    await vt.advance(15 * MIN - 1);
    assert.deepEqual(child.kills, []);
    await vt.advance(1);
    assert.ok(child.kills.includes('SIGKILL'), 'default load deadline is 15 minutes');
    assert.equal(a.error?.lost, true);

    // Backoff elapses, a new child serves one request, then idles.
    await vt.advance(2 * MIN);
    const b = watch(worker.request(req('b')));
    await flush();
    const c2 = fake.last();
    await bringUp(c2);
    await vt.advance(60_000 - 1);
    assert.deepEqual(c2.kills, [], 'default inference deadline is 60 seconds');
    await vt.advance(1);
    assert.ok(c2.kills.includes('SIGKILL'));
    assert.equal(b.error?.lost, true);
  });
});

describe('an idle child', () => {
  it('is stopped after the idle period so its memory returns to the OS, and the next request respawns it', async () => {
    const { worker, fake, vt, events } = setup({ fake: { auto: true } });
    await worker.request(req('a'));
    assert.equal(worker.state().phase, 'ready');

    await vt.advance(10 * MIN - 1);
    assert.equal(worker.state().phase, 'ready');
    await vt.advance(1);
    assert.equal(worker.state().phase, 'none', 'ten idle minutes and the model is out of memory');
    assert.ok(fake.children[0].exited, 'the child really ended');
    assert.deepEqual(restartReasons(events), ['idle']);
    assert.equal(worker.state().consecutiveLosses, 0, 'an idle exit is not a fault and does not start a backoff');

    await worker.request(req('b'));
    assert.equal(fake.children.length, 2);
    assert.equal(fake.children[1].loads().length, 1, 'the new child loads the model again');
  });

  it('counts idleness from the last activity, not from the first', async () => {
    const { worker, vt } = setup({ fake: { auto: true } });
    await worker.request(req('a'));
    await vt.advance(9 * MIN);
    await worker.request(req('b'));
    await vt.advance(9 * MIN);
    assert.equal(worker.state().phase, 'ready', 'eighteen minutes since the start, nine since the last request');
    await vt.advance(1 * MIN);
    assert.equal(worker.state().phase, 'none');
  });

  it('never runs the idle timer while a request is pending', async () => {
    const { worker, fake, vt } = setup({ fake: {}, host: { requestDeadlineMs: 24 * 60 * MIN } });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    await vt.advance(35 * MIN);
    assert.deepEqual(child.kills, [], 'a long inference is not an idle child');
    assert.equal(child.sent.filter(m => m.type === 'shutdown').length, 0);
    await answer(child);
    assert.equal(a.error, undefined);
    assert.equal(worker.state().phase, 'ready');
  });

  it('leaves no timer behind once it has gone idle', async () => {
    const { worker, vt } = setup({ fake: { auto: true } });
    await worker.request(req('a'));
    await vt.advance(11 * MIN);
    assert.equal(worker.state().phase, 'none');
    assert.equal(vt.pendingTimers(), 0, 'an idle host must not keep the process alive with a pending timer');
  });
});

describe('a change of model', () => {
  it('runs a request only on a child that loaded ITS model, switching first when needed', async () => {
    const { worker, fake } = setup({ fake: { auto: true } });
    const order = ['A', 'B', 'A', 'B', 'B', 'A'];
    const results = [];
    for (const m of order) results.push(await worker.request(req(`t-${m}`, { modelId: m })));

    assert.deepEqual(results.map(r => r.modelId), order, 'every vector carries the model its child computed it with');
    for (const child of fake.children) {
      const loaded = child.loads().map(m => m.modelId);
      assert.equal(loaded.length, 1, 'a child loads one model in its life');
      for (const r of child.requests()) assert.equal(r.modelId, loaded[0], 'a request never reaches a child holding another model');
    }
    assert.equal(fake.children.length, 5, 'A B A B (B reuses) A: five children, one per change');
  });

  it('awaits the old child\'s exit before it spawns the next, so two copies of a model never coexist', async () => {
    const { worker, fake, events } = setup({ fake: {} });
    const a = watch(worker.request(req('a', { modelId: 'A' })));
    await flush();
    const old = fake.last();
    old.dieOnKill = false;
    old.exitOnShutdown = false;
    await bringUp(old, 'A');
    await answer(old);
    assert.equal(a.settled, true);

    const b = watch(worker.request(req('b', { modelId: 'B' })));
    await flush();
    assert.ok(old.sent.some(m => m.type === 'shutdown') || old.kills.length > 0, 'the old child was told to go');
    assert.equal(fake.children.length, 1, 'the old child is still alive, so no second child yet');

    old.exit(0, null);
    await flush();
    assert.equal(fake.children.length, 2);
    await bringUp(fake.last(), 'B');
    assert.equal(fake.last().loads()[0].modelId, 'B');
    await answer(fake.last());
    assert.equal(b.settled, true);
    assert.deepEqual(restartReasons(events), ['model-change']);
    assert.equal(worker.state().consecutiveLosses, 0, 'a configured change is not a fault');
  });

  it('kills a child that ignores the request to go, after the grace period', async () => {
    const { worker, fake, vt } = setup({ fake: {}, host: { killGraceMs: 2_000 } });
    worker.request(req('a', { modelId: 'A' })).catch(() => {});
    await flush();
    const old = fake.last();
    old.dieOnKill = false;
    old.exitOnShutdown = false;
    await bringUp(old, 'A');
    await answer(old);

    worker.request(req('b', { modelId: 'B' })).catch(() => {});
    await flush();
    await vt.advance(1_999);
    assert.ok(!old.kills.includes('SIGKILL'));
    await vt.advance(1);
    assert.ok(old.kills.includes('SIGKILL'), 'a child that will not leave is made to');
    await flush();
    assert.equal(fake.children.length, 2);
  });

  it('recycle() drops the child after its work and forgets what it knew about load failures', async () => {
    const { worker, fake, events } = setup({ fake: { auto: { failLoad: m => (m === 'bad' ? 'cannot load bad' : false) } } });
    await worker.request(req('a'));
    await worker.recycle();
    assert.ok(fake.children[0].exited, 'the child that held the old configuration is gone');
    assert.deepEqual(restartReasons(events), ['model-change']);

    await assert.rejects(worker.request(req('b', { modelId: 'bad' })), /cannot load bad/);
    assert.equal(worker.state().loadFailure !== null, true);
    await worker.recycle();
    assert.equal(worker.state().loadFailure, null);
    const before = fake.children.length;
    await assert.rejects(worker.request(req('c', { modelId: 'bad' })), /cannot load bad/);
    assert.equal(fake.children.length, before + 1, 'the configuration changed, so the model is tried again');
  });
});

describe('a model that cannot be loaded', () => {
  const failing = { auto: { failLoad: m => (m === 'bad' ? 'Embedding model \'bad\' is not in the model cache' : false) } };

  it('is tried once, however many embeds fail, and the error text reaches the caller unchanged', async () => {
    const { worker, fake } = setup({ fake: failing });
    const messages = [];
    for (let i = 0; i < 5; i++) {
      const err = await worker.request(req(`t${i}`, { modelId: 'bad' })).then(() => null, e => e);
      assert.ok(err, 'rejected');
      messages.push(err.message);
      assert.notEqual(err.lost, true, 'a deterministic load failure is not a lost process');
      assert.equal(err.kind, 'load');
    }
    assert.equal(fake.children.length, 1, 'five failing embeds, one spawn: a model that cannot load is not retried in a loop');
    assert.ok(messages.every(m => m === 'Embedding model \'bad\' is not in the model cache'), messages.join(' | '));
  });

  it('answers a burst of concurrent requests with one spawn', async () => {
    const { worker, fake } = setup({ fake: failing });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => worker.request(req(`t${i}`, { modelId: 'bad' })).then(() => 'ok', e => e.kind)),
    );
    assert.deepEqual(outcomes, Array(8).fill('load'));
    assert.equal(fake.children.length, 1);
  });

  it('stays failed for as long as nothing changes, and starts no backoff', async () => {
    const { worker, fake, vt } = setup({ fake: failing });
    await worker.request(req('a', { modelId: 'bad' })).catch(() => {});
    assert.equal(worker.state().phase, 'none');
    assert.equal(worker.state().consecutiveLosses, 0);
    assert.match(worker.state().loadFailure, /not in the model cache/);
    assert.equal(worker.state().loadFailureModelId, 'bad',
      'the state names the model the failure is about, so a reader can tell it from a failure of a previous model');

    await vt.advance(24 * 60 * MIN);
    await worker.request(req('b', { modelId: 'bad' })).catch(() => {});
    assert.equal(fake.children.length, 1, 'a day later the answer has not changed, so nobody asked again');
  });

  it('does not stop a different model from loading', async () => {
    const { worker } = setup({ fake: failing });
    await worker.request(req('a', { modelId: 'bad' })).catch(() => {});
    const ok = await worker.request(req('b', { modelId: 'good' }));
    assert.equal(ok.modelId, 'good');
  });

  it('is forgotten on request (an operator changed something), and then tried again', async () => {
    const { worker, fake } = setup({ fake: failing });
    await worker.request(req('a', { modelId: 'bad' })).catch(() => {});
    worker.forgetLoadFailures();
    await worker.request(req('b', { modelId: 'bad' })).catch(() => {});
    assert.equal(fake.children.length, 2);
  });

  // A background load failure used to reach the server log only as one debug line per failing embed job, so an
  // operator reading the log at its default level saw nothing at all while every embed failed. One warn when the
  // failure is LEARNED, never one per refused embed: a thousand queued records would otherwise write a thousand.
  it('warns ONCE when a load failure is first learned, naming the model and the reason, and not on later embeds', async () => {
    const { worker, logs } = setup({ fake: { auto: { failLoad: m => (m.startsWith('bad') ? `cannot load ${m}: no such file` : false) } } });
    for (let i = 0; i < 6; i++) await worker.request(req(`t${i}`, { modelId: 'bad' })).catch(() => {});
    const warns = () => logs.filter(l => l.level === 'warn');
    assert.equal(warns().length, 1, `six failing embeds, one warning: ${JSON.stringify(warns())}`);
    assert.match(warns()[0].message, /bad/, 'the warning names the model');
    assert.match(warns()[0].message, /cannot load bad: no such file/, 'and carries the reason the child gave');

    // A different model that cannot load either is a new fact, so it is said once more.
    for (let i = 0; i < 3; i++) await worker.request(req(`u${i}`, { modelId: 'bad-two' })).catch(() => {});
    assert.equal(warns().length, 2, 'a model change that fails again warns again, once');
    assert.match(warns()[1].message, /bad-two/);

    // Forgotten (an operator changed something) and failing again: learned again, so warned again.
    worker.forgetLoadFailures();
    await worker.request(req('v', { modelId: 'bad' })).catch(() => {});
    assert.equal(warns().length, 3);
  });

  it('bounds the reason in that warning, however much the child said', async () => {
    const { worker, logs } = setup({ fake: { auto: { failLoad: () => 'x'.repeat(50_000) } }, host: { maxErrorChars: 300 } });
    await worker.request(req('a', { modelId: 'bad' })).catch(() => {});
    const warn = logs.find(l => l.level === 'warn');
    assert.ok(warn, 'warned');
    assert.ok(warn.message.length < 600, `the warning is ${warn.message.length} chars long`);
  });
});

describe('events from a child that is no longer the current one', () => {
  it('are ignored: a late reply, a second exit and an error from an old generation change nothing', async () => {
    const { worker, fake, vt } = setup({ fake: {}, host: { backoffMs: () => 100 } });
    const a = watch(worker.request(req('a')));
    await flush();
    const old = fake.children[0];
    await bringUp(old);
    const oldRequestId = old.lastRequestId();
    old.exit(1, null);
    await flush();
    assert.equal(a.error?.lost, true);

    await vt.advance(100);
    const b = watch(worker.request(req('b')));
    await flush();
    const fresh = fake.last();
    assert.notEqual(fresh, old);
    await bringUp(fresh);
    const spawnsBefore = worker.state().spawns;
    const lossesBefore = worker.state().consecutiveLosses;

    // The dead child's ghost: replies to the CURRENT request id with a wrong vector, exits again, errors.
    old.say({ type: 'reply', id: fresh.lastRequestId(), vector: [9, 9, 9], modelId: 'm', inferenceMs: 1 });
    old.say({ type: 'reply', id: oldRequestId, vector: [9, 9, 9], modelId: 'm', inferenceMs: 1 });
    old.emit('exit', 1, null);
    old.emit('close', 1, null);
    assert.doesNotThrow(() => old.emit('error', new Error('late')));
    await flush();

    assert.equal(b.settled, false, 'the current request is still waiting for ITS child');
    assert.equal(worker.state().consecutiveLosses, lossesBefore);
    assert.equal(worker.state().spawns, spawnsBefore);
    await answer(fresh, { vector: [0.5] });
    assert.deepEqual(b.value.vector, [0.5]);
  });
});

describe('a channel that has died', () => {
  for (const mode of ['callback-error', 'throw', 'emit-error']) {
    it(`rejects the request instead of throwing out of the host (send ${mode})`, async () => {
      const { worker, fake } = setup({ fake: {} });
      let uncaught = 0;
      const onUncaught = () => { uncaught++; };
      process.on('uncaughtException', onUncaught);
      try {
        const a = watch(worker.request(req('a')));
        await flush();
        const child = fake.last();
        child.ready();
        await flush();
        child.sendMode = mode;
        child.loaded('m');
        await flush();
        await flush();
        assert.equal(a.settled, true, 'a dead channel must not leave a request waiting for a reply that cannot come');
        assert.equal(a.error?.lost, true);
        assert.equal(uncaught, 0, 'and must not reach uncaughtException, which takes the server down');
      } finally {
        process.off('uncaughtException', onUncaught);
      }
    });
  }

  it('survives an error event on a child that has no other handler', async () => {
    const { worker, fake } = setup({ fake: {} });
    worker.request(req('a')).catch(() => {});
    await flush();
    assert.doesNotThrow(() => fake.last().emit('error', new Error('spawn ENOENT')));
    await flush();
  });
});

describe('what a child is allowed to tell the host', () => {
  it('ignores a reply that is malformed, unknown or for nobody, and still answers the real one', async () => {
    const { worker, fake } = setup({ fake: {}, host: { maxVectorLength: 16 } });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    const id = child.lastRequestId();
    const before = worker.state();

    for (const bad of [
      { type: 'reply', id: id + 1000, vector: [1, 2], modelId: 'm', inferenceMs: 1 },      // nobody asked
      { type: 'reply', id: String(id), vector: [1, 2], modelId: 'm', inferenceMs: 1 },     // id is not a number
      { type: 'reply', vector: [1, 2], modelId: 'm', inferenceMs: 1 },                     // no id
      { type: 'reply', id, vector: [], modelId: 'm', inferenceMs: 1 },                     // empty vector
      { type: 'reply', id, vector: [1, 'x', 3], modelId: 'm', inferenceMs: 1 },            // not numbers
      { type: 'reply', id, vector: [1, null, 3], modelId: 'm', inferenceMs: 1 },           // what JSON makes of NaN
      { type: 'reply', id, vector: [1, NaN], modelId: 'm', inferenceMs: 1 },
      { type: 'reply', id, vector: [1, Infinity], modelId: 'm', inferenceMs: 1 },
      { type: 'reply', id, vector: 'not an array', modelId: 'm', inferenceMs: 1 },
      { type: 'reply', id, vector: Array(17).fill(0.5), modelId: 'm', inferenceMs: 1 },    // larger than any real vector
      { type: 'error', id, kind: 'no-such-kind', error: 'ignore me' },
      { type: 'no-such-type', id },
      { fixture: 'started' },
      'a bare string',
      null,
      42,
      [],
    ]) {
      child.say(bad);
      await flush();
      assert.equal(a.settled, false, `settled by ${JSON.stringify(bad)?.slice(0, 80)}`);
    }

    assert.equal(worker.state().phase, before.phase, 'and none of it is a reason to kill the child');
    assert.deepEqual(child.kills, []);
    await answer(child, { vector: Array(16).fill(0.5) });
    assert.equal(a.settled, true);
    assert.equal(a.value.vector.length, 16);
  });

  it('settles a request once: a duplicate reply for it is ignored', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    const first = child.lastRequestId();
    await answer(child, { vector: [1] });
    child.reply(first, { vector: [7] });          // again, late
    await flush();
    assert.deepEqual(a.value.vector, [1]);
    assert.equal(b.settled, false, 'a stale reply must not settle the request that took the next turn');
  });

  it('believes a message that arrives before the handshake no more than one after it', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    child.say({ type: 'reply', id: 1, vector: [1], modelId: 'm', inferenceMs: 1 });
    child.say({ type: 'loaded', modelId: 'm' });
    await flush();
    assert.equal(a.settled, false);
    assert.equal(child.requests().length, 0, 'nothing was asked of a child that has not said it is ready');
  });
});

describe('the child holds the process open only while there is work for it', () => {
  it('is ref\'d while a request is pending and unref\'d, with its channel, when there is none', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    assert.equal(child.refed && child.channelRefed, true, 'pending work keeps the process alive');
    await bringUp(child);
    await answer(child);
    assert.equal(a.settled, true);
    assert.equal(child.refed, false, 'nothing pending: a script awaiting embed() must be free to exit');
    assert.equal(child.channelRefed, false, 'the IPC channel too, or the parent never exits');

    const b = watch(worker.request(req('b')));
    await flush();
    assert.equal(child.refed && child.channelRefed, true, 'the next request holds it again');
    await answer(child);
    assert.equal(b.settled, true);
    assert.equal(child.refed || child.channelRefed, false);
  });

  it('holds the process while a child is starting for a request, and lets go when the request is lost', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    assert.equal(child.refed, true);
    child.exit(1, null);
    await flush();
    assert.equal(a.error?.lost, true);
    assert.equal(child.refed || child.channelRefed, false);
  });

  it('stays ref\'d until the LAST pending request is answered, not the first', async () => {
    const { worker, fake } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    await answer(child);
    assert.equal(a.settled, true);
    assert.equal(b.settled, false);
    assert.equal(child.refed && child.channelRefed, true, 'one answered, one still waiting: still held');
    await answer(child);
    assert.equal(b.settled, true);
    assert.equal(child.refed || child.channelRefed, false);
  });

  // Found on Linux CI (PR #1470): after a loss there is no child to hold anything, the backoff timer was unref'd
  // like every other host timer, and a caller awaiting `waitOutBackoff()` was a process with nothing keeping it
  // alive, so a script (or a test) that awaited the end of a backoff simply ended. Windows passed only because a
  // killed child's handles linger there long enough to bridge a short backoff.
  it('a caller waiting out the backoff is held open by the backoff timer, and a backoff nobody awaits holds nothing', async () => {
    const { worker, fake, vt } = setup({ fake: {}, host: { backoffMs: () => 5_000 } });
    worker.request(req('a')).catch(() => {});
    await flush();
    await bringUp(fake.last());
    fake.last().exit(1, null);
    await flush();
    assert.equal(worker.state().phase, 'backoff');
    assert.equal(vt.refedTimers(), 0, 'a backoff nobody is waiting for must not keep a script alive');

    const w = watch(worker.waitOutBackoff());
    assert.equal(vt.refedTimers(), 1, 'someone awaits the end of the backoff: the process must live to see it');
    await vt.advance(5_000);
    assert.equal(w.settled, true);
    assert.equal(vt.refedTimers(), 0);
  });
});

describe('the environment a child gets', () => {
  it('is an allowlist: the platform basics and what the caller named, never the server\'s own environment', async () => {
    const secrets = { YTHRIL_TEST_CANARY_SECRET: 's1', MONGO_URI: 'mongodb://u:p@h/db', MASTER_KEY: 'k', ANTHROPIC_API_KEY: 'a' };
    const saved = {};
    for (const [k, v] of Object.entries({ ...secrets, NODE_OPTIONS: '--inspect=0', MODEL_CACHE_DIR: '/models', NOT_NAMED: 'x' })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const { worker, fake } = setup({ fake: { auto: true }, host: { envNames: ['MODEL_CACHE_DIR'], env: { EXTRA: '1' } } });
      await worker.request(req('a'));
      const env = fake.last().spec.env;

      for (const k of Object.keys(secrets)) assert.equal(env[k], undefined, `${k} reached the child`);
      assert.equal(env.NODE_OPTIONS, undefined, 'inherited inspector and heap flags are stripped');
      assert.equal(env.NOT_NAMED, undefined, 'only named variables pass');
      assert.equal(env.MODEL_CACHE_DIR, '/models');
      assert.equal(env.EXTRA, '1');
      const allowed = new Set([...PLATFORM_ENV, 'MODEL_CACHE_DIR', 'EXTRA']);
      const stray = Object.keys(env).filter(k => !allowed.has(k));
      assert.deepEqual(stray, [], 'nothing outside the allowlist');
      assert.ok(PLATFORM_ENV.some(k => k.toLowerCase() === 'path'),
        'the platform basics include the search path node needs to start');
      assert.ok(PLATFORM_ENV.length <= 20, 'the platform list is a short list of what node needs, not a second copy of the environment');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('is read at spawn time, so a changed setting reaches the next child', async () => {
    const before = process.env.MODEL_CACHE_DIR;
    try {
      process.env.MODEL_CACHE_DIR = '/first';
      const { worker, fake } = setup({ fake: { auto: true }, host: { envNames: ['MODEL_CACHE_DIR'] } });
      await worker.request(req('a', { modelId: 'A' }));
      process.env.MODEL_CACHE_DIR = '/second';
      await worker.request(req('b', { modelId: 'B' }));
      assert.deepEqual(fake.children.map(c => c.spec.env.MODEL_CACHE_DIR), ['/first', '/second']);
    } finally {
      if (before === undefined) delete process.env.MODEL_CACHE_DIR; else process.env.MODEL_CACHE_DIR = before;
    }
  });
});

describe('stopping', () => {
  it('lets the running inference finish inside the budget, rejects what was queued, and ends the child', async () => {
    const { worker, fake, vt } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    const b = watch(worker.request(req('b')));
    await flush();
    const child = fake.last();
    await bringUp(child);

    const stopped = watch(worker.stop({ budgetMs: 2_000 }));
    await flush();
    assert.equal(stopped.settled, false, 'the drain waits for the inference in flight');
    assert.equal(b.settled, true, 'queued work is not started during a shutdown');
    assert.ok(b.error, 'and is told so');

    await answer(child, { vector: [4] });
    assert.deepEqual(a.value.vector, [4], 'the inference that was running completed');
    await flush();
    assert.ok(child.sent.some(m => m.type === 'shutdown') || child.kills.length > 0);
    if (!child.exited) child.exit(0, null);
    await flush();
    assert.equal(stopped.settled, true);
    assert.equal(vt.pendingTimers(), 0, 'nothing is left scheduled to hold the process open');
    assert.equal(fake.children.length, 1, 'a stopped host never respawns');
  });

  it('kills a child that is still inside an inference when the budget runs out', async () => {
    const { worker, fake, vt } = setup({ fake: {} });
    const a = watch(worker.request(req('a')));
    await flush();
    const child = fake.last();
    await bringUp(child);
    const stopped = watch(worker.stop({ budgetMs: 2_000 }));
    await vt.advance(1_999);
    assert.equal(stopped.settled, false);
    await vt.advance(1);
    assert.ok(child.kills.includes('SIGKILL'));
    await flush();
    assert.equal(stopped.settled, true);
    assert.ok(a.error, 'the inference that was cut off is rejected, not left hanging');
    assert.equal(vt.pendingTimers(), 0);
  });

  it('resolves at once for a host that never started anything, and refuses requests afterwards', async () => {
    const { worker, fake } = setup({ fake: {} });
    await worker.stop({ budgetMs: 100 });
    await assert.rejects(worker.request(req('a')), e => e.lost !== true && /stop/i.test(e.message));
    assert.equal(fake.children.length, 0);
  });
});
