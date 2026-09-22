/**
 * A space whose links were never converted is REFUSED, not answered with "it has none".
 *
 * ## Why this became a rule in 5.0
 *
 * Until now a link lived in two shapes: the six array fields on the record, and a link record in the
 * space's `links` collection. `completeLinkage` chose which shape a space was read through, and a space
 * without it was read through the arrays — so an unconverted space was ordinary, not broken.
 *
 * 5.0 removes the arrays. There is one shape, so the flag stops being a choice and becomes an invariant,
 * and the space that never converted is the one case the invariant does not hold for. **Its pre-upgrade
 * links were only ever in the arrays**, so reading its link records answers about what was written since
 * the upgrade and drops everything older.
 *
 * ## The reason it cannot just be left to sort itself out
 *
 * The boot conversion runs for every unmarked space and **deliberately does not refuse the boot** when one
 * space's walk throws: one bad space must not stop an instance. That is right, and it is exactly why this
 * is needed — the space survives the boot, and without a refusal it goes on to answer *"no links"* to
 * every traversal, every backlink scan and every delete guard. Each of them reads an empty result as a
 * fact about the data. Nothing logs, nothing disagrees, and the delete guard is the dangerous one: it
 * stops refusing deletes it should refuse.
 *
 * ## An explicit `false` is refused as firmly as an absent flag
 *
 * The marker used to be an ordinary, reversible space setting — turn it off and array writes were accepted
 * again. With the arrays gone, turning it off would mean "read my links from a shape that does not exist",
 * so `false` and absent are the same answer here. The setting is off the writable list in the same change,
 * and this is the half that holds if it ever creeps back on.
 *
 * Run: node --test testing/standalone/an-unconverted-space-refuses-a-link-read.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { linkConversionRefusal } = await import('../../server/dist/brain/link-adjacency.js');

describe('a converted space is readable', () => {
  it('says nothing about a space that carries the marker', () => {
    assert.equal(linkConversionRefusal({ id: 'work', completeLinkage: true }), null);
  });

  it('and does not answer for a space that is not configured at all', () => {
    // Every caller has already resolved and authorised the space. Turning "no such space" into a link
    // error here would replace a clear 404 with a confusing one, about the wrong thing.
    assert.equal(linkConversionRefusal(undefined), null);
  });
});

describe('an unconverted space is refused, and the refusal is usable', () => {
  for (const [what, space] of [
    ['the marker is absent', { id: 'legacy-space' }],
    ['the marker is explicitly false', { id: 'legacy-space', completeLinkage: false }],
  ]) {
    it(`refuses when ${what}`, () => {
      const refusal = linkConversionRefusal(space);
      assert.ok(refusal, `${what}: a space with no converted links must not read as a space with no links`);
      assert.match(refusal, /legacy-space/, 'the refusal must name the space, or it cannot be acted on');
      assert.match(refusal, /links:convert/, 'the refusal must name the command that fixes it');
    });
  }

  it('does NOT treat a truthy-looking value as the marker', () => {
    // `completeLinkage === true` and not a truthiness check. A stored `"true"` from a hand-edited config
    // is the shape that would otherwise turn a broken space into a readable one.
    assert.ok(linkConversionRefusal({ id: 'x', completeLinkage: 'true' }));
    assert.ok(linkConversionRefusal({ id: 'x', completeLinkage: 1 }));
  });
});

describe('the assertion THROWS rather than returning the reason', () => {
  it('`assertLinkRecords` raises, so a caller cannot receive the refusal quietly', () => {
    /*
     * The forgettable half, and the reason this is a module rather than a check each reader writes. A
     * helper that RETURNS the problem is one a caller can ignore by not looking at the value — and the
     * readers this guards are loops that would then carry on and produce an empty array, which is the
     * exact failure being prevented.
     *
     * Read from the source because the config this would need cannot be driven from here; the truth table
     * above is what exercises the rule itself.
     */
    const src = stripComments(readFileSync('server/src/brain/link-adjacency.ts', 'utf8'));
    const at = src.indexOf('export function assertLinkRecords');
    assert.ok(at > 0, 'assertLinkRecords is gone — re-anchor this case rather than deleting it');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.match(body, /throw new Error\(/,
      'assertLinkRecords no longer throws, so every reader gets an empty result where it should get an error');
    assert.match(body, /linkConversionRefusal\(/,
      'assertLinkRecords must ask the same function this file exercises, not a second copy of the rule');
  });
});
