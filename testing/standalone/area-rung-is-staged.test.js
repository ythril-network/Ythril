/**
 * The area check is layered on reach, and a request it cannot resolve is refused rather than left to reach.
 *
 * ## Why it is no longer staged
 *
 * Reach ("may this token touch this space at all") is enforced from the rights matrix. The area check adds
 * "and at what level, for what kind of operation". It shipped staged: a miss warned and fell through to
 * reach, on the argument that this could only be stricter than before. That argument held for a route whose
 * key was rebuilt wrongly; it did not hold for a request whose METHOD has no row. Express runs the GET route
 * for a HEAD, the inventory has no HEAD rows, and every HEAD to a path-scoped GET route fell through: reach
 * alone answered for an area the token held nothing on. The key now comes from the route map (`registeredPathOf`),
 * HEAD is looked up as GET, and a miss is a `403`. The route walk in `every-space-route-has-an-area` holds
 * that no registered route, with any method it answers, is a miss.
 *
 * (The file keeps its name so its history stays with it.)
 *
 * ## What must not drift
 *
 * The two checks have to agree about WHICH spaces they are checking. A proxy resolves to its members, and if
 * reach checked the members while the area check checked the proxy id, a proxy would be governed at one
 * level and its contents at another. They share `spaceTargets` for exactly that reason.
 *
 * Run: node --test testing/standalone/area-rung-is-staged.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blockAfter, enclosingBlockAround } from './_structural-window.mjs';

const ROOT = process.cwd();
const SRC = 'server/src/auth/middleware.ts';
const code = readFileSync(join(ROOT, SRC), 'utf8')
  .replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

const body = (fn) => {
  const i = code.indexOf(`function ${fn}`);
  return i < 0 ? null : code.slice(i, code.indexOf('\n}', i));
};

describe('the area check', () => {
  it('exists and runs after reach, not instead of it', () => {
    assert.ok(body('enforceAreaRung'), 'enforceAreaRung is gone — re-point this test');
    const reachAt = code.indexOf('enforceSpaceScope(res, record, spaceId)');
    const areaAt = code.indexOf('enforceAreaRung(res, record, req');
    assert.ok(reachAt > 0 && areaAt > 0, 'both checks must be called');
    assert.ok(reachAt < areaAt, 'the area check runs before reach, so an unreachable space is judged on level');
  });

  it('an unresolved request is REFUSED, and says so', () => {
    /*
     * INVERTED. This case pinned the staged plan: a miss warned and fell through to reach, "until the log is clean". The log was never
     * the evidence that mattered: every HEAD to a path-scoped GET route missed (the inventory has GET rows, Express runs the GET route for
     * a HEAD), so for as long as the area check existed a token that reached a space read the status and headers of every area there.
     * A fall-through is the permissive default `required-rung.ts` says must never happen. A request the inventory does not resolve is
     * refused `403 route_unclassified`, still with the warning that names the key; `every-space-route-has-an-area` walks every registered
     * route, with every method it answers, so no real route is refused by this.
     */
    const b = body('enforceAreaRung');
    const at = b.indexOf("verdict.kind === 'unclassified'");
    assert.ok(at > -1, 'a miss is not handled at all');
    const branch = blockAfter(b, at, 'the unclassified branch');
    assert.match(branch, /log\.warn/, 'a miss is silent, so nothing would reveal which route lacks its row');
    assert.match(branch, /res\.status\(403\)[\s\S]*?code: 'route_unclassified'/, 'a miss must answer 403 with its named code');
    assert.match(branch, /return false;/, 'a miss must stop the request');
    assert.doesNotMatch(branch, /return true;/, 'a miss falls through to reach: the permissive default again');
  });

  it('a DELIBERATELY exempt route is silent — it is decided, not missed', () => {
    /*
     * The defect the canary operator read off a live pod on 2026-08-20. `NOT_AREA_SCOPED` records, with a
     * written reason each, that four routes are not views of a space's DATA. The runtime knew only
     * `ROUTE_RIGHTS`, so every request to one of them logged
     *
     *     no inventory entry for 'GET /api/brain/spaces/:spaceId/activity' — reach enforced, area not.
     *     Add it to ROUTE_RIGHTS; misses become refusals once the log is clean.
     *
     * Two things wrong with that, and the second is the serious one. The advice would have UNDONE the
     * recorded decision. And "once the log is clean" was a state four routes guaranteed could never be
     * reached, so the refusal flip the message promises could never happen — a deferred safety improvement
     * that its own log message makes unreachable is indistinguishable from one nobody got round to.
     */
    const b = body('enforceAreaRung');
    const exempt = b.indexOf("verdict.kind === 'not-area-scoped'");
    const unclassified = b.indexOf("verdict.kind === 'unclassified'");
    assert.ok(exempt > -1, 'the exempt case is not handled, so an exemption reads as an oversight again');
    assert.ok(unclassified > exempt,
      'the exempt check must come FIRST; after the warning it cannot prevent it');

    // AN ORDERING CLAIM, not a window: the exempt branch has to return before ANY log call in this function,
    // which is what makes it silent. Comparing indices says exactly that and nothing about how much text
    // sits between them.
    assert.ok(b.indexOf('log.warn') > exempt, 'the warning is reachable from the exempt path');

    // And the warning belongs to the unclassified branch specifically, bounded by that branch's own brace —
    // not to the function at large. `blockAfter` because a cap here could not tell "inside the branch" from
    // "a few lines after it", and those are the two opposite behaviours.
    assert.match(blockAfter(b, unclassified, 'the unclassified branch'), /log\.warn/,
      'the warning must live inside the unclassified branch, or it fires for decided routes too');

    // The advice in the message names BOTH lists now. Naming only ROUTE_RIGHTS is what sent an operator at
    // the wrong fix for two of the four.
    assert.match(b, /NOT_AREA_SCOPED/,
      'the warning must offer the exemption list as well, or the only advice on offer is the wrong one');
  });

  it('iterating routes are NOT gated on the call', () => {
    // Data quality takes no space and walks the token's reachable ones. Gating the call would refuse the
    // whole endpoint for a token that legitimately reaches some of the spaces behind it.
    assert.match(body('enforceAreaRung'), /need\.scope !== 'path'/,
      'an iterating route would be judged as though it named one space');
  });

  it('a record with no rights matrix is REFUSED, not left to reach alone', () => {
    /*
     * INVERTED by `Q-5`, and the reason it held is written here rather than deleted with it.
     *
     * It read *"OIDC tokens never pass the config backfill. Refusing them here would be a lockout"* and
     * asserted `if (!rights) return true;` — allow. That was true when it was written and stopped being
     * true two releases ago: an OIDC session carries `rights` as a REQUIRED field, derived per request by
     * `migrateToken` from its claim mapping, which is asserted three cases into
     * `no-matrix-reaches-nothing-not-everything.test.js`. There is no token shape left that this refuses,
     * so there is no lockout to trade against.
     *
     * The owner ruled on the general case the same day: *"no matrix = refuse - no fallback no backwards
     * compatibility anymore."* That swept two sites; this was the fourth and `toolRightsRefusal` the third.
     *
     * **The POSITION is asserted as well as the refusal**, because getting it wrong breaks the opposite
     * thing. The check has to run after the `NOT_AREA_SCOPED` and unclassified verdicts: the first is a decided
     * exemption, refusing it for want of a matrix would area-scope a route the design says is not, and the
     * second is refused with its own code before a matrix is asked about.
     */
    const b = body('enforceAreaRung');
    assert.doesNotMatch(b, /if \(!rights\) return true;/,
      'the area check allows a caller with no rights matrix — the absent-means-permission shape again');
    assert.match(b, /if \(!rights\) \{[\s\S]*?403/,
      'the absent-matrix case must refuse with a 403');
    const refusalAt = b.indexOf('if (!rights) {');
    const scopeAt = b.indexOf("need.scope !== 'path'");
    assert.ok(refusalAt > scopeAt && scopeAt > 0,
      'the matrix refusal runs BEFORE the verdict is known, so a NOT_AREA_SCOPED or unclassified route is '
      + 'now area-scoped for want of a matrix — the opposite of the decision recorded in each `why`');
  });

  it('both checks resolve the target spaces the SAME way', () => {
    // A path names ONE space (a personal view is judged first, by `judgeSpaceParam`, and is never a space), so reach and the area rung
    // are asked of the same id: the id the path named. If one asked about the space and the other about something derived from it, the
    // two would be governed at different levels — and the weaker one would win silently.
    assert.ok(body('judgeSpaceParam'), 'the step that judges the path\'s space id first is gone; a view or a retired id would reach the checks below');
    // Every guard that asks reach about the path's id asks the area rung about the same id, in the same block (bounded by the block,
    // never by a character count).
    const reachCalls = [...code.matchAll(/enforceSpaceScope\(res, record, spaceId\)/g)].map(m => m.index);
    assert.ok(reachCalls.length >= 2, `only ${reachCalls.length} guard(s) ask reach about the path's id; the anchor moved`);
    for (const at of reachCalls) {
      assert.match(enclosingBlockAround(code, at, 'the block asking reach'), /enforceAreaRung\(res, record, req, spaceId \? \[spaceId\] : \[\]\)/,
        'the area check must be asked about the same id the reach check was');
    }
  });

  it('refuses with the area and the level, not a bare 403', () => {
    // "Forbidden" on a matrix of four areas and four levels is unactionable.
    assert.match(body('enforceAreaRung'), /needs '\$\{need\.needs\}' on \$\{need\.area\}/);
  });
});
