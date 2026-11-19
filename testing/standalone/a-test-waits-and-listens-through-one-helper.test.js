/**
 * A test waits a fixed time through ONE helper (`elapse`), naming which kind of delay it is, and starts a loopback server
 * through ONE helper (`listenOnLoopback`), or it says why it does neither (`Q-375`, `Q-401`).
 *
 * ## What this prevents
 *
 * A fixed delay is spelled `await new Promise(r => setTimeout(r, ms))` about ninety times in the test tree, in
 * four dialects, and each local `const sleep = ...` is a place the delay can quietly change meaning. A hand-bound
 * test server (`server.listen(0, '127.0.0.1', r)`) is the same shape: the helper that ends a server without
 * waiting for a client that never leaves (`local-server.mjs`) is written once and forgotten about by whoever writes
 * the next fixture; `0.0.0.0` and a host variable are the spelling of "a CI runner is a shared host" being forgotten.
 * `a-shared-test-fixture-has-one-definition` could only hold this for helper modules, by regex; this gate reads
 * every tracked `.js`/`.mjs` under `testing/` and `scripts/` out of the syntax tree.
 *
 * ## The rule, and what counts (the classifier is `testing/_shared/timer-sites.mjs`)
 *
 * A FIXED DELAY is the promise of a timer that does nothing but resolve, with nobody to cancel it:
 *
 * - `await new Promise(r => setTimeout(r, ms))`, arrow or function executor, expression or block body, anywhere:
 *   inside a test callback, inside a loop bounded by an attempt count;
 * - `await setTimeout(ms)` from `node:timers/promises`, under any import spelling (named, renamed, member, namespace);
 * - a local helper that IS that promise and nothing else (`const sleep = ms => new Promise(...)`), found at its
 *   definition and named for nothing: it is judged by its body, so `const tick = () => new Date()` and
 *   `let delay = 250` are not sleeps.
 *
 * NOT a fixed delay, because each is another question: a `Promise.race` timeout, a timer held in a variable to be
 * cleared (`timer = setTimeout(...)`), `setTimeout` handed over as an argument, a fire-and-forget `setTimeout(fn, ms)`,
 * a `setTimeout(...).unref()` guard, a socket's own `.setTimeout`, a `setImmediate` yield. DECIDED, and stated here
 * because the plan left it open: a promise RETURNED from a helper that does other things too
 * (`async function backoff() { log(); return new Promise(r => setTimeout(r, 50)); }`) is that helper's backoff, not
 * a stand-alone delay, and an executor that does anything besides arm the timer is waiting for that other thing too.
 *
 * A LOOPBACK SERVER SITE is any `.listen(...)` call: no host, a host that is a name or a variable, `localhost`,
 * `::1`, `0.0.0.0`, a private address, `listen({ port, host })` — and the hand-bound `127.0.0.1` test server. Each
 * needs `listenOnLoopback(http.createServer(app))` or `// own-listener: <reason>`.
 *
 * ## Every delay names its kind (`Q-401`)
 *
 * A delay that is followed by reading a result has guessed how long the thing takes. So the shared delay is
 * `elapse(ms, '<kind>: <detail>')`, the kind one of `sleep.mjs`' DELAY_KINDS, and `delayCalls` judges EVERY call of it —
 * awaited or not, in a `Promise.race`, a `.then`, a wrapper, under any import name — by its literal reason, read the way
 * `elapse` reads it at run time. The module is reached by its named exports only. Any other sleep (a browser page's
 * `waitForTimeout`, a helper named like a sleep) carries the marker. Rows below: explained and refused, every spelling
 * the design challenges named; and an independent plain-text count of the calls, with a floor, so the tree rule cannot
 * be blind to a spelling and still pass.
 *
 * ## The markers
 *
 * `// waits-differently: <reason>` (a delay) and `// own-listener: <reason>` (a listener) in the comment block
 * directly above the statement. A reason of two words or more: a bare marker or a one-word one is the site without
 * one. DECIDED: a delay marker above a loop (`for`, `while`, `do`) covers the delays inside that loop's own code, so
 * the `// waits-differently:` that already exempts a hand-written poll keeps exempting its sleep; a marker above a
 * FUNCTION covers nothing inside it. A listener inside a `new Promise(...)` executor is exempt by a marker above
 * the statement holding the `new Promise`, as well as above its own statement.
 *
 * ## A race timer is cleared, `unref()`ed or kept out of the source
 *
 * A `Promise.race` timeout is no fixed delay (above), but it has a cost of its own: the timer that LOSES the race is still
 * armed, so the process stays alive for its whole length after the last test has ended. A test that races its answer against
 * `new Promise(r => setTimeout(() => r('hung'), 20_000))` ends its case at once and the file's row in CI is the timer's
 * length longer than its tests (bundle-348 found five such files from the timing records). `uncancelledRaceTimers` finds every global `setTimeout` inside a `Promise.race`
 * (or inside the local promise it names) that is not `unref()`ed and whose handle is not passed to `clearTimeout` in the
 * function around the race. The fix is `settleWithin` from `standalone/_write-faults.mjs` (bounded, clears its own timer), or
 * the handle kept and cleared in a `finally`. The shared `elapse` and `node:timers/promises`' `setTimeout` hold the same timer
 * with no handle to clear (a `timers/promises` one is cancellable only through a `signal` option or `ref: false`), so a race
 * against either is a finding too, and the wait to write instead is `raceDeadline(work, ms, 'race timeout: <detail>', onLate)`
 * from `sleep.mjs`, which clears its timer when `work` settles: its own cases are the `raceDeadline` describe below (the timer
 * is gone after either side settles, the reason is refused before a timer is armed, `elapse` is unchanged). Rows below plant
 * each spelling; an independent count of `Promise.race` calls sets the tree reader against a plain reading of the text.
 *
 * ## Why the instrument is exercised before it is trusted
 *
 * A gate whose scan is wrong reports success about nothing. So the truth table below runs the classifier over
 * snippets (found, and NOT found), and a permanent instrument row has it find the timer in `sleep.mjs`, the poll
 * interval in `wait-for.mjs` and the bind in `local-server.mjs`: a classifier that cannot see the homes cannot be
 * trusted about the rest. The tree rule derives its subject (`readTrackedSources`, with a floor) and names its homes.
 *
 * ## The subject, and what is out of it
 *
 * Every tracked `.js` and `.mjs` under `testing/` and `scripts/`. NOT `benchmarks/`: it is product-facing, with no
 * dependency on the test tree, so a helper from `testing/_shared` is not its to import. NOT the client's `*.spec.ts`:
 * vitest's own, run with its fake timers and its own conventions. Both are named in `testing/testing-guide`'s
 * "Waiting" table.
 *
 * ## One definition of "a sleep"
 *
 * `poll-loops.mjs` (the poll gate) decided what a sleep is by its own name list and its own body rule; this gate
 * decides it again. They are ONE reader: the poll gate imports the sleep definition, and the marker reader, from the
 * classifier module. The last describe holds that by behaviour (the same snippets, the same answer) and by source.
 *
 * Run: node --test testing/standalone/a-test-waits-and-listens-through-one-helper.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { fixedDelays, listenerSites, awaitedSleeps, delayCalls, uncancelledRaceTimers, promiseRaceCount } from '../_shared/timer-sites.mjs';
import { elapse, raceDeadline, DELAY_KINDS } from '../_shared/sleep.mjs';
import { pollLoops } from '../_shared/poll-loops.mjs';

const src = (...lines) => lines.join('\n');
const delays = (text) => fixedDelays(text, 'testing/snippet.test.js');
const listeners = (text) => listenerSites(text, 'testing/snippet.test.js');

/** The one file each question is allowed to spell. A home is asserted by name (below), so it cannot go stale silently. */
const DELAY_HOMES = ['testing/_shared/sleep.mjs', 'testing/_shared/wait-for.mjs'];
const LISTENER_HOMES = ['testing/_shared/local-server.mjs'];

/** This file: it calls `elapse` with refused reasons on purpose, to see `elapse` refuse them. Named, so nothing else is. */
const ELAPSE_REFUSAL_TESTS = ['testing/standalone/a-test-waits-and-listens-through-one-helper.test.js'];

/** This file spells `Promise.race(` inside planted snippets (strings), which a plain reading counts and the tree does not. */
const RACE_SNIPPET_TESTS = ['testing/standalone/a-test-waits-and-listens-through-one-helper.test.js'];

describe('the classifier finds a fixed delay in every spelling it is written in', () => {
  const MUST_BE_FOUND = [
    { name: 'an awaited promise over setTimeout, arrow executor',
      text: src('async function settle() {', '  await new Promise(r => setTimeout(r, 250));', '}'), line: 2 },
    { name: 'the same with a parenthesised parameter and a numeric separator',
      text: src('async function settle() {', '  await new Promise((resolve) => setTimeout(resolve, 5_000));', '}'), line: 2 },
    { name: 'a block-bodied arrow executor',
      text: src('async function settle() {', '  await new Promise((resolve) => { setTimeout(resolve, 50); });', '}'), line: 2 },
    { name: 'a function-expression executor',
      text: src('async function settle() {', '  await new Promise(function (done) { setTimeout(done, 50); });', '}'), line: 2 },
    { name: 'a computed duration',
      text: src('async function settle(attempt) {', '  await new Promise(r => setTimeout(r, 250 * attempt));', '}'), line: 2 },
    { name: 'a parenthesised await operand',
      text: src('async function settle() {', '  await (new Promise(r => setTimeout(r, 40)));', '}'), line: 2 },
    { name: 'inside a test callback',
      text: src(
        "it('indexes the record', async () => {",
        '  const id = await save();',
        '  await new Promise(r => setTimeout(r, 300));',
        '  assert.ok(await read(id));',
        '});'), line: 3 },
    { name: 'inside an attempt-count loop',
      text: src(
        'async function retry(probe) {',
        '  for (let i = 0; i < 30; i++) {',
        '    if (await probe()) return true;',
        '    await new Promise(r => setTimeout(r, 100));',
        '  }',
        '}'), line: 4 },
    { name: 'inside a while loop bounded by a flag',
      text: src(
        'async function run(state) {',
        '  while (!state.done) {',
        '    await new Promise(res => setTimeout(res, 10));',
        '  }',
        '}'), line: 3 },
    { name: 'timers/promises, named import',
      text: src("import { setTimeout } from 'node:timers/promises';", 'async function settle() {', '  await setTimeout(50);', '}'), line: 3 },
    { name: 'timers/promises without the node: prefix',
      text: src("import { setTimeout } from 'timers/promises';", 'async function settle() {', '  await setTimeout(50);', '}'), line: 3 },
    { name: 'timers/promises, renamed to something that is no sleep name',
      text: src("import { setTimeout as hold } from 'node:timers/promises';", 'async function settle() {', '  await hold(50);', '}'), line: 3 },
    { name: 'timers/promises, renamed to `sleep` — the name is not what makes it the shared one',
      text: src("import { setTimeout as sleep } from 'node:timers/promises';", 'async function settle() {', '  await sleep(50);', '}'), line: 3 },
    { name: 'timers/promises, default import reached as a member',
      text: src("import timers from 'node:timers/promises';", 'async function settle() {', '  await timers.setTimeout(50);', '}'), line: 3 },
    { name: 'timers/promises, namespace import',
      text: src("import * as timers from 'node:timers/promises';", 'async function settle() {', '  await timers.setTimeout(50);', '}'), line: 3 },
    { name: 'a local sleep, arrow with an expression body: found at its DEFINITION, its callers are not found again',
      text: src(
        'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
        'async function a() { await sleep(10); }',
        'async function b() { await sleep(20); }'), line: 1 },
    { name: 'a local sleep under a name no list contains',
      text: src('const breathe = (ms) => new Promise(r => setTimeout(r, ms));', 'async function a() { await breathe(40); }'), line: 1 },
    { name: 'a local sleep that takes no argument (`tick` defined by its BODY)',
      text: src('const tick = () => new Promise(res => setTimeout(res, 5));', 'async function a() { await tick(); }'), line: 1 },
    { name: 'a local sleep as a function declaration returning the promise',
      text: src('function delay(ms) {', '  return new Promise(r => setTimeout(r, ms));', '}'), line: 2 },
    { name: 'a local sleep as an async function that awaits it — ONE site, not the definition and the await',
      text: src('async function nap(ms) {', '  await new Promise(r => setTimeout(r, ms));', '}'), line: 2 },
    { name: 'a local sleep as a function expression',
      text: src('const pause = function (ms) { return new Promise(r => setTimeout(r, ms)); };'), line: 1 },
    { name: 'a method of an object literal that is a sleep',
      text: src('const clock = {', '  sleep(ms) { return new Promise(r => setTimeout(r, ms)); },', '};'), line: 2 },
  ];

  for (const row of MUST_BE_FOUND) {
    it(row.name, () => {
      const found = delays(row.text);
      assert.equal(found.length, 1, `expected exactly one fixed delay in:\n${row.text}\n— found ${JSON.stringify(found)}`);
      assert.equal(found[0].line, row.line, `the finding names line ${found[0].line}, the delay is on line ${row.line}`);
      assert.equal(found[0].reason, null, 'a delay with no marker must not read as exempt');
      assert.equal(found[0].file, 'testing/snippet.test.js');
    });
  }

  it('two delays in one file are two findings, in line order', () => {
    const found = delays(src(
      'async function a() {',
      '  await new Promise(r => setTimeout(r, 1));',
      '  await new Promise(r => setTimeout(r, 2));',
      '}'));
    assert.deepEqual(found.map(f => f.line), [2, 3]);
  });
});

describe('the classifier leaves alone what is not a stand-alone fixed delay', () => {
  const MUST_NOT_BE_FOUND = {
    'the shared sleep, imported by its home path': src(
      "import { sleep } from '../_shared/sleep.mjs';", 'async function a() { await sleep(250); }'),
    'a sleep imported from some other module — that module is judged by itself': src(
      "import { sleep } from './_helpers.mjs';", 'async function a() { await sleep(250); }'),
    'a local `tick` that reads the clock, not a timer': src(
      'const tick = () => new Date(Date.now());', 'const at = tick();'),
    'a local `delay` that is a number': src(
      'let delay = 250;', 'delay = delay * 2;', 'await probe(delay);'),
    'a local `delay` function whose body arms no timer': src(
      'const delay = () => computeBackoff();', 'const ms = delay();'),
    'a local `wait` function whose body arms no timer': src(
      'function wait() { return queue.length; }', 'const n = wait();'),
    'a Promise.race timeout that rejects': src(
      'async function a() {',
      "  await Promise.race([work(), new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 5000))]);",
      '}'),
    'a Promise.race timeout that resolves a verdict': src(
      'async function a() {',
      "  const r = await Promise.race([work(), new Promise(res => setTimeout(() => res('timeout'), 5_000))]);",
      '}'),
    'a timer held in a variable to be cleared, in a race': src(
      'async function a(asked, ms) {',
      '  let timer;',
      '  const answer = await Promise.race([asked, new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE), ms); })]);',
      '  clearTimeout(timer);',
      '}'),
    'a timer held in a variable, awaited alone': src(
      'async function a(ms) {',
      '  let timer;',
      '  await new Promise((resolve) => { timer = setTimeout(resolve, ms); });',
      '}'),
    'a timer held in a constant': src(
      'const t = setTimeout(() => finish(), 100);', 'clearTimeout(t);'),
    'setTimeout handed over as an argument': src(
      'schedule(setTimeout, 50);', 'const make = makeWaiter(setTimeout);'),
    'setTimeout in an object literal, as a scheduler hook': src(
      'const scheduler = { setTimeout: setTimer, clearTimeout: clearTimer };'),
    'a fire-and-forget setTimeout with a callback': src(
      'setTimeout(() => { finished = true; res.end("done"); }, 300);'),
    'an unref()ed guard timer that rejects, in a race': src(
      'const within = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("late")), ms).unref())]);'),
    'an unref()ed timer awaited alone': src(
      'async function a() { await new Promise(r => setTimeout(r, 50).unref()); }'),
    'a socket timeout, not a delay': src(
      'const sock = net.connect(port);', 'sock.setTimeout(1500);', 'req.setTimeout(500, () => req.destroy());'),
    'a yield to the event loop, not a delay': src(
      'async function a() { await new Promise((r) => setImmediate(r)); await new Promise(r => process.nextTick(r)); }'),
    'a promise RETURNED from a helper that does other things too — its backoff, DECIDED not a stand-alone delay': src(
      'async function fetchWithBackoff(url, attempt) {',
      '  const res = await fetch(url);',
      '  if (res.ok) return res;',
      '  return new Promise(r => setTimeout(r, 100 * attempt));',
      '}'),
    'an executor that does something besides arm the timer — it also waits for that': src(
      'async function a(sock) {',
      '  await new Promise((r) => { sock.end(); setTimeout(r, 50); });',
      '}'),
    'a delay promise that is never awaited or returned': src(
      'const gate = new Promise(r => setTimeout(r, 100));'),
    'a delay inside a string': src(
      "export const advice = 'await new Promise(r => setTimeout(r, 250))';"),
    'a delay inside a template literal': src(
      'export const advice = `await new Promise(r => setTimeout(r, 250)); await setTimeout(50);`;'),
    'a delay in a line comment': src(
      '// await new Promise(r => setTimeout(r, 250));', 'export const x = 1;'),
    'a delay in a block comment': src(
      '/* await new Promise(r => setTimeout(r, 250)); */', 'export const x = 1;'),
  };

  for (const [name, text] of Object.entries(MUST_NOT_BE_FOUND)) {
    it(name, () => {
      assert.deepEqual(delays(text).map(f => f.line), [], `a fixed delay was found in:\n${text}`);
    });
  }
});

describe('the classifier finds a race timer that is left running, in every spelling it is written in', () => {
  const races = (text) => uncancelledRaceTimers(text, 'testing/snippet.test.js');

  const MUST_BE_FOUND = [
    { name: 'a timer that resolves a verdict, inline in the race',
      text: src('async function a(work) {', "  const r = await Promise.race([work(), new Promise(res => setTimeout(() => res('hung'), 20_000))]);", '}'), line: 2 },
    { name: 'a timer that rejects, inline in the race',
      text: src('async function a(work) {',
        "  await Promise.race([work(), new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 5000))]);", '}'), line: 2 },
    { name: 'a timer in a race helper that is written once and called often',
      text: src('const within = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what)), 5000))]);'), line: 1 },
    { name: 'a timer in a local promise that the race names',
      text: src('async function a(work) {', '  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 2000));',
        '  await Promise.race([work(), timeout]);', '}'), line: 2 },
    { name: 'a timer whose handle is kept and never cleared',
      text: src('async function a(work) {', '  let timer;',
        '  await Promise.race([work(), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); })]);', '}'), line: 3 },
    { name: 'a handle cleared by a different function than the one that races',
      text: src('function stop(timer) { clearTimeout(timer); }', 'async function a(work) {', '  let timer;',
        '  await Promise.race([work(), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); })]);', '}'), line: 4 },
    { name: 'the global timer reached as globalThis.setTimeout',
      text: src('async function a(work) {', '  await Promise.race([work(), new Promise(r => globalThis.setTimeout(r, 3000))]);', '}'), line: 2 },
    { name: 'a timer whose unref() is on another timer',
      text: src('async function a(work) {', '  setTimeout(() => {}, 1).unref();',
        "  await Promise.race([work(), new Promise(res => setTimeout(() => res('hung'), 9000))]);", '}'), line: 3 },
    { name: 'the shared elapse as the losing side of a race, its verdict thrown from a then',
      text: src("import { elapse } from '../_shared/sleep.mjs';", 'async function a(p) {',
        "  await Promise.race([p, elapse(10_000, 'race timeout: the event never came').then(() => { throw new Error('x'); })]);", '}'), line: 3 },
    { name: 'the shared elapse as the losing side of a race, its verdict a value, over several lines',
      text: src("import { elapse } from '../_shared/sleep.mjs';", 'async function a(p) {', '  const v = await Promise.race([',
        '    p,', "    elapse(20_000, 'race timeout: the wait is reported as still waiting').then(() => 'still waiting'),", '  ]);', '}'), line: 5 },
    { name: 'the shared elapse under another import name',
      text: src("import { elapse as hold } from '../_shared/sleep.mjs';", 'async function a(p) {',
        "  await Promise.race([p, hold(5, 'race timeout: a b').then(() => false)]);", '}'), line: 3 },
    { name: 'the shared elapse held in a local promise the race names',
      text: src("import { elapse } from '../_shared/sleep.mjs';", 'async function a(p) {', "  const late = elapse(5, 'race timeout: a b');",
        '  await Promise.race([p, late]);', '}'), line: 3 },
    { name: 'a timer made by a same-file arrow helper called inside the race',
      text: src("const late = (ms) => new Promise(r => setTimeout(() => r('hung'), ms));", 'async function a(work) {',
        '  await Promise.race([work(), late(20_000)]);', '}'), line: 1 },
    { name: 'a timer made by a same-file function declaration called inside the race',
      text: src('function late(ms) {', "  return new Promise((_, rej) => setTimeout(() => rej(new Error('late')), ms));", '}', 'async function a(work) {',
        '  await Promise.race([work(), late(20_000)]);', '}'), line: 2 },
    { name: 'a helper called inside the race through a then',
      text: src('const late = (ms) => new Promise(r => setTimeout(r, ms));', 'async function a(work) {',
        "  await Promise.race([work(), late(5).then(() => 'hung')]);", '}'), line: 1 },
    { name: 'a helper that calls another helper that holds the timer',
      text: src('const tick = (ms) => new Promise(r => setTimeout(r, ms));', 'const late = (ms) => tick(ms);', 'async function a(work) {',
        '  await Promise.race([work(), late(5)]);', '}'), line: 1 },
    { name: 'a helper that calls itself, its timer found once and the walk ending',
      text: src('const late = (ms, n) => (n > 0 ? late(ms, n - 1) : new Promise(r => setTimeout(r, ms)));', 'async function a(work) {',
        '  await Promise.race([work(), late(5, 3)]);', '}'), line: 1 },
    { name: 'a helper called in a local promise the race names',
      text: src('const late = (ms) => new Promise(r => setTimeout(r, ms));', 'async function a(work) {', '  const hung = late(5);',
        '  await Promise.race([work(), hung]);', '}'), line: 1 },
    { name: 'a timers/promises timer in a race, named import',
      text: src("import { setTimeout } from 'node:timers/promises';", 'async function a(p) { await Promise.race([p, setTimeout(50)]); }'), line: 2 },
    { name: 'a timers/promises timer in a race, member of a namespace, with options that cancel nothing',
      text: src("import * as timers from 'node:timers/promises';", 'async function a(p) { await Promise.race([p, timers.setTimeout(50, null, {})]); }'), line: 2 },
    { name: 'a timer in the loop body of a read with a deadline',
      text: src('async function a(reader, deadline) {', '  for (;;) {',
        '    const next = await Promise.race([reader.read(), new Promise(res => setTimeout(() => res(null), Math.max(1, deadline - Date.now())))]);',
        '    if (!next) break;', '  }', '}'), line: 3 },
  ];
  for (const row of MUST_BE_FOUND) {
    it(row.name, () => {
      const found = races(row.text);
      assert.deepEqual(found.map(f => f.line), [row.line], `expected exactly one race timer, on line ${row.line}, in:\n${row.text}`);
      assert.equal(found[0].file, 'testing/snippet.test.js');
    });
  }

  const MUST_NOT_BE_FOUND = {
    'a timer that is unref()ed': src(
      'const within = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("late")), ms).unref())]);'),
    'a handle cleared in a finally': src(
      'async function a(work, ms) {', '  let timer;',
      '  try { return await Promise.race([work(), new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]); } finally { clearTimeout(timer); }', '}'),
    'a handle cleared once the race settles': src(
      'function within(promise, ms) {', '  let timer;',
      '  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("late")), ms); });',
      '  return Promise.race([promise, late]).finally(() => clearTimeout(timer));', '}'),
    'a local promise whose handle the function clears': src(
      'async function a(work) {', '  let timer;', '  const hung = new Promise(resolve => { timer = setTimeout(() => resolve("HUNG"), 500); });',
      '  try { return await Promise.race([work(), hung]); } finally { clearTimeout(timer); }', '}'),
    'a clear through a member (a scheduler)': src(
      'async function a(work, clock) {', '  let timer;',
      '  try { await Promise.race([work(), new Promise(r => { timer = setTimeout(r, 5); })]); } finally { clock.clearTimeout(timer); }', '}'),
    'a bounded look through settleWithin, with no timer written': src(
      "import { settleWithin } from './_write-faults.mjs';", 'async function a(run) { const r = await settleWithin(run, 20_000); return r.settled; }'),
    'a same-file helper whose timer is unref()ed': src(
      'const late = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), ms).unref());',
      'async function a(work) { await Promise.race([work(), late(5)]); }'),
    'a same-file helper that clears its own timer': src(
      'function late(work, ms) {', '  let timer;', '  const cut = new Promise(r => { timer = setTimeout(r, ms); });',
      '  return Promise.race([work, cut]).finally(() => clearTimeout(timer));', '}',
      'async function a(x, y) { await Promise.race([x(), late(y, 5)]); }'),
    'a same-file helper with a timer, called outside any race': src(
      'const late = (ms) => new Promise(r => setTimeout(r, ms));', 'async function a(work) { await work(); await late(5); }'),
    'a same-file helper with no timer, called inside a race': src(
      'const quick = (x) => Promise.resolve(x);', 'async function a(work) { await Promise.race([work(), quick(1)]); }'),
    'a call of a function that is not in this file': src(
      "import { late } from './_helpers.mjs';", 'async function a(work) { await Promise.race([work(), late(5)]); }'),
    'a race with no timer in it': src('async function a(x, y) { return Promise.race([x(), y()]); }'),
    'a timer outside any race': src('const t = setTimeout(() => finish(), 100);', 'clearTimeout(t);', 'setTimeout(() => done(), 5);'),
    'a race with the shared raceDeadline, which clears its own timer': src(
      "import { raceDeadline } from '../_shared/sleep.mjs';",
      "async function a(p) { return raceDeadline(p, 10, 'race timeout: the event never came', () => { throw new Error('x'); }); }"),
    'the shared elapse awaited alone, outside any race': src(
      "import { elapse } from '../_shared/sleep.mjs';", "async function a() { await elapse(10, 'pacing: one probe per tick'); }"),
    'a timers/promises timer given a signal that cancels it': src(
      "import { setTimeout as later } from 'node:timers/promises';",
      'async function a(p, signal) { await Promise.race([p, later(10, null, { signal })]); }'),
    'a timers/promises timer that is not ref()ed': src(
      "import { setTimeout as later } from 'node:timers/promises';",
      'async function a(p) { await Promise.race([p, later(10, null, { ref: false })]); }'),
    'a timer in a string, a template and a comment': src(
      "const a = 'await Promise.race([x, new Promise(r => setTimeout(r, 5))])';", 'const b = `Promise.race([x, setTimeout(r, 5)])`;',
      '// await Promise.race([x, new Promise(r => setTimeout(r, 5))]);'),
  };
  for (const [name, text] of Object.entries(MUST_NOT_BE_FOUND)) {
    it(name, () => {
      assert.deepEqual(races(text).map(f => f.line), [], `a race timer was found in:\n${text}`);
    });
  }

  it('two timers in two races are two findings, in line order', () => {
    const found = races(src(
      'async function a(x) {',
      '  await Promise.race([x(), new Promise(r => setTimeout(r, 1))]);',
      '  await Promise.race([x(), new Promise(r => setTimeout(r, 2))]);',
      '}'));
    assert.deepEqual(found.map(f => f.line), [2, 3]);
  });

  it('a race of a timer already named by another race is one finding, not two', () => {
    const found = races(src(
      'async function a(x) {', '  const late = new Promise(r => setTimeout(r, 1));',
      '  await Promise.race([x(), late]);', '  await Promise.race([x(), late]);', '}'));
    assert.deepEqual(found.map(f => f.line), [2]);
  });
});

describe('the classifier finds a loopback server site in every spelling it is written in', () => {
  const MUST_BE_FOUND = [
    { name: 'a listen with no host', text: src('const server = http.createServer(app);', 'server.listen(3000);'), line: 2 },
    { name: 'a listen with a port and only a callback — no host, so every interface',
      text: src('app.listen(0, () => console.log("up"));'), line: 1 },
    { name: 'every interface, spelled out', text: src("await new Promise(r => server.listen(0, '0.0.0.0', r));"), line: 1 },
    { name: 'a host that is a variable', text: src('await new Promise(resolve => server.listen(0, host, resolve));'), line: 1 },
    { name: 'a host that is a constant defined elsewhere',
      text: src("const MOCK_IDP_HOST = '127.0.0.1';", 'await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => resolve()));'), line: 2 },
    { name: 'localhost, which may resolve to ::1 and not the address the client dials',
      text: src("server.listen(0, 'localhost', r);"), line: 1 },
    { name: 'the IPv6 loopback', text: src("server.listen(0, '::1', r);"), line: 1 },
    { name: 'a private LAN address', text: src("server.listen(0, '192.168.1.5', r);"), line: 1 },
    { name: 'the options-object form with a host', text: src("server.listen({ port: 0, host: '127.0.0.1' }, r);"), line: 1 },
    { name: 'the options-object form with no host', text: src('server.listen({ port: 0 }, r);'), line: 1 },
    { name: 'a hand-bound loopback test server, promise-wrapped',
      text: src("await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));"), line: 1 },
    { name: 'a hand-bound loopback test server, assigned from the app factory',
      text: src("server = createApp().listen(0, '127.0.0.1');"), line: 1 },
    { name: 'a hand-bound loopback test server that reports its url',
      text: src("server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));"), line: 1 },
    { name: 'a block-bodied executor',
      text: src('const peer = await new Promise(r => {', '  const s = app.listen(0, host, () => r(s));', '});'), line: 2 },
  ];

  for (const row of MUST_BE_FOUND) {
    it(row.name, () => {
      const found = listeners(row.text);
      assert.equal(found.length, 1, `expected exactly one listener site in:\n${row.text}\n— found ${JSON.stringify(found)}`);
      assert.equal(found[0].line, row.line);
      assert.equal(found[0].reason, null, 'a listener with no marker must not read as exempt');
      assert.equal(found[0].file, 'testing/snippet.test.js');
    });
  }

  it('two listeners in one file are two findings', () => {
    assert.deepEqual(listeners(src("a.listen(0, '127.0.0.1');", "b.listen(0, '127.0.0.1');")).map(f => f.line), [1, 2]);
  });
});

describe('the classifier leaves alone what is not a hand-bound server', () => {
  const MUST_NOT_BE_FOUND = {
    'the helper': src(
      "import { listenOnLoopback } from '../_shared/local-server.mjs';",
      'const local = await listenOnLoopback(http.createServer(app));'),
    'the helper with a plain TCP server': src(
      'const local = await listenOnLoopback(net.createServer((socket) => socket.end("pong")));'),
    'a local function named listen, called bare': src(
      'const listen = (server) => listenOnLoopback(server);', 'const port = await listen(server);'),
    'an event name and a counter': src(
      "server.on('listening', () => ready());", "const n = emitter.listenerCount('x');", 'if (server.listening) stop();'),
    'a listen call in a string': src("export const advice = \"server.listen(0, '127.0.0.1', r)\";"),
    'a listen call in a template literal': src('export const advice = `app.listen(0, "0.0.0.0")`;'),
    'a searched-for listen in a string (a gate reading source)': src("const at = source.indexOf('.listen(');"),
    'a listen call in a line comment': src("// server.listen(0, '127.0.0.1', r);", 'export const x = 1;'),
    'a listen call in a block comment': src("/* server.listen(0, '0.0.0.0', r); */", 'export const x = 1;'),
  };

  for (const [name, text] of Object.entries(MUST_NOT_BE_FOUND)) {
    it(name, () => {
      assert.deepEqual(listeners(text).map(f => f.line), [], `a listener site was found in:\n${text}`);
    });
  }
});

describe('a marker exempts a site only when it says why, directly above it', () => {
  /*
   * Every spelling of the marker, run against BOTH questions and BOTH gates that read it (the delay classifier and the
   * poll gate), because "one shared reader" is a claim about all of them agreeing.
   */
  const DELAY = ['await new Promise(r => setTimeout(r, 300));'];
  const LISTEN = ["await new Promise(r => server.listen(0, '127.0.0.1', r));"];
  const POLL = [
    'while (Date.now() < deadline) {',
    '  if (await probe()) return true;',
    '  await sleep(10);',
    '}',
  ];

  const SUBJECTS = [
    { what: 'a delay', marker: 'waits-differently', lines: DELAY, read: (t) => delays(t) },
    { what: 'a listener', marker: 'own-listener', lines: LISTEN, read: (t) => listeners(t) },
    { what: 'a poll loop', marker: 'waits-differently', lines: POLL, read: (t) => pollLoops(t, 'testing/snippet.test.js') },
  ];

  for (const { what, marker, lines, read } of SUBJECTS) {
    describe(what, () => {
      const reasonOf = (...above) => {
        const found = read(src(...above, ...lines));
        assert.equal(found.length, 1, `expected one site in:\n${src(...above, ...lines)}`);
        return found[0].reason;
      };

      it('a line comment with a reason', () => {
        assert.equal(reasonOf(`// ${marker}: tolerates a restarting server`), 'tolerates a restarting server');
      });

      it('a block comment with a reason', () => {
        assert.equal(reasonOf(`/* ${marker}: virtual time, the clock is faked */`), 'virtual time, the clock is faked');
      });

      it('a marker that opens a longer comment block, the site right below it', () => {
        assert.equal(reasonOf(`// ${marker}: a fixed window that must elapse in full`, '// (a negative wait: nothing may arrive during it)'),
          'a fixed window that must elapse in full');
      });

      it('a marker with no reason does not exempt', () => {
        assert.equal(reasonOf(`// ${marker}:`), null);
        assert.equal(reasonOf(`// ${marker}:    `), null);
      });

      it('a one-word reason does not exempt — it says nothing', () => {
        assert.equal(reasonOf(`// ${marker}: tolerates`), null);
      });

      it('a marker that is not directly above the site does not exempt it', () => {
        assert.equal(reasonOf(`// ${marker}: tolerates a restarting server`, ''), null);
        assert.equal(reasonOf(`// ${marker}: tolerates a restarting server`, 'const x = 1;'), null);
      });

      it('a marker belongs to the ONE site below it, not to the next', () => {
        const found = read(src(`// ${marker}: tolerates a restarting server`, ...lines, ...lines));
        assert.equal(found.length, 2);
        assert.equal(found[0].reason, 'tolerates a restarting server');
        assert.equal(found[1].reason, null, 'the second site inherited the first one\'s marker');
      });

      it('the marker in a string is not a marker', () => {
        assert.equal(reasonOf(`const note = "// ${marker}: tolerates a restarting server";`), null);
      });

      it('the marker without its colon is not a marker', () => {
        assert.equal(reasonOf(`// ${marker} tolerates a restarting server`), null);
      });
    });
  }

  describe('the two markers are not interchangeable', () => {
    it('own-listener does not exempt a delay, and waits-differently does not exempt a listener', () => {
      const d = delays(src('// own-listener: reads server.address() beyond the port', ...DELAY));
      assert.equal(d.length, 1);
      assert.equal(d[0].reason, null);
      const l = listeners(src('// waits-differently: a fixed window that must elapse in full', ...LISTEN));
      assert.equal(l.length, 1);
      assert.equal(l[0].reason, null);
    });
  });

  describe('where a marker sits (DECIDED, stated in the header)', () => {
    it('a delay marker above a loop covers the delays in that loop\'s own code', () => {
      const found = delays(src(
        'async function a(probe) {',
        '  // waits-differently: a negative window, nothing may arrive during it',
        '  for (let i = 0; i < 30; i++) {',
        '    if (await probe()) return true;',
        '    await new Promise(r => setTimeout(r, 100));',
        '  }',
        '}'));
      assert.equal(found.length, 1);
      assert.equal(found[0].line, 5);
      assert.equal(found[0].reason, 'a negative window, nothing may arrive during it');
    });

    it('a delay marker above a loop does not reach a delay in a function nested in it', () => {
      const found = delays(src(
        '// waits-differently: a negative window, nothing may arrive during it',
        'for (const id of ids) {',
        '  handlers.push(async () => { await new Promise(r => setTimeout(r, 100)); });',
        '}'));
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, null);
    });

    it('a delay marker above a FUNCTION covers nothing inside it', () => {
      const found = delays(src(
        '// waits-differently: a negative window, nothing may arrive during it',
        'async function a() {',
        '  await new Promise(r => setTimeout(r, 100));',
        '}'));
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, null, 'the marker has to sit on the delay, or on the loop it is in');
    });

    it('a marker above a local sleep\'s definition exempts the definition', () => {
      const found = delays(src(
        '// waits-differently: the fixture must take a measurable while',
        'const sleep = (ms) => new Promise(r => setTimeout(r, ms));'));
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, 'the fixture must take a measurable while');
    });

    it('a listener inside a new Promise executor is exempt by a marker above the statement that holds the new Promise', () => {
      const found = listeners(src(
        '// own-listener: reads server.address() beyond the port',
        'const peer = await new Promise(r => {',
        '  const s = app.listen(0, host, () => r(s));',
        '});'));
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, 'reads server.address() beyond the port');
    });

    it('a listener is also exempt by a marker above its own statement inside the executor', () => {
      const found = listeners(src(
        'const peer = await new Promise(r => {',
        '  // own-listener: reads server.address() beyond the port',
        '  const s = app.listen(0, host, () => r(s));',
        '});'));
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, 'reads server.address() beyond the port');
    });

    it('a listener marker above a whole function covers nothing inside it', () => {
      const found = listeners(src(
        '// own-listener: reads server.address() beyond the port',
        'async function start() {',
        "  await new Promise(r => server.listen(0, '127.0.0.1', r));",
        '}'));
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, null);
    });
  });
});

describe('one definition of "a sleep" — the poll gate and the delay classifier ask the same reader', () => {
  /*
   * Each row is a poll loop around ONE awaited call. The loop is a poll (a deadline, a condition, an awaited sleep) exactly
   * when the call is a sleep, so the poll gate's answer and `awaitedSleeps`' answer have to be the same one. Rows run
   * both ways: the call IS a sleep, and the call only looks like one (its name, its text).
   */
  const ROWS = [
    // a sleep ---------------------------------------------------------------------------------------------------------
    { name: 'the shared sleep', preamble: "import { sleep } from '../_shared/sleep.mjs';", call: 'sleep(50)', sleeps: true },
    { name: 'a sleep name imported from anywhere (the list)', preamble: "import { delay } from './helpers.mjs';", call: 'delay(50)', sleeps: true },
    { name: 'a method named like a sleep', preamble: '', call: 'h.sleep(10)', sleeps: true },
    { name: 'an inline promise over setTimeout', preamble: '', call: 'new Promise(r => setTimeout(r, 25))', sleeps: true },
    { name: 'a local helper whose body is the timer, any name',
      preamble: 'const breathe = (ms) => new Promise((resolve) => setTimeout(resolve, ms));', call: 'breathe(40)', sleeps: true },
    { name: 'a local function declaration whose body is the timer',
      preamble: 'function snooze2(ms) { return new Promise(r => setTimeout(r, ms)); }', call: 'snooze2(40)', sleeps: true },
    { name: 'a local helper that backs off: other statements AND the timer — it waits, whether or not it is a stand-alone delay',
      preamble: 'async function backoff(n) { log(n); return new Promise(r => setTimeout(r, 10 * n)); }', call: 'backoff(2)', sleeps: true },
    { name: 'timers/promises renamed to a name no list contains',
      preamble: "import { setTimeout as hold } from 'node:timers/promises';", call: 'hold(25)', sleeps: true },
    { name: 'timers/promises reached as a member',
      preamble: "import timers from 'node:timers/promises';", call: 'timers.setTimeout(50)', sleeps: true },
    { name: 'the shared elapse', preamble: "import { elapse } from '../_shared/sleep.mjs';",
      call: "elapse(50, 'pacing: one probe per tick')", sleeps: true },
    { name: 'the shared elapse under a name no list contains — known by its import, not its name',
      preamble: "import { elapse as hold } from '../_shared/sleep.mjs';", call: "hold(50, 'pacing: one probe per tick')", sleeps: true },
    { name: 'a local wrapper whose body calls the shared elapse',
      preamble: "import { elapse } from '../_shared/sleep.mjs';\nconst later = () => elapse(15, 'timestamps differ: the next write is later');",
      call: 'later()', sleeps: true },
    { name: 'a browser page waiting a fixed time', preamble: '', call: 'page.waitForTimeout(700)', sleeps: true },
    // only looks like one ----------------------------------------------------------------------------------------------
    { name: 'a local `tick` that reads the clock', preamble: 'const tick = () => new Date();', call: 'tick()', sleeps: false },
    { name: 'a local `delay` that is a number, handed to something else', preamble: 'let delay = 250;', call: 'settle(delay)', sleeps: false },
    { name: 'a local function NAMED like a sleep whose body arms no timer',
      preamble: 'const delay = () => computeBackoff();', call: 'delay()', sleeps: false },
    { name: 'a local `wait` whose body arms no timer', preamble: 'function wait() { return queue.length; }', call: 'wait()', sleeps: false },
    { name: 'a helper that sets a SOCKET timeout — a limit, not a delay',
      preamble: 'function ping() { const s = net.connect(1); s.setTimeout(500); return ok(s); }', call: 'ping()', sleeps: false },
  ];

  for (const row of ROWS) {
    it(row.name, () => {
      const pre = row.preamble ? `${row.preamble}\n` : '';
      const text = src(
        pre + 'async function until(probe, deadline) {',
        '  while (Date.now() < deadline) {',
        '    if (await probe()) return true;',
        `    await ${row.call};`,
        '  }',
        '}');
      const callLine = pre.split('\n').length - 1 + 4;
      const polls = pollLoops(text, 'testing/snippet.test.js').length;
      const sleepsAtCall = awaitedSleeps(text, 'testing/snippet.test.js').some(s => s.line === callLine);
      assert.equal(sleepsAtCall, row.sleeps, `awaitedSleeps ${row.sleeps ? 'missed' : 'invented'} the sleep on line ${callLine} of:\n${text}`);
      assert.equal(polls, row.sleeps ? 1 : 0, `the poll gate and awaitedSleeps disagree about whether \`await ${row.call}\` is a sleep, in:\n${text}`);
    });
  }

  it('the poll gate takes the sleep definition and the marker reader from the classifier module, defining neither', () => {
    const [{ text }] = readTrackedSources(['testing/_shared/poll-loops.mjs'], { ext: ['.mjs'], floor: 1 });
    const code = stripComments(text);
    assert.match(code, /from\s+'\.\/timer-sites\.mjs'/, 'poll-loops.mjs does not import from timer-sites.mjs: it decides what a sleep is for itself');
    assert.doesNotMatch(code, /\b(?:const|let|var|function)\s+(?:SLEEP_NAMES|localSleepers|MARKER|markerAbove)\b/,
      'poll-loops.mjs still defines the sleep names, the local-sleeper body rule or the marker reader: they live in timer-sites.mjs');
    assert.doesNotMatch(code, /getLeadingCommentRanges\(/, 'poll-loops.mjs reads the comment above a node itself: use the one marker reader');
  });

  it('exactly one non-test module under testing/ and scripts/ reads the comment block above a node', () => {
    const readers = readTrackedSources(['testing', 'scripts'], { ext: ['.js', '.mjs'], floor: 500 })
      .filter(s => !s.file.endsWith('.test.js') && /getLeadingCommentRanges\(/.test(stripComments(s.text)))
      .map(s => s.file);
    assert.equal(readers.length, 1, `the marker is read in ${readers.length} places (${readers.join(', ')}); it is read once, by the one reader both gates import`);
  });
});

describe('elapse refuses a delay that does not say which kind of delay it is, before it waits at all', () => {
  it('the kinds are a closed, frozen list', () => {
    assert.ok(Array.isArray(DELAY_KINDS) && Object.isFrozen(DELAY_KINDS), 'DELAY_KINDS is not a frozen array');
    for (const kind of ['absence window', 'ttl elapses', 'timestamps differ', 'simulated latency', 'pacing',
      'bind-mount propagation', 'sampler interval', 'race timeout']) {
      assert.ok(DELAY_KINDS.includes(kind), `DELAY_KINDS lacks "${kind}"`);
    }
  });

  it('a reason of a known kind with a detail waits and resolves', async () => {
    const t0 = Date.now();
    await elapse(20, 'pacing: one probe per tick');
    assert.ok(Date.now() - t0 >= 15, 'elapse resolved before its time');
  });

  for (const [name, reason] of [
    ['no reason', undefined],
    ['a reason that is not a string', 42],
    ['a reason with no kind', 'let the server settle'],
    ['a kind nobody listed', 'server catches up: hopefully by now'],
    ['a known kind with no detail', 'pacing:'],
    ['a known kind with only blanks as detail', 'pacing:    '],
  ]) {
    it(`${name} throws synchronously — no promise is ever made`, () => {
      let returned;
      assert.throws(() => { returned = elapse(5, reason); }, /kind|reason/i);
      assert.equal(returned, undefined);
    });
  }
});

describe('raceDeadline answers a race against a deadline and leaves no timer running', () => {
  const reason = 'race timeout: the answer has this long to arrive';
  const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  const never = () => new Promise(() => {});

  it('the work settling first answers its value, and the deadline timer is gone', async () => {
    const before = timers();
    assert.equal(await raceDeadline(Promise.resolve('answer'), 60_000, reason, () => 'late'), 'answer');
    assert.equal(timers(), before, 'the deadline timer is still armed after the work settled: the process would wait it out');
  });

  it('the work failing first rejects with its error, and the deadline timer is gone', async () => {
    const before = timers();
    await assert.rejects(raceDeadline(Promise.reject(new Error('the work failed')), 60_000, reason, () => 'late'), /the work failed/);
    assert.equal(timers(), before);
  });

  it('a deadline that passes first answers what onLate returns', async () => {
    assert.equal(await raceDeadline(never(), 5, reason, () => 'still waiting'), 'still waiting');
  });

  it('a deadline that passes first rejects with what onLate throws', async () => {
    await assert.rejects(raceDeadline(never(), 5, reason, () => { throw new Error('no event within the deadline'); }), /no event within the deadline/);
  });

  it('work that settles after the deadline changes nothing', async () => {
    let finish;
    const work = new Promise((r) => { finish = r; });
    const late = raceDeadline(work, 5, reason, () => 'late');
    assert.equal(await late, 'late');
    finish('too late');
    assert.equal(await late, 'late');
  });

  it('a value that is not a promise is the work as well', async () => {
    assert.equal(await raceDeadline('plain', 60_000, reason, () => 'late'), 'plain');
  });

  for (const [name, bad] of [
    ['no reason', undefined],
    ['a reason with no kind', 'let it settle'],
    ['a kind that is a delay but not a race timeout', 'pacing: one probe per tick'],
    ['a race timeout with no detail', 'race timeout:'],
  ]) {
    it(`${name} throws synchronously, before any timer is armed`, () => {
      const before = timers();
      let returned;
      assert.throws(() => { returned = raceDeadline(never(), 5, bad, () => 'late'); }, /kind|reason|race timeout/i);
      assert.equal(returned, undefined);
      assert.equal(timers(), before);
    });
  }

  for (const [name, bad] of [['NaN', NaN], ['Infinity', Infinity], ['a negative number', -1], ['a string', '10'], ['undefined', undefined]]) {
    it(`a deadline of ${name} throws synchronously, before any timer is armed`, () => {
      const before = timers();
      let returned;
      assert.throws(() => { returned = raceDeadline(never(), bad, reason, () => 'late'); }, /ms must be/);
      assert.equal(returned, undefined);
      assert.equal(timers(), before);
    });
  }

  it('a deadline of 0 is a deadline: onLate answers once the timer fires', async () => {
    assert.equal(await raceDeadline(never(), 0, reason, () => 'at once'), 'at once');
  });

  it('an onLate that is not a function throws synchronously: a deadline with no answer would pass for the wrong reason', () => {
    assert.throws(() => raceDeadline(never(), 5, reason, undefined), /onLate/);
  });

  it('elapse itself still resolves after its time and still refuses a reason with no kind', async () => {
    await elapse(5, 'pacing: one probe per tick');
    assert.throws(() => elapse(5, 'let it settle'), /kind|reason/i);
  });
});

describe('every call of the shared elapse names its kind in a literal, and every other sleep says why it waits differently', () => {
  const ELAPSE = "import { elapse } from '../_shared/sleep.mjs';";
  const calls = (text) => delayCalls(text, 'testing/snippet.test.js');
  const problems = (text) => calls(text).filter(c => c.problem !== null).map(c => ({ line: c.line, problem: c.problem }));

  const EXPLAINED = [
    { name: 'awaited, a string literal of a known kind',
      text: src(ELAPSE, 'async function t() {', "  await elapse(50, 'absence window: no second sweep after the first');", '}') },
    { name: 'a template literal without substitutions',
      text: src(ELAPSE, 'async function t() {', '  await elapse(5, `timestamps differ: the second write is later`);', '}') },
    { name: 'an aliased import with a good reason',
      text: src("import { elapse as hold } from '../_shared/sleep.mjs';", 'async function t() {', "  await hold(5, 'pacing: one request per tick');", '}') },
    { name: 'inside a Promise.race, judged at its own call',
      text: src(ELAPSE, 'async function t(p) {',
        "  await Promise.race([p, elapse(10, 'race timeout: the event never came').then(() => { throw new Error('x'); })]);", '}') },
    { name: 'not awaited, inside a local wrapper',
      text: src(ELAPSE, "const later = () => elapse(15, 'timestamps differ: the next write is later');", 'async function t() { await later(); }') },
    { name: 'a raceDeadline with a race timeout reason',
      text: src("import { raceDeadline } from '../_shared/sleep.mjs';", 'async function t(p) {',
        "  return raceDeadline(p, 10, 'race timeout: the event never came', () => false);", '}') },
    { name: 'a raceDeadline under another import name',
      text: src("import { raceDeadline as within } from '../_shared/sleep.mjs';", 'async function t(p) {',
        "  return within(p, 10, 'race timeout: the event never came', () => false);", '}') },
    { name: 'a browser page wait with the marker above it',
      text: src('async function t(page) {', '  // waits-differently: the chart animates in for a fixed time', '  await page.waitForTimeout(300);', '}') },
    { name: 'a sleep named helper imported from elsewhere, with the marker above it',
      text: src("import { delay } from './helpers.mjs';", 'async function t() {', '  // waits-differently: the vendor client paces itself', '  await delay(100);', '}') },
    { name: 'CRLF line ends change nothing',
      text: [ELAPSE, 'async function t() {', "  await elapse(50, 'absence window: no second sweep after the first');", '}'].join('\r\n') },
  ];
  for (const row of EXPLAINED) {
    it(`explained: ${row.name}`, () => {
      assert.deepEqual(problems(row.text), [], `a delay that says its kind was refused in:\n${row.text}`);
      assert.ok(calls(row.text).length >= 1, `the instrument judged no call at all in:\n${row.text}`);
    });
  }

  const REFUSED = [
    { name: 'a reason whose kind nobody listed', line: 3, problem: 'reason-not-a-kind',
      text: src(ELAPSE, 'async function t() {', "  await elapse(50, 'server catches up: hopefully by now');", '}') },
    { name: 'a reason with no kind at all', line: 3, problem: 'reason-not-a-kind',
      text: src(ELAPSE, 'async function t() {', "  await elapse(50, 'let it settle');", '}') },
    { name: 'a known kind with no detail', line: 3, problem: 'reason-not-a-kind',
      text: src(ELAPSE, 'async function t() {', "  await elapse(5, 'pacing:');", '}') },
    { name: 'no reason at all', line: 3, problem: 'reason-not-literal',
      text: src(ELAPSE, 'async function t() {', '  await elapse(5);', '}') },
    { name: 'a reason held in a variable', line: 3, problem: 'reason-not-literal',
      text: src(ELAPSE, 'async function t(why) {', '  await elapse(5, why);', '}') },
    { name: 'a template literal with a substitution', line: 3, problem: 'reason-not-literal',
      text: src(ELAPSE, 'async function t(n) {', '  await elapse(5, `pacing: ${n}`);', '}') },
    { name: 'an unbraced if', line: 3, problem: 'reason-not-literal',
      text: src(ELAPSE, 'async function t(x) {', '  if (x) await elapse(5, x);', '}') },
    { name: 'an aliased import with no reason', line: 3, problem: 'reason-not-literal',
      text: src("import { elapse as e } from '../_shared/sleep.mjs';", 'async function t() {', '  await e(5);', '}') },
    { name: 'inside a Promise.race with a kind nobody listed', line: 3, problem: 'reason-not-a-kind',
      text: src(ELAPSE, 'async function t(p) {', "  await Promise.race([p, elapse(10, 'give up: after ten')]);", '}') },
    { name: 'a raceDeadline whose kind is a delay but not a race timeout', line: 3, problem: 'reason-not-a-kind',
      text: src("import { raceDeadline } from '../_shared/sleep.mjs';", 'async function t(p) {',
        "  return raceDeadline(p, 10, 'pacing: one probe per tick', () => false);", '}') },
    { name: 'a raceDeadline with no reason', line: 3, problem: 'reason-not-literal',
      text: src("import { raceDeadline } from '../_shared/sleep.mjs';", 'async function t(p) {', '  return raceDeadline(p, 10);', '}') },
    { name: 'a raceDeadline whose reason is held in a variable', line: 3, problem: 'reason-not-literal',
      text: src("import { raceDeadline } from '../_shared/sleep.mjs';", 'async function t(p, why) {', '  return raceDeadline(p, 10, why, () => false);', '}') },
    { name: 'raceDeadline handed on as a value', line: 2, problem: 'side-door',
      text: src("import { raceDeadline } from '../_shared/sleep.mjs';", 'const within = raceDeadline;', "export const x = within(null, 1, 'race timeout: a b', () => 1);") },
    { name: 'a wrapper that passes its caller\'s reason through', line: 2, problem: 'reason-not-literal',
      text: src(ELAPSE, 'const later = (why) => elapse(15, why);', "async function t() { await later('pacing: a b'); }") },
    { name: 'not awaited, inside a .then', line: 3, problem: 'reason-not-a-kind',
      text: src(ELAPSE, 'function t(chain) {', "  return chain.then(() => elapse(5, 'settle down'));", '}') },
    { name: 'a browser page wait with no marker', line: 2, problem: 'no-marker',
      text: src('async function t(page) {', '  await page.waitForTimeout(300);', '}') },
    { name: 'a sleep named helper imported from elsewhere with no marker', line: 3, problem: 'no-marker',
      text: src("import { delay } from './helpers.mjs';", 'async function t() {', '  await delay(100);', '}') },
    { name: 'a sleep that is a method, no marker', line: 2, problem: 'no-marker',
      text: src('async function t(h) {', '  await h.sleep(10);', '}') },
    { name: 'a namespace import of the module — a side door around the binding rule', line: 1, problem: 'side-door',
      text: src("import * as s from '../_shared/sleep.mjs';", "async function t() { await s.elapse(5, 'pacing: a b'); }") },
    { name: 'a default import of the module', line: 1, problem: 'side-door',
      text: src("import s from '../_shared/sleep.mjs';", 'export const x = s;') },
    { name: 'a re-export of elapse', line: 1, problem: 'side-door',
      text: src("export { elapse } from '../_shared/sleep.mjs';") },
    { name: 'a re-export of everything', line: 1, problem: 'side-door',
      text: src("export * from '../_shared/sleep.mjs';") },
    { name: 'elapse handed on as a value, then called where no literal can be read', line: 2, problem: 'side-door',
      text: src(ELAPSE, 'const later = elapse;', "async function t() { await later(5, 'pacing: a b'); }") },
    { name: 'this file\'s elapse exported onward — a door for every importer of this file', line: 2, problem: 'side-door',
      text: src(ELAPSE, 'export { elapse };') },
    { name: 'the old sleep, imported by name', line: 1, problem: 'side-door',
      text: src("import { sleep } from '../_shared/sleep.mjs';", 'export const x = sleep;') },
  ];
  for (const row of REFUSED) {
    it(`refused: ${row.name}`, () => {
      assert.deepEqual(problems(row.text), [{ line: row.line, problem: row.problem }], `in:\n${row.text}`);
    });
  }

  it('what is not a delay is not judged', () => {
    for (const text of [
      src('function t(stream) { stream.pause(); }'),
      src("// await elapse(5, 'not code');", 'export const x = 1;'),
      src("export const advice = \"await elapse(5, 'in a string')\";"),
      src('function t(fn) { setTimeout(fn, 10); }'),
    ]) assert.deepEqual(calls(text), [], `something was judged in:\n${text}`);
  });

  it('the kind list is read from sleep.mjs, never written a second time', () => {
    const [{ text }] = readTrackedSources(['testing/_shared/timer-sites.mjs'], { ext: ['.mjs'], floor: 1 });
    const code = stripComments(text);
    assert.match(code, /from\s+'\.\/sleep\.mjs'/, 'timer-sites.mjs does not take the delay kinds from sleep.mjs');
    assert.ok(DELAY_KINDS.length >= 1, 'sleep.mjs exports no kinds: the check below would pass over nothing');
    for (const kind of DELAY_KINDS) {
      assert.ok(!code.includes(`'${kind}'`), `timer-sites.mjs spells the kind '${kind}' itself: a second copy of the list`);
    }
  });
});

describe('every tracked test and script', () => {
  const sources = readTrackedSources(['testing', 'scripts'], { ext: ['.js', '.mjs'], floor: 500 });
  const byFile = new Map(sources.map(s => [s.file, s.text]));

  it('the scan reads every suite folder and the scripts', () => {
    const where = new Set(sources.map(s => s.file.split('/')[0] === 'testing' ? s.file.split('/')[1] : 'scripts'));
    for (const area of ['standalone', 'integration', 'sync', 'red-team-tests', '_shared', 'scripts']) {
      assert.ok(where.has(area), `the scan found nothing under ${area}/ — the listing is broken, not the code`);
    }
  });

  it('the scan does not reach benchmarks/ or the client specs (product-facing, and vitest\'s own)', () => {
    const outside = sources.filter(s => s.file.startsWith('benchmarks/') || s.file.endsWith('.spec.ts')).map(s => s.file);
    assert.deepEqual(outside, []);
  });

  it('every home exists and is part of the scan', () => {
    for (const home of [...DELAY_HOMES, ...LISTENER_HOMES]) {
      assert.ok(byFile.has(home), `${home} is not among the scanned sources — the home was moved or renamed, and the exemption with it`);
    }
  });

  it('the instrument sees the timer in sleep.mjs, the poll interval in wait-for.mjs and the bind in local-server.mjs', () => {
    // A classifier that cannot find the one spelling each home exists to hold would pass the rule below by being blind.
    for (const home of DELAY_HOMES) {
      assert.ok(fixedDelays(byFile.get(home), home).length >= 1, `the classifier finds no fixed delay in ${home}, the home of the spelling: it is blind`);
    }
    for (const home of LISTENER_HOMES) {
      assert.ok(listenerSites(byFile.get(home), home).length >= 1, `the classifier finds no listener in ${home}, the home of the spelling: it is blind`);
    }
  });

  it('none spells a fixed delay itself, unless it says why it waits differently', () => {
    const offenders = sources
      .filter(s => !DELAY_HOMES.includes(s.file))
      .flatMap(s => fixedDelays(s.text, s.file))
      .filter(f => f.reason === null)
      .map(f => `${f.file}:${f.line}  ${f.text}`);
    assert.deepEqual(offenders, [],
      'a hand-written fixed delay. Time itself is rarely the subject: if you are waiting for a CONDITION, use waitFor from '
      + 'testing/_shared/wait-for.mjs. If time is the subject, import `elapse` from testing/_shared/sleep.mjs and name the kind '
      + 'of delay: `elapse(ms, \'<kind>: <detail>\')`. If this one asks a different question '
      + '(a window that must elapse in full before something is asserted absent, a fixture that must take a measurable while), '
      + 'say so in the comment directly above it: `// waits-differently: <reason>`.');
  });

  it('every delay names its kind, or says why it waits differently', () => {
    assert.ok(byFile.has(ELAPSE_REFUSAL_TESTS[0]), 'the exempt file is not among the scanned sources: it was moved, and the exemption with it');
    const offenders = sources
      .filter(s => !DELAY_HOMES.includes(s.file) && !ELAPSE_REFUSAL_TESTS.includes(s.file))
      .flatMap(s => delayCalls(s.text, s.file))
      .filter(c => c.problem !== null)
      .map(c => `${c.file}:${c.line}  [${c.problem}]  ${c.text}`);
    assert.deepEqual(offenders, [],
      'a fixed delay that does not say which kind of delay it is. If you are waiting for a CONDITION, it is not a delay: '
      + 'use waitFor from testing/_shared/wait-for.mjs. If time itself is the subject, import `elapse` by name from '
      + 'testing/_shared/sleep.mjs and give it a literal `<kind>: <detail>` from DELAY_KINDS (absence window, ttl elapses, ...). '
      + 'Any other delay (a browser page wait, a vendor helper) says why in the comment directly above it: '
      + '`// waits-differently: <reason>`.');
  });

  it('the instrument judges every call of elapse a plain reading finds, and there are enough to mean something', () => {
    // An independent count: the binding rule finds its calls through the syntax tree, this counts the bound names' calls
    // in the comment-stripped text. A file where the two differ is a spelling the tree rule does not see.
    let judged = 0;
    const disagree = [];
    for (const s of sources.filter(x => !DELAY_HOMES.includes(x.file) && !ELAPSE_REFUSAL_TESTS.includes(x.file))) {
      const names = [...s.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/sleep\.mjs['"]/g)]
        .flatMap(m => m[1].split(',').map(x => x.trim()).filter(Boolean))
        .map(spec => spec.split(/\s+as\s+/))
        .filter(([imported]) => imported === 'elapse')
        .map(parts => parts.pop());
      if (names.length === 0) continue;
      const code = stripComments(s.text);
      const plain = names.reduce((n, local) => n + [...code.matchAll(new RegExp(`(?<![\\w.$])${local}\\s*\\(`, 'g'))].length, 0);
      const tree = delayCalls(s.text, s.file).filter(c => c.callee === 'elapse').length;
      judged += tree;
      if (plain !== tree) disagree.push(`${s.file}: ${plain} calls by reading, ${tree} judged`);
    }
    assert.deepEqual(disagree, [], 'the tree rule and a plain reading disagree about how many times elapse is called');
    assert.ok(judged >= 100, `only ${judged} calls of elapse were judged across the tree; the floor is 100 — the instrument or the import spelling broke`);
  });

  it('the testing guide names every kind of delay', () => {
    const [{ text }] = readTrackedSources(['docs/testing-guide.md'], { ext: ['.md'], floor: 1 });
    const missing = DELAY_KINDS.filter(k => !text.includes(k));
    assert.deepEqual(missing, [], 'docs/testing-guide.md does not name these kinds of delay; the list lives in sleep.mjs and the guide follows it');
  });

  it('the race reader sees every Promise.race a plain reading of the text finds, and there are enough to mean something', () => {
    // An independent count: the tree reader finds the calls through the syntax tree, this counts `Promise.race(` in the
    // comment-stripped text. A file where the two differ holds a spelling the race rule does not see.
    let judged = 0;
    const disagree = [];
    assert.ok(byFile.has(RACE_SNIPPET_TESTS[0]), 'the exempt file is not among the scanned sources: it was moved, and the exemption with it');
    for (const s of sources.filter(x => !RACE_SNIPPET_TESTS.includes(x.file))) {
      const plain = [...stripComments(s.text).matchAll(/\bPromise\s*\.\s*race\s*\(/g)].length;
      const tree = promiseRaceCount(s.text, s.file);
      judged += tree;
      if (plain !== tree) disagree.push(`${s.file}: ${plain} by reading, ${tree} by the tree`);
    }
    assert.deepEqual(disagree, [], 'the tree reader and a plain reading disagree about how many times Promise.race is called');
    // A floor below what the tree holds today (the races that went through `raceDeadline` are gone from the count): it only has to be
    // far above zero, so a reader that sees nothing cannot pass.
    assert.ok(judged >= 25, `only ${judged} Promise.race calls were read across the tree; the floor is 25 — the reader or the scan broke`);
  });

  it('none leaves the timer of a Promise.race running', () => {
    const offenders = sources
      .flatMap(s => uncancelledRaceTimers(s.text, s.file))
      .map(f => `${f.file}:${f.line}  ${f.text}`);
    assert.deepEqual(offenders, [],
      'a Promise.race timer that is never cleared. The timer that loses the race keeps the process alive for its whole length after '
      + 'the last test, so the file takes that much longer than its tests. Bound the wait with `settleWithin` from '
      + 'testing/standalone/_write-faults.mjs (it clears its own timer and reports `settled: false`), or, for a deadline that '
      + 'answers a value or throws, `raceDeadline(work, ms, \'race timeout: <detail>\', onLate)` from testing/_shared/sleep.mjs (a race '
      + 'against `elapse` or a `timers/promises` timer cannot clear its timer), or keep the handle '
      + '(`let timer; ... timer = setTimeout(...)`) and `clearTimeout(timer)` in a `finally`, or `.unref()` a guard that only '
      + 'rejects.');
  });

  it('none binds a test server itself, unless it says why it keeps its own', () => {
    const offenders = sources
      .filter(s => !LISTENER_HOMES.includes(s.file))
      .flatMap(s => listenerSites(s.text, s.file))
      .filter(f => f.reason === null)
      .map(f => `${f.file}:${f.line}  ${f.text}`);
    assert.deepEqual(offenders, [],
      'a hand-bound server. Hand it to listenOnLoopback from testing/_shared/local-server.mjs: `const local = await '
      + 'listenOnLoopback(http.createServer(app))` gives its port and url, binds 127.0.0.1 only, and ends the sockets a client '
      + 'left open. A server that reads server.address() beyond its port, closes with timing that matters, tests connection '
      + 'lifetime, or must bind 0.0.0.0 or a LAN address keeps its own: say why in the comment directly above it, '
      + '`// own-listener: <reason>`.');
  });
});
