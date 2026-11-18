/**
 * A conversion run restarts toward the new fingerprint instead of being superseded (Q-746, bundle-284 design r5 section 5.2 "Restart instead of
 * supersede", finding B2; the pure half: what the restarted run document holds).
 *
 * ## The rule
 *
 * When the space's fingerprint moves while a run is unfinished (any schema door, a library edit, a layer pull), or a new start arrives, the run is
 * rewritten in place by `restartedSchemaConvertRun(run, { toFp, after, start?, at })`:
 *
 * - `toFp` is the fingerprint now, the cursor resets, and `types` is the union of the old run's UNFINISHED types and the new start's, all not done;
 * - the old steps are checked again against the schema now (`after`; the before was checked once): a step that no longer holds moves to
 *   `stepsRefused` with its reason, and so does one a new step on the same source replaces; the new start's steps are added;
 * - `sources` gains the new start's, `owed` is true when any source is a round, and `syncedFirst` carries over: a restart asks for no second sync.
 *
 * ## What was wrong
 *
 * r3 superseded a run with the next one, so the types the first run had not reached were converted by nobody (B2).
 *
 * Seen red on 14af4644: `server/dist/spaces/schema-convert-run.js` does not exist.
 *
 * Run: node --test testing/standalone/a-run-restarts-toward-the-new-fingerprint.test.js (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleOrNull } from './_b81c-door.mjs';

const mod = await moduleOrNull('spaces/schema-convert-run.js');
const OLD_FP = 'a'.repeat(64);
const NEW_FP = 'b'.repeat(64);
const AT = '2026-11-18T12:00:00.000Z';

function restart(run, opts) {
  assert.ok(mod && typeof mod.restartedSchemaConvertRun === 'function',
    'server/src/spaces/schema-convert-run.ts (restartedSchemaConvertRun) is not built: a moved fingerprint has nothing to restart its run with');
  return mod.restartedSchemaConvertRun(structuredClone(run), { toFp: NEW_FP, at: AT, ...opts });
}

const RENAME_NICK = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
/** The schema now: `person` declares `alias` and no longer `nick`, so the rename still holds. */
const AFTER_OK = { typeSchemas: { entity: { person: { propertySchemas: { alias: { type: 'string' } } } }, fact: { claim: {} } } };
/** The schema now: a layer brought `nick` back, so the rename would move values the schema still accepts under the old name. */
const AFTER_NICK_BACK = { typeSchemas: { entity: { person: { propertySchemas: { alias: { type: 'string' }, nick: { type: 'string' } } } }, fact: { claim: {} } } };

const RUN = Object.freeze({
  _id: 'run', toFp: OLD_FP, state: 'running',
  types: [{ kind: 'entity', type: 'person', done: false }, { kind: 'fact', type: 'claim', done: true }, { kind: 'chrono', type: 'event', done: false }],
  steps: [RENAME_NICK], stepsRefused: [], splitDeclared: {},
  sources: [{ kind: 'round', roundId: 'r-1', at: '2026-11-18T10:00:00.000Z' }], owed: true,
  syncedFirst: { asked: 2, answered: 1 },
  startedAt: '2026-11-18T10:00:00.000Z', cursor: { kind: 'entity', type: 'person', afterId: 'e-5' },
  counts: { stamped: 3, rewritten: 2, unconverted: 0, moved: 0, edgesRestamped: 0 }, failures: 0,
});

const typeKeys = (run) => run.types.map(t => `${t.kind}:${t.type}:${t.done}`).sort();

describe('a run restarts toward the new fingerprint', () => {
  it('takes the fingerprint now, resets the cursor and keeps every unfinished type, none done', () => {
    const next = restart(RUN, { after: AFTER_OK });
    assert.equal(next.toFp, NEW_FP);
    assert.equal(next.cursor, null, 'the records stamped toward the old fingerprint are passed again');
    assert.equal(next.state, 'running');
    assert.deepEqual(typeKeys(next), ['chrono:event:false', 'entity:person:false'],
      'the unfinished types stay; the finished one is not taken again unless a start names it');
  });

  it('a new start\'s types join the unfinished ones', () => {
    const next = restart(RUN, {
      after: AFTER_OK,
      start: { types: [{ kind: 'fact', type: 'claim' }, { kind: 'entity', type: 'person' }], steps: [], source: { kind: 'act' } },
    });
    assert.deepEqual(typeKeys(next), ['chrono:event:false', 'entity:person:false', 'fact:claim:false'], 'the union, each once, none done');
  });

  it('an old step that still holds is kept', () => {
    const next = restart(RUN, { after: AFTER_OK });
    assert.deepEqual(next.steps, [RENAME_NICK]);
    assert.deepEqual(next.stepsRefused, []);
  });

  it('an old step that no longer holds moves to stepsRefused with its reason', () => {
    const next = restart(RUN, { after: AFTER_NICK_BACK });
    assert.deepEqual(next.steps, [], 'a rename between two names both still declared must not run');
    assert.equal(next.stepsRefused.length, 1);
    assert.deepEqual(next.stepsRefused[0].step, RENAME_NICK);
    assert.equal(next.stepsRefused[0].reason, 'property_still_declared');
  });

  it('a new step on the same source replaces the old one, which moves to stepsRefused', () => {
    const replacing = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'handle' };
    const after = { typeSchemas: { entity: { person: { propertySchemas: { alias: { type: 'string' }, handle: { type: 'string' } } } } } };
    const next = restart(RUN, { after, start: { types: [], steps: [replacing], source: { kind: 'act' } } });
    assert.deepEqual(next.steps, [replacing]);
    assert.deepEqual(next.stepsRefused.map(r => [r.step, r.reason]), [[RENAME_NICK, 'replaced']]);
  });

  it('sources, owed and syncedFirst carry over, and a restart asks for no second sync', () => {
    const next = restart(RUN, { after: AFTER_OK, start: { types: [], steps: [], source: { kind: 'act' } } });
    assert.deepEqual(next.sources.map(s => s.kind), ['round', 'act']);
    assert.equal(next.sources[1].at, AT);
    assert.equal(next.owed, true, 'a run with a round among its sources stays owed');
    assert.deepEqual(next.syncedFirst, { asked: 2, answered: 1 }, 'the sync already made stands: no second one');
  });

  it('a run that had not synced yet still owes its one sync after a restart; an act-only run never becomes owed', () => {
    const unsynced = { ...structuredClone(RUN), syncedFirst: undefined, sources: [{ kind: 'act', at: AT }], owed: false };
    delete unsynced.syncedFirst;
    const next = restart(unsynced, { after: AFTER_OK });
    assert.equal('syncedFirst' in next && next.syncedFirst !== undefined, false, 'absent until the step ended');
    assert.equal(next.owed, false);
  });

  it('the counts so far are kept', () => {
    assert.deepEqual(restart(RUN, { after: AFTER_OK }).counts, RUN.counts);
  });
});
