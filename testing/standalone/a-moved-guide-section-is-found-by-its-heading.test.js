/**
 * A gate that checks the documentation finds its page by the SECTION, not by the filename.
 *
 * ## What went wrong, twice, and what the second time cost
 *
 * Every tracked document here is capped at 900 lines, so a reference page that keeps growing is eventually
 * split and a section moves to a filename nobody wrote down. `04g-links-api.md` came out of `04b`;
 * `04h-graph-augmented-recall.md` came out of `04a` when that page reached the cap exactly.
 *
 * Two gates named `docs/integration-guide/04a-recall-api.md` as "the integrator's recall page" — one
 * asserting that every surface offering `direction` says it narrows stored edges only, the other that
 * `includeChrono`, `includeMemories` and `includeFiles` are documented for an integrator. Both went red on
 * the split, which is the *lucky* half of this failure.
 *
 * **The unlucky half is a gate that keeps passing.** An absence assertion — "this page does not claim X" —
 * is satisfied by any page that never mentioned X, so it goes green about a document that no longer
 * contains its subject and nothing ever contradicts it. That is this repo's named defect, *a gate concludes
 * about more than it checks*, arriving through a filename rather than through a list.
 *
 * So the lookup is derived from the headings, and the derivation lives in one module rather than in each
 * caller — a hand-written `find` returns `undefined` for a reworded heading, and a caller that spreads
 * `undefined` into a list asserts over nothing.
 *
 * Run: node --test testing/standalone/a-moved-guide-section-is-found-by-its-heading.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guidePartOwning } from '../_shared/integration-guide-parts.mjs';

describe('the owner of a section is the part that HAS it', () => {
  it('finds graph-augmented recall on the part that carries the heading', () => {
    const owner = guidePartOwning('Graph-Augmented Recall');
    assert.match(owner, /^docs\/integration-guide\/.+\.md$/);
    assert.match(readFileSync(owner, 'utf8'), /^#{1,6}\s.*Graph-Augmented Recall/mi,
      'the answer must be a page with the heading, not a page that links to it');
  });

  it('does NOT answer with a page that only links to the section', () => {
    /*
     * The case that makes this a heading search rather than a file search. `04a-recall-api.md` still refers
     * to graph-augmented recall twice, by name, in a table row and a cross-reference — so a whole-file
     * match would name the page the section moved OUT of, which is the exact wrong answer and the one a
     * reader would never question.
     */
    const recall = 'docs/integration-guide/04a-recall-api.md';
    assert.match(readFileSync(recall, 'utf8'), /Graph-Augmented Recall/,
      'if the old page stopped mentioning it at all, this case no longer proves anything — re-anchor it');
    assert.notEqual(guidePartOwning('Graph-Augmented Recall'), recall);
  });

  it('every part it can answer with is one the repo actually ships', () => {
    // Derived, with a floor: an empty listing passes every loop written over it, and the module is what
    // several gates now resolve their subject through.
    for (const section of ['Recall & Similarity', 'Links', 'Schema Library']) {
      assert.ok(guidePartOwning(section).startsWith('docs/integration-guide/'), section);
    }
  });
});

describe('it refuses rather than returning nothing', () => {
  it('THROWS when no part owns the section, naming what it looked for', () => {
    // The whole reason this is a module. A reworded heading must not resolve to `undefined` and be read as
    // "nothing to check here" by a caller that spreads it into a list of surfaces.
    assert.throws(() => guidePartOwning('A Section That Does Not Exist'), (e) => {
      assert.match(e.message, /A Section That Does Not Exist/);
      assert.match(e.message, /renamed|no part/i);
      return true;
    });
  });

  it('THROWS when the fragment is too vague to have one owner', () => {
    // `API` is a heading word on many parts. Answering with the first would be a silent wrong answer, and
    // the caller has no way to notice it got one.
    assert.throws(() => guidePartOwning('API'), /matches a heading in \d+ parts/);
  });

  it('is case-insensitive, because a heading is prose and gets recapitalised', () => {
    assert.equal(guidePartOwning('graph-augmented recall'), guidePartOwning('Graph-Augmented Recall'));
  });
});
