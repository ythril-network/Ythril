/**
 * A token with no rights matrix reaches NOTHING. It used to reach everything.
 *
 * ## The branch
 *
 * `tokenReachesSpace` asked the matrix first and fell back to the pre-3.0 `spaces` allowlist:
 *
 * ```
 * const legacy = authToken?.['spaces'];
 * return !legacy || legacy.includes(spaceId);
 * ```
 *
 * `!legacy` — **an absent allowlist meant unrestricted.** So a token carrying neither a matrix nor an
 * allowlist reached every space on the instance.
 *
 * ## Why that was defensible once, and is not now
 *
 * The fallback existed for records that predate the matrix, and its own comment said so: *"Dropping that
 * branch here would REFUSE those tokens rather than widen them, which is the safe direction but still an
 * outage. It goes with the field itself in D-8d."*
 *
 * **D-8d happened in 3.1.** `spaces`, `admin` and `readOnly` left `TokenRecord`; every scoping decision
 * reads `rights`. And nothing can now reach this branch:
 *
 *  - a **PAT** gets a matrix from `createToken`, which stores `opts.rights ?? migrateToken(…)`;
 *  - a PAT that predates the matrix gets one from `migrateTokenRightsOnBoot`, in memory, on every start;
 *  - an **OIDC session** carries `rights` as a REQUIRED field, derived by `migrateToken` from its claim
 *    mapping — so the surface that genuinely has no stored matrix builds one per request.
 *
 * So the branch was unreachable **and failed open**, which is the worse of the two ways to be unreachable:
 * nothing exercises it, and if anything ever did it would hand over the whole instance.
 *
 * ## What it does now
 *
 * No matrix, no reach. That is the direction the original comment already called safe, and it is now free
 * of the outage that made it unattractive — there is no token shape left that would be refused by it.
 *
 * Run: node --test testing/standalone/no-matrix-reaches-nothing-not-everything.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const SHARED = 'server/src/api/sync/_shared.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

const sync = await import('../../server/dist/api/sync/_shared.js');
const editor = await import('../../server/dist/auth/editor-scope.js');
const mcp = await import('../../server/dist/mcp/tool-rights-guard.js');

/**
 * A matrix that grants something, used only to prove each guard can ALSO say yes.
 *
 * The vacuity guard for the "every guard alike" block below: a guard that refuses everything satisfies each
 * refusal assertion while being broken in the opposite direction, and refusing everything is exactly what a
 * careless *"no matrix means refuse"* change produces.
 */
const GRANTING = {
  instanceAdmin: false,
  createSpaces: false,
  floor: null,
  perSpace: { demo: { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' } },
};

describe('every token shape that exists carries a matrix', () => {
  it('a PAT gets one at mint, or derived from the legacy inputs', () => {
    // `createToken` stores `opts.rights ?? migrateToken(…)`. The `??` is what makes this true for a caller
    // that named no matrix — omitting the field left a newly minted token with none until the next boot.
    const src = code('server/src/auth/tokens.ts');
    assert.match(src, /rights: opts\.rights \?\?/,
      'createToken no longer guarantees a matrix, so a freshly minted token can have none');
  });

  it('a pre-matrix PAT gets one at boot, in memory', () => {
    assert.match(code('server/src/config/loader.ts'), /migrateTokenRightsOnBoot\(_config\)/,
      'the boot derivation is gone, so a token predating the matrix reaches this branch with none');
  });

  it('and an OIDC session carries one as a REQUIRED field', () => {
    /*
     * The surface that genuinely has no STORED matrix. It builds one per request from its claim mapping,
     * with `migrateToken` — the same function, so an OIDC session and a legacy PAT with identical settings
     * resolve identically. Required rather than optional is the half that matters here: an optional field
     * would put OIDC straight back on the fallback.
     */
    const src = code('server/src/auth/oidc.ts');
    assert.match(src, /rights: TokenRights;/,
      'OidcTokenRecord no longer requires a matrix, so an OIDC session can reach the no-matrix branch');
    assert.match(src, /rights: migrateToken\(/,
      'OIDC no longer derives its matrix, so its claim mapping is not enforced through `rights`');
  });
});

describe('so no matrix means no reach', () => {
  it('the legacy allowlist fallback is gone', () => {
    const src = code(SHARED);
    const at = src.indexOf('export function tokenReachesSpace');
    assert.ok(at > 0, 'tokenReachesSpace is gone — re-point this gate');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.doesNotMatch(body, /\['spaces'\]/,
      'tokenReachesSpace still reads the pre-3.0 allowlist — the field left TokenRecord in 3.1, so the '
      + 'branch is unreachable, and it grants EVERY space when the allowlist is absent');
  });

  it('and the absent case refuses rather than admitting', () => {
    /*
     * THE CASE THIS FILE EXISTS FOR. `!legacy || legacy.includes(spaceId)` read a missing scope as
     * unrestricted — the same absent-means-permission shape this codebase has shipped as an empty
     * allowlist read as "unrestricted", three times over.
     */
    const src = code(SHARED);
    const at = src.indexOf('export function tokenReachesSpace');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.doesNotMatch(body, /return !\w+ \|\|/,
      'an absent scope is still read as unrestricted');
    assert.match(body, /return false|if \(!rights\) return false/,
      'a token with no matrix must reach nothing; refusing is the direction the original comment already '
      + 'called safe, and there is no longer a token shape it would wrongly refuse');
  });
});

/**
 * ## EVERY guard alike, because this file was scoped to one of them (`Q-5`)
 *
 * The block above reads one function in one file, and the ruling it enforces was about a rule rather than a
 * function. **A third copy was missed for that reason.** `toolRightsRefusal`, which area-scopes an MCP tool
 * call, opened with `if (!rights || !space) return null` — no matrix, so allow — and no assertion anywhere
 * looked at it.
 *
 * The precedent for this correction is in `CLAUDE.md`, about a different gate and the same mistake: *"A gate
 * scoped to one mechanism concludes about all of them."* So these cases ask the question of every guard that
 * can be handed an absent matrix, and they CALL the guards rather than reading their source — a source test
 * cannot tell live code from dead, and the first version of the MCP guard's own check was a grep that passed
 * against `if (false && …)`.
 *
 * `spaceAdminRefusal` already refused and is asserted anyway: it sits twenty lines above the one that did
 * not, so this file's whole subject had both answers inside one screen of one file.
 */
describe('and every other guard that can see an absent matrix answers the same way', () => {
  it('the space-reach guard refuses, and admits a matrix that grants', () => {
    assert.equal(sync.tokenReachesSpace({}, 'demo'), false, 'a token with no matrix reached a space');
    assert.equal(sync.tokenReachesSpace(undefined, 'demo'), false, 'no token at all reached a space');
    assert.equal(sync.tokenReachesSpace({ rights: GRANTING }, 'demo'), true,
      'the guard refuses a matrix that grants — every refusal above would then pass while nothing worked');
  });

  it('the editor-scope guard answers "no spaces", not "unrestricted"', () => {
    // The two values mean opposite things and look identical at a call site: `undefined` is unrestricted,
    // `[]` is nothing. That is what made this one dangerous rather than merely wrong.
    assert.deepEqual(editor.editorScopeFor({}), [], 'a token with no matrix was read as unrestricted');
    assert.equal(editor.editorScopeFor({ rights: GRANTING })?.includes('demo'), true,
      'the guard denies a matrix that grants — the vacuity half');
  });

  it('the MCP tool-rights guard refuses, and still lets an instance-level tool through', () => {
    /*
     * The site the ruling missed. `saveFact` is a write into the knowledge area, so a matrixless caller
     * asking for it is the plainest case there is.
     *
     * The second assertion is the one that made the ORDER of the fix matter: a tool with no `TOOL_RIGHTS`
     * row is instance-level and is governed by its `admin` flag elsewhere, so refusing on an absent matrix
     * before looking the row up would have broken `list_spaces` and friends — the same mistake pointing the
     * other way.
     */
    assert.notEqual(mcp.toolRightsRefusal('save_fact', undefined, 'demo'), null,
      'an MCP tool call with no rights matrix was allowed — the absent-means-permission shape the owner '
      + 'ruled out on 2026-09-05, still standing on the MCP door');
    assert.equal(mcp.toolRightsRefusal('list_spaces', undefined, ''), null,
      'a tool with no rights row is instance-level; refusing it here means the matrix check ran before the '
      + 'row lookup');
    assert.equal(mcp.toolRightsRefusal('save_fact', GRANTING, 'demo'), null,
      'the guard refuses a matrix granting admin on every area — this case would then pass vacuously');
  });

  it('the space-admin guard already refused, and is asserted so it cannot drift the other way', () => {
    const tool = { name: 'schema_update', spaceAdmin: true };
    assert.notEqual(mcp.spaceAdminRefusal(tool, undefined, 'demo'), null,
      'a space-configuring tool was allowed to a token with no rights matrix');
    /*
     * ADMITTED BY THE GRANT, and refused by four admin rungs — which is the 5.0 change, not a slip. Space
     * admin is its own right: `GRANTING` holds every AREA at admin and is therefore able to do anything
     * to that space's DATA, which is not the same as configuring the space.
     */
    const ADMINISTERS = { ...GRANTING, spaceAdmin: { floor: false, spaces: ['demo'] } };
    assert.equal(mcp.spaceAdminRefusal(tool, ADMINISTERS, 'demo'), null,
      'the guard refuses a token that actually holds the space-admin grant');
    assert.notEqual(mcp.spaceAdminRefusal(tool, GRANTING, 'demo'), null,
      'four admin rungs configured the space — administration is its own grant since 5.0, and reading it '
      + "off the data rungs hands the space's settings to any token holding four of them");
  });

  it('and the REST area check refuses too — the same rule on the other door', () => {
    /*
     * The FOURTH copy, and the one that makes this a both-doors fix rather than an MCP one. `enforceAreaRung`
     * in `auth/middleware.ts` opened with `if (!rights) return true;  // OIDC records: reach already answered
     * for them` — the identical shape with the identical expired reason, letting a matrixless caller past
     * the AREA check on every classified REST route.
     *
     * `spaceTargets`, forty lines above it in the same file, was swept when the ruling landed and says so in
     * its own comment. So this file held both answers to one question, adjacent — exactly as the MCP rights
     * file did.
     *
     * Source-read rather than called because the function is Express middleware wanting a `res`, a `req` with
     * a matched route, and a token record. What it is asserted on is the SHAPE that was wrong: an early
     * `return true` keyed on the matrix being absent.
     */
    const src = code('server/src/auth/middleware.ts');
    const at = src.indexOf('function enforceAreaRung');
    assert.ok(at > 0, 'enforceAreaRung is gone — re-point this gate');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(body.length > 300, 'the enforceAreaRung body is suspiciously small — re-anchor this gate');
    assert.doesNotMatch(body, /if\s*\(\s*!rights\s*\)\s*return\s+true/,
      'the REST area check allows a caller with no rights matrix. Refuse instead — owner, 2026-09-05: '
      + '"no matrix = refuse - no fallback no backwards compatibility anymore". The reach guard answers a '
      + 'different question: which spaces, not which areas within one.');
    assert.match(body, /if\s*\(\s*!rights\s*\)\s*\{[\s\S]*?403/,
      'the absent-matrix case no longer refuses with a 403 — if the check moved, re-point this assertion '
      + 'rather than deleting it');
  });

  it('and no guard in the MCP rights file reads an absent matrix as allow', () => {
    /*
     * The structural half, and it is here because the cases above can only ask about guards that EXIST.
     * A fifth added to that file tomorrow with the same opening line would satisfy every one of them,
     * because none of them knows to call it.
     *
     * `if (!rights…) return null` is the whole signature: it is how all three swept sites were spelled, and
     * it is short enough to be re-typed by somebody who has read one of the others.
     */
    const src = code('server/src/mcp/tool-rights-guard.ts');
    assert.ok(src.length > 500, 'the guard source is suspiciously small — re-anchor this gate');
    assert.match(src, /toolRightsRefusal/, 'the guard has been renamed or moved — re-anchor this gate');
    assert.doesNotMatch(src, /if\s*\(\s*!rights[^)]*\)\s*return\s+null/,
      'a guard in tool-rights-guard.ts returns "allow" when the rights matrix is absent. Refuse instead — '
      + 'owner, 2026-09-05: "no matrix = refuse - no fallback no backwards compatibility anymore".');
  });
});
