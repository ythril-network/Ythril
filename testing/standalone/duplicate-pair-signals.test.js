/**
 * A duplicate pair says whether it is the SAME or the OPPOSITE — or admits it does not know.
 *
 * ## The report
 *
 * Two memories meaning opposite things — *"ship the rough version today"* vs *"take the extra days and never
 * ship a rough version"* — score **0.97** and arrive from `/api/duplicates` as a *possible duplicate* with no
 * contradiction flag, because neither sets a single-valued property to a conflicting value. A nightly pass
 * reads that endpoint and works the pairs, so **a reversal of opinion arrives labelled as redundancy**, and
 * merging it erases the fact that someone changed their mind.
 *
 * The reporter was explicit that they are NOT asking us to solve semantic contradiction. They asked for a
 * cheap discriminating hint, or enough in the payload to decide for themselves.
 *
 * ## What is asserted here, and why these three things
 *
 *  - **The join.** Both candidate collections key a pair canonically (`aId < bId`), so "is this pair also a
 *    known contradiction?" was always one indexed lookup away and was simply never asked. The key derivation
 *    is what makes that join sound, so it is tested in both orderings.
 *  - **The tri-state.** `not-checked` and `none-found` are different facts. An optional field whose absence
 *    means either would reproduce, on this endpoint, the exact confusion this correspondent reported against
 *    our settings page: an unconfigured optional component looks identical to "checked, nothing found".
 *  - **The cue does not fire on ordinary pairs.** A hint that fires on redundancy is worse than no hint,
 *    because it teaches the reader to ignore the field. This is the same bar the metrics registry applies when
 *    it refuses to count a missing lexical channel.
 *
 * Run: node --test testing/standalone/duplicate-pair-signals.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockAfter, balancedFrom, statementFrom } from './_structural-window.mjs';

let mod;
before(async () => { mod = await import('../../server/dist/api/duplicates.js'); });

/** The source, for the assertions that are about shape rather than behaviour. */
const src = readFileSync('server/src/api/duplicates.ts', 'utf8');

describe('the pair key joins the two candidate collections', () => {
  it('is order-independent — the same pair in either order yields one key', () => {
    // The scanners enforce aId < bId, but deriving the key rather than trusting field order means a row
    // written before that was enforced still joins, and a caller cannot desynchronise the two lists by
    // presenting a pair backwards.
    assert.match(src, /function pairKey/, 'pairKey must exist for the join to be sound');
    assert.match(src, /c\.aId < c\.bId \? `\$\{c\.aId\}:\$\{c\.bId\}` : `\$\{c\.bId\}:\$\{c\.aId\}`/,
      'the key must normalise the ordering rather than assume it');
  });

  it('joins with ONE batched query per space, not one per pair', () => {
    // 500 pairs × a round trip each would make this endpoint quietly slow, and the contradiction rows are
    // keyed by exactly this key — so an $in over the page is the whole cost.
    // Re-anchored by Q-211: the `$in` over the page is read through the one by-id reader, which chunks it.
    assert.match(src, /readStoredById<ContradictionCandidateDoc>\(\s*spaceCollection\(spaceId, 'contradictionCandidates'\), keys,/,
      'the join must be batched');
    /*
     * EVERY such loop, and each bounded by its own body — which is not always a block.
     *
     * `indexOf` found the FIRST one, and that one is braceless: `for (const p of pairs) out.set(pairKey(p), {...})`.
     * So `blockAfter` bounded the OBJECT LITERAL in its argument, checked that for `await col(`, found none, and
     * passed — while the braced loop further down went unexamined. A vacuous check that reads as a real one.
     */
    const loops = [...src.matchAll(/for \(const p of pairs\)/g)];
    assert.ok(loops.length > 0, 'no per-pair loop found — re-anchor this gate');
    for (const m of loops) {
      const header = balancedFrom(src, m.index, 'the loop header');
      const afterHeader = m.index + src.slice(m.index).indexOf(header) + header.length;
      // The next non-space character, found rather than sliced — `slice(afterHeader, afterHeader + 8)` is a magic
      // window, and the ratchet in this same suite caught it the moment it was written.
      const braced = src[afterHeader + src.slice(afterHeader).search(/\S/)] === '{';
      const body = braced
        ? blockAfter(src, afterHeader, 'the per-pair loop body')
        : statementFrom(src, afterHeader, 'the per-pair loop body');
      assert.doesNotMatch(body, /await col\(/, 'no awaited query inside a per-pair loop');
    }
  });
});

describe('the contradiction signal never reports a bare absence', () => {
  it('declares the three distinguishable states in the type', () => {
    assert.match(src, /checked: false; reason: 'no-judge-configured' \| 'never-scanned'/);
    assert.match(src, /checked: true; found: false/);
    assert.match(src, /checked: true; found: true/);
  });

  it('reports no-judge-configured rather than a clean pair when no judge exists', () => {
    // Without an NLI judge there is no semantic pass at all, so an empty contradiction list says only that no
    // structured FIELD conflicted. Reporting that as "checked, they agree" would license exactly the merge
    // this feature exists to prevent.
    assert.match(src, /if \(!nliConfigured\(\)\)/, 'the judge must be consulted before claiming a check ran');
    assert.match(src, /reason: 'no-judge-configured'/);
  });

  it('reports never-scanned rather than a clean pair for an unscanned space', () => {
    assert.match(src, /estimatedDocumentCount\(\)/,
      'an empty collection must be distinguished from a scanned-and-clean one');
    assert.match(src, /everScanned \? \{ checked: true, found: false \} : \{ checked: false, reason: 'never-scanned' \}/);
  });
});

describe('negationAsymmetry is a cue, and behaves like one', () => {
  it('fires on the reporter\'s own example', () => {
    // The case that produced the report: 0.97 similar, opposite meaning, no structured conflict.
    const a = 'ship the rough version today';
    const b = 'take the extra days and never ship a rough version';
    assert.equal(mod.negationAsymmetryForTest(a, b), true);
    assert.equal(mod.negationAsymmetryForTest(b, a), true, 'it must be symmetric in its arguments');
  });

  it('does NOT fire on ordinary redundancy', () => {
    // The failure that would make the field worthless: firing on the pairs it is meant to distinguish FROM.
    assert.equal(mod.negationAsymmetryForTest(
      'the deploy pipeline runs on push to main',
      'pushing to main triggers the deploy pipeline',
    ), false);
  });

  it('does NOT fire when both sides negate', () => {
    // Two records that both say "do not" are more likely to agree than to disagree, so presence alone is not
    // the signal — asymmetry is.
    assert.equal(mod.negationAsymmetryForTest(
      'never ship on a Friday',
      'do not ship on a Friday afternoon',
    ), false);
  });

  it('is not fooled by a negation token inside another word', () => {
    // "nothing" contains "not"; "another" contains "not"; a substring match would fire on both.
    assert.equal(mod.negationAsymmetryForTest(
      'nothing about another release is notable',
      'the release is notable',
    ), false);
  });

  it('handles apostrophe forms, which is how people actually write', () => {
    assert.equal(mod.negationAsymmetryForTest(
      "we can't merge that pair",
      'we should merge that pair',
    ), true);
  });

  it('is documented as lexical rather than semantic', () => {
    // The comment is load-bearing: the next person to read this must not promote a cue into a verdict.
    assert.match(src, /never a verdict|not a verdict|reason to look/i,
      'the cue must be documented as a reason to look, not a judgement');
  });
});
