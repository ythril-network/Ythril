/**
 * A matrix SPACE ADMINISTRATOR reaches the token routes — and nothing else.
 *
 * ## The gap this closes
 *
 * Owner: *"i need the space admin that can print tokens and adjust them."* Until now "space admin" was
 * expressible only through the legacy pair (`admin: true` + a `spaces` allowlist). The matrix could not say
 * it: an `admin` rung on all four areas of a space granted those AREAS and nothing about token management,
 * because `enforceAdmin` gates on `record.admin` — the legacy boolean — and nothing read the matrix.
 *
 * ## The two decisions, and which one was the owner's
 *
 * **Mechanism (derivable):** `admin` on ALL FOUR areas of a space is being that space's administrator.
 * Holding the destructive rung everywhere in a space already says there is nothing there you cannot do.
 * Requiring all four is what stops `admin` on Files alone minting tokens — a token is not a file.
 *
 * **Scope (the owner's, P-8 = B, 2026-08-15):** it unlocks that space's tokens and that space's own settings.
 * I had proposed the narrower "token routes only" because `enforceAdmin` also guards spaces, networks and
 * instance settings; the correction was that those are instance-shaped and a space admin was never going to
 * reach them — there is no space to scope them to.
 *
 * ## Passing the guard is not permission to act
 *
 * Every route behind it still runs `refusalsOutsideEditorScope`, fed by `editorScopeFor`. That is what makes
 * opening this door safe and it is why it shipped first (#916): a space admin admitted here still cannot
 * grant `instanceAdmin`, `createSpaces`, a floor, or rights on a space it does not hold.
 *
 * Run: node --test testing/standalone/space-admin-reaches-its-own-tokens.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let isSpaceAdminFor, spaceAdminSpacesFor, refusalsOutsideEditorScope, editorScopeFor;
before(async () => {
  ({ isSpaceAdminFor, spaceAdminSpacesFor, refusalsOutsideEditorScope, editorScopeFor } =
    await import('../../server/dist/auth/editor-scope.js'));
});

const ALL = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });
const NONE = ALL('none');
const rights = (over = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

describe('what makes a token a space administrator', () => {
  /*
   * THE GRANT, AND ONLY THE GRANT — the 5.0 change, and these cases are the inverse of what they said.
   *
   * Owner, 2026-09-16: *"Space admin is more than the four area admin rungs. It must be its own"* and
   * *"It includes the four but the four do not equal space admin"*. Administering a space is authority
   * over the space — its tokens, its settings — and holding every DATA rung is not that.
   */
  const ADMINS = (...spaces) => ({ floor: false, spaces });

  it('the spaceAdmin grant, for that space', () => {
    assert.equal(isSpaceAdminFor(rights({ spaceAdmin: ADMINS('qa') }), 'qa'), true);
  });

  it('NOT admin on all four areas — which is what this used to mean', () => {
    const r = rights({ perSpace: { qa: ALL('admin') } });
    assert.equal(isSpaceAdminFor(r, 'qa'), false,
      "four admin rungs are everything you can do to the DATA; the space's own tokens and settings are a "
      + 'different authority, and reading one off the other is what 5.0 stopped');
    assert.deepEqual(spaceAdminSpacesFor({ rights: r }), []);
  });

  it('NOT admin on one area only — a token is not a file', () => {
    const r = rights({ perSpace: { qa: { ...NONE, files: 'admin' } } });
    assert.equal(isSpaceAdminFor(r, 'qa'), false);
    assert.deepEqual(spaceAdminSpacesFor({ rights: r }), []);
  });

  it('the FLOOR form administers every space, including ones created later', () => {
    /*
     * The canary operator's shape (`Q-12`). It is the grant's own floor now, not four area floors — those
     * grant maximal rights over every space's data and administration of none.
     */
    const r = rights({ spaceAdmin: { floor: true, spaces: [] } });
    assert.equal(isSpaceAdminFor(r, 'qa'), true);
    assert.equal(isSpaceAdminFor(r, 'a-space-created-tomorrow'), true);
  });

  it('and four admin FLOORS do not, for the same reason four rungs do not', () => {
    const r = rights({ floor: ALL('admin') });
    assert.equal(isSpaceAdminFor(r, 'qa'), false);
  });

  it('is per SPACE — administering one is not administering another', () => {
    const r = rights({ spaceAdmin: ADMINS('qa') });
    assert.equal(isSpaceAdminFor(r, 'qa'), true);
    assert.equal(isSpaceAdminFor(r, 'research'), false);
    assert.deepEqual(spaceAdminSpacesFor({ rights: r }), ['qa']);
  });

  it('reads the matrix ONLY — no fallback to the legacy admin boolean', () => {
    // A legacy admin already passes `enforceAdmin` on its own. Folding it in here would make this predicate
    // answer two questions at once, and deprecation 1.7 is about getting that pair OUT of the decision path.
    assert.deepEqual(spaceAdminSpacesFor({ admin: true, spaces: ['qa'] }), []);
    assert.equal(isSpaceAdminFor(undefined, 'qa'), false);
    assert.equal(isSpaceAdminFor(null, 'qa'), false);
  });

  it('a row of all `none` administers nothing', () => {
    assert.deepEqual(spaceAdminSpacesFor({ rights: rights({ perSpace: { old: NONE } }) }), []);
  });
});

describe('being admitted is not being unbounded', () => {
  const spaceAdmin = rights({ spaceAdmin: { floor: false, spaces: ['qa'] } });

  it('the scope guard still confines it to its own space', () => {
    const scope = editorScopeFor({ rights: spaceAdmin });
    assert.deepEqual([...scope], ['qa']);
    const refusals = refusalsOutsideEditorScope({
      editorSpaces: scope,
      // Described by its MATRIX, not the pre-3.0 allowlist. Since 2026-09-05 a record with no matrix
      // reaches NOTHING, so a fixture built from `spaces` would be a token that reaches no space at all —
      // inside every scope, refused by nothing, and this case would pass while asserting nothing.
      target: { rights: rights({ perSpace: { research: ALL('admin') } }), schemaLibrary: false },
      rights: undefined,
    });
    assert.equal(refusals.length, 1, 'a token reaching another space must still be refused');
  });

  it('it still cannot grant instanceAdmin, createSpaces or a floor', () => {
    // The three escalations that would turn "administers one space" into "administers the instance". This is
    // the reason the door can be opened at all.
    const refusals = refusalsOutsideEditorScope({
      editorSpaces: editorScopeFor({ rights: spaceAdmin }),
      target: { spaces: ['qa'], schemaLibrary: false },
      rights: { instanceAdmin: true, createSpaces: true, floor: { knowledge: 'read' }, perSpace: {} },
    });
    assert.equal(refusals.length, 3, refusals.join(' | '));
  });

  it('and it CAN edit a token inside its own space', () => {
    // The capability the owner asked for, asserted rather than assumed from the absence of a refusal above.
    assert.deepEqual(refusalsOutsideEditorScope({
      editorSpaces: editorScopeFor({ rights: spaceAdmin }),
      target: { spaces: ['qa'], schemaLibrary: false },
      rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { qa: ALL('write') } },
    }), []);
  });
});

describe('the guard is applied where a space can be named, and nowhere else', () => {
  it('the token routes use the widened guard', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('server/src/api/tokens.ts', 'utf8');
    assert.match(src, /requireAdminOrSpaceAdmin/, 'the token routes must admit a space administrator');
    assert.doesNotMatch(src, /\brequireAdminMfa\b\s*[,)]/, 'no token route may still use the instance-only guard');
  });

  it('every OTHER admin route still uses the instance-only guard', async () => {
    // The half that must not drift. `enforceAdmin` is one function behind spaces, networks, instance settings
    // and the database page; widening it there would hand a space administrator the instance.
    //
    // `spaces.ts` joined `tokens.ts` on the allowlist when the owner's second clause landed — a space
    // administrator gets that space's own SETTINGS as well as its tokens. Two names in a list is exactly how
    // this assertion would rot into a formality, so `space-admin-reaches-its-own-space-settings.test.js` pins
    // WHICH routes in `spaces.ts` may be widened and requires delete/create/reorder to stay shut.
    const ALLOWED = ['server/src/api/tokens.ts', 'server/src/api/spaces.ts'];
    const { execSync } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const files = execSync('git ls-files "server/src/api/*.ts"', { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean).filter(f => !ALLOWED.includes(f));
    // The floor: an empty offender list over an empty enumeration is green and means nothing.
    assert.ok(files.length > 10, `only walked ${files.length} api modules — the enumeration is broken`);
    const widened = files.filter(f => /requireAdminOrSpaceAdmin/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(widened, [],
      `neither tokens nor space settings — these must stay instance-admin only: ${widened.join(', ')}`);
  });
});
