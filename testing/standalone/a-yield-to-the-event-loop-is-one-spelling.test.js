/**
 * Yielding a turn of the event loop is spelled one way, `yieldToEventLoop` in `util/yield-to-event-loop.ts` (bundle-23
 * wave 0, extraction 2).
 *
 * ## The defect it prevents
 *
 * `await new Promise(r => setImmediate(r))` was written four times in `server/src` (`brain/suppression-sweep.ts`,
 * `files/at-rest-migration.ts`, `files/media/slot-pool.ts` as `yieldMacrotask`, `webhooks/dispatcher.ts`), and bundle-23
 * was about to add five more. Each copy picks its own primitive, and a wrong pick does not fail: a microtask yields to
 * nothing waiting on I/O, `setTimeout(r, 0)` is clamped and orders differently. The module holds the primitive.
 *
 * ## What it holds
 *
 * - The module resolves in the check phase: an immediate queued ahead of it has run by the time it resolves, which a
 *   microtask turn is shown not to achieve.
 * - No other tracked source under `server/src` builds a promise resolved by `setImmediate` or by a 0 ms `setTimeout`, or
 *   takes either from `timers/promises` / `promisify` (comments stripped). A DEFERRAL — `setImmediate(() => { … })`,
 *   nothing awaited — is a different question and is not matched; it is pinned below as a fixture.
 * - The reader finds each spelling the four sites used (fixtures), so it is seen red on them; and the module has at least
 *   the four askers it came from (derived, with a floor).
 *
 * ## Seen red
 *
 * By hand: `await new Promise(r => setImmediate(r));` put back into `files/at-rest-migration.ts`, run, red naming that file;
 * removed by hand, green.
 *
 * Run: node --test testing/standalone/a-yield-to-the-event-loop-is-one-spelling.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/util/yield-to-event-loop.ts';

/** A promise whose resolver is handed to setImmediate or a 0 ms / no-delay setTimeout, directly or through an arrow. */
const HAND_YIELD = new RegExp(String.raw`new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*(\w+)\s*(?::[^)=]*)?\)?\s*=>\s*\{?\s*`
  + String.raw`(?:setImmediate|setTimeout)\s*\(\s*(?:\1|\(\)\s*=>\s*\1\s*\(\s*\))\s*(?:\)|,\s*0\s*\))`);
/** The library spellings of the same thing. */
const LIBRARY_YIELD = /promisify\s*\(\s*(?:setImmediate|setTimeout)\s*\)|from\s+['"](?:node:)?timers\/promises['"]/;
const yieldsIn = code => HAND_YIELD.test(code) || LIBRARY_YIELD.test(code);

describe('the reader finds each hand-written yield, and leaves a deferral alone', () => {
  const YIELDS = [
    ['suppression-sweep', 'await new Promise<void>(resolve => setImmediate(resolve));'],
    ['at-rest-migration', 'await new Promise(r => setImmediate(r));'],
    ['slot-pool', 'const yieldMacrotask = () => new Promise<void>(resolve => setImmediate(resolve));'],
    ['webhook dispatcher', 'beforeFirstBatch: () => new Promise<void>(resolve => setImmediate(resolve)),'],
    ['a zero timer', 'await new Promise(r => setTimeout(r, 0));'],
    ['a no-delay timer', 'await new Promise((r) => setTimeout(r));'],
    ['an arrow around the resolver', 'await new Promise<void>((done) => { setImmediate(() => done()); });'],
    ['timers/promises', "import { setImmediate } from 'node:timers/promises';"],
    ['promisify', 'const tick = promisify(setImmediate);'],
  ];
  for (const [what, code] of YIELDS) it(`finds: ${what}`, () => assert.ok(yieldsIn(code), code));

  const NOT_YIELDS = [
    ['a deferral (reindex)', 'setImmediate(() => { void sweepRun(spaceId); });'],
    ['a real delay', 'await new Promise(r => setTimeout(r, 250));'],
    ['a delay by a name', 'await new Promise(r => setTimeout(r, backoffMs));'],
    ['the compliant spelling', 'await yieldToEventLoop();'],
  ];
  for (const [what, code] of NOT_YIELDS) it(`does not report: ${what}`, () => assert.ok(!yieldsIn(code), code));
});

describe('yielding a turn is spelled once', () => {
  it('the module yields to an immediate already queued, which a microtask would not', async () => {
    const { yieldToEventLoop } = await import('../../server/dist/util/yield-to-event-loop.js');
    let immediateRan = false;
    setImmediate(() => { immediateRan = true; });
    await Promise.resolve();
    assert.equal(immediateRan, false, 'a microtask turn ran the immediate — the comparison below proves nothing');
    await yieldToEventLoop();
    assert.equal(immediateRan, true, 'yieldToEventLoop resolved before an immediate queued ahead of it: it is not a check-phase yield');
  });

  const sources = readTrackedSources('server/src', { untracked: true })
    .map(({ file, text }) => ({ file, code: stripComments(text) }));

  it('reads a tree worth reading, and the module has its askers (the floors)', () => {
    assert.ok(sources.length >= 300, `only ${sources.length} server sources were read`);
    const askers = sources.filter(s => s.file !== MODULE && /\byieldToEventLoop\b/.test(s.code)).map(s => s.file);
    assert.ok(askers.length >= 4, `only ${askers.length} file(s) use yieldToEventLoop: ${askers.join(', ')}`);
  });

  it('no other server source writes its own yield', () => {
    const copies = sources.filter(s => s.file !== MODULE && yieldsIn(s.code)).map(s => s.file);
    assert.deepEqual(copies, [],
      `a hand-written event-loop yield — await yieldToEventLoop() (${MODULE}) instead:\n  ${copies.join('\n  ')}`);
  });
});
