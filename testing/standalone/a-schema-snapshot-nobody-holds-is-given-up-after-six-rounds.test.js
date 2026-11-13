/**
 * A schema snapshot every candidate member has answered "not held" for, six back-off rounds in a row, is no longer asked for, until a new arrival
 * carrying it names a deliverer again (bundle-266, design r3 S-8; reliability lens S3).
 *
 * ## Why
 *
 * Once the sweep (Q-739) removes rows, "nobody holds it" is reachable network-wide: a peer still holding a record stamped X after every member removed
 * X's row is answered `not_held` by all of them. The owed set backs off (60 s doubling to an hour, `BACKOFF_FIRST_MS` / `BACKOFF_MAX_MS`), and today it
 * asks again every hour for as long as the process lives. After `OWED_GIVE_UP_ROUNDS` (6) rounds in which every candidate answered `not_held`, the
 * fingerprint is given up, said once (warnOnce); a new deliverer resets the count, as it resets the back-off today.
 *
 * ## How
 *
 * The owed set is in memory (`sync/schema-snapshot-owed.ts`): `noteOwedSchemaSnapshot`, `noteNotHeld`, `owedTo`, with the clock passed in. Each round
 * is asked after the previous back-off has run out, so only the give-up can keep it from being asked.
 *
 * ## Seen red at 82208a6b
 *
 * The seventh `owedTo` names the fingerprint again: nothing gives up, the back-off ceiling just repeats.
 *
 * Run: node --test testing/standalone/a-schema-snapshot-nobody-holds-is-given-up-after-six-rounds.test.js (a prior `npm run build -w @ythril/server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logLinesDuring } from './_log-lines.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-owed-give-up-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = tmpDir;

const SPACE = 'giveup';
const X = 'ab'.repeat(32);
const CANDIDATES = ['member-1', 'member-2'];
const HOUR = 3_600_000;

let owed;
before(async () => { owed = await import('../../server/dist/sync/schema-snapshot-owed.js'); });

/** One round: every candidate is asked (the back-off has run out) and answers not_held. Returns the time after it. */
function notHeldRound(now) {
  for (const m of CANDIDATES) {
    assert.deepEqual(owed.owedTo(SPACE, m, CANDIDATES, now), [X], `round at +${(now - T0) / HOUR} h: ${m} was not asked for X`);
    owed.noteNotHeld(SPACE, X, m, CANDIDATES, now);
  }
  return now + 2 * HOUR;
}
const T0 = Date.parse('2026-11-13T00:00:00.000Z');

describe('a snapshot nobody holds is given up after six not-held rounds', () => {
  it('the seventh time it is not asked; a warn line says so once; a new deliverer brings it back', async () => {
    owed.forgetOwedSchemaSnapshots();
    owed.noteOwedSchemaSnapshot(SPACE, X);
    let now = T0;
    for (let round = 1; round <= 5; round++) now = notHeldRound(now);
    const { lines } = await logLinesDuring(() => { now = notHeldRound(now); });
    assert.deepEqual(CANDIDATES.map(m => owed.owedTo(SPACE, m, CANDIDATES, now + 10 * HOUR)), [[], []],
      'after six rounds in which every candidate answered not_held, the fingerprint is still asked for');
    const said = lines.filter(l => l.includes(X.slice(0, 12)) && l.includes(SPACE));
    assert.equal(said.length, 1, `want one line naming the space and the fingerprint prefix when it is given up: ${JSON.stringify(lines)}`);
    const again = await logLinesDuring(() => owed.owedTo(SPACE, CANDIDATES[0], CANDIDATES, now + 20 * HOUR));
    assert.equal(again.lines.filter(l => l.includes(X.slice(0, 12))).length, 0, 'the give-up was said again');
    owed.noteOwedSchemaSnapshot(SPACE, X, 'member-3');
    assert.deepEqual(owed.owedTo(SPACE, 'member-3', [...CANDIDATES, 'member-3'], now + 21 * HOUR), [X], 'a new deliverer did not reset the give-up');
  });

  it('five rounds are not enough: the fingerprint is still asked once its back-off runs out', () => {
    owed.forgetOwedSchemaSnapshots();
    owed.noteOwedSchemaSnapshot(SPACE, X);
    let now = T0;
    for (let round = 1; round <= 5; round++) now = notHeldRound(now);
    assert.deepEqual(owed.owedTo(SPACE, CANDIDATES[0], CANDIDATES, now + 10 * HOUR), [X]);
  });
});
