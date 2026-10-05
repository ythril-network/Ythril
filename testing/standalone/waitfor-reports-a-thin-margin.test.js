/**
 * A wait that only just passed says so, so a timeout can be decided from evidence.
 *
 * ## What happened
 *
 * `Subscriber-local content survives publisher tombstone` timed out in CI at its 25 s budget — on a diff of
 * client CSS, docs and a changelog, none of which can touch sync propagation. It passed on rerun with no code
 * change.
 *
 * The tempting move is to raise the 25 s. It is also a guess, and the two things it could be are different
 * problems:
 *
 *   - a green run genuinely takes ~20 s, the margin is thin, and a bigger budget is the fix; or
 *   - a green run takes ~3 s and something occasionally **stalls**, in which case the deadline is only how we
 *     found out, and raising it hides the stall until it is longer than the new number too.
 *
 * Nothing recorded how long a passing wait took, so nobody could tell which. That was the missing measurement,
 * and it was missing for every wait in the suite rather than just the one that went red.
 *
 * ## Why a warning and not a failure
 *
 * A slow pass failing the build would make CI stricter than the product, and propagation time legitimately
 * varies with what else the runner is doing. The point is to make the margin visible while it is still a margin.
 *
 * ## Where the warning lives now
 *
 * There is ONE wait, `testing/_shared/wait-for.mjs`, and the warning is its `thinMargin` option — off unless
 * asked, because an in-process poll of a queue that drains in milliseconds has no stack-wide budget to be close
 * to and would warn on noise. The stack helper (`testing/sync/helpers.js`) asks, for every wait that goes through
 * it, so the ~117 call sites keep the warning without having changed. The threshold is written once, in the
 * module: a second copy of a threshold is a second place for the two to disagree about what "thin" means.
 *
 * Run: node --test testing/standalone/waitfor-reports-a-thin-margin.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

/*
 * Loaded in a hook, but a failure to load is kept and re-thrown by the test that needs the module: a hook that throws
 * cancels the whole file ("test did not finish before its parent and was cancelled") and every red then points
 * nowhere near the missing module.
 */
let waitForImpl;
let stackImpl;
let loadError;
before(async () => {
  try {
    ({ waitFor: waitForImpl } = await import('../../testing/_shared/wait-for.mjs'));
    ({ waitFor: stackImpl } = await import('../../testing/sync/helpers.js'));
  } catch (err) { loadError = err; }
});
const loaded = (impl) => {
  if (!impl) throw new Error(`testing/_shared/wait-for.mjs (or the stack helper over it) could not be loaded: ${loadError?.message}`);
  return impl;
};
const waitFor = async (...args) => loaded(waitForImpl)(...args);
const stackWaitFor = async (...args) => loaded(stackImpl)(...args);

/** Capture console.warn for one call. */
async function warnsDuring(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try { await fn(); } finally { console.warn = original; }
  return lines;
}

/** The wait, asked to report a thin margin. */
const asking = (condition, timeout, interval, diagnose) => waitFor(condition, timeout, interval, diagnose, { thinMargin: true });

describe('a comfortable pass is quiet', () => {
  it('says nothing when the condition is true immediately', async () => {
    const lines = await warnsDuring(() => asking(() => true, 1_000, 10));
    assert.deepEqual(lines, [], 'a wait that returned at once must not warn — that is noise on every test');
  });

  it('still returns true, so no caller changes', async () => {
    // The return value is load-bearing: several waits are used as `assert.ok(await waitFor(...))`. Returning
    // the elapsed time instead would make a wait that succeeded on its first poll return 0 — falsy — and
    // silently invert those assertions.
    assert.equal(await asking(() => true, 1_000, 10), true);
  });
});

describe('a thin pass reports the numbers', () => {
  it('warns when the wait consumed most of its budget', async () => {
    // 160ms budget, condition true after ~100ms: past the 60% mark.
    const start = Date.now();
    const lines = await warnsDuring(() => asking(() => Date.now() - start > 100, 160, 10));
    assert.equal(lines.length, 1, `expected one warning, got ${lines.length}`);
    assert.match(lines[0], /passed after \d+ms of a 160ms budget/,
      'the message must carry BOTH numbers — a percentage alone cannot be compared across different budgets');
    assert.match(lines[0], /\d+%/);
  });

  it('the warning says what to do with it', async () => {
    // A warning that only reports is a warning people learn to scroll past. This one has to distinguish the
    // two diagnoses, because picking the wrong one is how a stall gets hidden behind a bigger number.
    const start = Date.now();
    const lines = await warnsDuring(() => asking(() => Date.now() - start > 100, 160, 10));
    assert.match(lines[0], /stall/i, 'the message must name the alternative to "just raise it"');
  });
});

describe('the timeout path is unchanged', () => {
  it('still throws with the budget and the diagnosis', async () => {
    await assert.rejects(
      () => asking(() => false, 60, 10, 'the subscriber never saw it'),
      /waitFor timed out after 60ms — the subscriber never saw it/,
    );
  });

  it('a timeout does NOT also warn about a thin margin', async () => {
    // It failed; a note that it was close would be absurd and would bury the real error.
    const lines = await warnsDuring(async () => {
      await asking(() => false, 60, 10).catch(() => {});
    });
    assert.deepEqual(lines, []);
  });
});

describe('it is asked for, not on by default', () => {
  it('the wait itself stays quiet about a thin pass unless `thinMargin` is set', async () => {
    // An in-process poll waits on a queue that drains in tens of milliseconds against a budget chosen for a slow
    // runner. Warning there would be a line on every test about a margin nobody can act on.
    const start = Date.now();
    const lines = await warnsDuring(() => waitFor(() => Date.now() - start > 100, 160, 10));
    assert.deepEqual(lines, []);
  });

  it('the stack helper asks, so every wait that goes through it keeps its warning', async () => {
    const start = Date.now();
    const lines = await warnsDuring(() => stackWaitFor(() => Date.now() - start > 100, 160, 10));
    assert.equal(lines.length, 1, 'the stack helper stopped reporting a thin margin — its ~117 callers lost the measurement');
    assert.match(lines[0], /passed after \d+ms of a 160ms budget/);
  });

  it('and a comfortable pass through the stack helper is quiet too', async () => {
    assert.deepEqual(await warnsDuring(() => stackWaitFor(() => true, 1_000, 10)), []);
  });
});

describe('the threshold is a named constant, written once', () => {
  it('is stated once, in the module, and explained', () => {
    const src = readFileSync(join(REPO_ROOT, 'testing/_shared/wait-for.mjs'), 'utf8');
    assert.match(src, /const TIGHT_MARGIN = 0\.6/,
      'a bare 0.6 inside the comparison is a number nobody can find when they want to tune it');
  });

  it('no other test or helper file defines it or words the warning again', () => {
    // Derived from what is tracked, so a copy written next year is in scope the day it is written. The module is
    // the one place that may hold the constant and the sentence; anywhere else it is a second opinion about "thin".
    const files = trackedSources(['testing'], { ext: ['.js', '.mjs'], floor: 500 });
    const copies = files.filter(f => f !== 'testing/_shared/wait-for.mjs'
      && !(f.startsWith('testing/standalone/') && f.endsWith('.test.js')) // gates that QUOTE the sentence
      && /\bTIGHT_MARGIN\b|thin margin, and a/.test(readFileSync(join(REPO_ROOT, f), 'utf8')));
    assert.deepEqual(copies, [], 'these files carry their own copy of the thin-margin threshold or its warning');
  });
});
