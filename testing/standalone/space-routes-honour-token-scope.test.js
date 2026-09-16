/**
 * Every route that takes a space id enforces the token's scope — derived from source, not from a list of routes.
 *
 * ## What happened
 *
 * Three READ routes were mounted behind `requireAuth`, which authenticates and nothing else. Every other
 * space-scoped route uses `requireSpaceAuth` or `requireAdminMfaScoped`, both of which call `enforceSpaceScope`. So a
 * token scoped to `["general"]` could read another space's schema, purpose and usage notes:
 *
 *     GET /api/spaces/other/meta                                  -> 200  purpose, usageNotes, typeSchemas
 *     GET /api/spaces/other/completeness                           -> 200  per-type counts
 *     GET /api/spaces/other/meta/typeSchemas/entity/SecretType     -> 200  the individual schema
 *     POST /api/brain/spaces/other/facts                        -> 403  (correct)
 *
 * The contrast is what made it a defect rather than a design choice: the same instance filtered that space out of
 * `GET /api/spaces` for the same token. It knew the scope perfectly well, and three sibling routes served the space's
 * contents anyway.
 *
 * ## Why this gate is derived rather than a list
 *
 * A list of three would have been written against the routes that existed and agreed with itself. This enumerates
 * every `spacesRouter` handler that takes `:id` and requires each to sit behind a scope-enforcing middleware — so a
 * fourth route added later is covered on the day it is written, which is the only day it is cheap.
 *
 * **The middlewares are themselves derived**, by reading which exported guards in `auth/middleware.ts` call
 * `enforceSpaceScope`. Naming them here would let a future guard that authenticates only pass this check by being
 * added to a list, which is the same failure one level up.
 *
 * Run: node --test testing/standalone/space-routes-honour-token-scope.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const ROUTER = 'server/src/api/spaces.ts';
const MIDDLEWARE = 'server/src/auth/middleware.ts';

/**
 * Exported guards that enforce the token's space scope, read from the middleware module.
 *
 * A guard qualifies when its body reaches `enforceSpaceScope`. `requireAuth` does not — it delegates to
 * `performAuth`, which authenticates and sets `req.authToken`, and that is the whole of it.
 */
function scopeEnforcingGuards() {
  const src = strip(readFileSync(MIDDLEWARE, 'utf8'));
  const guards = [];
  // `export function NAME(` / `export async function NAME(` / `export const NAME = ` — take the body to the next export.
  const re = /export (?:async )?(?:function|const) (require[A-Za-z]+)\b/g;
  const starts = [...src.matchAll(re)].map(m => ({ name: m[1], at: m.index }));
  for (let i = 0; i < starts.length; i++) {
    const body = src.slice(starts[i].at, starts[i + 1]?.at ?? src.length);
    if (/enforceSpaceScope\(/.test(body)) guards.push(starts[i].name);
  }
  // Plus ALIASES: `export const requireSpaceAuth = requireSpaceAuthScoped('spaceId')` enforces scope by being a
  // binding of one that does. Resolved rather than listed, because the alias is how most routes mount it — and
  // because a detector that missed it would call every brain route unguarded and be ignored for crying wolf.
  for (const m of src.matchAll(/export const (require[A-Za-z]+)\s*=\s*(require[A-Za-z]+)\(/g)) {
    if (guards.includes(m[2]) && !guards.includes(m[1])) guards.push(m[1]);
  }
  return guards;
}

/**
 * Every `spacesRouter.<verb>('<path>', <middlewares…>` whose path takes a space id.
 *
 * The middleware list is captured with `[\s\S]*?` up to `(req`, NOT with `[^)]*?`. The first version used the latter
 * and stopped at the first closing paren — so every route guarded by `requireAdminMfaScoped('id')` was skipped, and
 * the sweep silently ran over the three routes that happened to have paren-free guards: exactly the three that were
 * broken. It reported them fixed and said nothing about the other ten.
 *
 * The floor assertion below is what caught that, which is the entire reason it is there.
 */
function spaceIdRoutes() {
  const src = strip(readFileSync(ROUTER, 'utf8'));
  const out = [];
  const re = /spacesRouter\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]*?)(?:async )?\(req/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, verb, path, middlewares] = m;
    if (!path.includes(':id')) continue;    // `/` and `/reorder` take no space id
    out.push({ verb: verb.toUpperCase(), path, middlewares });
  }
  return out;
}

describe('a space route cannot be reached by a token that is not scoped to that space', () => {
  const guards = scopeEnforcingGuards();
  const routes = spaceIdRoutes();

  it('found the guards and the routes — or every check below is vacuous', () => {
    assert.ok(guards.includes('requireSpaceAuth'), `requireSpaceAuth must enforce scope; found ${JSON.stringify(guards)}`);
    assert.ok(guards.includes('requireAdminMfaScoped'), `requireAdminMfaScoped must enforce scope; found ${JSON.stringify(guards)}`);
    assert.ok(!guards.includes('requireAuth'),
      'requireAuth appears to enforce space scope now — if that is true this whole gate is obsolete, and if it is '
      + 'not, the detector is wrong');
    assert.ok(routes.length >= 8, `only ${routes.length} space-id routes found in ${ROUTER} — the parser is wrong`);
  });

  it('every space-id route sits behind a scope-enforcing guard', () => {
    const open = routes
      .filter(r => !guards.some(g => new RegExp(`\\b${g}\\b`).test(r.middlewares)))
      .map(r => `${r.verb} ${r.path}`);
    assert.deepEqual(open, [],
      'these take a space id and never check whether the token may reach that space, so any authenticated token can '
      + 'read or act on any space — while `GET /api/spaces` correctly hides it from the same token:\n  '
      + open.join('\n  '));
  });

  it('and the guard is BOUND to the parameter that route actually declares', () => {
    // The assertion this file was missing, and the reason the first fix shipped as a no-op that looked correct.
    //
    // `enforceSpaceScope` returns TRUE when the id is undefined — right for a route with no space in its path, fatal
    // for a guard bound to the wrong parameter name. Mounting `requireSpaceAuth` (which reads `spaceId`) on a route
    // declaring `:id` authenticates and waves the request through. The previous version of this gate checked the
    // guard's NAME, went green, and the leak was completely untouched; a red-team test caught it minutes later.
    //
    // So: a route declaring `:id` must use a guard bound to `'id'`. Derived from the path, not from a list.
    const wrong = [];
    for (const r of routes) {
      const param = r.path.includes(':spaceId') ? 'spaceId' : 'id';
      const boundHere = new RegExp(`\\((?:'${param}'|"${param}")\\)`).test(r.middlewares);
      // A bare `requireSpaceAuth` is the `spaceId` binding, so it is correct only on a `:spaceId` route.
      const bareSpaceIdGuard = /\brequireSpaceAuth\b(?!Scoped)/.test(r.middlewares);
      const ok = boundHere || (param === 'spaceId' && bareSpaceIdGuard);
      if (!ok) wrong.push(`${r.verb} ${r.path} — declares :${param}, guard not bound to it`);
    }
    assert.deepEqual(wrong, [],
      'these mount a scope guard that reads a parameter the route does not declare. `enforceSpaceScope` passes on an '
      + 'undefined id, so the guard authenticates and enforces NOTHING — it reads as protection at the mount site:\n  '
      + wrong.join('\n  '));
  });

  it('the three that leaked are specifically covered', () => {
    // Not the mechanism — the mechanism is the derived check above. These three are named because they are the ones
    // that shipped wrong, and a regression on exactly them is the thing most worth failing loudly.
    for (const path of ['/:id/meta', '/:id/completeness', '/:id/meta/typeSchemas/:knowledgeType/:typeName']) {
      const r = routes.find(x => x.path === path && x.verb === 'GET');
      assert.ok(r, `GET ${path} is gone — if it moved, re-point this assertion`);
      assert.ok(guards.some(g => new RegExp(`\\b${g}\\b`).test(r.middlewares)),
        `GET ${path} must enforce the token's space scope — it leaked a space's schema and purpose without it`);
    }
  });
});
