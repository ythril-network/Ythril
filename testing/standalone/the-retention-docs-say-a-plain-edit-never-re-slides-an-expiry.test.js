/**
 * The settings guide says how an expiry is set and when it moves, and no longer says what the code never did (Q-269; bundle-40 plan R3).
 *
 * ## The defect it prevents
 *
 * `docs/userguide/04-settings.md` told an operator three things the server does not do:
 *
 *  - "a local write recomputes it": a plain edit never re-slides an existing expiry (`applyExpiryToUpdate` in brain/ttl.ts sets one only
 *    for an explicit `ttlDays`, or for a record that has none yet);
 *  - "a stamp that came from a peer is replaced by your own the next time that record is written": a record that arrives from a peer is
 *    stamped here once, from its own `createdAt` with this space's window (D-9), and a later write keeps that stamp;
 *  - "a record backed up as 'never expires' stays that way": a restore keeps the backup's stamps and stamps an UNSTAMPED record from this
 *    instance's window (D-13), so a record the backup recorded no expiry for does expire here if the space has a window.
 *
 * An operator who reads "a local write recomputes it" shortens a window and edits records expecting the new window to reach them. It
 * does not: nothing re-slides an expiry but an explicit `ttlDays`.
 *
 * ## The rule
 *
 *  - the three sentences above are gone from the settings guide (read through line wraps, emphasis and quotes);
 *  - the guide states that a plain edit never re-slides an expiry (the paragraph that names "a plain edit" says "never re-slides");
 *  - the matcher is exercised against the retired text as the guide wrapped it, so a pass means the sentence is gone, not that the
 *    matcher cannot see it.
 *
 * Red on main: all three retired sentences are there and no sentence says a plain edit never re-slides an expiry.
 *
 * Run: node --test testing/standalone/the-retention-docs-say-a-plain-edit-never-re-slides-an-expiry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readDoc } from './_docs.mjs';

const GUIDE = 'userguide/04-settings.md';

/** Text as a reader sees it: no markup, quotes or line wraps, one case, single spaces. */
const plain = (md) => md.replace(/[*_`"“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The sentences the guide must no longer say, each as the words a reader would read. */
const RETIRED = [
  ['a plain edit recomputes an expiry', 'a local write recomputes it'],
  ['a peer\'s stamp is replaced by this instance\'s on the next write', 'replaced by your own the next time that record is written'],
  ['a record backed up as never expiring stays that way', 'never expires stays that way'],
];

/** The retired sentences as `04-settings.md` wrapped and marked them up, to prove the matcher sees them. */
const AS_WRAPPED = [
  'a peer\'s later edit keeps it rather than restarting the clock; a\nlocal   write recomputes it.',
  'a stamp that came from a peer is **replaced by your own** the next\ntime that record is written.',
  'a record backed up as "never expires" stays\nthat way.',
];

/** Does the guide say a plain edit never re-slides an expiry? The paragraph naming "a plain edit" must say "never re-slides" within a few words, and name the expiry. */
function saysAPlainEditNeverReSlides(md) {
  return md.split(/\n\s*\n/).map(plain).some(p => /\bplain edit\b\W+(?:\w+\W+){0,6}never re-?slid?e?s?\b/.test(p) && /\bexpir/.test(p));
}

describe('the settings guide on how an expiry is set and when it moves (Q-269)', () => {
  const md = readDoc(GUIDE);

  it('the guide is read whole (a gate over an empty file passes)', () => {
    assert.ok(md.length > 5000, `${GUIDE} is ${md.length} characters`);
    assert.match(plain(md), /expired records are removed by a sweep that runs every 5 minutes/, 'the sweep paragraph the guide anchors the rest on');
  });

  it('the matcher sees each retired sentence as the guide wrapped it, and the new sentence in the shapes it may take', () => {
    for (const [i, [, phrase]] of RETIRED.entries()) {
      assert.ok(plain(AS_WRAPPED[i]).includes(phrase), `the matcher cannot see "${phrase}" in ${JSON.stringify(AS_WRAPPED[i])}`);
    }
    assert.ok(saysAPlainEditNeverReSlides('An expiry is set on create. A **plain edit** never\nre-slides it.'));
    assert.ok(saysAPlainEditNeverReSlides('The expiry is set on create from the tiers; a plain edit never re-slides an existing expiry.'));
    assert.ok(!saysAPlainEditNeverReSlides('A plain edit re-slides the expiry.'));
    assert.ok(!saysAPlainEditNeverReSlides('A plain edit changes the text.\n\nNever re-slides an expiry.'));
  });

  for (const [what, phrase] of RETIRED) {
    it(`the guide no longer says that ${what}`, () => {
      assert.ok(!plain(md).includes(phrase), `${GUIDE} still says "${phrase}": ${what}, which the server does not do`);
    });
  }

  it('the guide states that a plain edit never re-slides an expiry', () => {
    assert.ok(saysAPlainEditNeverReSlides(md),
      `${GUIDE} has no paragraph that says a plain edit never re-slides an expiry (an expiry is set on create, or by an explicit ttlDays)`);
  });
});
