/**
 * "A passed round still to apply here" is ONE predicate per kind of round, in `networks/round-state.ts`, and the veto is read once
 * (bundle-106 PR A, the duplicate-rule sweep of the diff).
 *
 * ## What it prevents
 *
 * The question was spelled five times and the copies disagreed on the veto: the settle's `passedOf` and the pass half of `spaceRoundAction` refused a
 * vetoed round, while `spaceActOwed`'s own docblock said "unvetoed" and its body did not check, and the addition's settle and the hold's evidence
 * read the flags again by hand. A round one reader applied and the next left owed is a debt that is neither done nor retried. The same sweep found
 * the pair of act types spelled eight times and the "this instance publishes a pub/sub" test three times, so a third act type, or a publisher
 * defined slightly differently, would have been picked up by some doors and not by others.
 *
 * ## What holds
 *
 * - the truth table of `spaceActOwed`, `spaceActApplied` and `spaceAdditionOwed`: a veto, an applied round, an unconcluded or unpassed one, and
 *   the other kind's type each answer no;
 * - no source outside `round-state.ts` spells the act-type pair as a disjunction, and none outside `network-role.ts` spells the publisher test.
 *
 * ## Seen red
 *
 * Against 72f2a5d3 the three predicates other than `spaceActOwed` do not exist, `spaceActOwed` answers yes for a vetoed round, and the source holds
 * the pair at eight sites.
 *
 * Run: node --test testing/standalone/a-passed-round-still-to-apply-has-one-predicate.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const state = await import('../../server/dist/networks/round-state.js');

const round = (over = {}) => ({ type: 'space_wipe', concluded: true, passed: true, votes: [{ vote: 'yes' }], ...over });

describe('the owed predicates, over the truth table', () => {
  it('a passed, unvetoed, unapplied deletion or wipe is an act owed, and an addition is not', () => {
    for (const type of ['space_deletion', 'space_wipe']) assert.equal(state.spaceActOwed(round({ type })), true, type);
    assert.equal(state.spaceActOwed(round({ type: 'space_addition' })), false);
  });

  it('a single veto stops an act owed, whatever else says passed', () => {
    assert.equal(state.spaceActOwed(round({ votes: [{ vote: 'yes' }, { vote: 'veto' }] })), false);
  });

  it('an applied, unconcluded or unpassed round is not owed', () => {
    assert.equal(state.spaceActOwed(round({ appliedHere: true })), false);
    assert.equal(state.spaceActOwed(round({ concluded: false })), false);
    assert.equal(state.spaceActOwed(round({ passed: false })), false);
    assert.equal(state.spaceActOwed(round({ passed: undefined })), false);
  });

  it('an addition owed is the same question for the other kind, with the same veto', () => {
    const addition = (over = {}) => round({ type: 'space_addition', ...over });
    assert.equal(state.spaceAdditionOwed(addition()), true);
    assert.equal(state.spaceAdditionOwed(addition({ votes: [{ vote: 'veto' }] })), false);
    assert.equal(state.spaceAdditionOwed(addition({ appliedHere: true })), false);
    assert.equal(state.spaceAdditionOwed(round()), false, 'a wipe is no addition');
  });

  it('applied is the complement of owed over the rounds that passed', () => {
    for (const appliedHere of [true, false, undefined]) {
      const r = round({ appliedHere });
      assert.equal(state.spaceActApplied(r), appliedHere === true, `appliedHere ${appliedHere}`);
      assert.equal(state.spaceActOwed(r) && state.spaceActApplied(r), false, 'a round both owed and applied');
    }
    assert.equal(state.spaceActApplied(round({ passed: false, appliedHere: true })), false);
  });

  it('the act types are the pair, and a type nobody knows is no act', () => {
    for (const type of ['space_deletion', 'space_wipe']) assert.equal(state.isSpaceActRound(type), true);
    for (const type of ['space_addition', 'meta_change', 'join', 'remove', '', undefined, null, 7]) assert.equal(state.isSpaceActRound(type), false, String(type));
  });
});

describe('no site spells the pair, or the publisher test, by hand', () => {
  const sources = trackedSources('server/src', { untracked: true, floor: 300 });
  const text = (f) => stripComments(readFileSync(`${REPO_ROOT}/${f}`, 'utf8'));

  it('the act-type pair is a disjunction of two type tests only in round-state.ts', () => {
    // Two type tests joined by `||` (or `&&` of the negations) — an identifier path between them, no capped gap.
    const pair = /===\s*['"]space_deletion['"]\s*\|\|\s*[\w$.?]+\s*===\s*['"]space_wipe['"]|===\s*['"]space_wipe['"]\s*\|\|\s*[\w$.?]+\s*===\s*['"]space_deletion['"]|!==\s*['"]space_deletion['"]\s*&&\s*[\w$.?]+\s*!==\s*['"]space_wipe['"]/;
    assert.deepEqual(sources.filter(f => f !== 'server/src/networks/round-state.ts' && pair.test(text(f))), [], 'these test for a deletion or a wipe by hand: use isSpaceActRound(type)');
  });

  it('"this instance publishes on a pub/sub" is spelled only in network-role.ts', () => {
    const publisher = /type\s*===\s*['"]pubsub['"]\s*&&\s*networkRole\([^)]*\)\.role\s*===\s*['"]publisher['"]/;
    assert.deepEqual(sources.filter(f => f !== 'server/src/networks/network-role.ts' && publisher.test(text(f))), [], 'these spell the publisher test by hand: use publishesOn(net)');
  });
});
