/**
 * Space administrator is a rung you can GRANT, not one you have to assemble.
 *
 * ## The ask, twice, and what was shipped instead
 *
 * The canary operator, 2026-08-17T1910Z and again at 1916Z: *"there is still no SPACE ADMIN rung in the
 * rights matrix"*. They wanted to grant it in one action and verify they held it.
 *
 * What shipped was a NAME. `DERIVED_RUNGS` publishes `spaceAdmin` with its `requires` map through
 * `rights-catalog`, so the capability became findable — and stayed something you express by setting four
 * separate rungs and hoping you set all four. Owner, 2026-09-16: *"Make space admin real and not derived
 * if that still is not fixed"*.
 *
 * ## The implication runs ONE way, and that is the whole model
 *
 * Owner, 2026-09-16: *"Space admin is more than the four area admin rungs. It must be its own"*, and
 * *"It includes the four but the four do not equal space admin"*.
 *
 *     spaceAdmin  ⟹  admin in all four areas of that space     (resolved by `grantedRung`)
 *     admin in all four  ⟹̸  spaceAdmin                         (`isSpaceAdminFor` refuses it)
 *
 * A token with the four rungs can do everything to the DATA in that space and is not its administrator:
 * it does not manage the space's own tokens and it does not change the space's settings. Those are not a
 * fifth area — they are a different authority over the same space, which is why reading them off the data
 * rungs was wrong rather than merely awkward.
 *
 * **The old objection is answered better this way, not worse.** `editor-scope.ts` refused a flag because
 * *"it would then be a second thing that can disagree with them"*. Nothing compares the two: the rungs are
 * RESOLVED from the grant, so there is one statement of the right and no second opinion to drift.
 *
 * **And existing tokens are migrated, not stranded** — `config/migrate-space-admin-grant.ts` writes the
 * flag for every token that held all four, because under the old rule those tokens WERE administrators.
 *
 * ## What this file will not let through
 *
 * The escalation. A minter may delegate `spaceAdmin` only where it administers, and a token holding the
 * flag for one space must not gain a thing anywhere else — those two are the cases worth the file.
 *
 * Run: node --test testing/standalone/space-admin-is-a-rung-you-can-grant.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let effectiveRung, floorRung, isSpaceAdminFor, capRights, repairRights, SPACE_AREAS, SPACE_ADMIN_AREAS;

before(async () => {
  ({ effectiveRung, floorRung, capRights } = await import('../../server/dist/auth/mint-cap.js'));
  ({ isSpaceAdminFor } = await import('../../server/dist/auth/editor-scope.js'));
  ({ repairRights, SPACE_AREAS, SPACE_ADMIN_AREAS } = await import('../../server/dist/config/rights-shape.js'));
});

const rights = (over = {}) => ({
  instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over,
});

describe('the flag grants the rungs rather than sitting beside them', () => {
  it('a space named in spaceAdmin holds admin in every area administering a space covers', () => {
    const r = rights({ spaceAdmin: { floor: false, spaces: ['work'] } });
    for (const area of SPACE_ADMIN_AREAS) {
      assert.equal(effectiveRung(r, 'work', area), 'admin',
        `${area} is not admin in a space this token administers — the flag would then be a claim the rungs `
        + 'contradict, which is exactly the objection this design answers');
    }
  });

  it('but NOT on networks — a membership shares the space with other instances, and is its own column (F-34)', () => {
    const r = rights({ spaceAdmin: { floor: false, spaces: ['work'] } });
    assert.equal(effectiveRung(r, 'work', 'networks'), 'none',
      'administering a space must not let a token put it into a network — the column exists to decide that');
  });

  it('and the grant is what makes an administrator', () => {
    assert.equal(isSpaceAdminFor(rights({ spaceAdmin: { floor: false, spaces: ['work'] } }), 'work'), true);
  });

  it('THE FOUR RUNGS ALONE DO NOT, which is the half that is easy to get backwards', () => {
    /*
     * Owner: *"It includes the four but the four do not equal space admin"*. A token at `admin` in every
     * area has everything you can do to the DATA and is not the space's administrator — it does not
     * manage that space's tokens, and it does not change that space's settings.
     *
     * The predicate used to BE this expression, so the assertion is the exact inverse of what shipped
     * before and is the reason the migration exists.
     */
    const allFour = Object.fromEntries(SPACE_ADMIN_AREAS.map(a => [a, 'admin']));
    assert.equal(isSpaceAdminFor(rights({ perSpace: { work: allFour } }), 'work'), false,
      'four admin rungs made a space administrator — administration is a different authority from '
      + 'maximal data rights, and conflating them hands the space\'s token surface to any token that '
      + 'happens to hold four rungs');
  });

  it('and a FLOOR of all-admin does not either — it reaches spaces nobody has created', () => {
    const allFour = Object.fromEntries(SPACE_ADMIN_AREAS.map(a => [a, 'admin']));
    assert.equal(isSpaceAdminFor(rights({ floor: allFour }), 'work'), false,
      'a floor granted administration of every space present and future, from one setting');
  });
});

describe('it reaches exactly one space, and no further', () => {
  it('grants nothing in a space it does not name', () => {
    const r = rights({ spaceAdmin: { floor: false, spaces: ['work'] } });
    for (const area of SPACE_AREAS) {
      assert.equal(effectiveRung(r, 'other', area), 'none',
        'administering one space must not leak a rung into another — this is the escalation to fear');
    }
    assert.equal(isSpaceAdminFor(r, 'other'), false);
  });

  it('is not an instance capability', () => {
    const r = rights({ spaceAdmin: { floor: false, spaces: ['work'] } });
    assert.equal(r.instanceAdmin, false, 'administering a space must never imply administering the instance');
  });

  it('does not raise the FLOOR, which is a different scope', () => {
    /*
     * The trap this case exists for. `floorRung` is a SEPARATE funnel from `grantedRung` — the floor
     * reaches every space including ones created later, so a per-space grant leaking into it would hand a
     * space administrator every space on the instance, present and future.
     */
    const r = rights({ spaceAdmin: { floor: false, spaces: ['work'] } });
    for (const area of SPACE_AREAS) {
      assert.equal(floorRung(r, area), 'none',
        'a per-space grant raised the floor — that is every space on the instance, not one');
    }
  });
});

describe('a minter cannot delegate what it does not administer', () => {
  const excessesOf = (minter, requested) => capRights(minter, requested);

  it('refuses spaceAdmin for a space the minter does not administer', () => {
    const minter = rights({ perSpace: { work: { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' } } });
    const asked = rights({ spaceAdmin: { floor: false, spaces: ['other'] } });
    const out = excessesOf(minter, asked);
    assert.ok(Array.isArray(out) && out.length > 0,
      'a token administering `work` minted one administering `other` — the flag is a grant, so the mint cap '
      + 'has to price it exactly like the four rungs it stands for');
  });

  it('allows it where the minter DOES administer', () => {
    const allFour = { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' };
    const minter = rights({ perSpace: { work: allFour } });
    assert.deepEqual(excessesOf(minter, rights({ spaceAdmin: { floor: false, spaces: ['work'] } })), [],
      'delegating what you hold is the whole point of a rung');
  });

  it('and a minter holding the FLAG can delegate the flag', () => {
    assert.deepEqual(excessesOf(rights({ spaceAdmin: { floor: false, spaces: ['work'] } }), rights({ spaceAdmin: { floor: false, spaces: ['work'] } })), [],
      'a space administrator that cannot mint another one is a rung that cannot be handed over');
  });
});

describe('a stored matrix survives the new field', () => {
  it('coerces a matrix that predates it, without inventing a grant', () => {
    const out = repairRights({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} });
    assert.ok(!out.rights.spaceAdmin,
      'a token stored before this field existed must not come back administering anything');
  });

  it('drops a non-string entry rather than storing it', () => {
    // `repairRights` exists because a malformed matrix reached disk once and made every save of that
    // token fail validation — the matrix could be looked at and never corrected.
    const out = repairRights({
      instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces: ['work', 7, null] },
    });
    assert.deepEqual(out.rights.spaceAdmin, { floor: false, spaces: ['work'] });
  });
});

describe('the upgrade does not take administration away silently', () => {
  let migrateSpaceAdminGrant;
  before(async () => {
    ({ migrateSpaceAdminGrant } = await import('../../server/dist/config/migrate-space-admin-grant.js'));
  });

  const allFour = () => Object.fromEntries(SPACE_ADMIN_AREAS.map(a => [a, 'admin']));

  it('writes the grant for a token that held all four', () => {
    /*
     * The case this migration exists for, and the failure it prevents is silent: the rule changed, so
     * nothing errors. An operator simply finds they can no longer mint a token for a space they
     * administer, with nothing to read about why.
     */
    const tokens = [{ id: 't1', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { work: allFour() } } }];
    const out = migrateSpaceAdminGrant(tokens);
    assert.deepEqual(tokens[0].rights.spaceAdmin, { floor: false, spaces: ['work'] });
    assert.equal(out.granted.length, 1);
  });

  it('leaves a token that held less than all four alone', () => {
    const rungs = { ...allFour(), files: 'write' };
    const tokens = [{ id: 't2', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { work: rungs } } }];
    migrateSpaceAdminGrant(tokens);
    assert.ok(!tokens[0].rights.spaceAdmin?.spaces.length && !tokens[0].rights.spaceAdmin?.floor,
      'three rungs and a write were never administration, and inventing it here would GRANT access');
  });

  it('migrates a floor of all-admin to the FLOOR form, not to a list', () => {
    /*
     * The canary operator's shape (`Q-12`): admin on all four areas of every space, through the floor, no
     * `instanceAdmin`. Enumerating the spaces that happen to exist at upgrade time would freeze a list
     * that was never a list, and stop them administering every space created afterwards.
     */
    const tokens = [{ id: 't3', rights: { instanceAdmin: false, createSpaces: false, floor: allFour(), perSpace: {} } }];
    migrateSpaceAdminGrant(tokens);
    assert.ok(tokens[0].rights.spaceAdmin?.floor, 'a floor of all-admin migrates to the FLOOR form');
  });

  it('is idempotent — a second boot grants nothing further', () => {
    const tokens = [{ id: 't4', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { work: allFour() } } }];
    migrateSpaceAdminGrant(tokens);
    const second = migrateSpaceAdminGrant(tokens);
    assert.deepEqual(second.granted, []);
    assert.deepEqual(tokens[0].rights.spaceAdmin, { floor: false, spaces: ['work'] }, 'and it did not duplicate the entry');
  });
});
