/**
 * The mint route and the edit routes decide "outside your scope" with the SAME function.
 *
 * ## The claim that was not true
 *
 * `PATCH /api/tokens/:id` carries this comment: *"Same rule the MINT route applies to a space-restricted
 * creator, expressed once in `refusalsOutsideEditorScope` so the two cannot drift into disagreeing about
 * what 'outside your scope' means."*
 *
 * Three routes called that function. The mint route was not one of them. It had its own inline check —
 * and the two did not merely differ, they disagreed about which FIELD describes a token's scope:
 *
 * ```
 * if (creatorSpaces) {
 *   if (schemaLibrary) { … }
 *   else if (!spaces) { 403 }        // ← the deprecated allowlist
 *   else { … }
 * }
 * ```
 *
 * ## What that cost, and it is not hypothetical
 *
 * The per-space rights matrix has been the permission model since 2.6, and the token-create form in this
 * repo's own UI stopped sending `spaces` some releases ago — it mints with `rights` only. Put those
 * together and a **space-restricted administrator could not mint any token at all through the product's
 * own interface**: no `spaces` in the body, so `!spaces` is true, so 403 *"A space-restricted token
 * cannot create an unrestricted (all-spaces) token"* — about a request that was not unrestricted.
 *
 * An unrestricted admin never saw it, because `creatorSpaces` is `undefined` for them and the whole block
 * is skipped. That is why it could sit there: the people most likely to test the mint form are exactly
 * the people the bug cannot reach.
 *
 * ## Why a gate rather than just the fix
 *
 * `CLAUDE.md` names one rule with two implementations as the defect this repo produces most, and says the
 * weaker one wins silently. Here the weaker one was a PRIVILEGE boundary reading a deprecated field, with
 * a comment two hundred lines away asserting that the unification had already happened. A comment cannot
 * hold that; a gate can.
 *
 * Run: node --test testing/standalone/minting-and-editing-share-one-scope-rule.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const TOKENS = 'server/src/api/tokens.ts';
const SCOPE = 'server/src/auth/editor-scope.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

/** The body of the handler registered for a route, bounded by the next route registration. */
function handlerFor(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at > 0, `${marker} is gone — re-point this gate`);
  const next = src.indexOf('tokensRouter.', at + marker.length);
  return src.slice(at, next < 0 ? src.length : next);
}

describe('one scope rule, used by every route that applies it', () => {
  it('the shared function exists and more than one route calls it', () => {
    /*
     * The vacuity guard. A gate asserting "the mint route calls X" says nothing if X has been renamed
     * away and nobody calls it — every route would then be equally, silently, non-compliant.
     */
    // Q-531: PATCH, regenerate and DELETE call `refusalsToManageToken`, the rule fed by the caller's own scope, extracted when a
    // personal-view copy became the fourth site that must refuse exactly when they do. It is the same rule, held below: its body
    // IS a call of `refusalsOutsideEditorScope` with `editorScopeFor(caller)`.
    const src = code(TOKENS);
    const calls = [...src.matchAll(/refusalsOutsideEditorScope\(|refusalsToManageToken\(/g)].length;
    assert.ok(calls >= 3,
      `only ${calls} call(s) to refusalsOutsideEditorScope or refusalsToManageToken — the shared rule has stopped being shared, so `
      + 'this gate is measuring nothing');
    assert.match(code(SCOPE), /export function refusalsOutsideEditorScope/,
      'the shared rule is gone from editor-scope.ts');
    assert.match(code(SCOPE), /export function refusalsToManageToken\([\s\S]*?\)[^{]*\{\s*return refusalsOutsideEditorScope\(\{ editorSpaces: editorScopeFor\(caller\)/,
      'refusalsToManageToken no longer IS the shared rule fed by the caller\'s scope, so the routes calling it have a second rule');
  });

  it('THE MINT ROUTE IS ONE OF THEM', () => {
    /*
     * The case this file exists for. Scoped to the POST handler rather than matched across the file,
     * because the other three calls are in this same module — a file-wide match passes while the mint
     * route runs its own copy, which is exactly the state this was written from.
     */
    // b100 row 5: through `refusalsToManageToken`, the entry PATCH, regenerate and DELETE use, not the rule fed by hand - a mint that
    // assembled `{ editorSpaces: editorScopeFor(...) }` itself was the fourth spelling of the caller's scope.
    const post = handlerFor(code(TOKENS), "tokensRouter.post('/'");
    assert.match(post, /refusalsToManageToken\(/,
      'the mint route decides "outside your scope" with its own inline check while three other routes use '
      + 'the shared one. It is a privilege boundary, and the PATCH route already claims in a comment that '
      + 'the two are unified');
  });

  it('and it no longer keys that decision on the deprecated allowlist', () => {
    /*
     * `!spaces` as the test for "unrestricted" is the specific defect: the matrix is the permission model
     * and `spaces` is deprecated, so a matrix-only request — which is what this product's own UI sends —
     * read as unrestricted and was refused.
     */
    const post = handlerFor(code(TOKENS), "tokensRouter.post('/'");
    assert.doesNotMatch(post, /else if \(!spaces\)/,
      'the mint route still treats a missing legacy allowlist as "unrestricted", so a space-restricted '
      + 'administrator cannot mint a matrix-only token — which is the only kind the UI sends');
  });
});

describe('the matrix carries the protections the removed array had', () => {
  /*
   * TWO PROTECTIONS WERE RIDING ON `spaces: z.array(z.string().min(1)).max(1000)` and both would have
   * been lost by deleting it — silently, because the field that replaces it is a `z.record`, which caps
   * nothing and accepts any string as a key.
   *
   * Neither was found by reading the diff. Both were found by red-team cases whose SUBJECT had moved out
   * from under them: each asserts a 400, and a removed field answers 400 too, so each went on passing
   * while the thing it guarded disappeared. **That is the shape to watch whenever a field is retired —
   * a test on its validation keeps passing on the refusal that replaced it.**
   */
  it('a size cap, the same one the array carried', () => {
    const src = code(TOKENS);
    const at = src.indexOf('const RightsMatrix');
    assert.ok(at > 0, 'RightsMatrix is gone — re-point this gate');
    const decl = src.slice(at, src.indexOf('}).strict()', at));
    assert.match(decl, /MAX_SCOPED_SPACES/,
      'perSpace has no size cap, so a token can name any number of spaces — each one stored on the '
      + 'record and walked on every scope decision. The array it replaced was capped at 1000');
  });

  it('and a space id that is not empty', () => {
    const src = code(TOKENS);
    /*
     * Anchored INSIDE the schema. A bare `indexOf('perSpace:')` finds the `NO_RIGHTS` constant at the
     * top of the file first and reads a line that has no validation on it at all — the third time in
     * this change that an unscoped `indexOf` measured the wrong code and reported confidently.
     */
    const decl = src.indexOf('const RightsMatrix');
    assert.ok(decl > 0, 'RightsMatrix is gone — re-point this gate');
    const at = src.indexOf('perSpace:', decl);
    assert.ok(at > decl, 'perSpace is gone from the matrix schema — re-point this gate');
    // Bounded by the newline character itself, which is right on CRLF too: it is the last one.
    const line = src.slice(at, src.indexOf('\n', at));
    assert.match(line, /z\.string\(\)\.min\(1\)/,
      'perSpace accepts an empty string as a space id, which is a grant to a space that cannot exist. '
      + 'The array it replaced refused it per element');
  });
  it('and the matrix is declared ONCE, for both doors', () => {
    // It was written out identically on the mint schema and the edit schema. Two copies of one shape is
    // how a cap gets added to one door and not the other.
    const src = code(TOKENS);
    const decls = [...src.matchAll(/perSpace: z\.record/g)].length;
    assert.equal(decls, 1,
      `perSpace is declared ${decls} times — one shape, one declaration, or a protection added to one `
      + 'door quietly misses the other');
  });
});

describe('the legacy mint options are refused, and say what to use instead', () => {
  it('the body schema no longer accepts them', () => {
    // set-claim: the retired scope spellings, a closed historical set -- nothing mints them any more, so
    // this is a record of what was removed rather than a copy of anything live.
    // `CreateTokenBody` is `.strict()`, so removing the keys turns them into a 400 rather than a silent
    // drop. That strictness is documented in this file as the most important word in it.
    const src = code(TOKENS);
    const at = src.indexOf('const CreateTokenBody');
    assert.ok(at > 0, 'CreateTokenBody is gone — re-point this gate');
    const schema = src.slice(at, src.indexOf('});', at));
    for (const legacy of ['spaces:', 'admin:', 'readOnly:']) {
      assert.ok(!schema.includes(legacy),
        `CreateTokenBody still declares \`${legacy}\` — 4.0 removes the legacy token inputs, and the `
        + 'matrix expresses everything they could (`migrateToken` maps every shape, and `grantsMoreThan` '
        + 'proves the mapping never widens)');
    }
  });

  it('and the refusal names the replacement rather than saying "unrecognized key"', () => {
    /*
     * `.strict()` alone answers `Unrecognized key(s) in object: 'spaces'`, which tells a caller they are
     * wrong and not what to do. The field it replaces is `rights`, and saying so is the difference
     * between a 400 somebody can act on and one they open an issue about.
     */
    const src = code(TOKENS);
    assert.match(src, /legacy|no longer accepted|use `rights`|use rights/i,
      'nothing in the mint route explains what replaced the legacy options');
  });
});
