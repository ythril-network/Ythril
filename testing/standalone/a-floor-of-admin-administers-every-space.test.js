/**
 * A token whose admin comes from the FLOOR administers every space, and must reach the routes that say so.
 *
 * ## The report (`Q-12`)
 *
 * The canary operator's token holds `admin` on all four areas of every space — no `instanceAdmin`, no
 * `createSpaces` — and `GET /api/tokens` answered `Admin token required`. `07-tokens-api` promises the
 * opposite: a token holding the `admin` rung on all four areas of a space *"reaches the token routes and is
 * then held to exactly the rules above"*, and the listing *"is scoped the same way"*.
 *
 * **The cost was not cosmetic.** That credential runs their daily token inventory, so their seven-day warning
 * before a token lapses had been blind since 2026-08-20, and their MCP connector lapsed on 2026-09-01 with no
 * notice at all. They ruled out the 3.3.0 privilege fix by deploy timestamps before reporting it.
 *
 * ## The cause, which is this repository's named defect class
 *
 * The gate asked `spaceAdminSpacesFor(record).length > 0`. That function answers *which per-space rows does
 * this token hold*, and says in its own docblock that it is derived from rows rather than from the instance's
 * space list — correct for scoping a write. A floor-admin token holds NO rows, so the count is zero and the
 * gate read it as administering nothing.
 *
 * Meanwhile `editorScopeFor`, on the same rights, returns `undefined` — unrestricted — because it does read
 * the floor. One rule, two implementations, and the weaker one refusing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { administersAnySpace, spaceAdminSpacesFor, editorScopeFor } from '../../server/dist/auth/editor-scope.js';
import { SPACE_AREAS } from '../../server/dist/config/rights-shape.js';

/*
 * The areas are DERIVED, and the first version of this file is why. It hand-wrote
 * `knowledge, schema, files, settings` — and `settings` is not an area, `dataQuality` is. So the fixture was
 * missing a real area, `every` was false, and three assertions failed against code that was correct. A
 * fixture that names a vocabulary instead of reading it tests the author's memory.
 */
const allAreas = rung => Object.fromEntries(SPACE_AREAS.map(a => [a, rung]));

/** Every area at `admin`, named by nothing — the canary's shape. */
/*
 * THE SHAPE MOVED AT 5.0 AND THE CONFIGURATION DID NOT. Space admin is its own grant now, and a floor of
 * `admin` on the four AREAS grants maximal rights over every space's data — not administration of any.
 * So the canary's token is `spaceAdmin.floor`, which is what the boot migration writes for exactly this
 * matrix, and what the floor row's toggle writes from the editor.
 *
 * The incident this file is named for is unchanged: a token administering every space through the floor
 * holds no per-space ROWS, so any check counting rows reads zero and refuses it.
 */
const FLOOR_ADMIN = { rights: { instanceAdmin: false, createSpaces: false,
  floor: allAreas('admin'), perSpace: {}, spaceAdmin: { floor: true, spaces: [] } } };

/** The same reach, spelled per space — what the gate already accepted. */
const ROW_ADMIN = { rights: { instanceAdmin: false, createSpaces: false, floor: {},
  spaceAdmin: { floor: false, spaces: ['work'] },
  perSpace: { work: allAreas('admin') } } };

test('a floor of admin on all four areas administers every space', () => {
  assert.equal(administersAnySpace(FLOOR_ADMIN), true,
    'the shape the canary holds was refused at the door while the guide promised it a scoped listing');
});

test('and the two spellings of the same reach agree', () => {
  /*
   * The point of the fix. `editorScopeFor` already read the floor and returned unrestricted; the gate did
   * not. Asserting them side by side is what stops the two drifting apart again — a token that scopes to
   * everything and is admitted to nothing is the contradiction that produced the report.
   */
  assert.equal(editorScopeFor(FLOOR_ADMIN), undefined, 'a floor of admin scopes to every space');
  assert.equal(administersAnySpace(FLOOR_ADMIN), true, '…so it must also be admitted as a space administrator');

  assert.deepEqual(editorScopeFor(ROW_ADMIN), ['work']);
  assert.equal(administersAnySpace(ROW_ADMIN), true);
});

test('the row-derived list is UNCHANGED, because scoping is a different question', () => {
  // `spaceAdminSpacesFor` must keep answering "which rows", or a floor-admin token would start scoping to
  // a list of every space that happens to exist today — which is what its own docblock warns against.
  assert.deepEqual(spaceAdminSpacesFor(FLOOR_ADMIN), [], 'a floor names no space, and still should not');
  assert.deepEqual(spaceAdminSpacesFor(ROW_ADMIN), ['work']);
});

test('a partial floor is not administration, and neither is nothing at all', () => {
  /*
   * The refusals that must survive. `admin` on all but one area is not administering the space — the
   * predicate is `every`, matching `isSpaceAdminFor`, so widening the gate cannot become "any high rung
   * anywhere".
   */
  const oneShort = { rights: { instanceAdmin: false, createSpaces: false,
    floor: { ...allAreas('admin'), [SPACE_AREAS[SPACE_AREAS.length - 1]]: 'write' }, perSpace: {} } };
  assert.equal(administersAnySpace(oneShort), false,
    'admin on all but one area is not administering the space');

  assert.equal(administersAnySpace({ rights: { instanceAdmin: false, createSpaces: false, floor: {}, perSpace: {} } }), false);
  assert.equal(administersAnySpace({}), false, 'no matrix means no reach — owner, 2026-09-05');
  assert.equal(administersAnySpace(undefined), false);
});
