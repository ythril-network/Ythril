/**
 * The verdict over one lane of the write-landing experiment states the RULE before the fixture (`Q-712`).
 *
 * ## The defect it prevents
 *
 * The experiment (`_write-landing-experiment.mjs`) holds one rule: a write the bound ended never lands after the answer. Each lane's
 * verdict also checks its fixture (the lock released cleanly, the call was answered, a write was alive behind the lock). It asserted
 * those first, and node stops at the first failing assertion, so a repetition whose release failed was reported as "the lock could
 * not be released cleanly" and never said whether its write LANDED. In CI run 42108181905 both fork lanes failed that way at once
 * (a database stall kept the killed write alive past the drain), and the one fact that decides between a slow database and the
 * defect itself was not in the report.
 *
 * ## The rule this file holds
 *
 * - A repetition that landed fails on the landing, whatever else failed beside it.
 * - Each fixture failure alone still fails the lane, with its own message: none is dropped by the reorder.
 * - A lane whose repetitions all held passes.
 *
 * Run: node --test testing/standalone/a-landing-verdict-names-the-landing-first.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertLaneHeld } from './_landing-verdict.mjs';

const REPS = 3;
const O = { reps: REPS, capMs: 5500, maxAttempts: 4, clockWindowMs: 400 };
const door = { name: 'door: a fork', collection: 'landlane0_facts', expect503: true };

/** One repetition that held everything: answered 503 by the bound, a write alive behind the lock, released cleanly, nothing landed. */
const held = (rep) => ({
  rep, attempts: 1, fixtureError: null, answered: true, elapsedMs: 4000, sawStall: true, status: 503, said: 'store-side failure',
  serverSaid: [], thrown: null, releaseError: null, fromStall: true, landed: [],
});
const lane = (patch = {}, at = 1) => Array.from({ length: REPS }, (_, i) => (i === at ? { ...held(i), ...patch } : held(i)));

describe('the verdict over a lane of the write-landing experiment', () => {
  it('a lane whose repetitions all held passes', () => {
    assert.doesNotThrow(() => assertLaneHeld(door, lane(), [], O));
  });

  it('a repetition whose release failed AND whose write landed fails on the landing', () => {
    const rs = lane({ releaseError: 'waitFor timed out after 5000ms waiting for no write alive', landed: ['facts:fork-1 inserted'] });
    assert.throws(() => assertLaneHeld(door, rs, [], O), /LANDED[\s\S]*fork-1/);
  });

  it('a landing under every other fixture failure at once is still reported as the landing', () => {
    const rs = lane({
      releaseError: 'drain', answered: true, sawStall: false, status: 500, thrown: null, fixtureError: null, elapsedMs: 100,
      landed: ['facts:fork-2 inserted'],
    });
    assert.throws(() => assertLaneHeld(door, rs, [], { ...O, clientTimeoutMs: 1500 }), /LANDED[\s\S]*fork-2/);
  });

  it('a landing of an attempt that was run again (it proved nothing) is reported too', () => {
    assert.throws(() => assertLaneHeld(door, lane(), [{ ...held(1), attempt: 1, sawStall: false, landed: ['facts:fork-3 inserted'] }], O), /LANDED[\s\S]*fork-3/);
  });

  // Each fixture failure alone: the reorder must drop none of them.
  const alone = [
    ['too few repetitions ran', () => lane().slice(1), /only 2 of 3 repetitions ran/],
    ['the release failed', () => lane({ releaseError: 'waitFor timed out' }), /could not be released cleanly/],
    ['the fixture failed', () => lane({ fixtureError: 'during the seed: boom' }), /a repetition could not run/],
    ['the call was never answered', () => lane({ answered: false }), /no bound ended it/],
    ['no write was alive behind the lock', () => lane({ sawStall: false }), /no write was ever alive/],
    ['the answer was not the bound\'s timeout', () => lane({ status: 200 }), /not with the bound's timeout/],
    ['a door answered something else than 503', () => lane({ status: undefined, thrown: 'StoreTimeout: timed out' }), /not answered 503/],
  ];
  for (const [what, rs, message] of alone) {
    it(`${what}: the lane fails with its own message`, () => {
      assert.throws(() => assertLaneHeld(door, rs(), [], O), message);
    });
  }

  it('an answer within the client\'s own clock fails a client-timeout lane', () => {
    assert.throws(() => assertLaneHeld(door, lane({ elapsedMs: 1600 }), [], { ...O, clientTimeoutMs: 1500, boundMs: 3000 }), /answered within 400 ms of the client's own clock/);
  });

  it('a holder lane with a designed answer is held to that answer, not to a 503', () => {
    const holder = { name: 'holder x: a move', collection: 'landlane9_files', expect503: false, endedAs: /owed/ };
    assert.doesNotThrow(() => assertLaneHeld(holder, lane().map(r => ({ ...r, status: undefined, thrown: 'Error: the rows are owed' })), [], O));
    assert.throws(() => assertLaneHeld(holder, lane(), [], O), /its designed answer/);
  });
});
