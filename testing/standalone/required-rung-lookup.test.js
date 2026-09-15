/**
 * The route inventory answers "what rung does this request need", and a miss means REFUSE.
 *
 * ## The property that carries the whole feature
 *
 * `rungFor()` answers with one of THREE kinds, and the reason it is three rather than two is a defect that
 * shipped for five releases.
 *
 *   requires          classified in ROUTE_RIGHTS. Enforce it.
 *   not-area-scoped   on NOT_AREA_SCOPED, with a written reason. An explicit allow.
 *   unclassified      nobody decided. **The caller must treat this as REFUSE, never as "no requirement".**
 *
 * An unclassified route is one nobody decided about, and defaulting it to permissive reproduces exactly the
 * situation this feature exists to end: access that works because nothing said otherwise.
 *
 * The old shape returned `null` for the last TWO, so a deliberate exemption and an oversight were the same
 * event. `enforceAreaRung` logged every request to an exempt route as a miss, advising the operator to add it
 * to `ROUTE_RIGHTS` -- which would have undone the decision the exemption records -- and the message's own
 * plan ("misses become refusals once the log is clean") could never fire, because four routes were guaranteed
 * to warn forever. The canary operator read those two log lines off a live pod on 2026-08-20 and reported them.
 *
 * The build-time gate makes `unclassified` unreachable in practice. This file assumes it happens anyway,
 * because "unreachable in practice" is how the last three silent failures in this codebase described
 * themselves.
 *
 * Run: node --test testing/standalone/required-rung-lookup.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let rungFor, satisfies, ROUTE_RIGHTS, NOT_AREA_SCOPED;
before(async () => {
  ({ rungFor, satisfies } = await import('../../server/dist/auth/required-rung.js'));
  ({ ROUTE_RIGHTS, NOT_AREA_SCOPED } = await import('../../server/dist/auth/space-rights.js'));
});

describe('the lookup', () => {
  it('answers for a classified route', () => {
    const r = rungFor('POST', '/api/brain/spaces/:spaceId/traverse');
    assert.deepEqual(r, { kind: 'requires', area: 'knowledge', needs: 'read', scope: 'path' });
  });

  it('distinguishes methods on the same path', () => {
    // GET and DELETE on a collection are not the same permission, and a path-only lookup would say they are.
    assert.equal(rungFor('GET', '/api/brain/spaces/:spaceId/memories').needs, 'read');
    assert.equal(rungFor('POST', '/api/brain/spaces/:spaceId/memories').needs, 'write');
    assert.equal(rungFor('DELETE', '/api/brain/spaces/:spaceId/memories').needs, 'admin');
  });

  it('says UNCLASSIFIED for a route nobody decided about, NOT a permissive default', () => {
    assert.deepEqual(rungFor('GET', '/api/brain/spaces/:spaceId/invented'), { kind: 'unclassified' });
    assert.deepEqual(rungFor('PUT', '/api/brain/recall'), { kind: 'unclassified' },
      'a method the inventory does not list must miss, not inherit the path');
  });

  it('says NOT-AREA-SCOPED for an exempt route, which is a different answer from unclassified', () => {
    // The distinction the old two-state shape could not make. Both were `null`, so the runtime reported a
    // written-down decision as an oversight on every request.
    for (const { route } of NOT_AREA_SCOPED) {
      assert.deepEqual(rungFor('GET', route), { kind: 'not-area-scoped' },
        `${route} is exempt and must resolve as such, not as unclassified`);
    }
  });

  it('an exemption covers every verb on its path, deliberately', () => {
    // ROUTE_RIGHTS keys on method + path because GET and DELETE need different rungs. An exemption is a claim
    // about what the route IS, so it is path-only -- and `/api/spaces/:id/rename` is registered as PATCH,
    // which a method-keyed exemption written for POST would have silently missed.
    assert.deepEqual(rungFor('PATCH', '/api/spaces/:id/rename'), { kind: 'not-area-scoped' });
    assert.deepEqual(rungFor('DELETE', '/api/spaces/:id/rename'), { kind: 'not-area-scoped' });
  });

  it('no path is on both lists', () => {
    // A route that is both governed and exempt is a contradiction, not a precedence question. `rungFor` would
    // answer `requires` (the safe direction), but relying on that hides the disagreement.
    const both = ROUTE_RIGHTS.map(r => r.route).filter(r => NOT_AREA_SCOPED.some(e => e.route === r));
    assert.deepEqual([...new Set(both)], [],
      'these paths are classified into an area AND exempt from areas -- resolve which one is true');
  });

  it('carries the scope shape through, because Data quality needs it', () => {
    // Those routes take no space and iterate the token's reachable ones. A caller that ignores `scope` would
    // gate the call instead of the loop, leaving that column decorative.
    assert.equal(rungFor('GET', '/api/duplicates').scope, 'iterates');
    assert.equal(rungFor('POST', '/api/brain/spaces/:spaceId/traverse').scope, 'path');
    // The third shape, added at 5.0: the search family moved the space into the BODY so a caller can omit
    // it and read across spaces. `enforceAreaRung` skips those — `requireBodyScopedSpace` checks the same
    // area and rung against the space the body named, or against every space the token may read — so a
    // caller that ignored `scope` here would gate a cross-space search as though it named one space.
    assert.equal(rungFor('POST', '/api/brain/recall').scope, 'body');
  });

  it('every inventory entry is findable — the map has no dropped rows', () => {
    // A Map built from a list can silently lose duplicates. Asserting the count catches a key collision,
    // which would leave one route unclassified while the inventory looks complete.
    let found = 0;
    for (const r of ROUTE_RIGHTS) {
      const got = rungFor(r.method, r.route);
      assert.equal(got.kind, 'requires', `${r.method} ${r.route} is in the inventory but not findable`);
      assert.equal(got.needs, r.needs);
      found++;
    }
    assert.equal(found, ROUTE_RIGHTS.length);
  });

  it('a trailing slash does not change the answer', () => {
    assert.deepEqual(rungFor('POST', '/api/brain/recall/'),
      rungFor('POST', '/api/brain/recall'));
    // The exemption path is normalised the same way, or the two lists disagree on `/x` versus `/x/`.
    assert.deepEqual(rungFor('PATCH', '/api/spaces/:id/rename/'), { kind: 'not-area-scoped' });
  });
});

describe('rung containment', () => {
  it('a higher rung satisfies a lower requirement', () => {
    assert.equal(satisfies('admin', 'read'), true);
    assert.equal(satisfies('write', 'write'), true);
    assert.equal(satisfies('read', 'write'), false);
    assert.equal(satisfies('none', 'read'), false);
  });

  it('none satisfies nothing, including none', () => {
    // `needs` is never 'none' in the inventory, but if it ever were, "you may call it holding nothing" would
    // be a route with no requirement at all — which is what an exemption is for, not a rung.
    assert.equal(satisfies('none', 'read'), false);
    assert.equal(satisfies('read', 'none'), true);
  });
});
