/**
 * The write bound answers a push BEFORE its sender gives up — however late the bound's two clocks end the last write
 * of a hold (`Q-372`, pre-ship finding F3).
 *
 * ## The relation
 *
 * A stalled push answers a retryable `503` so the sender does not give up at `BATCH_FETCH_TIMEOUT_MS` and re-send the
 * page into the same stall. The last operation of a hold can end as late as the hold's deadline PLUS the client
 * backstop's margin (`SERVER_FIRST_MARGIN_MS`: the server's deadline is the one the operation carries, the backstop
 * answers that much after it) PLUS the time the backstop gives itself to kill the server operation and see it gone
 * (`KILL_WAIT_MS`, `Q-380`: the caller is answered only after that, or when it runs out). So the longest a hold can last is
 *
 *     the hold deadline's CEILING + SERVER_FIRST_MARGIN_MS + KILL_WAIT_MS  <  BATCH_FETCH_TIMEOUT_MS
 *
 * That sentence was a comment in `db/write-bound.ts` ("it stays below the 1 000 ms the ceiling keeps under what a
 * sender waits") and nothing held it: a margin raised to 1 000 ms, or a ceiling raised to the wait itself, would have
 * left every other gate green and the sender giving up before the answer.
 *
 * ## Derived, never listed
 *
 * All four numbers are read from the modules that own them — the ceiling from the setting's own row in
 * `NUMERIC_SETTINGS` (the one boot validates the environment against), the margin and the kill window from
 * `write-bound.ts`, the wait from `sync/peer-timeouts.ts` (the number the sender's `AbortSignal.timeout` uses). Nothing
 * here is a literal copy of any of them.
 *
 * Run: node --test testing/standalone/a-write-bound-answers-before-the-sender-gives-up.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NUMERIC_SETTINGS, validateNumericEnv } from '../../server/dist/config/env-num.js';
import { SERVER_FIRST_MARGIN_MS, KILL_WAIT_MS, holdDeadlineMs } from '../../server/dist/db/write-bound.js';
import { BATCH_FETCH_TIMEOUT_MS } from '../../server/dist/sync/peer-timeouts.js';

const holdSetting = () => NUMERIC_SETTINGS.find(s => s.name === 'YTHRIL_HOLD_DEADLINE_MS');

describe('the write bound answers a push before its sender gives up', () => {
  it('the three numbers exist, so the relation below is about something', () => {
    assert.ok(holdSetting(), 'YTHRIL_HOLD_DEADLINE_MS is no longer a row of NUMERIC_SETTINGS — re-anchor this gate on the setting that bounds a hold');
    assert.ok(Number.isInteger(holdSetting().max) && holdSetting().max > 0, `the hold deadline's ceiling is ${holdSetting().max}`);
    assert.ok(Number.isInteger(SERVER_FIRST_MARGIN_MS) && SERVER_FIRST_MARGIN_MS > 0, `SERVER_FIRST_MARGIN_MS is ${SERVER_FIRST_MARGIN_MS}`);
    assert.ok(Number.isInteger(BATCH_FETCH_TIMEOUT_MS) && BATCH_FETCH_TIMEOUT_MS > 0, `BATCH_FETCH_TIMEOUT_MS is ${BATCH_FETCH_TIMEOUT_MS}`);
    assert.ok(Number.isInteger(KILL_WAIT_MS) && KILL_WAIT_MS > 0, `KILL_WAIT_MS is ${KILL_WAIT_MS}`);
  });

  it('the longest a hold can last (the ceiling, the backstop margin and the kill window) is under what a sender waits', () => {
    const longest = holdSetting().max + SERVER_FIRST_MARGIN_MS + KILL_WAIT_MS;
    assert.ok(longest < BATCH_FETCH_TIMEOUT_MS,
      `a hold at its ceiling (${holdSetting().max} ms) can be answered ${SERVER_FIRST_MARGIN_MS} ms late, and then ${KILL_WAIT_MS} ms more while the backstop `
      + `kills the server operation, at ${longest} ms — not under the ${BATCH_FETCH_TIMEOUT_MS} ms a sender waits for a push answer, so the sender gives up before the 503`);
  });

  it('so does the default hold, which is what an operator who sets nothing gets', () => {
    assert.ok(holdDeadlineMs() + SERVER_FIRST_MARGIN_MS + KILL_WAIT_MS < BATCH_FETCH_TIMEOUT_MS,
      `the default hold deadline (${holdDeadlineMs()} ms) plus the margin and the kill window reaches the sender's ${BATCH_FETCH_TIMEOUT_MS} ms wait`);
    assert.ok(holdDeadlineMs() <= holdSetting().max, 'the default hold deadline is above the ceiling the setting allows');
  });

  it('the ceiling really is where the environment is refused: one past it fails boot validation, the ceiling itself passes', () => {
    const before = process.env['YTHRIL_HOLD_DEADLINE_MS'];
    try {
      process.env['YTHRIL_HOLD_DEADLINE_MS'] = String(holdSetting().max);
      const atCeiling = validateNumericEnv();
      assert.deepEqual(atCeiling.problems.filter(p => p.includes('YTHRIL_HOLD_DEADLINE_MS')), [], 'the ceiling itself is refused');
      process.env['YTHRIL_HOLD_DEADLINE_MS'] = String(holdSetting().max + 1);
      const past = validateNumericEnv();
      assert.ok(past.problems.some(p => p.includes('YTHRIL_HOLD_DEADLINE_MS')), 'a value past the ceiling is accepted — the row\'s max is not what boot enforces');
    } finally {
      if (before === undefined) delete process.env['YTHRIL_HOLD_DEADLINE_MS']; else process.env['YTHRIL_HOLD_DEADLINE_MS'] = before;
    }
  });
});
