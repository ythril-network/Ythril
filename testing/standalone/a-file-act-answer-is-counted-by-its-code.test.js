/**
 * A file act's refusal is ONE answer per class, and every answer a door gives is counted by its code in one place (Q-437, Q-438,
 * bundle-44 D-29, S0).
 *
 * ## What it holds
 *
 *  - every answer the module can give has the status, the `body.code` and the `path` of its class, asserted by value, and its
 *    sentence names the remedy and the space-relative paths it was built from;
 *  - `fileActAnswer` (the door's call) moves `ythril_file_act_answers_total{code}` by exactly one for exactly its code, and
 *    `fileActAnswerOf` (a classification) moves nothing, and neither does `isPathBlocked`, which only classifies: a refusal that
 *    no door answered must not be counted as an answer;
 *  - the series exists at 0 for every code before the first answer, so `rate()` has a series to read during the healthy period;
 *  - the set of codes is DERIVED from the spelling in `act-answers.ts` (each return branch spells its `code: '<x>'` literally,
 *    which is what the client spec reads), and every derived code has a case here: a code added to the module with no case
 *    here fails, instead of passing every loop over a hand-written list;
 *  - the retired code and the retired counter are gone.
 *
 * Mutations seen red (restored by hand): delete the `inc` line of `fileActAnswer`; make `isPathBlocked` call `fileActAnswer` again.
 *
 * Run: node --test testing/standalone/a-file-act-answer-is-counted-by-its-code.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';

const answers = await import('../../server/dist/files/act-answers.js');
const destination = await import('../../server/dist/files/destination.js');
const registry = await import('../../server/dist/metrics/registry.js');

const COUNTER = 'ythril_file_act_answers_total';
const SOURCE = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'server', 'src', 'files', 'act-answers.ts');

/** The module's source with comments removed, so a code spelled in prose is not a code spelled in a branch. */
function sourceWithoutComments() {
  return stripComments(readFileSync(SOURCE, 'utf8'));
}

/** Every `code: '<x>'` the module's return branches spell, in the spelling the client spec reads. */
function codesInSource() {
  return [...new Set([...sourceWithoutComments().matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]))].sort();
}

/** The counter's value per `code` label in one scrape. */
async function counted() {
  const text = await registry.register.getSingleMetricAsString(COUNTER);
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^ythril_file_act_answers_total\{(?:[^}]*,)?code="([a-z_]+)"(?:,[^}]*)?\}\s+(\S+)$/.exec(line);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

/** What each answer class must say: how to build one, and the exact status, code and path it answers. */
const CASES = [
  {
    name: 'PathBlocked', status: 409, code: 'path_blocked', path: 'blocked/x.txt',
    make: () => new answers.PathBlocked('blocked/x.txt', "'blocked/x.txt' cannot be created: a file stands where a directory is needed."),
  },
  {
    name: 'DestinationExists (bytes)', status: 409, code: 'destination_exists', path: 'b.txt', says: [/'b\.txt' already exists/, /never replaces/, /Delete it first/],
    make: () => new answers.DestinationExists('b.txt', 'bytes'),
  },
  {
    name: 'DestinationExists (record)', status: 409, code: 'destination_exists', path: 'b.txt', says: [/'b\.txt' has a file record but no bytes/, /delete_file/, /every instance/],
    make: () => new answers.DestinationExists('b.txt', 'record'),
  },
  {
    name: 'DestinationExists (rows)', status: 409, code: 'destination_exists', path: 'b.txt', says: [/'b\.txt' already has the records of another file/, /never replaces/],
    make: () => new answers.DestinationExists('b.txt', 'rows'),
  },
  {
    name: 'DestinationExists (sidecar)', status: 409, code: 'destination_exists', path: 'b.txt', says: [/'b\.txt' cannot be taken: '_converted\/b\.txt\.md' already exists/],
    make: () => new answers.DestinationExists('b.txt', 'sidecar', '_converted/b.txt.md'),
  },
  {
    name: 'DestinationHeldAfterMove', status: 409, code: 'destination_held_after_move', path: '_converted/b.txt.md',
    heldBy: 'other.txt',
    says: [/bytes of 'a\.txt' already moved to 'b\.txt'/, /'_converted\/b\.txt\.md' is held by the records of 'other\.txt'/, /Housekeeping retries the move/, /delete 'other\.txt' and repeat the move/],
    make: () => new answers.DestinationHeldAfterMove('_converted/b.txt.md', 'a.txt', 'b.txt', 'other.txt'),
  },
  {
    name: 'ConfirmRequired', status: 422, code: 'confirm_required', path: 'docs', says: [/Deleting a directory requires confirm: true\./],
    make: () => new answers.ConfirmRequired('docs'),
  },
  {
    name: 'SpaceRootRefused', status: 400, code: 'space_root_refused', path: '.', says: [/Cannot delete the space root directory\./],
    make: () => new answers.SpaceRootRefused('.'),
  },
  {
    name: 'MoveStillOwed', status: 503, code: 'move_still_owed', path: 'b.txt',
    make: () => new answers.MoveStillOwed('a.txt', 'b.txt'),
  },
  {
    name: 'ActNotRecorded', status: 500, code: 'act_not_recorded', path: 'a.txt',
    make: () => new answers.ActNotRecorded('move', 'a.txt'),
  },
  {
    name: 'FileSystemFault', status: 500, code: 'file_system_fault', path: undefined,
    make: () => new answers.FileSystemFault(Object.assign(new Error('EACCES: permission denied, open /data/x'), { code: 'EACCES' })),
  },
];

describe('a series exists for every code before the first answer', () => {
  it('derives the codes from the module, with a floor, and has a case for each', () => {
    const derived = codesInSource();
    assert.ok(derived.length >= 6, `only ${derived.length} codes derived from act-answers.ts: an empty derivation passes every loop over it`);
    const covered = [...new Set(CASES.map(c => c.code))].sort();
    assert.deepEqual(covered, derived, 'a code the module spells has no case here, or a case names a code the module does not spell');
  });

  it('is at 0 for every derived code on a scrape taken before any answer', async () => {
    const seen = await counted();
    for (const code of codesInSource()) {
      assert.equal(seen.get(code), 0, `${COUNTER}{code="${code}"} is not scrapable at 0`);
    }
  });

  it('no longer carries the retired code or the retired counter', async () => {
    assert.ok(!codesInSource().includes('destination_taken_by_other'), 'the retired code is still spelled in act-answers.ts');
    assert.equal(answers.DestinationTakenByOther, undefined, 'the retired class is still exported');
    const text = await registry.register.metrics();
    assert.ok(!text.includes('ythril_file_moves_onto_taken_destination_total'), 'the retired counter is still registered');
  });

  it('declares the two move counters at 0', async () => {
    const text = await registry.register.metrics();
    assert.match(text, /^ythril_file_move_link_fallback_total 0$/m, 'the link-fallback counter is not scrapable at 0');
    assert.match(text, /^ythril_file_move_rows_replaced_total\{space=""\} 0$/m, 'the rows-replaced counter is not scrapable at 0');
  });

  it('counts rows replaced by the number of rows, not by batch', async () => {
    registry.fileMoveRowsReplacedTotal.labels({ space: 'counted-by-rows' }).inc(3);
    const text = await registry.register.metrics();
    assert.match(text, /^ythril_file_move_rows_replaced_total\{space="counted-by-rows"\} 3$/m);
  });
});

describe('every answer class is answered by value and counted exactly once', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.status} ${c.code}, path ${c.path === undefined ? 'absent' : `'${c.path}'`}, counted once`, async () => {
      const err = c.make();
      const before = await counted();

      const answer = answers.fileActAnswer(err);

      assert.ok(answer, `${c.name} is not answered at all`);
      assert.equal(answer.status, c.status);
      assert.equal(answer.body.code, c.code);
      assert.equal(answer.body.path, c.path);
      assert.equal(answer.body.heldBy, c.heldBy, 'the body names the file that holds the id for the held finish and for no other answer');
      assert.equal(typeof answer.body.error, 'string');
      for (const fragment of c.says ?? []) assert.match(answer.body.error, fragment, 'the sentence does not say what the table promises');
      assert.ok(!answer.body.error.includes('/data/'), 'the sentence names an absolute path');

      const after = await counted();
      for (const code of codesInSource()) {
        const moved = (after.get(code) ?? 0) - (before.get(code) ?? 0);
        assert.equal(moved, code === c.code ? 1 : 0, `${COUNTER}{code="${code}"} moved by ${moved} for a ${c.code} answer`);
      }
    });

    it(`${c.name}: the classification alone moves nothing and says the same`, async () => {
      const err = c.make();
      const before = await counted();

      const answer = answers.fileActAnswerOf(err);

      assert.ok(answer);
      assert.equal(answer.status, c.status);
      assert.equal(answer.body.code, c.code);
      assert.deepEqual(await counted(), before, 'a classification counted an answer');
    });
  }

  it('an error that is not a file act answers nothing and counts nothing', async () => {
    const before = await counted();
    assert.equal(answers.fileActAnswer(new Error('boom')), undefined);
    assert.equal(answers.fileActAnswerOf(new Error('boom')), undefined);
    assert.deepEqual(await counted(), before);
  });

  it('a retry window rides on the owed move only', () => {
    assert.ok(answers.fileActAnswerOf(new answers.MoveStillOwed('a.txt', 'b.txt')).retryAfterSeconds > 0);
    assert.equal(answers.fileActAnswerOf(new answers.DestinationExists('b.txt', 'bytes')).retryAfterSeconds, undefined);
  });
});

describe('a classifier that decides what an upload discards counts nothing', () => {
  it('isPathBlocked moves no series, for a refusal it recognises and for one it does not', async () => {
    const before = await counted();

    assert.equal(destination.isPathBlocked(new answers.PathBlocked('x', 'x blocked')), true);
    assert.equal(destination.isPathBlocked(new answers.DestinationExists('x', 'bytes')), false);
    assert.equal(destination.isPathBlocked(new Error('boom')), false);

    assert.deepEqual(await counted(), before, 'isPathBlocked counted an answer that no door gave');
  });
});
