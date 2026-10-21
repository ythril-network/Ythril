/**
 * The space guard asks the rights matrix, and still refuses everything it refused before.
 *
 * ## What changed, and what must not have
 *
 * `enforceSpaceScope` decided access from `record.spaces`. It now asks `reachesSpace()` on the token's
 * rights, which are derived from the same legacy fields at config load. Behaviour is unchanged BY
 * CONSTRUCTION — but "by construction" is exactly the claim that needs a test, because the failure mode of
 * getting it wrong is a token reaching a space it never could, with nothing to notice.
 *
 * `rights-reach-matches-legacy.test.js` proves the two predicates agree. This proves the GUARD uses the new
 * one, keeps the proxy rule, and keeps the fallback that OIDC callers depend on.
 *
 * ## The fallback is not decoration
 *
 * OIDC-derived tokens are built per request, not read from config, so the backfill never sees them and they
 * carry no `rights`. Without the legacy branch the guard would refuse every OIDC caller — a lockout, not a
 * widening, but a lockout that would reach production because no unit test stands up an OIDC session.
 *
 * Run: node --test testing/standalone/space-guard-reads-rights.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = 'server/src/auth/middleware.ts';
const src = readFileSync(join(ROOT, SRC), 'utf8');
const withoutComments = (text) =>
  text.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const code = withoutComments(src);

/** The body of `enforceSpaceScope`, sliced to its own closing brace rather than by a character count. */
function guardBody() {
  const i = code.indexOf('function enforceSpaceScope');
  if (i < 0) return null;
  const j = code.indexOf('\n}', i);
  return j < 0 ? null : code.slice(i, j);
}

describe('the space guard', () => {
  it('is still there to be checked', () => {
    // A gate that cannot find its subject passes vacuously and would keep passing after a rename.
    assert.ok(guardBody(), `enforceSpaceScope is gone from ${SRC} — re-point this test`);
  });

  it('asks the rights matrix', () => {
    assert.match(guardBody(), /reachesSpace\(/,
      'the guard no longer consults the rights matrix, so the grid governs nothing');
  });

  it('has NO legacy branch — a record with no rights reaches nothing', () => {
    /*
     * This asserted the legacy branch was KEPT, on the grounds that "OIDC tokens are built per request and
     * never reach the config backfill — removing this refuses them all".
     *
     * That reason expired. The OIDC path derives a matrix per request through the same `migrateToken` the
     * migration uses (`oidc.ts`), which was the fix for OIDC connections being governed by the old booleans
     * while PATs were enforced per space and per area. So the branch served nobody — and while it sat there
     * it failed OPEN, because an absent legacy allowlist meant unrestricted.
     *
     * `a-token-without-a-matrix-reaches-nothing.test.js` carries the proof that no record without a matrix
     * reaches a handler; what is asserted here is that this surface no longer has the arm.
     */
    assert.doesNotMatch(guardBody(), /legacySpacesOf|\.spaces\b/,
      'the guard must read the matrix and nothing else');
    // Q-531: the guard asks of ONE id, so the fail-closed answer is the absent matrix refused in the same condition as an
    // unreached space (it was a member filter that returned [] for no matrix, while a proxy had members).
    assert.match(guardBody(), /if \(!rights \|\| !reachesSpace\(rights, spaceId\)\)/,
      'and say so explicitly, so the fail-closed answer is not arrived at by accident');
  });

  /*
   * Q-531 retired the proxy rule this file held ("AT LEAST ONE member, since Q-6", with its `[spaceId]` fallback): a proxy is a
   * personal view, outside `config.spaces`, and a path naming a view is judged BEFORE this guard (`judgeSpaceParam`), so a path
   * reaching here names one space. The safety property that fallback carried — an unknown id never yields an empty target list
   * that a `.some()`-shaped check passes vacuously — now holds by construction, and is asserted as that: one id, asked once.
   */
  it('asks reach of the ONE id the path named, with no member expansion', () => {
    const body = guardBody();
    assert.match(body, /reachesSpace\(rights, spaceId\)/, 'the guard no longer asks reach of the id the path named');
    assert.doesNotMatch(body, /resolveMemberSpaces|memberIds|targets|\.some\(|\.filter\(/,
      'the guard expands the id to a list again: a list is what an unknown id once emptied into a vacuous pass');
  });

  it('refuses rather than falling through when a space is unreachable', () => {
    const body = guardBody();
    assert.match(body, /status\(403\)/, 'an unreachable space must be refused, not allowed');
    assert.match(body, /return false/);
  });

  it('still answers true when there is no space to check', () => {
    // Routes with no :spaceId must not be refused by a space guard.
    assert.match(guardBody(), /if \(!spaceId\) return true;/);
  });
});
