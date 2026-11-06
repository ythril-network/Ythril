/**
 * What one lane's repetitions of the write-landing experiment say: the verdict `_write-landing-experiment.mjs` gives each lane
 * (`Q-372`, `Q-712`).
 *
 * ## Why a module
 *
 * The experiment holds ONE rule, "a write the bound ended never lands after the answer", and around it checks its own fixture: the
 * repetitions ran, the call was answered by the bound, a write was alive behind the lock, the lock was released cleanly. The order
 * of those checks decides what a failure says, because node stops at the first failing assertion. This is the one place that
 * order is written, with the test that holds it (`a-landing-verdict-names-the-landing-first`): the rule first, then the fixture,
 * so a repetition whose fixture also failed still says whether its write landed.
 *
 * @param {{ name: string, collection: string, expect503: boolean, endedAs?: RegExp }} lane
 * @param {Array<object>} rs  one result per repetition (`finishOnce`)
 * @param {Array<object>} discarded  the attempts that proved nothing and were run again (`notASample`)
 * @param {{ reps: number, capMs: number, maxAttempts: number, clockWindowMs: number, clientTimeoutMs?: number, boundMs?: number, seamError?: Error | null }} o
 */
import assert from 'node:assert/strict';

export function assertLaneHeld(lane, rs, discarded, { reps, capMs, maxAttempts, clockWindowMs, clientTimeoutMs, boundMs, seamError = null }) {
  assert.equal(rs.length, reps, `only ${rs.length} of ${reps} repetitions ran — ${seamError ? 'no seam' : 'the experiment stopped'}`);
  // THE RULE FIRST. Every check below is of the fixture, and node stops at the first that fails: placed after them, a landing
  // beside a failed release was never reported (CI run 42108181905, Q-712). An attempt that proved nothing and was run again is
  // read for a landing too: a write it left must not appear later.
  const landed = [...rs, ...discarded].filter(r => r.landed.length > 0);
  assert.deepEqual(landed.map(r => `#${r.rep}: ${r.landed.join('; ')}`), [],
    `${lane.name}: in ${landed.length} of ${reps} repetitions the write the caller was told had timed out LANDED after the answer — `
    + `the client's deadline passed before the server's, so the server operation outlived the answer and the hold`);
  if (clientTimeoutMs !== undefined) {
    const early = rs.filter(r => r.answered && r.elapsedMs < clientTimeoutMs + clockWindowMs);
    assert.deepEqual(early.map(r => `#${r.rep}: answered after ${r.elapsedMs} ms`), [],
      `${lane.name}: answered within ${clockWindowMs} ms of the client's own clock (${clientTimeoutMs} ms), well before the server's deadline (${boundMs} ms) — a client-side clock, the \`timeoutMS\` this client inherited from `
      + 'MONGO_URI, ended the write first; the bound must carry the server\'s deadline and no driver clock of its own');
  }
  const broken = rs.filter(r => r.fixtureError);
  assert.deepEqual(broken.map(r => `#${r.rep}: ${r.fixtureError.slice(0, 500)}`), [],
    `${lane.name}: a repetition could not run. An E11000 from holdDocumentLock means a write of an EARLIER repetition `
    + 'landed after this one wiped its space, which is the defect itself, seen from the next case');
  const unanswered = rs.filter(r => !r.answered);
  assert.deepEqual(unanswered.map(r => `#${r.rep}`), [],
    `${lane.name}: still waiting ${capMs} ms into a write stalled behind a lock — no bound ended it`);
  const unstalled = rs.filter(r => !r.sawStall);
  assert.deepEqual(unstalled.map(r => `#${r.rep}: answered after ${r.elapsedMs} ms (${r.thrown ?? r.status}: ${r.said}), ${r.attempts} attempt(s); the server said: ${r.serverSaid.join(' | ') || 'nothing'}`), [],
    `${lane.name}: no write was ever alive on ${lane.collection} while the call waited, in ${maxAttempts} attempts — the lock stalled nothing, so "nothing landed" proves nothing`);
  // The bound's timeout, unless the lane's own designed answer says otherwise (`endedAs`, `_seq-hold-cases.mjs`: a move whose rows are not carried is OWED).
  const notTimedOut = rs.filter(r => !(lane.endedAs ? lane.endedAs.test(r.thrown ?? '') : (r.status === 503 || /Timeout|timed out/i.test(r.thrown ?? ''))));
  assert.deepEqual(notTimedOut.map(r => `#${r.rep}: ${r.thrown ?? r.status}`), [],
    `${lane.name}: answered, but not with ${lane.endedAs ? `its designed answer (${lane.endedAs})` : 'the bound\'s timeout'} — the write was not ended by the bound`);
  if (lane.expect503) {
    assert.deepEqual(rs.filter(r => r.status !== 503).map(r => `#${r.rep}: ${r.status ?? r.thrown}`), [], `${lane.name}: not answered 503`);
  }
  assert.deepEqual(rs.filter(r => r.releaseError).map(r => `#${r.rep}: ${r.releaseError}`), [],
    `${lane.name}: the lock could not be released cleanly`);
}
