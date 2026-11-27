/**
 * The push doors are found, each has a case, and none reaches the counter's raiser (bundle-81, design rev 8 §1a, D-19 B; split out by Q-969).
 *
 * The database half, `no-push-door-moves-the-counter-db.test.js`, sends a page to each door over a counter that will not move and holds the answer
 * below 500. These three cases are its static half, and they need no database: the doors are DERIVED through the call graph (every POST route
 * mounted from `server/src/api/sync/` whose handler reaches an arrival writer, `_push-door-counter-doors.mjs`), with a floor; each has a case in the
 * database file; and no handler of them reaches `raiseVersionTo` (closures followed), a function checked to exist so a rename cannot turn the walk
 * into one over nothing. They sat in the `-db` file, so the local preflight never ran them (Q-969).
 *
 * Run: node --test testing/standalone/no-push-door-moves-the-counter.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFrom } from './_call-graph.mjs';
import { DOORS, INDEX, ARRIVAL_WRITERS, RAISE, CASE_PATHS } from './_push-door-counter-doors.mjs';

describe('no push door moves the counter: the doors, their cases and the walk', () => {
  it('the derivation finds the push doors, and the counter raiser exists, so an empty walk cannot pass', () => {
    assert.ok(DOORS.length >= 6, `only ${DOORS.length} push door(s) derived — re-anchor: ${JSON.stringify(DOORS.map(d => d.path))}`);
    assert.ok(DOORS.some(d => d.routePath === '/batch-upsert') && DOORS.some(d => d.routePath === '/tombstones'),
      `the batch or tombstone door was not derived: ${JSON.stringify(DOORS.map(d => d.path))}`);
    for (const w of ARRIVAL_WRITERS) assert.ok(INDEX.bodies.has(w), `${w} is not a function of the source index — the doors are derived from what reaches it; re-anchor`);
    assert.ok(INDEX.bodies.has(RAISE), `${RAISE} is not a function of the source index — the walk below would look for a name nothing has; re-anchor`);
    assert.ok(DOORS.every(d => d.roots.length > 0), 'a door has no handler root: the walk would pass over it');
  });

  it('every derived door has a case', () => {
    const missing = DOORS.filter(d => !CASE_PATHS.includes(d.routePath)).map(d => `${d.file} POST ${d.path}`);
    assert.deepEqual(missing, [], 'a push door with no case here is one nobody checked for a counter that follows a peer');
  });

  it('no push door reaches the counter raiser', () => {
    const reaching = DOORS.filter(d => walkFrom(INDEX, d.roots, { closures: true }).seen.has(RAISE)).map(d => `${d.file} POST ${d.path}`);
    assert.deepEqual(reaching, [], 'a push door raises the counter over what it received: an arrival lifts every later stamp of the space to a peer\'s clock, '
      + 'and a counter that will not move fails the page again');
  });
});
