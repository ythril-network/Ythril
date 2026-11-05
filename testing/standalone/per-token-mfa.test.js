/**
 * Per-token MFA — the policy, and the escalation it must not allow.
 *
 * ## The reported problem
 *
 * `/api/mfa` is a single instance-wide `{ enabled }`. Turning it on makes every MFA-gated route demand a TOTP
 * code from every PAT, including the ones a scheduler holds — so **MFA is mutually exclusive with automation,
 * and the deployments most likely to want MFA are exactly the ones that have automation.** The ask was to make
 * it a token property, as read-only and space scoping already are.
 *
 * ## The two things worth pinning
 *
 * 1. **The policy itself.** Three states, both overrides, and `inherit` meaning precisely what an absent field
 *    means today — so no existing token changes behaviour.
 * 2. **An exemption must not be able to widen itself.** `POST /api/tokens` is guarded by `requireAdminMfa`,
 *    which an admin token that is ITSELF exempt satisfies with no code at all. Without a second rule, one
 *    exemption mints another, and another, until the instance-wide switch protects nothing. Granting an
 *    exemption therefore costs a live TOTP code regardless of who is asking.
 *
 * The second is asserted against the SOURCE as well as the helper, because the hole is opened by an ordering
 * mistake (checking after the write, or not at all on a future edit route) that a unit test of the predicate
 * cannot see.
 *
 * Run: node --test testing/standalone/per-token-mfa.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let mfaRequiredFor;

describe('per-token MFA policy', () => {
  before(async () => {
    ({ mfaRequiredFor } = await import('../../server/dist/auth/middleware.js'));
  });

  it('an absent setting follows the instance switch — nothing existing changes', () => {
    // This is the compatibility guarantee: every token in every current config has no `mfa` field.
    assert.equal(mfaRequiredFor({}, true), true);
    assert.equal(mfaRequiredFor({}, false), false);
    assert.equal(mfaRequiredFor({ mfa: 'inherit' }, true), true);
    assert.equal(mfaRequiredFor({ mfa: 'inherit' }, false), false);
  });

  it('exempt skips MFA even when the instance switch is ON — the automation case', () => {
    assert.equal(mfaRequiredFor({ mfa: 'exempt' }, true), false);
    assert.equal(mfaRequiredFor({ mfa: 'exempt' }, false), false);
  });

  it('required demands MFA even when the instance switch is OFF — the mirror case', () => {
    // Why the field is not a boolean: an operator who wants a second factor on two human admin tokens and
    // nothing else would otherwise have to turn it on for everything, which is the same all-or-nothing trap
    // from the other side.
    assert.equal(mfaRequiredFor({ mfa: 'required' }, false), true);
    assert.equal(mfaRequiredFor({ mfa: 'required' }, true), true);
  });

  it('is a total function over the three states', () => {
    for (const mfa of [undefined, 'inherit', 'exempt', 'required']) {
      for (const enabled of [true, false]) {
        assert.equal(typeof mfaRequiredFor({ mfa }, enabled), 'boolean', `${mfa}/${enabled}`);
      }
    }
  });
});

describe('an MFA exemption cannot widen itself', () => {
  const src = readFileSync(join(ROOT, 'server/src/api/tokens.ts'), 'utf8');
  // Comments explain the trap by name, so they must not satisfy the checks that guard it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  it('creating an exempt token verifies a live TOTP code', () => {
    assert.match(code, /mfa !== 'exempt' \|\| !isMfaEnabled\(\)/,
      'the guard must key on the REQUESTED exemption and the instance switch');
    // Asked through the attempt counter (Q-694), whose answer is an object: the code must actually be verified, and the verdict read as
    // `.ok` (or `.reason`), never as a boolean. The helper's own body is the window, so a call elsewhere in the file cannot satisfy this.
    const at = code.indexOf('function exemptionNeedsLiveCode(');
    assert.ok(at >= 0, 'exemptionNeedsLiveCode is gone');
    const helper = code.slice(at, code.indexOf('\n}\n', at));
    const call = /(?<![\w$])tryMfaCode\(/.exec(helper);
    assert.ok(call, 'the code must actually be verified, through tryMfaCode, not merely present');
    assert.match(helper.slice(call.index), /\.(?:ok|reason)\b/, 'the verdict of tryMfaCode must be read as .ok or .reason');
    assert.doesNotMatch(helper, /(?<![\w$])!\s*tryMfaCode\(/, 'tryMfaCode answers an object: a negated call is never true');
    assert.doesNotMatch(helper, /\bverifyMfaCode\(/, 'the exemption door verifies a code without the attempt counter');
  });

  it('checks BEFORE the token is created, not after', () => {
    // An after-the-fact check leaves the token minted. Ordering is the whole guarantee here, and it is the
    // kind of thing a predicate test cannot see.
    const guard = code.indexOf('exemptionNeedsLiveCode(req, res, mfa)');
    const create = code.indexOf('await createToken(');
    assert.ok(guard > 0, 'the create route must call the guard');
    assert.ok(create > guard, 'the exemption guard must run before createToken');
  });

  it('every route that can SET mfa is behind admin + MFA to begin with', () => {
    // The live-code rule is the second lock. The first is that only an administrator gets here at all.
    //
    // The guard was renamed when a matrix SPACE administrator was admitted to the token routes (SA-1, owner
    // ruling P-8 = B). The assertion is on the MFA half rather than on the old name, because that is what
    // this test is about: `requireAdminOrSpaceAdminMfa` still enforces `enforceMfa`, and a space admin is
    // still a human with an authenticator — exempting one would make "space admin" a way around the
    // instance-wide second factor.
    assert.match(code, /tokensRouter\.post\('\/',[^\n]*requireAdmin\w*Mfa/,
      'token creation must stay admin + MFA gated');
    assert.doesNotMatch(code, /tokensRouter\.post\('\/',[^\n]*requireAuth\b/,
      'token creation must never fall back to plain authentication');
  });

  it('the ROUTE, not just the helper, is what refuses — a 403 with a reason', () => {
    assert.match(code, /error: 'MFA_REQUIRED'/,
      'the refusal must use the documented MFA_REQUIRED code so a client can tell it from a generic 403');
  });
});

describe('the stored record stays clean', () => {
  const src = readFileSync(join(ROOT, 'server/src/auth/tokens.ts'), 'utf8');

  it('does not persist `inherit`, which is what absence already means', () => {
    // Writing the default would put a field on every future token that says exactly what its absence says,
    // and would make a config diff look like a policy change on tokens nobody touched.
    assert.match(src, /opts\.mfa && opts\.mfa !== 'inherit'/);
  });
});
