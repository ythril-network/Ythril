/**
 * A driver failure that arrives at the rate of its callers is reported once per window for each (operation, kind), and
 * the kind is never the driver's text (Q-361: the text an answer withholds is read in the log, not once per failed call).
 *
 * ## What is asserted
 *
 * `reportRecurringDriverFailure(operation, kind, detail)` (`util/report-failure.ts`):
 *
 * - the same (operation, kind) meets the log once, however many times it fails and whatever `detail` each carries —
 *   `detail` is the driver's text and varies per call, so a key that included it would report every occurrence;
 * - a different `kind` on the same operation is news, and so is the same `kind` on a different operation;
 * - once the window has passed the pair is reported again — a condition that lasts for hours is not silent after its
 *   first line;
 * - the line that is written carries the first `detail` and the operation, through `reportDriverFailure`.
 *
 * The window is read off the clock, so the test moves `Date` (node's mock timers) BEFORE the module is loaded: `warnOnce`
 * takes `Date.now` at construction.
 *
 * Seen red by hand, restored by hand: `detail` added to the key in `reportRecurringDriverFailure` (the same kind with
 * another text reported again); the call replaced by `reportDriverFailure` (every occurrence reported).
 *
 * Run: node --test testing/standalone/a-recurring-driver-failure-is-reported-once-per-window-and-kind.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

let reportRecurringDriverFailure, logMod;
const START = 1_800_000_000_000;

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: START });
  mock.method(console, 'warn', () => {});
  ({ reportRecurringDriverFailure } = await import('../../server/dist/util/report-failure.js'));
  logMod = await import('../../server/dist/util/log.js');
});
after(() => { mock.timers.reset(); mock.restoreAll(); });

/** The log lines `fn` wrote. */
function linesDuring(fn) {
  const lines = [];
  const stop = logMod.subscribeLogLines((l) => lines.push(l));
  try { fn(); } finally { stop(); }
  return lines;
}

describe('a recurring driver failure is reported once per window for each operation and kind', () => {
  it('the same operation and kind is one line however often it fails and whatever text each failure carries', () => {
    const lines = linesDuring(() => {
      for (let i = 0; i < 20; i++) reportRecurringDriverFailure('op-same', 'MongoServerError', `connection ${i} to host-${i} refused`);
    });
    assert.equal(lines.length, 1, `${lines.length} lines for one condition`);
    assert.match(lines[0], /op-same failed: .*connection 0 to host-0 refused/, 'the line does not carry the first failure');
  });

  it('a different kind on one operation, and the same kind on another operation, are each news', () => {
    const lines = linesDuring(() => {
      reportRecurringDriverFailure('op-pair', 'KindA', 'first');
      reportRecurringDriverFailure('op-pair', 'KindA', 'again');
      reportRecurringDriverFailure('op-pair', 'KindB', 'other kind');
      reportRecurringDriverFailure('op-pair-2', 'KindA', 'other operation');
    });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /op-pair failed: first/);
    assert.match(lines[1], /op-pair failed: other kind/);
    assert.match(lines[2], /op-pair-2 failed: other operation/);
  });

  it('is reported again once the window has passed, and not before', () => {
    const count = () => linesDuring(() => reportRecurringDriverFailure('op-window', 'KindW', 'text')).length;
    assert.equal(count(), 1);
    // The whole window is not a constant this file knows: step through it until the pair is reported again, bounded.
    let elapsedMin = 0;
    let again = 0;
    while (again === 0 && elapsedMin < 24 * 60) {
      mock.timers.tick(60_000);
      elapsedMin++;
      again = count();
    }
    assert.equal(again, 1, 'the pair was never reported again');
    assert.ok(elapsedMin > 1, `the pair was reported again after ${elapsedMin} minute(s): no window held it`);
    assert.equal(count(), 0, 'the pair was reported twice in one window');
  });
});
