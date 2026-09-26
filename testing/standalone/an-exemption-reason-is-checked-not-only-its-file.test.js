/**
 * An exemption's stated REASON is checked, not only the file it names.
 *
 * ## The half that was checked was the harmless half
 *
 * `todo-consistency.mjs` exempts ten pages from the queue rules, each with a written reason, and it verified
 * exactly one thing about them: that the file still exists. That check fired a yellow note calling itself
 * *"harmless, but tidy it"* — and it was right that it was harmless. An exemption naming a file that is gone
 * points at nothing and excuses nothing.
 *
 * The damaging half was never checked at all. The script's own comment records it: `_PARKED-DECISIONS.md` was
 * exempted because it was *"indexed by outcome rather than queued"*, the outcomes then moved to
 * `_REFERENCE.md`, and the exemption stayed. That page accumulated resolved history for weeks while every
 * checked page reported clean, until the owner opened it and found seven settled items filed as open. The file
 * existed the whole time. So the check watched the half that cannot hurt anyone and looked away from the half
 * that already had.
 *
 * And the same shape was sitting in the list while this was written: one reason said its file held SIX steps
 * while the file had seven boxes. Nothing could see it, because a reason was never read.
 *
 * ## A number in a reason is a claim, so it is derivable
 *
 * The general rule cannot be gated — *"is this sentence still true?"* has no `grep -c`. A COUNT can be. When a
 * reason says how many steps, boxes or rows a file has, that is a statement about the file, and the file can
 * be counted. It is a narrow rule and today exactly one entry is subject to it — which is the argument for the
 * check, since that one entry was wrong.
 *
 * The extraction is exercised as a truth table here rather than grepped for in the script, because a gate that
 * only asserts a check EXISTS passes just as well on a check that answers wrongly.
 *
 * ## Why the absent-file case now fails rather than warns
 *
 * Not because it became harmful. Because `console.log` is not a gate — the same file's docblock says a stale
 * entry must fail rather than warn, and then left this one warning. A yellow note in a green run is read as
 * decoration; that is the whole mechanism by which a stale reason survives.
 *
 * Run: node --test testing/standalone/an-exemption-reason-is-checked-not-only-its-file.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statedStructureCount, checklistBoxCount } from '../../scripts/todo-open-items.mjs';

const SCRIPT = 'scripts/todo-consistency.mjs';
const src = () => stripComments(readFileSync(SCRIPT, 'utf8'));

describe('a count stated in a reason is extracted', () => {
  it('reads a number word, whichever structural noun it counts', () => {
    assert.equal(statedStructureCount("the current job's six steps, not a queue"), 6);
    assert.equal(statedStructureCount('its four boxes are the steps of the current job'), 4);
    assert.equal(statedStructureCount('the seven rows, in order'), 7);
    assert.equal(statedStructureCount('one step and nothing else'), 1);
    assert.equal(statedStructureCount('all twelve steps'), 12);
  });

  it('reads a digit as readily as a word — the same claim, written two ways', () => {
    assert.equal(statedStructureCount("the current job's 6 steps"), 6);
    assert.equal(statedStructureCount('7 boxes, ticked before a push'), 7);
  });

  it('finds nothing where nothing is claimed', () => {
      // set-claim: the OTHER exemption reasons in the tracker, as fixture inputs -- real strings that must
      // yield null, so the rule cannot start reporting on the ones it must leave alone.
    // Every other exemption reason in the list, so the rule cannot start reporting on the nine it must not.
    for (const reason of [
      'resolved rationale — where closed work is supposed to end up',
      'a catalogue of review methods, not a list of work',
      'the process description itself',
      'a fact sheet kept for reference; its subject is closed',
      'owner DECISIONS, not work — no verify line, not in the ordered index (see rule 5)',
      'a removal checklist keyed to a future major, not the current queue',
      'setup instructions',
      'the working plan for the PR in flight; cleared on push',
    ]) assert.equal(statedStructureCount(reason), null, reason);
  });

  it('a number that counts something else is not a structure claim', () => {
    // `see rule 5` is a cross-reference, and `keyed to a future major` has no count at all. A rule that
    // grabbed any digit would fail on the two reasons that legitimately carry one.
    assert.equal(statedStructureCount('not in the ordered index (see rule 5)'), null);
    assert.equal(statedStructureCount('three parties read it'), null);
    assert.equal(statedStructureCount('2 of the 3 dissolved on reading the code'), null);
  });
});

describe('the file it describes is counted', () => {
  it('counts numbered checklist boxes, ticked or not', () => {
    const doc = [
      '- [x] **1 plan** — done',
      '      continued prose that is not a box',
      '- [ ] **2 tests first** — pending',
      '- [x] **3 implement**',
    ].join('\n');
    assert.equal(checklistBoxCount(doc), 3);
  });

  it('a page with no checklist counts zero rather than throwing', () => {
    assert.equal(checklistBoxCount('# Reference\n\nSome prose.\n'), 0);
  });

  it('an unnumbered bullet list is not a checklist', () => {
    // `_REFERENCE.md` is full of `- ` bullets. Counting those would give every exempt page a box count and
    // invent a contradiction on all nine.
    assert.equal(checklistBoxCount('- one thing\n- another thing\n'), 0);
  });
});

describe('the script actually applies it', () => {
  it('an exempt page that todo/ does not contain FAILS, and is not called harmless', () => {
    const code = src();
    const block = code.slice(code.indexOf('NOT_A_QUEUE.keys()'));
    const window = block.slice(0, 900);
    assert.match(window, /fail\(/, 'a stale exemption still only logs — a yellow note in a green run is read '
      + 'as decoration, which is how a stale reason survives');
    assert.doesNotMatch(code, /harmless, but tidy it/,
      'the absent-file case is no longer a note calling itself harmless');
  });

  it('and it compares a stated count against the real one', () => {
    const code = src();
    assert.match(code, /statedStructureCount/, 'nothing reads the reasons');
    assert.match(code, /checklistBoxCount/, 'nothing counts the file the reason describes');
  });
});
