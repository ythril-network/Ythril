/**
 * Whether a file record whose bytes are gone may be removed NOW is ONE pure question, `absentRowIsDue(row, facts)` of
 * `server/src/files/absent-bytes-sweep.ts`, and this is its whole truth table (bundle-70, Q-337, slice S4).
 *
 * ## What it prevents
 *
 * The owner decided "remove meta with the file": a record whose bytes are gone goes with them, on THIS instance, with no tombstone. That
 * is irreversible, and the record may be one that only LOOKS like an orphan: bytes still arriving from a peer, a restored or imported
 * record, a move still carrying it, a delete in flight, an unmounted volume that makes every file of a space read as gone. A rule spread
 * over the sweep's steps (an age check here, a hold there) is a rule each step can drop; written once as a predicate it is a table a
 * reviewer reads whole. A predicate that answers `due` where one row of this table says wait deletes a record somebody still needed.
 *
 * ## The contract the implementation meets (the parent implements against it; the facts are what the sweep gathers by code)
 *
 *     absentRowIsDue(row, facts) -> { due: boolean, reason: null | string }
 *
 *  - `row`: `{ path, sha256?, bytesAbsentSince }` (`bytesAbsentSince` an ISO instant, the sweep's `now` at the pass that first saw the bytes absent).
 *  - `facts.now`: ms (the sweep's `now` parameter; the predicate never reads a clock).
 *  - `facts.spaceRestoredAt`: ms or null, the space's local `filesRestoredAt` (a restore or import clears every stamp it brings back and sets it).
 *  - `facts.members`: ONE entry per network member THIS instance pulls the space from: `{ id, leg }` where `leg` is null (no leg yet) or
 *    `{ manifestReadAt: ms, complete: boolean, carriesUnreadable: boolean, namesPath: boolean, truncated: boolean }`: our manifest read of that member
 *    for the leg, whether the leg refused nothing, whether the peer's manifest carried the `unreadable` field (a peer of this version or later),
 *    whether that list names the row's path (or an ancestor directory of it), and whether the peer cut the list short (`unreadableTruncated`).
 *  - `facts.holds`: `{ owedMove, tombstone, spaceNotWritable, chunkSession }`, each boolean, default false: a move still owes the record,
 *    a pending or held file tombstone is at the path, the space is not taking writes, a chunked-upload session is open at the path.
 *  - `facts.lastPass`: the counts of the LAST COMPLETE PASS of the row's space, `{ recorded, present, absent, unlooked }`, or null when none completed.
 *  - `facts.directory`: for a row below a top-level directory `{ recorded, absent, gone }` (rows recorded under it, rows of them absent, the directory itself
 *    absent from disk), or null for a file at the root.
 *  - the verdict `reason` is null when due, else one of: `unstamped`, `no_complete_pass`, `mass_loss`, `mass_loss_directory`, `owed_move`, `tombstone`,
 *    `not_writable`, `chunk_session`, `window`, `legs`. Each case below holds ONE cause, so the order of the checks never decides a case.
 *
 * ## The rule (design plan-final.md S4, as amended by plan-vet.md)
 *
 *  - Window, from the stamp: 1 day for a row that recorded bytes (sha256 set), WAIT_DAYS (30) for a row with none, and for every row of a space restored
 *    or imported within the last WAIT_DAYS.
 *  - Evidence: with members, EVERY member needs a leg that is complete, whose manifest was read AFTER the stamp, whose manifest carries `unreadable`, does not
 *    name the path and was not truncated. A space with no pulling member is due on time alone. The ceiling, WAIT_DAYS after the stamp, releases the evidence
 *    requirement and nothing else.
 *  - Holds, each on its own and at the ceiling too: owed move, tombstone, space not taking writes, open chunk session.
 *  - Mass loss, from the last complete pass: held when `present == 0` with at least one recorded row, or when `(absent + unlooked) * 2 > recorded`;
 *    exactly half is not held; no complete pass yet is held. Per top-level directory: held when every recorded row under it is absent and the directory is gone.
 *
 * Red on 8ee92312: the module does not exist (`absentRowIsDue` is not exported); every case says so through `verdict`, not through the import.
 *
 * Run: node --test testing/standalone/an-absent-bytes-row-is-due-by-one-predicate.test.js (requires a prior `npm run build -w @ythril/server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DAY = 86_400_000;
const WAIT_DAYS = 30;
const STAMP = Date.UTC(2026, 9, 1);
const SHA = 'ab'.repeat(32);

let mod;
try { mod = await import('../../server/dist/files/absent-bytes-sweep.js'); } catch (err) { mod = { importFailure: err }; }
/** The predicate's verdict, or the plain failure that there is none. */
function verdict(row, facts) {
  assert.equal(typeof mod.absentRowIsDue, 'function',
    `files/absent-bytes-sweep.ts exports no absentRowIsDue (the one pure question "may this stamped row be removed now"): ${mod.importFailure?.message ?? 'not exported'}`);
  return mod.absentRowIsDue(row, facts);
}

/** A row a pass stamped at STAMP and a world in which it is due 1 day and a millisecond later: every case changes ONE thing from it. */
const row = (over = {}) => ({ path: 'docs/a.txt', sha256: SHA, bytesAbsentSince: new Date(STAMP).toISOString(), ...over });
const facts = (over = {}) => ({
  now: STAMP + DAY + 1, spaceRestoredAt: null, members: [], holds: {},
  lastPass: { recorded: 4, present: 3, absent: 1, unlooked: 0 }, directory: null, ...over,
});
const leg = (over = {}) => ({ manifestReadAt: STAMP + 1_000, complete: true, carriesUnreadable: true, namesPath: false, truncated: false, ...over });
const member = (id, l) => ({ id, leg: l });

/** [name, row, facts, due, reason] */
const TABLE = [
  // ── the control ──
  ['control: a stamped row with sha256, one day and a millisecond old, a healthy space, nobody to deliver: due', row(), facts(), true, null],
  ['a row that was never stamped is not due', row({ bytesAbsentSince: undefined }), facts(), false, 'unstamped'],

  // ── the window ──
  ['sha256 row, a millisecond short of 1 day: wait', row(), facts({ now: STAMP + DAY - 1 }), false, 'window'],
  ['sha256 row, a millisecond past 1 day: due', row(), facts({ now: STAMP + DAY + 1 }), true, null],
  ['a row with NO sha256 (its bytes may still be arriving) is not due after 1 day', row({ sha256: undefined }), facts({ now: STAMP + 2 * DAY }), false, 'window'],
  ['a row with no sha256 is not due a millisecond short of WAIT_DAYS', row({ sha256: undefined }), facts({ now: STAMP + WAIT_DAYS * DAY - 1 }), false, 'window'],
  ['a row with no sha256 is due a millisecond past WAIT_DAYS', row({ sha256: undefined }), facts({ now: STAMP + WAIT_DAYS * DAY + 1 }), true, null],
  ['sha256 row of a space restored 29 days ago waits WAIT_DAYS, not 1 day', row(), facts({ now: STAMP + 2 * DAY, spaceRestoredAt: STAMP + 2 * DAY - 29 * DAY }), false, 'window'],
  ['sha256 row of a space restored 31 days ago is back to the 1 day window', row(), facts({ now: STAMP + 2 * DAY, spaceRestoredAt: STAMP + 2 * DAY - 31 * DAY }), true, null],
  ['sha256 row of a restored space is due past WAIT_DAYS from its stamp', row(), facts({ now: STAMP + WAIT_DAYS * DAY + 1, spaceRestoredAt: STAMP - 1 }), true, null],

  // ── evidence of a complete leg ──
  ['one pulling member with a complete leg read after the stamp: due', row(), facts({ members: [member('m1', leg())] }), true, null],
  ['a member with no leg yet: wait', row(), facts({ members: [member('m1', null)] }), false, 'legs'],
  ['a leg whose manifest was read BEFORE the stamp is no evidence', row(), facts({ members: [member('m1', leg({ manifestReadAt: STAMP - 1 }))] }), false, 'legs'],
  ['a leg whose manifest was read a millisecond after the stamp is evidence', row(), facts({ members: [member('m1', leg({ manifestReadAt: STAMP + 1 }))] }), true, null],
  ['a leg that refused or deferred something is no evidence', row(), facts({ members: [member('m1', leg({ complete: false }))] }), false, 'legs'],
  ['a leg with an older peer (its manifest carries no `unreadable`) is no evidence', row(), facts({ members: [member('m1', leg({ carriesUnreadable: false }))] }), false, 'legs'],
  ['a leg whose peer names the path unreadable is no evidence for that path', row(), facts({ members: [member('m1', leg({ namesPath: true }))] }), false, 'legs'],
  ['a leg whose peer list was truncated is no evidence for any path', row(), facts({ members: [member('m1', leg({ truncated: true }))] }), false, 'legs'],
  ['two members, one with evidence and one with none: wait', row(), facts({ members: [member('m1', leg()), member('m2', null)] }), false, 'legs'],
  ['two members, both with evidence: due', row(), facts({ members: [member('m1', leg()), member('m2', leg())] }), true, null],
  ['a no-sha256 row with every leg complete is still held to WAIT_DAYS', row({ sha256: undefined }), facts({ now: STAMP + 2 * DAY, members: [member('m1', leg())] }), false, 'window'],
  ['a no-sha256 row past WAIT_DAYS with a complete leg is due', row({ sha256: undefined }), facts({ now: STAMP + WAIT_DAYS * DAY + 1, members: [member('m1', leg())] }), true, null],

  // ── the ceiling: WAIT_DAYS after the stamp releases the evidence requirement, nothing else ──
  ['the ceiling releases a member that never completed a leg', row(), facts({ now: STAMP + WAIT_DAYS * DAY + 1, members: [member('m1', null)] }), true, null],
  ['the ceiling releases an older peer', row(), facts({ now: STAMP + WAIT_DAYS * DAY + 1, members: [member('m1', leg({ carriesUnreadable: false }))] }), true, null],
  ['a millisecond short of the ceiling an absent leg still holds', row(), facts({ now: STAMP + WAIT_DAYS * DAY - 1, members: [member('m1', null)] }), false, 'legs'],
  ['the ceiling does not release the mass-loss hold', row(), facts({ now: STAMP + WAIT_DAYS * DAY + 1, members: [member('m1', null)], lastPass: { recorded: 3, present: 0, absent: 3, unlooked: 0 } }), false, 'mass_loss'],
  ['the ceiling does not release an owed move', row(), facts({ now: STAMP + WAIT_DAYS * DAY + 1, holds: { owedMove: true } }), false, 'owed_move'],

  // ── every hold, each alone ──
  ['a move that still owes the record holds it', row(), facts({ holds: { owedMove: true } }), false, 'owed_move'],
  ['a pending or held file tombstone at the path holds it', row(), facts({ holds: { tombstone: true } }), false, 'tombstone'],
  ['a space that is not taking writes holds it', row(), facts({ holds: { spaceNotWritable: true } }), false, 'not_writable'],
  ['an open chunked-upload session at the path holds it', row(), facts({ holds: { chunkSession: true } }), false, 'chunk_session'],
  ['a hold that is false changes nothing', row(), facts({ holds: { owedMove: false, tombstone: false, spaceNotWritable: false, chunkSession: false } }), true, null],

  // ── mass loss per space, from the last complete pass ──
  ['no complete pass of the space yet: nothing is removed', row(), facts({ lastPass: null }), false, 'no_complete_pass'],
  ['one absent of four recorded: not held', row(), facts({ lastPass: { recorded: 4, present: 3, absent: 1, unlooked: 0 } }), true, null],
  ['EXACTLY half absent (2 of 4) is not held', row(), facts({ lastPass: { recorded: 4, present: 2, absent: 2, unlooked: 0 } }), true, null],
  ['more than half absent (3 of 5) is held', row(), facts({ lastPass: { recorded: 5, present: 2, absent: 3, unlooked: 0 } }), false, 'mass_loss'],
  ['a one-row space whose row is absent is held (one missing file in a one-file space reads as a missing volume)', row(), facts({ lastPass: { recorded: 1, present: 0, absent: 1, unlooked: 0 } }), false, 'mass_loss'],
  ['a space whose every recorded row is absent is held (2 of 2)', row(), facts({ lastPass: { recorded: 2, present: 0, absent: 2, unlooked: 0 } }), false, 'mass_loss'],
  ['a space with one present row and one absent (exactly half) is not held', row(), facts({ lastPass: { recorded: 2, present: 1, absent: 1, unlooked: 0 } }), true, null],
  ['unlooked rows count AGAINST removal: (1 absent + 1 unlooked) of 4 is exactly half, not held', row(), facts({ lastPass: { recorded: 4, present: 2, absent: 1, unlooked: 1 } }), true, null],
  ['unlooked rows count against removal: (1 absent + 2 unlooked) of 4 is more than half, held', row(), facts({ lastPass: { recorded: 4, present: 1, absent: 1, unlooked: 2 } }), false, 'mass_loss'],
  ['unlooked rows count against removal: (2 absent + 1 unlooked) of 5 is more than half, held', row(), facts({ lastPass: { recorded: 5, present: 2, absent: 2, unlooked: 1 } }), false, 'mass_loss'],
  ['nothing present with the rest unlooked is held (1 absent, 2 unlooked, 0 present)', row(), facts({ lastPass: { recorded: 3, present: 0, absent: 1, unlooked: 2 } }), false, 'mass_loss'],

  // ── mass loss per top-level directory ──
  ['every recorded row under one directory absent and the directory itself gone: held as a unit (a missing mount)', row(), facts({ directory: { recorded: 3, absent: 3, gone: true } }), false, 'mass_loss_directory'],
  ['every row under a directory absent but the directory still on disk: due (the files were removed, not the mount)', row(), facts({ directory: { recorded: 3, absent: 3, gone: false } }), true, null],
  ['the directory gone but a recorded row under it NOT absent: not the unit rule', row(), facts({ directory: { recorded: 3, absent: 2, gone: true } }), true, null],
  ['a file at the root has no directory to hold it', row({ path: 'a.txt' }), facts({ directory: null }), true, null],
];

describe('absentRowIsDue: one truth table for "may this stamped record be removed now"', () => {
  for (const [name, r, f, due, reason] of TABLE) {
    it(name, () => {
      const v = verdict(r, f);
      assert.equal(v.due, due, `due: ${JSON.stringify(v)} for ${JSON.stringify({ row: r, facts: f })}`);
      assert.equal(v.reason ?? null, reason, `reason: ${JSON.stringify(v)}`);
    });
  }

  it('the table holds both verdicts and every hold reason (a table of one answer proves nothing)', () => {
    assert.ok(TABLE.some(t => t[3] === true) && TABLE.some(t => t[3] === false));
    for (const reason of ['unstamped', 'no_complete_pass', 'mass_loss', 'mass_loss_directory', 'owed_move', 'tombstone', 'not_writable', 'chunk_session', 'window', 'legs']) {
      assert.ok(TABLE.some(t => t[4] === reason), `no case holds the reason ${reason}`);
    }
  });

  it('the predicate reads no clock and mutates nothing: the same row and facts answer alike, and the inputs are unchanged', () => {
    const r = row(); const f = facts({ members: [member('m1', leg())] });
    const before = JSON.stringify({ r, f });
    const first = verdict(r, f);
    assert.deepEqual(verdict(r, f), first);
    assert.equal(JSON.stringify({ r, f }), before, 'the predicate changed its inputs');
    assert.equal(first.due, true);
    assert.equal(verdict(r, { ...f, now: Date.now() + 400 * DAY }).due, true, 'a later now cannot turn a due row into one that waits');
  });
});
