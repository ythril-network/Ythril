/**
 * The space-admin rung has a NAME, and the published name matches the enforced predicate.
 *
 * ## What was wrong, and it was not the capability
 *
 * `isSpaceAdminFor` has been enforced since #937: every one of the four areas at `admin`, for ONE space. Both
 * of its containment rules are red-teamed in `space-admin-edit-boundary.test.js` — it cannot grant
 * `instanceAdmin`/`createSpaces`, cannot set a floor, and cannot see or edit tokens for a space it does not
 * administer.
 *
 * **It had no name on any surface.** Measured 2026-08-19: `isSpaceAdminFor` appeared in three server files and
 * **zero** client files. The rights matrix showed four independent rungs and nothing said that all four at
 * `admin` IS administering that space. The canary operator asked twice — 2026-08-17T1910Z and a 1916Z narrowing
 * — and both times about the surface: *"there is still no SPACE ADMIN rung in the rights matrix"*. An operator
 * could not **find** it, **grant** it in one action, or **verify** they held it.
 *
 * ## What this file guards, which is the part that can rot
 *
 * A published definition is a SECOND statement of a security rule, and the copy that drifts is the one people
 * read — the reason `rights-catalog` publishes `ROUTE_RIGHTS` rather than letting the client type a list. So
 * `DERIVED_RUNGS.requires` is COMPUTED from `SPACE_ADMIN_AREAS`, and this file proves it still agrees with
 * `isSpaceAdminFor` by running the predicate over a rights object built from the published value.
 *
 * That is the difference between "we wrote the same thing twice" and "one of them is derived from the other".
 *
 * Run: node --test testing/standalone/space-admin-rung-is-named.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const { DERIVED_RUNGS, SPACE_ADMIN_AREAS, RUNGS } = await import('../../server/dist/config/rights-shape.js');
const { effectiveRung } = await import('../../server/dist/auth/mint-cap.js');
const { isSpaceAdminFor } = await import('../../server/dist/auth/editor-scope.js');

const spaceAdmin = DERIVED_RUNGS.find(r => r.id === 'spaceAdmin');
/** A rights matrix granting `rungs` on `spaceId` and nothing else. */
const rightsFor = (spaceId, rungs) => ({
  instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [spaceId]: { ...rungs } },
});

describe('the published definition IS the enforced predicate', () => {
  it('publishes a spaceAdmin entry at all', () => {
    assert.ok(spaceAdmin, 'DERIVED_RUNGS must carry `spaceAdmin` — without it the rung has no name again');
    assert.ok(spaceAdmin.grants, 'and say what it unlocks');
    assert.ok(spaceAdmin.excludes, 'and what it does not, which is what the canary operator asked to be explicit');
  });

  it('`requires` is what the GRANT CONFERS, and the grant really confers it', () => {
    /*
     * THE DIRECTION OF THIS CLAIM CHANGED AT 5.0, and the change is the point.
     *
     * It used to assert that a token built from `requires` passes `isSpaceAdminFor` — the two were the
     * same statement, because administering a space WAS holding those four rungs. Owner, 2026-09-16:
     * *"It includes the four but the four do not equal space admin"*.
     *
     * So `requires` is no longer a condition to satisfy; it is what the grant hands over, and that is what
     * a caller reading the catalogue needs in order to know what they are giving away. Asserted against
     * `effectiveRung` rather than against prose, so the published map cannot drift from the resolution.
     */
    const granted = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {},
      spaceAdmin: { floor: false, spaces: ['s1'] } };
    for (const [area, rung] of Object.entries(spaceAdmin.requires)) {
      assert.equal(effectiveRung(granted, 's1', area), rung,
        `the catalogue says spaceAdmin confers ${area}:${rung} and the grant does not resolve to it`);
    }
  });

  it('and the four rungs alone do NOT make an administrator', () => {
    // The inverse, stated because it is the half a reader will assume. A token holding everything
    // `requires` names has maximal rights over the space's DATA and administers nothing.
    assert.equal(isSpaceAdminFor(rightsFor('s1', spaceAdmin.requires), 's1'), false,
      'the published requirement was read as a way to BECOME a space admin — it is what being one gives '
      + 'you, and the two stopped being the same thing at 5.0');
  });

  it('and it is per-SPACE, never instance-wide', () => {
    // The containment rule that matters most: holding it on s1 must say nothing about s2.
    const r = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {},
      spaceAdmin: { floor: false, spaces: ['s1'] } };
    assert.equal(isSpaceAdminFor(r, 's1'), true);
    assert.equal(isSpaceAdminFor(r, 's2'), false,
      'administering one space must not administer another — this is the rule they asked to be part of the '
      + 'definition, and the definition would be a lie without it');
  });

  it('names every area administering a space covers, so a new one cannot be silently omitted', () => {
    assert.deepEqual(Object.keys(spaceAdmin.requires).sort(), [...SPACE_ADMIN_AREAS].sort(),
      'requires must cover exactly the areas the predicate iterates');
    for (const v of Object.values(spaceAdmin.requires)) {
      assert.ok(RUNGS.includes(v), `${v} is not a published rung`);
    }
  });

  it('`requires` is COMPUTED from SPACE_ADMIN_AREAS, not written out', () => {
    /*
     * The anti-drift property, asserted on source because it cannot be seen from the value.
     *
     * A literal `{knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin'}` would satisfy
     * every assertion above TODAY and silently stop matching the predicate the day a fifth area is added —
     * the predicate would iterate five, the published definition would still claim four, and the assertions
     * above would keep passing because they are built from the published value.
     */
    const src = stripComments(readFileSync('server/src/config/rights-shape.ts', 'utf8'));
    const block = bodyOf(src, 'DERIVED_RUNGS');
    assert.match(block, /SPACE_ADMIN_AREAS\.map/,
      'requires must be built from SPACE_ADMIN_AREAS, or it is a second copy of the predicate free to disagree');
    assert.doesNotMatch(block, /knowledge:\s*'admin'/,
      'a hand-written area list is the drift this exists to prevent');
  });
});

describe('the surfaces that were blind now name it', () => {
  it('rights-catalog publishes it', () => {
    const src = stripComments(readFileSync('server/src/api/tokens.ts', 'utf8'));
    assert.match(src, /derivedRungs: DERIVED_RUNGS/,
      'the catalog is where a client reads the model — it published the four areas and not this');
  });

  it('help() names the rung AND marks where the caller holds it', () => {
    // Naming it in prose answers "find it". Marking the spaces answers "verify I have it", which is the part a
    // sentence cannot do and the third of the canary operator's three complaints.
    const src = stripComments(readFileSync('server/src/mcp/tools/help-sections.ts', 'utf8'));
    assert.match(src, /ADMINISTERING A SPACE/, 'help must name the rung');
    assert.match(src, /isSpaceAdminFor\(ctx\.rights, s\.id\)/,
      'and mark it per space from the same predicate the server enforces with, so it cannot over-claim');
  });
});
