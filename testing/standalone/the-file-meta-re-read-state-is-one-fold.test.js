/**
 * The file-row re-read mark changes in exactly one place, and this is its truth table (bundle-89, Q-419, plan rev 3 §E3
 * items 5, 7 and 8).
 *
 * ## What the mark is for
 *
 * A file row whose `updatedAt` drifted from its author's converges when the AUTHOR delivers it again at the same seq
 * (`a-file-row-at-an-equal-seq-converges-on-its-authors-updatedat-db`). But an ordinary pull starts at the receive
 * watermark, and a drifted row is behind it — so nothing delivers it again. The re-read asks the member for its file
 * rows once more, from a cursor, through the same accept, and the mark (`fileMetaRereadAt[space]` on the member row) is
 * what says it is owed and how far it got.
 *
 * ## Why a truth table and not a shape
 *
 * Unlike the tombstone re-read it is modelled on, an absent mark means NOT owed: nothing is re-read until a merkle check
 * says the roots differ, so an instance with `merkle` off pays nothing. That makes it a small state machine with two
 * event sources — what a merkle check concluded, and how a re-read ended — and a cap, so that a difference the re-read
 * cannot fix is said once instead of re-read for ever. A state machine is exactly where a test of its shape passes a
 * wrong rule (pitfall-shape-gate-passes-a-wrong-rule), so every row below is written by hand and a wrong transition in
 * any one fails and names it.
 *
 * ## The states
 *
 *   absent        not owed
 *   `k:<seq>`     owed: attempt k, reading from <seq>
 *   `k:done`      attempt k read to the end; waiting on the next merkle check
 *   `spent`       the cap's attempts all read to the end and the roots still differ; said once, kept until a match
 *
 * Run: node --test testing/standalone/the-file-meta-re-read-state-is-one-fold.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mod, CAP;

describe('the file-row re-read mark is one fold', () => {
  before(async () => {
    mod = await import('../../server/dist/sync/file-meta-reread.js');
    CAP = mod.FILE_META_REREAD_CAP;
    // The table's last rows sit AT the cap; a cap below 2 would make "a second attempt" and "the cap" the same row.
    assert.ok(Number.isInteger(CAP) && CAP >= 2, `FILE_META_REREAD_CAP is ${CAP}: the table below needs at least two attempts`);
  });

  describe('a merkle verdict', () => {
    /** [state before, verdict, state after, why] — written out, never derived from the fold under test. */
    const rows = () => [
      [undefined, 'match', undefined, 'nothing owed, and nothing to do'],
      [undefined, 'mismatch', '1:0', 'a difference arms the first attempt, from the start'],
      [undefined, 'unknown', undefined, 'a check that answered nothing arms nothing'],
      ['1:7', 'match', undefined, 'converged while reading: stop, nothing is owed any more'],
      ['1:7', 'mismatch', '1:7', 'still mid-read: a difference is expected, and must not restart or count the attempt'],
      ['1:7', 'unknown', '1:7', 'mid-read, nothing learnt'],
      ['1:done', 'match', undefined, 'the attempt worked'],
      ['1:done', 'mismatch', '2:0', 'read to the end and still different: the next attempt, from the start'],
      ['1:done', 'unknown', '1:done', 'nothing learnt; keep waiting for a verdict'],
      [`${CAP}:done`, 'mismatch', 'spent', 'the last attempt read to the end and the roots still differ: give up, and say so'],
      [`${CAP}:done`, 'match', undefined, 'the last attempt worked'],
      ['spent', 'mismatch', 'spent', 'already said; not re-armed, or the cap would mean nothing'],
      ['spent', 'unknown', 'spent', 'nothing learnt'],
      ['spent', 'match', undefined, 'converged after all (a later write fixed it): clear, so a NEW drift can arm again'],
      ['not a mark', 'mismatch', '1:0', 'an unreadable mark reads as not owed, and a difference arms it from the start'],
      ['not a mark', 'match', undefined, 'an unreadable mark is cleared by a match'],
    ];
    it('every row', () => {
      for (const [before, verdict, after, why] of rows()) {
        assert.equal(mod.nextFileMetaRereadState(before, { merkle: verdict }), after,
          `${JSON.stringify(before)} + merkle ${verdict} should be ${JSON.stringify(after)}: ${why}`);
      }
    });
  });

  describe('a re-read ending', () => {
    const rows = () => [
      ['1:0', { complete: true }, '1:done', 'read to the end: the attempt is done, and the next merkle check judges it'],
      ['2:0', { complete: true }, '2:done', 'the attempt number is kept: it is what the cap counts'],
      ['1:0', { complete: false, cursor: '40' }, '1:40', 'stopped part-way with progress: resume from where it is complete'],
      ['1:40', { complete: false, stopped: true }, '1:40', 'stopped with no progress: owed from the same place, not reset'],
      [undefined, { complete: true }, undefined, 'nothing owed: a stray ending changes nothing'],
      ['1:done', { complete: true }, '1:done', 'already done: an ending does not start a new attempt — only a merkle verdict does'],
      ['spent', { complete: true }, 'spent', 'given up: only a match clears it'],
    ];
    it('every row', () => {
      for (const [before, ending, after, why] of rows()) {
        assert.equal(mod.nextFileMetaRereadState(before, { reread: ending }), after,
          `${JSON.stringify(before)} + ${JSON.stringify(ending)} should be ${JSON.stringify(after)}: ${why}`);
      }
    });
  });

  it('where a re-read starts: the cursor of an owed mark, from 0 when it is unreadable, and nowhere when nothing is owed', () => {
    const rows = [
      [undefined, null], ['1:done', null], ['spent', null], ['not a mark', null],
      ['1:0', 0], ['2:55', 55],
      // Read again from the start, never skipped: a cursor that is not a seq is the one place a guess could lose rows.
      ['1:abc', 0], ['1:-5', 0],
    ];
    for (const [state, start] of rows) {
      assert.equal(mod.fileMetaRereadStart(state), start, `${JSON.stringify(state)} should start at ${JSON.stringify(start)}`);
    }
  });

  it('what the gauge counts: marks with a read still owed — not one that is done, given up, or absent', () => {
    const member = (id, marks) => ({ instanceId: id, url: 'https://x', fileMetaRereadAt: marks });
    const cfg = {
      networks: [
        { id: 'n1', members: [member('a', { s1: '1:0', s2: '1:done', s3: 'spent' }), member('b', { s1: '2:40' })] },
        { id: 'n2', members: [member('c', {}), { instanceId: 'd', url: 'https://y' }, member('e', { s9: 'not a mark' })] },
      ],
    };
    assert.equal(mod.fileMetaRereadsOwed(cfg), 2, 'a:s1 (1:0) and b:s1 (2:40) are the two reads owed');
    assert.equal(mod.fileMetaRereadsOwed({ networks: [] }), 0);
  });
});
