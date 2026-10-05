/**
 * `testing/_shared/wait-for.mjs` is the one wait — what it promises, exercised rather than grepped (`Q-319`).
 *
 * ## What this prevents
 *
 * About thirty tests and helpers polled for a condition by hand, in four dialects. They differed in exactly the
 * places a wait is hard to get right: how the deadline is read, what is said when it passes, whether a thrown probe
 * ends the wait or is ridden out, and whether a probe that never answers can outlast the deadline. Every one of
 * those has already cost a red CI run somewhere in this suite — a bare `timed out after 90000ms` that hid a
 * rejected trigger for weeks, a `before` hook that outlived its own deadline, a `waitForApi` that swallowed every
 * error while a server restarted and then reported none of them.
 *
 * The module keeps the positional signature of the sync helper it grew from —
 * `waitFor(condition, timeout, interval, diagnose)` — so the ~117 call sites did not move, and takes the rest as a
 * fifth, optional argument:
 *
 *     waitFor(condition, timeout, interval, diagnose, { what, thinMargin, tolerate })
 *
 * - `what`       the phrase completing "waiting for …"; a timeout then names it and the LAST VALUE the condition
 *                returned (or that the last probe threw, or was still pending at the deadline).
 * - `thinMargin` ask for the warning when a wait passes with most of its budget gone. OFF unless asked: a stack
 *                helper wants it, an in-process poll of a 10 ms queue does not.
 * - `tolerate`   `(error) => boolean`: a probe that throws is ridden out when this says so (a server that is
 *                restarting refuses connections) and PROPAGATES otherwise — never a blanket catch.
 *
 * and it appends the time it waited to the timing JSONL when a destination is set (`WAIT_TIMING_ENV`), so the
 * setup / waits / work breakdown of a file's time exists: work = file time − hooks − waits.
 *
 * The timeout message keeps today's shape for a caller that passes no `what` — `waitFor timed out after 30ms`, and
 * ` — <diagnosis>` after it — because pins and people read it.
 *
 * Not tested here, by design: whether any hand-written poll is left (`a-poll-is-written-once`), and the
 * "which side lost it" diagnostics (`a-timeout-says-which-side-lost-it`), which now run through this module.
 *
 * Run: node --test testing/standalone/wait-for-is-one-module.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { sleep } from '../_shared/sleep.mjs';

const MODULE_PATH = join(REPO_ROOT, 'testing', '_shared', 'wait-for.mjs');

/*
 * Loaded in a hook, but a failure to load is kept and re-thrown by every test that needs the module: a hook that
 * throws cancels the suite ("test did not finish before its parent and was cancelled") and every red then reads
 * the same and points nowhere near the missing file.
 */
let impl;
let loadError;
let WAIT_TIMING_ENV;
before(async () => {
  try {
    impl = await import(pathToFileURL(MODULE_PATH).href);
    WAIT_TIMING_ENV = impl.WAIT_TIMING_ENV;
  } catch (err) { loadError = err; }
});
const waitFor = async (...args) => {
  if (!impl) throw new Error(`testing/_shared/wait-for.mjs could not be loaded: ${loadError?.message ?? 'not loaded'}`);
  return impl.waitFor(...args);
};

const never = async () => false;

/** Capture console.warn for one call. */
async function warnsDuring(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try { await fn(); } finally { console.warn = original; }
  return lines;
}

describe('the signature the call sites already use', () => {
  it('is a module of its own, exporting waitFor and the name of its timing destination', () => {
    assert.ok(existsSync(MODULE_PATH), 'testing/_shared/wait-for.mjs does not exist');
    assert.ok(impl, `the module did not load: ${loadError?.message}`);
    assert.equal(typeof impl.waitFor, 'function');
    assert.equal(typeof WAIT_TIMING_ENV, 'string', 'WAIT_TIMING_ENV names the env var that carries the destination');
    assert.ok(WAIT_TIMING_ENV.length > 0);
  });

  it('resolves to exactly true when the condition holds, so `assert.ok(await waitFor(…))` keeps working', async () => {
    // Several callers assert on the value. Returning the elapsed time would make a wait that held on its first poll
    // return 0 — falsy — and silently invert them.
    assert.equal(await waitFor(() => true, 1_000, 10), true);
    assert.equal(await waitFor(async () => 'yes', 1_000, 10), true, 'truthy is enough; the value is not the contract');
  });

  it('works with the condition alone (default budget, default interval)', async () => {
    assert.equal(await waitFor(() => true), true);
  });

  it('polls until the condition holds, once per interval', async () => {
    let calls = 0;
    const t0 = Date.now();
    assert.equal(await waitFor(async () => ++calls >= 3, 5_000, 40), true);
    assert.equal(calls, 3, 'it must stop polling the moment the condition holds');
    assert.ok(Date.now() - t0 >= 60, 'two intervals must have been slept between three polls');
  });
});

describe('a timeout says what never held', () => {
  it('without a `what`, keeps the bare shape existing pins read', async () => {
    await assert.rejects(() => waitFor(never, 40, 10), /^Error: waitFor timed out after 40ms$/);
  });

  it('appends the diagnosis — a string, a function, or an async function that goes and looks', async () => {
    await assert.rejects(() => waitFor(never, 40, 10, 'because the widget never arrived'),
      /waitFor timed out after 40ms — because the widget never arrived$/);
    await assert.rejects(() => waitFor(never, 40, 10, () => 'sync detail'), /— sync detail$/);
    await assert.rejects(
      () => waitFor(never, 40, 10, async () => { await sleep(5); return 'the sender holds it at seq 42'; }),
      (err) => {
        assert.match(err.message, /— the sender holds it at seq 42$/);
        assert.doesNotMatch(err.message, /\[object Promise\]/, 'diagnose was called without await');
        return true;
      });
  });

  it('with a `what`, names it and the last value the condition returned', async () => {
    await assert.rejects(() => waitFor(never, 40, 10, undefined, { what: 'the record to reach B' }),
      /^Error: waitFor timed out after 40ms waiting for the record to reach B \(last value: false\)$/);
  });

  it('reports the LAST value, not the first — a condition that moves says where it stopped', async () => {
    // A reading that changes on every poll, and the message must name the one the FINAL poll returned. Which one that is
    // depends on how many polls fit in the window, so the assertion reads it back rather than assuming three fit: under
    // preflight's load two did, and a fixed "undefined" read the timing, not the rule.
    // Every reading is falsy, so the wait never ends early; the first (NaN) is one no later poll returns.
    const later = [null, 0, false, undefined];
    let polls = 0;
    let lastReturned;
    await assert.rejects(
      () => waitFor(async () => { lastReturned = polls === 0 ? NaN : later[(polls - 1) % later.length]; polls++; return lastReturned; },
        120, 10, undefined, { what: 'the count to arrive' }),
      (e) => {
        assert.ok(polls >= 2, `only ${polls} poll(s) ran, so first and last cannot be told apart`);
        assert.ok(e.message.endsWith(`waiting for the count to arrive (last value: ${String(lastReturned)})`),
          `the message does not name the last reading (${String(lastReturned)}): ${e.message}`);
        assert.ok(!e.message.includes('(last value: NaN)'), `the message names the first reading, not the last: ${e.message}`);
        return true;
      });
    await assert.rejects(() => waitFor(async () => 0, 40, 10, undefined, { what: 'a number' }), /\(last value: 0\)$/);
    await assert.rejects(() => waitFor(async () => null, 40, 10, undefined, { what: 'a thing' }), /\(last value: null\)$/);
  });

  it('puts the diagnosis after the what and the last value', async () => {
    await assert.rejects(
      () => waitFor(never, 40, 10, () => 'sync triggers to A all succeeded (8)', { what: 'the tombstone to arrive' }),
      /^Error: waitFor timed out after 40ms waiting for the tombstone to arrive \(last value: false\) — sync triggers to A all succeeded \(8\)$/);
  });

  it('says so when the last probe was still pending at the deadline', async () => {
    await assert.rejects(
      () => waitFor(() => new Promise(() => {}), 80, 10, undefined, { what: 'an answer that never comes' }),
      /waiting for an answer that never comes \(last probe still pending\)$/);
  });
});

describe('a wait on a STATE answers with the reading it accepted, and names the last one it did not', () => {
  const waitForReading = async (...args) => {
    assert.ok(impl, `the module did not load: ${loadError?.message}`);
    return impl.waitForReading(...args);
  };

  it('resolves with the reading that was accepted — the state itself, not a boolean', async () => {
    const readings = ['pending', 'processing', 'complete'];
    let i = 0;
    assert.equal(await waitForReading(async () => readings[i++], (s) => s === 'complete', 1_000, 10), 'complete');
    assert.equal(i, 3, 'it read once per poll and stopped at the reading it accepted');
  });

  it('THROWS at the deadline, naming what was waited for and the last reading (the state, not the predicate\'s false)', async () => {
    await assert.rejects(
      () => waitForReading(async () => 'pending', (s) => s === 'complete', 40, 10, { what: 'the file to be embedded' }),
      /^Error: waitFor timed out after 40ms waiting for the file to be embedded \(last value: false\) — last reading: "pending"$/);
  });

  it('names an object reading as JSON — a state that is an answer with a status and a body is not `[object Object]`', async () => {
    await assert.rejects(
      () => waitForReading(async () => ({ status: 503, body: { error: 'warming up' } }), (r) => r.status === 200, 40, 10, { what: 'recall to answer' }),
      /last reading: \{"status":503,"body":\{"error":"warming up"\}\}$/);
  });

  it('a reading that is undefined is named as such rather than as nothing', async () => {
    await assert.rejects(() => waitForReading(async () => undefined, (s) => s === 'complete', 40, 10, { what: 'the status' }),
      /last reading: undefined$/);
  });
});

describe('a probe cannot outlast the deadline', { timeout: 20_000 }, () => {
  it('a probe that never answers ends at the deadline, not never', async () => {
    const t0 = Date.now();
    await assert.rejects(() => waitFor(() => new Promise(() => {}), 150, 20), /waitFor timed out after 150ms/);
    const took = Date.now() - t0;
    assert.ok(took >= 140, `rejected after ${took}ms, before its 150ms deadline`);
    assert.ok(took < 3_000, `a probe that never answers held the wait for ${took}ms — the deadline did not bound it`);
  });

  it('a slow probe that would have succeeded late still loses to the deadline', async () => {
    const slowYes = async () => { await sleep(400); return true; };
    await assert.rejects(() => waitFor(slowYes, 100, 10), /waitFor timed out after 100ms/);
  });

  it('the probe that was cut off cannot raise an unhandled rejection later', async () => {
    const escaped = [];
    const onUnhandled = (reason) => escaped.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const lateBoom = async () => { await sleep(250); throw new Error('boom, after the deadline'); };
      await assert.rejects(() => waitFor(lateBoom, 80, 10), /waitFor timed out after 80ms/);
      await sleep(500);
      assert.deepEqual(escaped.map(String), [], 'the abandoned probe rejected after the wait ended and nobody was listening');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('leaves nothing on the event loop once it has returned', () => {
    // A deadline timer armed per probe and not cleared holds the process open for the full budget: a 60 s wait that
    // held on its third poll would keep every test file alive for a minute. Checked in a child, because that is
    // the only place "the process exits" can be observed.
    const url = JSON.stringify(pathToFileURL(MODULE_PATH).href);
    const code = `import { waitFor } from ${url};
      let n = 0;
      await waitFor(async () => ++n >= 3, 600_000, 15);
      process.stdout.write('held');`;
    const t0 = Date.now();
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code],
      { timeout: 30_000, encoding: 'utf8', cwd: REPO_ROOT, env: { ...process.env, [WAIT_TIMING_ENV]: '' } });
    assert.equal(out, 'held');
    assert.ok(Date.now() - t0 < 25_000, 'the process lingered after the wait returned — a timer was left armed');
  });
});

describe('a probe that throws', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3200'), { code: 'ECONNREFUSED' });

  it('propagates at once when nothing was said to tolerate it', async () => {
    let calls = 0;
    const boom = new Error('the probe is broken, not slow');
    await assert.rejects(() => waitFor(async () => { calls++; throw boom; }, 1_000, 10),
      (err) => { assert.equal(err, boom, 'the ORIGINAL error, not a wrapper'); return true; });
    assert.equal(calls, 1, 'an untolerated throw must end the wait on the first poll');
  });

  it('is ridden out when `tolerate` says so — a server that is restarting refuses connections', async () => {
    let calls = 0;
    const seen = [];
    const ok = await waitFor(async () => {
      if (++calls < 3) throw refused();
      return true;
    }, 2_000, 10, undefined, { tolerate: (e) => { seen.push(e); return e.code === 'ECONNREFUSED'; } });
    assert.equal(ok, true);
    assert.equal(calls, 3);
    assert.equal(seen.length, 2, 'the predicate is asked once per thrown error, and with the error');
    assert.equal(seen[0].code, 'ECONNREFUSED');
  });

  it('propagates an error the predicate refuses, even from a wait that tolerates others', async () => {
    const boom = new TypeError('not a connection problem');
    await assert.rejects(
      () => waitFor(async () => { throw boom; }, 1_000, 10, undefined, { tolerate: (e) => e.code === 'ECONNREFUSED' }),
      (err) => { assert.equal(err, boom); return true; });
  });

  it('names the tolerated error that was still being thrown when the deadline came', async () => {
    await assert.rejects(
      () => waitFor(async () => { throw refused(); }, 80, 10, undefined, { what: 'the API to come back', tolerate: () => true }),
      /waiting for the API to come back \(last probe threw: connect ECONNREFUSED 127\.0\.0\.1:3200\)$/);
    await assert.rejects(
      () => waitFor(async () => { throw refused(); }, 80, 10, undefined, { tolerate: () => true }),
      /waitFor timed out after 80ms \(last probe threw: connect ECONNREFUSED 127\.0\.0\.1:3200\)$/,
      'without a `what` the thrown error is still the only thing worth saying');
  });
});

describe('a thin margin is reported only when asked', () => {
  it('stays silent by default — an in-process poll has no stack-wide budget to be close to', async () => {
    const start = Date.now();
    const lines = await warnsDuring(() => waitFor(() => Date.now() - start > 100, 160, 10));
    assert.deepEqual(lines, [], 'the module must not warn unless `thinMargin` is set');
  });

  it('warns with both numbers when asked and the wait used most of its budget', async () => {
    const start = Date.now();
    const lines = await warnsDuring(() => waitFor(() => Date.now() - start > 100, 160, 10, undefined, { thinMargin: true }));
    assert.equal(lines.length, 1, `expected one warning, got ${lines.length}`);
    assert.match(lines[0], /passed after \d+ms of a 160ms budget/);
  });
});

describe('the time it waited is recorded', () => {
  let dir;
  let dest;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'wait-for-timing-')); dest = join(dir, 'timing.jsonl'); });
  after(() => {
    delete process.env[WAIT_TIMING_ENV];
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = () => (existsSync(dest) ? readFileSync(dest, 'utf8') : '').split('\n').filter(Boolean).map(l => JSON.parse(l));

  it('appends one line for a wait that held: its name, how long, and that it held', async () => {
    process.env[WAIT_TIMING_ENV] = dest;
    const t0 = Date.now();
    await waitFor(async () => Date.now() - t0 > 120, 5_000, 20, undefined, { what: 'a recorded wait' });
    const got = lines().filter(l => l.what === 'a recorded wait');
    assert.equal(got.length, 1, `expected one line for the wait, found ${JSON.stringify(lines())}`);
    assert.equal(got[0].type, 'wait', 'the breakdown reads waits by type');
    assert.equal(got[0].held, true);
    assert.ok(got[0].ms >= 100 && got[0].ms < 5_000, `ms was ${got[0].ms} for a wait of about 120`);
    assert.equal(basename(got[0].file), basename(process.argv[1]), 'the line says which test file waited — work = file time − hooks − waits');
  });

  it('appends a line for a wait that gave up too — a timeout is time spent waiting', async () => {
    process.env[WAIT_TIMING_ENV] = dest;
    await assert.rejects(() => waitFor(never, 90, 10, undefined, { what: 'a wait that failed' }), /waiting for a wait that failed/);
    const got = lines().filter(l => l.what === 'a wait that failed');
    assert.equal(got.length, 1);
    assert.equal(got[0].held, false);
    assert.ok(got[0].ms >= 80, `ms was ${got[0].ms} for a wait that ran its 90ms budget`);
  });

  it('records a wait that was not given a name, so the sum of waits is not missing the unnamed ones', async () => {
    process.env[WAIT_TIMING_ENV] = dest;
    const before_ = lines().length;
    await waitFor(() => true, 1_000, 10);
    assert.equal(lines().length, before_ + 1);
  });

  it('writes nothing, and fails nothing, when no destination is set', async () => {
    delete process.env[WAIT_TIMING_ENV];
    const before_ = lines().length;
    assert.equal(await waitFor(() => true, 1_000, 10, undefined, { what: 'unrecorded' }), true);
    assert.equal(lines().length, before_);
  });

  it('never lets an unwritable destination fail the test it is measuring', async () => {
    process.env[WAIT_TIMING_ENV] = join(dir, 'no', 'such', 'directory', 'timing.jsonl');
    assert.equal(await waitFor(() => true, 1_000, 10, undefined, { what: 'measured badly' }), true,
      'measurement is a side effect of the wait; its failure must not become the wait\'s');
    await assert.rejects(() => waitFor(never, 40, 10), /^Error: waitFor timed out after 40ms$/,
      'and a timeout still says what the wait said, not what the recorder said');
  });
});

describe('the stack helper is this module, not a second copy of it', () => {
  it('accepts the same options through its own `waitFor`', async () => {
    const { waitFor: stackWaitFor } = await import(pathToFileURL(join(REPO_ROOT, 'testing', 'sync', 'helpers.js')).href);
    await assert.rejects(() => stackWaitFor(never, 40, 10, 'detail', { what: 'the stack to answer' }),
      /^Error: waitFor timed out after 40ms waiting for the stack to answer \(last value: false\) — detail$/);
    let calls = 0;
    assert.equal(await stackWaitFor(async () => { if (++calls < 2) throw new Error('down'); return true; },
      1_000, 10, undefined, { tolerate: () => true }), true);
  });
});
