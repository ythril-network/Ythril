/**
 * No test or helper polls by hand — the wait is `testing/_shared/wait-for.mjs`, or it says why it is not (`Q-319`).
 *
 * ## What this prevents
 *
 * A wait is a deadline, a sleep and a condition, and every hand-written copy decides the rest again: how the
 * deadline is read, what the timeout says, whether a thrown probe ends the wait or is swallowed, whether a probe that
 * never answers can outlast the deadline. About thirty loops did, in four dialects, and each defect was found by a
 * red CI run — a bare `timed out after 90000ms` over a rejected trigger, a `before` hook that never ended, a wait
 * that said nothing about what it waited for. The module is the one place those decisions are made; this gate is how
 * a thirty-first copy does not appear.
 *
 * ## The rule, and what counts
 *
 * A loop (`while`, `do`, `for` including `for (;;)`) is a hand-written poll when ALL of
 *
 * - its exit is a deadline read from the clock (`Date.now()`, `performance.now()`) — in its own condition, or in an
 *   `if` / `assert` in its body that leaves the loop;
 * - its body awaits a sleep;
 * - it tests a condition (a probe's answer, or a `try` that succeeds).
 *
 * Such a loop is refused anywhere in a test or helper file outside `wait-for.mjs`, unless the comment block directly
 * above it carries `// waits-differently: <reason>` — a loop that asks a DIFFERENT question (virtual time, a fixed
 * window that must elapse in full, a deliberate busy-spin, a poll that reads the clock for another reason). The
 * reason has to say something: a bare marker is the loop without one.
 *
 * The detection is read out of the syntax tree (`testing/_shared/poll-loops.mjs`), so a loop in a comment or a
 * string is not a loop, and a clock held in a variable (`const now = Date.now()`) is still the clock. It does NOT
 * see a loop bounded by an attempt count or a recursive poll: neither reads a deadline, and this gate answers the
 * question the plan names.
 *
 * ## Why the instrument is exercised before it is trusted
 *
 * A gate whose scan is wrong reports success about nothing. So the truth table below runs the detector over
 * snippets — the shapes that must be found (today's own `waitFor` among them), the shapes that must not, and
 * every spelling of the marker that must and must not exempt — and the tree assertions carry floors: the files
 * scanned, and the module's own loop, which proves the detector sees the shape the module is made of.
 *
 * Run: node --test testing/standalone/a-poll-is-written-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { pollLoops } from '../_shared/poll-loops.mjs';

/** The one file allowed to contain the loop. */
const MODULE = 'testing/_shared/wait-for.mjs';

const src = (...lines) => lines.join('\n');

/**
 * Hand-written polls in `sources`, the module and marked loops left out.
 * @param {Array<{ file: string, text: string }>} sources
 */
function handWrittenPolls(sources) {
  return sources
    .filter(s => s.file !== MODULE)
    .flatMap(s => pollLoops(s.text, s.file))
    .filter(p => p.reason === null);
}

const flagged = (text) => pollLoops(text, 'testing/snippet.test.js');

describe('the detector finds a poll in every spelling it is written in', () => {
  const MUST_BE_FOUND = {
    'today\'s own waitFor, the loop the module replaces': src(
      'export async function waitFor(condition, timeout = 15_000, interval = 500, diagnose) {',
      '  const start = Date.now();',
      '  while (Date.now() - start < timeout) {',
      '    if (await condition()) return true;',
      '    await new Promise(r => setTimeout(r, interval));',
      '  }',
      '  throw new Error(`waitFor timed out after ${timeout}ms`);',
      '}'),
    'a while on a deadline held in a variable': src(
      'async function until(probe, ms) {',
      '  const deadline = Date.now() + ms;',
      '  while (Date.now() < deadline) {',
      '    if (await probe()) return true;',
      '    await sleep(100);',
      '  }',
      '}'),
    'performance.now rather than Date.now': src(
      'async function until(probe, budget) {',
      '  const t0 = performance.now();',
      '  while (performance.now() - t0 < budget) {',
      '    if (await probe()) return true;',
      '    await sleep(25);',
      '  }',
      '}'),
    'a deadline and a probe in the condition itself, the body only sleeps': src(
      'async function until(ready, deadline) {',
      '  while (!(await ready()) && Date.now() < deadline) await sleep(50);',
      '}'),
    'for (;;) whose deadline is an if that throws': src(
      'async function until(probe, deadline) {',
      '  for (;;) {',
      '    if (await probe()) return;',
      '    if (Date.now() > deadline) throw new Error("never");',
      '    await new Promise(r => setTimeout(r, 250));',
      '  }',
      '}'),
    'for (;;) whose deadline is assert.fail': src(
      'async function until(cond, what, ms) {',
      '  const end = Date.now() + ms;',
      '  for (;;) {',
      '    const v = await cond();',
      '    if (v) return v;',
      '    if (Date.now() > end) assert.fail("timed out waiting for " + what);',
      '    await sleep(100);',
      '  }',
      '}'),
    'for (;;) whose deadline is an assertion': src(
      'async function until(hit, deadline) {',
      '  for (;;) {',
      '    if (await hit()) break;',
      '    assert.ok(Date.now() < deadline, "the index never came up");',
      '    await new Promise(r => setTimeout(r, 1000));',
      '  }',
      '}'),
    'do … while on the clock': src(
      'async function until(probe, deadline) {',
      '  let ok = false;',
      '  do {',
      '    ok = await probe();',
      '    if (!ok) await sleep(10);',
      '  } while (!ok && Date.now() < deadline);',
      '}'),
    'a clock read inside the loop and compared through a name': src(
      'async function until(ok, deadline) {',
      '  while (true) {',
      '    const now = Date.now();',
      '    if (now >= deadline) break;',
      '    if (await ok()) return true;',
      '    await sleep(5);',
      '  }',
      '}'),
    'the clock in the for header': src(
      'async function until(probe, budget) {',
      '  for (const t0 = performance.now(); performance.now() - t0 < budget;) {',
      '    if (await probe()) return true;',
      '    await sleep(20);',
      '  }',
      '}'),
    'a sleep helper of the same file under any name': src(
      'const breathe = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
      'async function until(probe, deadline) {',
      '  while (Date.now() < deadline) {',
      '    if (await probe()) return true;',
      '    await breathe(40);',
      '  }',
      '}'),
    'timers/promises, reached as a member': src(
      'import timers from "node:timers/promises";',
      'async function until(probe, deadline) {',
      '  while (Date.now() < deadline) {',
      '    if (await probe()) return true;',
      '    await timers.setTimeout(50);',
      '  }',
      '}'),
    'a sleep that is a method': src(
      'async function until(h, deadline) {',
      '  while (Date.now() < deadline) {',
      '    if (await h.probe()) return true;',
      '    await h.sleep(10);',
      '  }',
      '}'),
    'retry until the probe stops throwing — the server that is restarting': src(
      'async function waitForApi(deadline) {',
      '  while (Date.now() < deadline) {',
      '    try { return await fetchHealth(); } catch { await sleep(200); }',
      '  }',
      '}'),
  };

  for (const [name, text] of Object.entries(MUST_BE_FOUND)) {
    it(name, () => {
      const found = flagged(text);
      assert.equal(found.length, 1, `expected exactly one poll in:\n${text}\n— found ${JSON.stringify(found)}`);
      assert.equal(found[0].reason, null, 'a loop with no marker must not read as exempt');
    });
  }
});

describe('the detector leaves alone what is not a poll', () => {
  const MUST_NOT_BE_FOUND = {
    'a loop bounded by an attempt count, not a deadline (the gate\'s stated edge)': src(
      'async function retry(probe) {',
      '  for (let i = 0; i < 30; i++) {',
      '    if (await probe()) return true;',
      '    await sleep(1000);',
      '  }',
      '}'),
    'a delay until a time — it tests nothing': src(
      'async function pad(end) {',
      '  while (Date.now() < end) await sleep(10);',
      '}'),
    'a deadline and a condition but no sleep — it never yields, it is not a wait': src(
      'function spin(deadline, done) {',
      '  while (Date.now() < deadline) { if (done()) break; }',
      '}'),
    'a sleep and a condition but no clock — a queue drain': src(
      'async function drain(queue) {',
      '  while (queue.length > 0) {',
      '    if (queue[0].ready) queue.shift();',
      '    await sleep(10);',
      '  }',
      '}'),
    'a flag, no clock': src(
      'async function run(state) {',
      '  while (!state.done) { await sleep(10); }',
      '}'),
    'the clock read only to LOG, never to exit': src(
      'async function pump(queue, log) {',
      '  while (queue.length) {',
      '    const t0 = Date.now();',
      '    const r = await work(queue.shift());',
      '    if (r.failed) log(Date.now() - t0);',
      '    await sleep(1);',
      '  }',
      '}'),
    'an attempt-count loop that stamps the clock into a request': src(
      'async function restore(post, u) {',
      '  for (let attempt = 0; attempt < 20; attempt++) {',
      '    const probe = await post(u, { fact: `probe-${Date.now()}` });',
      '    if (probe.status === 201) break;',
      '    await sleep(400);',
      '  }',
      '}'),
    'a for…of — bounded by its list, the clock only a guard': src(
      'async function each(ids, deadline) {',
      '  for (const id of ids) {',
      '    if (Date.now() > deadline) break;',
      '    if (await exists(id)) continue;',
      '    await sleep(5);',
      '  }',
      '}'),
    'a sleep inside a callback is not the loop\'s sleep': src(
      'async function fanOut(items, deadline) {',
      '  while (Date.now() < deadline) {',
      '    if (check()) break;',
      '    items.forEach(async () => { await sleep(1); });',
      '  }',
      '}'),
    'a poll in a comment': src(
      '// while (Date.now() < deadline) { if (await ok()) return; await sleep(10); }',
      '/* for (;;) { if (await ok()) break; if (Date.now() > d) throw 1; await sleep(1); } */',
      'export const x = 1;'),
    'a poll in a string': src(
      'export const advice = "while (Date.now() < deadline) { if (await ok()) return; await sleep(10); }";'),
  };

  for (const [name, text] of Object.entries(MUST_NOT_BE_FOUND)) {
    it(name, () => {
      assert.deepEqual(flagged(text).map(p => p.line), [], `a loop was found in:\n${text}`);
    });
  }
});

describe('the marker exempts a loop only when it says why, directly above it', () => {
  const LOOP = [
    'while (Date.now() < deadline) {',
    '  if (await probe()) return true;',
    '  await sleep(10);',
    '}',
  ];

  const reasonOf = (...lines) => {
    const found = flagged(src(...lines));
    assert.equal(found.length, 1, `expected one poll in:\n${src(...lines)}`);
    return found[0].reason;
  };

  it('a line comment with a reason', () => {
    assert.equal(reasonOf('// waits-differently: tolerates a restarting server', ...LOOP), 'tolerates a restarting server');
  });

  it('a block comment with a reason', () => {
    assert.equal(reasonOf('/* waits-differently: virtual time, the clock is faked */', ...LOOP), 'virtual time, the clock is faked');
  });

  it('a marker that opens a longer comment block, the loop right below it', () => {
    assert.equal(reasonOf(
      '// waits-differently: a fixed window that must elapse in full',
      '// (a negative wait: nothing may arrive during it)',
      ...LOOP), 'a fixed window that must elapse in full');
  });

  it('a marker with no reason does not exempt', () => {
    assert.equal(reasonOf('// waits-differently:', ...LOOP), null);
    assert.equal(reasonOf('// waits-differently:    ', ...LOOP), null);
  });

  it('a one-word reason does not exempt — it says nothing', () => {
    assert.equal(reasonOf('// waits-differently: tolerates', ...LOOP), null);
  });

  it('a marker that is not directly above the loop does not exempt it', () => {
    assert.equal(reasonOf('// waits-differently: tolerates a restarting server', '', ...LOOP), null);
    assert.equal(reasonOf('// waits-differently: tolerates a restarting server', 'const x = 1;', ...LOOP), null);
  });

  it('a marker belongs to the ONE loop below it, not to the next', () => {
    const found = flagged(src(
      '// waits-differently: tolerates a restarting server',
      ...LOOP,
      ...LOOP));
    assert.equal(found.length, 2);
    assert.equal(found[0].reason, 'tolerates a restarting server');
    assert.equal(found[1].reason, null, 'the second loop inherited the first one\'s marker');
  });

  it('the word in a string is not a marker', () => {
    assert.equal(reasonOf('const note = "// waits-differently: tolerates a restarting server";', ...LOOP), null);
  });

  it('the plain "waits-differently" without a colon is not a marker', () => {
    assert.equal(reasonOf('// waits-differently tolerates a restarting server', ...LOOP), null);
  });
});

describe('the gate reads files, and exempts exactly the module', () => {
  const LOOP_TEXT = src(
    'async function until(probe, deadline) {',
    '  while (Date.now() < deadline) {',
    '    if (await probe()) return true;',
    '    await sleep(10);',
    '  }',
    '}');

  it('refuses the loop anywhere but the module, naming file and line', () => {
    const found = handWrittenPolls([{ file: 'testing/integration/x.test.js', text: LOOP_TEXT }]);
    assert.equal(found.length, 1);
    assert.equal(found[0].file, 'testing/integration/x.test.js');
    assert.equal(found[0].line, 2);
  });

  it('exempts the module by its path, and only by its path', () => {
    assert.deepEqual(handWrittenPolls([{ file: MODULE, text: LOOP_TEXT }]), []);
    assert.equal(handWrittenPolls([{ file: 'testing/sync/wait-for.mjs', text: LOOP_TEXT }]).length, 1,
      'a file merely NAMED like the module is not the module');
    assert.equal(handWrittenPolls([{ file: 'testing/_shared/wait-for.test.js', text: LOOP_TEXT }]).length, 1);
  });

  it('lets a marked loop through and still refuses its unmarked neighbour in the same file', () => {
    const text = src('// waits-differently: tolerates a restarting server', LOOP_TEXT, LOOP_TEXT);
    // The marker is above the FUNCTION, not the loop, in both — so neither is exempt. The marker has to sit on the loop.
    assert.equal(handWrittenPolls([{ file: 'testing/a.test.js', text }]).length, 2);
    const onLoop = src(
      'async function a(probe, deadline) {',
      '  // waits-differently: tolerates a restarting server',
      '  while (Date.now() < deadline) { if (await probe()) return; await sleep(1); }',
      '}',
      'async function b(probe, deadline) {',
      '  while (Date.now() < deadline) { if (await probe()) return; await sleep(1); }',
      '}');
    const found = handWrittenPolls([{ file: 'testing/a.test.js', text: onLoop }]);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 6);
  });
});

describe('every tracked test and helper file', () => {
  const testing = trackedSources(['testing'], { ext: ['.js', '.mjs'], floor: 500 })
    .map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));
  const clientSpecs = trackedSources(['client/src'], { ext: ['.spec.ts'], floor: 100 })
    .map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));
  const all = [...testing, ...clientSpecs];

  it('the scan reads the test and helper files of every suite, and the client specs', () => {
    const suites = new Set(testing.map(s => s.file.split('/')[1]));
    for (const suite of ['standalone', 'integration', 'sync', 'red-team-tests', '_shared']) {
      assert.ok(suites.has(suite), `the scan found nothing under testing/${suite}/ — the listing is broken, not the code`);
    }
    assert.ok(clientSpecs.length > 0);
  });

  it('the module exists, and the detector recognises the loop it is made of', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)), `${MODULE} does not exist — there is no one wait to send a poll to`);
    const own = pollLoops(readFileSync(join(REPO_ROOT, MODULE), 'utf8'), MODULE);
    assert.ok(own.length >= 1,
      'the detector found no poll loop inside the module: either the module does not poll with a deadline and a sleep, '
      + 'or the instrument cannot see the shape every other file is judged by');
  });

  it('none polls by hand outside the module, unless it says why it waits differently', () => {
    const offenders = handWrittenPolls(all).map(p => `${p.file}:${p.line}  ${p.text}`);
    assert.deepEqual(offenders, [],
      'a hand-written poll: a loop whose exit is a deadline read from the clock, that awaits a sleep and tests a '
      + 'condition. Use waitFor from testing/_shared/wait-for.mjs — it names what never held, ends a probe that never '
      + 'answers, and records how long it waited. If this loop asks a different question (virtual time, a window that '
      + 'must elapse in full, a deliberate busy-spin), say so in the comment directly above it: '
      + '`// waits-differently: <reason>`.');
  });
});
