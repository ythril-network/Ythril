/**
 * An administrator's scope is read from the RIGHTS MATRIX, not from the legacy allowlist.
 *
 * ## The gap
 *
 * `refusalsOutsideEditorScope` is the guard that stops a space-restricted administrator editing a token
 * outside its spaces. It takes `editorSpaces`, and all three callers passed `req.authToken?.spaces` — the
 * pre-3.0 allowlist, deprecated at `_DEPRECATIONS.md` 1.7 and measured across 14 files and 87 reads.
 *
 * The matrix has been the permission model since 2.6. A token minted with a matrix and no `spaces` array —
 * which is every token minted through the rights editor — answered `undefined`, and `undefined` is exactly
 * what this guard reads as *"unrestricted instance administrator, skip every check"*.
 *
 * So the widest possible reading was applied to the token whose scope was written down somewhere else. That
 * is the absent-vs-empty conflation `reachable-spaces.ts` documents, one layer up: there an EMPTY allowlist
 * was read as unrestricted, here an ABSENT one is.
 *
 * ## Three unrestricted cases, and why a floor is one of them
 *
 * A floor applies to every space **including ones created later**, so it cannot be enumerated into a list —
 * which is the same reason the guard refuses a floor outright rather than capping it. `instanceAdmin` says so
 * directly. No matrix at all means an OIDC session or a pre-backfill record, where the legacy field is the
 * only answer there is.
 *
 * ## What is NOT asserted here
 *
 * Whether a space administrator gets THROUGH `enforceAdmin` at all — it still gates on the legacy `admin`
 * boolean, and that is the next step of SA-1. This change makes the scope computation correct for the callers
 * that already run; it does not open a door.
 *
 * Run: node --test testing/standalone/editor-scope-comes-from-the-matrix.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let editorScopeFor, refusalsOutsideEditorScope;
before(async () => {
  ({ editorScopeFor, refusalsOutsideEditorScope } = await import('../../server/dist/auth/editor-scope.js'));
});

const ALL = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });
const NONE = ALL('none');
const rights = (over = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

describe('editorScopeFor — where an administrator may act', () => {
  it('lists the spaces the matrix gives it something in', () => {
    const r = rights({ perSpace: { qa: ALL('admin'), research: { ...NONE, files: 'read' } } });
    assert.deepEqual([...editorScopeFor({ rights: r })].sort(), ['qa', 'research']);
  });

  it('ignores a row that grants nothing', () => {
    // A row of four `none`s is a row somebody emptied, not scope. Counting it would let a token administer a
    // space it holds nothing in — and an emptied row is how an operator REMOVES access.
    const r = rights({ perSpace: { qa: ALL('write'), old: NONE } });
    assert.deepEqual(editorScopeFor({ rights: r }), ['qa']);
  });

  it('is NOT unrestricted for instanceAdmin alone — the bug CI caught', () => {
    // The first version of this function short-circuited on `instanceAdmin`, and the integration suite
    // refused it. `migrateToken` maps a legacy SPACE-RESTRICTED admin -- `admin: true` with `spaces: ['qa']`
    // -- to `{ instanceAdmin: true, floor: null, perSpace: { qa } }`. The old model narrowed that token with
    // its allowlist; `instanceAdmin` in the matrix carries no narrowing. So the short-circuit widened exactly
    // the token this guard exists to constrain, inside a change whose stated purpose was to narrow.
    //
    // `instanceAdmin` is a CAPABILITY (create spaces, manage tokens), not a REACH. Reach over every space
    // including future ones is what a floor expresses, and the only thing that does.
    const migratedSpaceAdmin = rights({ instanceAdmin: true, floor: null, perSpace: { qa: ALL('admin') } });
    assert.deepEqual(editorScopeFor({ rights: migratedSpaceAdmin }), ['qa']);
  });

  it('IS unrestricted for a legacy unscoped admin, which migrates to an admin FLOOR', () => {
    // The other half of the same migration, and the reason the floor rule is the right one: an admin token
    // with no allowlist maps to `floor: admin`, so it still reads as unrestricted -- through the field that
    // actually means it.
    const migratedInstanceAdmin = rights({ instanceAdmin: true, floor: ALL('admin') });
    assert.equal(editorScopeFor({ rights: migratedInstanceAdmin }), undefined);
  });

  it('scopes an instanceAdmin with no floor and no rows to nothing', () => {
    // Honest rather than an oversight: such a token holds no rung in any space, so it reaches no space's
    // data. It can still create spaces; that is a capability, and this function does not answer capabilities.
    assert.deepEqual(editorScopeFor({ rights: rights({ instanceAdmin: true }) }), []);
  });

  it('is UNRESTRICTED when a floor grants anything', () => {
    // The non-obvious one. A floor reaches spaces that do not exist yet, so it cannot be enumerated — the same
    // reasoning that makes the guard refuse a floor rather than cap it.
    assert.equal(editorScopeFor({ rights: rights({ floor: { ...NONE, knowledge: 'read' } }) }), undefined);
  });

  it('is NOT unrestricted for a floor of all none', () => {
    // An empty floor is the shape the migration writes for a token with no instance-wide grant. Reading it as
    // "has a floor, therefore unrestricted" would hand every migrated token the widest scope there is.
    const r = rights({ floor: NONE, perSpace: { qa: ALL('read') } });
    assert.deepEqual(editorScopeFor({ rights: r }), ['qa']);
  });

  // That it does NOT fall back to the legacy allowlist — no matrix is no scope — is asserted, for every
  // guard, in `no-matrix-reaches-nothing-not-everything.test.js` (`Q-45.4`).

  it('prefers the matrix over a legacy allowlist that disagrees', () => {
    // Both present is the state every migrated token is in. The matrix is the model; the allowlist is the
    // field being removed, and letting it win would make the deprecation unfinishable.
    const r = rights({ perSpace: { qa: ALL('admin') } });
    assert.deepEqual(editorScopeFor({ rights: r, spaces: ['research', 'other'] }), ['qa']);
  });

  it('counts a space reached only through an IMPLIED rung as scope', () => {
    // `knowledge: write` entails `schema: read` (#914). It cannot ADD a space — the implication needs a
    // knowledge rung in that space, which is already non-none — so this pins that the two features compose
    // without one widening the other.
    const r = rights({ perSpace: { qa: { ...NONE, knowledge: 'write' } } });
    assert.deepEqual(editorScopeFor({ rights: r }), ['qa']);
  });

  it('answers undefined for no record at all', () => {
    assert.equal(editorScopeFor(undefined), undefined);
  });
});

describe('the guard behaves the same, now fed from the matrix', () => {
  /*
   * A target is described by its MATRIX now, not by the pre-3.0 allowlist. `editorScopeFor` reads the
   * target the same way it reads the editor — one resolution, both sides — so a fixture built from
   * `spaces` would describe a token that reaches nothing and prove nothing about the guard.
   */
  const target = (spaces) => ({
    schemaLibrary: false,
    rights: rights({ perSpace: Object.fromEntries(spaces.map(s => [s, ALL('admin')])) }),
  });

  it('refuses an edit to a token reaching outside a MATRIX-derived scope', () => {
    // The case that silently passed before: the editor's scope lived only in its matrix, so the guard saw
    // `undefined` and skipped every check.
    const scope = editorScopeFor({ rights: rights({ perSpace: { qa: ALL('admin') } }) });
    const refusals = refusalsOutsideEditorScope({ editorSpaces: scope, target: target(['research']), rights: undefined });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /outside your scope/);
  });

  it('still allows an edit inside that scope', () => {
    const scope = editorScopeFor({ rights: rights({ perSpace: { qa: ALL('admin') } }) });
    assert.deepEqual(refusalsOutsideEditorScope({ editorSpaces: scope, target: target(['qa']), rights: undefined }), []);
  });

  it('still refuses instanceAdmin, createSpaces and a floor from a scoped editor', () => {
    // Re-asserted because the SOURCE of `editorSpaces` changed underneath them: a guard fed a new input is a
    // guard whose existing refusals need re-proving, not assuming.
    const scope = editorScopeFor({ rights: rights({ perSpace: { qa: ALL('admin') } }) });
    const refusals = refusalsOutsideEditorScope({
      editorSpaces: scope,
      target: target(['qa']),
      rights: { instanceAdmin: true, createSpaces: true, floor: { knowledge: 'read' }, perSpace: {} },
    });
    assert.equal(refusals.length, 3, refusals.join(' | '));
  });

  it('an unrestricted editor is still unaffected', () => {
    const scope = editorScopeFor({ rights: rights({ instanceAdmin: true, floor: ALL('admin') }) });
    assert.deepEqual(refusalsOutsideEditorScope({
      editorSpaces: scope,
      target: target(['anything']),
      rights: { instanceAdmin: true, createSpaces: true, floor: { knowledge: 'admin' }, perSpace: { x: ALL('admin') } },
    }), []);
  });
});
