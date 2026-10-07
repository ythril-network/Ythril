/**
 * The one-time re-read of an upstream's tombstones is owed until it has completed, and `'done'` is the only exit.
 *
 * ## The rule (`nextRereadState`, plan §4)
 *
 * The state per upstream member and space is a string that is absent, a cursor, or `'done'`:
 *
 *   - **absent** — the re-read is owed from the start;
 *   - **a cursor** — it is owed from there (the previous cycle stopped at a page bound and said where);
 *   - **`'done'`** — it ran to the end once and is never asked for again.
 *
 * A cycle's outcome moves it: a COMPLETE read is `'done'`; a partial read with a cursor is that cursor; a stop or a
 * failure (an unknown type, a wedge, a 403 or 5xx) changes nothing, so the repair stays owed and is said once per
 * window by the caller. `'done'` is absorbing: no outcome can re-open a finished repair, because a re-read re-applies
 * deletions and a second full read is a cost nobody asked for.
 *
 * ## Why a pure function
 *
 * The state machine is the whole of what keeps the repair from being lost or repeated, and it is decidable without a
 * database or a clock. The door tests (-db) hold that the sync cycle CALLS it; this holds what it answers.
 *
 * ## Mutation that turns it red
 *
 * Let a stop clear the state (the repair restarts from 0 after every transient 503), let `'done'` accept a cursor
 * (a finished repair re-opens), or make a complete outcome keep the cursor (it is owed for ever).
 *
 * Run: node --test testing/standalone/a-tombstone-reread-is-owed-until-it-completes.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/sync/deletion-authority.js', import.meta.url); });
const next = (rule) => needModule(loaded, ['nextRereadState'], rule).nextRereadState;

const STATES = [undefined, 'cursor-1', 'done'];

describe('nextRereadState', () => {
  it('absent -> a partial read leaves the cursor it reached', () => {
    assert.equal(next('absent/partial')(undefined, { complete: false, cursor: 'c1' }), 'c1');
  });

  it('absent -> a complete read is done (a repair that read to the end in one cycle is finished)', () => {
    assert.equal(next('absent/complete')(undefined, { complete: true }), 'done');
  });

  it('a cursor -> a further partial read advances the cursor, and a complete one finishes it', () => {
    const f = next('cursor/…');
    assert.equal(f('cursor-1', { complete: false, cursor: 'cursor-2' }), 'cursor-2');
    assert.equal(f('cursor-2', { complete: true }), 'done');
  });

  it('a complete read is done from EVERY state, and a cursor it carries does not keep it owed', () => {
    const f = next('complete');
    for (const s of STATES) {
      assert.equal(f(s, { complete: true }), 'done', `from ${s}`);
      assert.equal(f(s, { complete: true, cursor: 'left-over' }), 'done', `from ${s}, with a stale cursor on the outcome`);
    }
  });

  it('a stop changes nothing: absent stays absent (owed from 0), a cursor stays where it was', () => {
    const f = next('stop');
    for (const s of ['cursor-1', undefined]) {
      assert.equal(f(s, { complete: false, stopped: true }), s, `from ${s}`);
    }
  });

  it('a failure with no cursor changes nothing either', () => {
    const f = next('failure');
    for (const s of ['cursor-1', undefined]) assert.equal(f(s, { complete: false }), s, `from ${s}`);
  });

  it('done is absorbing: no outcome re-opens it', () => {
    const f = next('done');
    const outcomes = [
      { complete: true }, { complete: true, cursor: 'x' },
      { complete: false, cursor: 'x' }, { complete: false, stopped: true }, { complete: false },
    ];
    for (const o of outcomes) assert.equal(f('done', o), 'done', JSON.stringify(o));
  });

  it('the whole life of a repair: owed, partial, stopped, partial, complete, then never again', () => {
    const f = next('life');
    let s = undefined;
    const steps = [
      [{ complete: false, cursor: 'c1' }, 'c1'],
      [{ complete: false, stopped: true }, 'c1'],
      [{ complete: false, stopped: true }, 'c1'],
      [{ complete: false, cursor: 'c2' }, 'c2'],
      [{ complete: true }, 'done'],
      [{ complete: false, cursor: 'c3' }, 'done'],
      [{ complete: false, stopped: true }, 'done'],
      [{ complete: true }, 'done'],
    ];
    for (const [outcome, want] of steps) {
      s = f(s, outcome);
      assert.equal(s, want, `after ${JSON.stringify(outcome)}`);
    }
  });

  it('is a function of its arguments: the same input answers the same, and the outcome is not touched', () => {
    const f = next('pure');
    const outcome = Object.freeze({ complete: false, cursor: 'c9' });
    assert.equal(f('c1', outcome), f('c1', outcome));
    assert.deepEqual(outcome, { complete: false, cursor: 'c9' });
  });
});
