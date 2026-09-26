/**
 * Every token record that can reach a handler carries a rights matrix, and a record without one reaches
 * NOTHING rather than everything.
 *
 * ## The default that was the wrong way round
 *
 * "Which spaces may this token see" had two implementations: the rights matrix, and the pre-3.0 `spaces`
 * allowlist as a fallback for a record that had no matrix. The fallback's own rule was carefully written —
 * an ABSENT allowlist is every space, an EMPTY one is none, never length-as-truthiness — and it was correct
 * for the legacy field it was reading.
 *
 * Put the two together and the composite answer was **fail-open**: no matrix AND no allowlist returned every
 * space in the instance. `spacesWhereTokenMay` did it explicitly, and `middleware.ts` did it twice more.
 * That is defensible for a legacy token, whose absent allowlist genuinely meant "unrestricted" — and it is
 * not defensible as the answer to "this record has no scope information at all", which is what it had become.
 *
 * ## Why the fallback is unreachable, established rather than assumed
 *
 * There is exactly ONE place a record is attached to a request — `attachToken`, fed by `resolveAuthOrFail`,
 * fed by `resolveBearer` — and `resolveBearer` has two branches:
 *
 *  - **PAT.** `createToken` always writes a matrix, and `migrateTokenRightsOnBoot` derives one IN MEMORY for
 *    any stored record that lacks it. The in-memory half is what matters here: it mutates the same config
 *    object `findMatchingToken` reads, so a pre-matrix token on disk still arrives with a matrix.
 *  - **OIDC.** `validateOidcJwt` derives one per request through the same `migrateToken` the migration uses,
 *    which is the fix that closed a hole where OIDC connections were governed by the old booleans while PATs
 *    were enforced per space.
 *
 * So a record with no matrix cannot reach a handler. This file asserts each of those three facts, because
 * "cannot happen" is worth exactly as much as the thing that stops it happening. That if one ever did the
 * answer is no spaces rather than all of them — on every guard, not one — is asserted in
 * `no-matrix-reaches-nothing-not-everything.test.js`, the one home of that rule since `Q-45.4`.
 *
 * ## What this is NOT
 *
 * Not the removal of the legacy FIELDS. `admin`, `readOnly` and `spaces` are still on the record type, still
 * written by `createToken` and the OIDC mapping, and still returned by the tokens API; deleting them is a
 * separate job that produced 55 type errors across 14 files when measured. What goes here is their last use
 * as a SCOPING INPUT — the second implementation of the reach rule.
 *
 * Run: node --test testing/standalone/a-token-without-a-matrix-reaches-nothing.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const MIDDLEWARE = 'server/src/auth/middleware.ts';

describe('a record cannot reach a handler without a matrix', () => {
  it('there is exactly ONE place a record is attached to a request', () => {
    /*
     * The whole argument rests on this. Two attachment points and the second one is where a record with no
     * matrix gets in — which is the shape of the OIDC hole that was closed in 3.0, one surface out.
     */
    const s = src(MIDDLEWARE);
    const assigns = [...s.matchAll(/req\.authToken\s*=/g)].length;
    assert.equal(assigns, 1, `req.authToken is assigned ${assigns} times — every record must come through one door`);
  });

  it('and one place a bearer is resolved into one, with two branches', () => {
    const s = src(MIDDLEWARE);
    const at = s.indexOf('async function resolveBearer(');
    assert.notEqual(at, -1, 'resolveBearer is gone — this gate is reading the wrong thing');
    const fn = s.slice(at, s.indexOf('\n}', at));
    assert.match(fn, /isPat\(bearer\)/, 'the PAT branch');
    assert.match(fn, /validateOidcJwt\(bearer\)/, 'the OIDC branch');
    // A third source of records would need its own proof that it attaches a matrix.
    const returns = [...fn.matchAll(/return\s+/g)].length;
    assert.ok(returns <= 4, `resolveBearer has ${returns} returns — a new record source needs a row in this gate`);
  });

  it('the PAT branch: createToken writes a matrix, and the boot backfill covers what is stored', () => {
    // `rights: opts.rights ?? migrateToken(…)`. The `??` is what makes this true for a caller that named no
    // matrix — omitting the field left a newly minted token with none until the next boot.
    assert.match(src('server/src/auth/tokens.ts'), /rights: opts\.rights \?\?/,
      'createToken no longer guarantees a matrix, so a freshly minted token can have none');
    assert.match(src('server/src/config/loader.ts'), /migrateTokenRightsOnBoot\(_config\)/,
      'the in-memory backfill must still run at boot — it is what makes a pre-matrix token on disk arrive '
      + 'with one');
  });

  it('the OIDC branch: a matrix is derived per request, from the same migration', () => {
    const s = src('server/src/auth/oidc.ts');
    // REQUIRED rather than optional is the half that matters: an optional field would put OIDC straight back
    // on the no-matrix branch.
    assert.match(s, /rights: TokenRights;/,
      'OidcTokenRecord no longer requires a matrix, so an OIDC session can arrive with none');
    // Optionally through `withInstanceAdminGrants` (S-11), which applies the instance-admin floor to the derivation.
    assert.match(s, /rights:\s*(withInstanceAdminGrants\()?migrateToken\(/,
      'the OIDC record must derive its matrix through migrateToken — hand-rolling it is what granted whole '
      + 'instances when it was got wrong before');
  });
});

/*
 * The CONSEQUENCE — that a record with no matrix reaches nothing, on every guard — is asserted in
 * `no-matrix-reaches-nothing-not-everything.test.js`, the one home of that rule (`Q-45.4`). Two blocks
 * restating it for `spacesWhereTokenMay` stood here and moved there.
 */
