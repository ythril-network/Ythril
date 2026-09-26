/**
 * Standalone tests: every mutating route must carry an authorisation guard.
 *
 * This is the security twin of audit-route-coverage.test.js, and it exists because of a
 * question worth asking of any test: **what would still pass if the mechanism were removed?**
 *
 * Nothing in the suite would fail if `denyReadOnly` were dropped from a single route. The
 * red-team tests prove a read-only token is rejected on *some* endpoints — not on *every*
 * mutating endpoint — so a new route that forgot the guard would ship silently, and a
 * read-only token could write through it. Same for `requireSpaceAuth`: a route without it is
 * reachable by a token scoped to a different space.
 *
 * Per-route tests cannot close that: they enumerate what someone remembered to write. So this
 * derives the route list from the ROUTER SOURCE and asserts the guard is present on each — add
 * a mutating route without a guard and this fails, by name, until you either add the guard or
 * declare the route exempt WITH A REASON.
 *
 * It checks the middleware chain is *wired*, not that each guard's logic is correct — the
 * red-team suite covers the behaviour. The failure this catches is the one that actually
 * happens in practice: a guard that was simply never attached.
 *
 * Run: node --test testing/standalone/route-guard-coverage.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { argumentsOf } from './_structural-window.mjs';
import { routerMounts } from './_router-mounts.mjs';
import { mountedRoutes } from './_routes.mjs';
import { stripComments } from './_strip-comments.mjs';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Every directory that declares an Express router — not just `api/`.
 *
 * It was `api/` alone, so `mcpRouter` (server/src/mcp/router.ts) and `setupRouter`
 * (server/src/setup/routes.ts) had NEVER been scanned. Both carried an EXEMPT entry, which made the
 * omission read as deliberate and covered — the gate was not exempting them, it could not see them.
 *
 * Proven by mutation before it was fixed: deleting `mcpRouter.use(requireMcpAuth)` — the guard on the
 * entire agent-facing API — left this suite green.
 */
const ROUTER_DIRS = [
  path.join(__dirname, '..', '..', 'server', 'src', 'api'),
  path.join(__dirname, '..', '..', 'server', 'src', 'mcp'),
  path.join(__dirname, '..', '..', 'server', 'src', 'setup'),
];
const API_DIR = ROUTER_DIRS[0];
const APP_TS = path.join(__dirname, '..', '..', 'server', 'src', 'app.ts');
/** `server/src`, for reading the module that DEFINES the guards rather than the routes that use them. */
const SERVER = path.join(__dirname, '..', '..', 'server', 'src');

const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

/** Any of these means "an authenticated identity is required to reach this route". */
/**
 * Every middleware that establishes an identity — DERIVED from the module that defines them.
 *
 * This was a hand-written list of five names, and the comment it carried is the argument for deriving it:
 * `requireMcpAuth` was missing, so rather than being recognised the whole MCP router was EXEMPTED, under a
 * reason that described its read-only enforcement instead of its authentication. The entire agent-facing API
 * sat outside this gate until somebody noticed the name.
 *
 * The same thing happened again at 5.0 with `requireBodyScopedSpace`, which is what prompted this: a new
 * guard is invisible to a list, and the gate reports the route it guards as UNPROTECTED — a false alarm that
 * costs a debugging session, where the reverse (a guard nobody added, silently trusted) costs a breach.
 *
 * **The property, not the names:** an auth guard is an exported middleware in `auth/middleware.ts` that
 * reaches `resolveAuthOrFail` — directly, through another guard, or through a private helper.
 *
 * **That last clause is the fix, and the bug it replaces is this gate's own failure mode.** The spans were
 * cut between EXPORTS, so a private helper's body landed inside whichever exported span happened to precede
 * it. `performAuth` is declared after `requireMcpAuth` and before the next export, so `requireMcpAuth` was
 * recognised because the helper's `resolveAuthOrFail` fell inside its span — by accident of ordering, not
 * by the rule. `requireAuth`, which calls the identical helper from a span that ends before it, was NOT
 * recognised. The plainest guard in the codebase read as no guard at all, and a route carrying it reported
 * as reachable without an identity.
 *
 * So the spans are cut between ALL top-level declarations, private ones included, and the closure runs over
 * that graph. Only exported names are returned, because only those can appear in a route chain.
 */
function deriveAuthGuards() {
  const src = stripComments(readFileSync(path.join(SERVER, 'auth/middleware.ts'), 'utf8'));

  /*
   * Every top-level binding, with the source span up to the NEXT top-level binding — exported or not.
   *
   * A span rather than a brace-match: the question is only "does this definition reach the resolver", and a
   * span cannot under-read it. Cutting on every declaration is what stops a span over-reading into the next
   * function's body, which is what made the old version accidentally right about one name and wrong about
   * another.
   */
  const spans = [];
  const re = /^(export\s+)?(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm;
  const marks = [...src.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    spans.push({ name: marks[i][2], exported: Boolean(marks[i][1]), body: src.slice(start, end) });
  }
  assert.ok(spans.length > 5, `parsed ${spans.length} declarations from auth/middleware.ts — the derivation broke`);
  assert.ok(spans.some(x => !x.exported),
    'no private declaration was parsed — the helper that actually calls the resolver is private, so a parse '
    + 'that sees only exports is the bug this derivation was rewritten to fix');

  // Transitive closure: reaches the resolver, or calls something that does. Repeated to a fixed point
  // rather than in two passes, because the chain is guard -> helper -> resolver and can grow a link.
  const reaches = new Set(spans.filter(x => x.body.includes('resolveAuthOrFail')).map(x => x.name));
  for (let changed = true; changed;) {
    changed = false;
    for (const x of spans) {
      if (reaches.has(x.name)) continue;
      if ([...reaches].some(g => new RegExp(`\\b${g}\\s*\\(`).test(x.body))) { reaches.add(x.name); changed = true; }
    }
  }

  const guards = spans.filter(x => x.exported && reaches.has(x.name)).map(x => x.name);

  // The floor. An empty or tiny set passes every loop written over it, and this one decides whether a
  // mutating route counts as protected — the direction that fails OPEN.
  assert.ok(guards.length >= 5,
    `derived only ${guards.length} auth guards (${guards.join(', ')}) — expected at least the five that `
    + 'predate this derivation, so the parse is wrong rather than the code');
  // Named explicitly because it was the one the old parse missed, and because a derivation that quietly
  // stops finding the commonest guard would otherwise look like a clean run with a shorter list.
  assert.ok(guards.includes('requireAuth'),
    `requireAuth is not among the derived guards (${guards.join(', ')}) — it reaches the resolver through a `
    + 'private helper, and a parse that cannot follow that reports every route carrying it as unprotected');
  return guards;
}

const AUTH_GUARDS = deriveAuthGuards();

/** Guards that block a READ-ONLY token from writing. Admin guards imply a non-read-only admin. */
const WRITE_GUARDS = [
  'denyReadOnly',
  'requireAdminMfaScoped',
  'requireAdminMfa',
  'requireAdmin',
];

/**
 * Routes that legitimately carry no auth guard. Every entry needs a REASON — an exemption
 * without one is how a guard table rots (see the audit route table, which had drifted so far
 * that file uploads and the entire governance surface were unlogged).
 */
const PEER_AUTH_REASON = 'peer-to-peer sync — authenticated as a PEER via peer tokens, not user tokens';
/**
 * Routes exempt by PATH rather than by router, because their router has no name worth keying on.
 *
 * A route registered inside a function is written against that function's `router` parameter, so exempting
 * `'router'` would exempt every such route on the instance -- including the file upload, which is a real
 * space-scoped write. The path is the only handle that means one route.
 */
const EXEMPT_ROUTE = new Map([
  ['POST /', 'the peer notification channel on `notifyRouter`. Authenticated INSIDE the handler against the '
    + 'claiming instance: a peer PAT carries `peerInstanceId` and may only speak as that peer, and a '
    + 'non-member is refused. Middleware cannot do it — which instance may send the event depends on the '
    + 'body. Its sibling `/trigger` is NOT covered by this and never was.'],
  /*
   * The invite handshake's two unauthenticated legs, and NOT its third route.
   *
   * `inviteRouter` was exempt as a whole under "authenticated by the invite key itself". True of `/apply`
   * and `/finalize`, which is where the key is presented — and false of `POST /generate`, which MINTS the
   * key and is `requireAdmin`. Nothing was wrong today; what was wrong was that dropping that guard would
   * have been invisible, which is exactly how `POST /api/notify/trigger` came to take any token at all.
   */
  ['POST /apply', 'the joining leg of the invite handshake. Authenticated by the invite KEY in the body — '
    + 'the caller has no token on this instance yet, which is what the handshake is for.'],
  ['POST /finalize', 'the completing leg of the same handshake, authenticated by the same key.'],
  ['POST /redeem', 'a pub/sub\'s published invite key opening a handshake (F-41). The key IS the credential — the '
    + 'caller has no token here, which is the point — and the route answers only for a network this instance publishes.'],
  ['POST /mcp-oauth/consent', 'the OAuth consent form POST. It carries no bearer header by design — the '
    + 'token arrives in the form body, and `handleConsent` validates it itself with `findMatchingToken` and '
    + 'answers 401 when it does not match. Middleware could not read it from there.'],
]);

const EXEMPT = new Map([
  ['setupRouter', 'first-run setup — runs BEFORE any token exists; guarded by configExists()'],
  // The /api/sync surface was one `syncRouter` until A17.6 split it into per-concern sub-routers.
  // The exemption is about HOW the surface authenticates (peer tokens), so it follows every
  // sub-router — otherwise the split would silently re-flag the whole peer protocol.
  ['syncRouter', PEER_AUTH_REASON],
  ['syncDocsRouter', PEER_AUTH_REASON],
  ['syncTombstonesRouter', PEER_AUTH_REASON],
  ['syncManifestRouter', PEER_AUTH_REASON],
  ['syncMembersRouter', PEER_AUTH_REASON],
  ['syncVotesRouter', PEER_AUTH_REASON],
  ['syncWarmRouter', PEER_AUTH_REASON],

  ['oidcRouter', 'OIDC login/callback — this is how you GET a token'],
  ['themeRouter', 'public unauthenticated theme endpoint (read-only, no user data)'],
  // `notifyRouter` was exempt AS A WHOLE here, under the reason "peer notifications + admin sync trigger —
  // peer-authenticated". That is true of `POST /api/notify` and was never true of `POST /api/notify/trigger`,
  // which carried `requireAuth`: ANY valid token — one with every area at `none` and no spaces — could start
  // a sync cycle on any network id it named. Proven on 2026-09-09 by minting exactly that token and getting
  // `200 {"status":"triggered"}`, while the sibling `POST /api/networks/:id/sync` refused it with 403.
  //
  // The trigger carried `requireAdmin` from 4.4 and is REMOVED in 5.0, so the router-wide reason is finally
  // true of every route on the router. An exemption whose reason covers one route and is applied to the whole
  // router is the shape `CLAUDE.md` warns about, and this file is where it should have been caught.
  // mcpRouter is deliberately NOT here any more. `requireMcpAuth` is in AUTH_GUARDS above, so the gate
  // can now see that the router is guarded instead of being told to look away. It remains exempt from the
  // READ-ONLY check below, where the original reason was true: a read-only token does reach the
  // dispatcher, which refuses every mutating tool.
  ['metricsRouter', 'Prometheus scrape — guarded by METRICS_TOKEN inside the router'],
]);

/**
 * Exempt from the READ-ONLY check only — still required to authenticate.
 *
 * The two dimensions used to share one map, which forced an all-or-nothing choice: a router that
 * authenticates properly but enforces write-blocking somewhere the scanner cannot see had to be exempted
 * from **both**. That is how `mcpRouter` ended up excused from an auth check it actually passes, under a
 * reason that was only ever about the other dimension.
 */
const WRITE_EXEMPT = new Map([
  // True, and checkable: `mcp/router.ts` opens its `CallToolRequestSchema` handler with
  // `if (tool && !toolIsVisible(tool, rights))`, which refuses a mutating tool to a token holding no write
  // rung anywhere. The enforcement is per TOOL, which a per-route scanner cannot see — every tool arrives
  // as `POST /`. It also enforces the per-space rung at call time via `toolRightsRefusal`.
  //
  // The quoted expression used to be `readOnly && tool?.mutating`. An exemption whose stated reason quotes
  // code that no longer exists is how a scanner ends up excusing a check nobody has verified in a year.
  ['mcpRouter', 'read-only is enforced per tool in the dispatcher, not per route'],
  /*
   * THE SAME REASON, AND NOW LITERALLY THE SAME CODE — which is why this entry can be trusted where a
   * second exemption for a second door could not.
   *
   * `POST /api/<tool-name>` is one generic `/:tool` route that hands the body to `callTool`, the function
   * the MCP dispatcher above also calls. The write-blocking is `toolIsVisible`, which refuses a mutating
   * tool to a token holding no write rung anywhere, and `toolRightsRefusal`, which enforces the per-space
   * rung on every named space at call time. Neither is visible to a per-route scanner: forty-five
   * capabilities with forty-five different requirements all arrive as `POST /:tool`.
   *
   * A `denyReadOnly` here would be strictly worse than the exemption. It would refuse a read-only token
   * `recall` — a read — while the tools that actually mutate are already refused one layer in, so it would
   * break the safe half and add nothing to the dangerous half.
   *
   * `one-capability-is-one-shape.test.js` is what keeps this honest: it asserts the door performs no check
   * of its own AND dispatches through `callTool`, so the enforcement named here cannot be quietly bypassed
   * by a second handler growing beside it.
   */
  ['toolsRouter', 'read-only is enforced per tool by `callTool`, the same function the MCP door uses — a '
    + 'per-route guard cannot express forty-five different requirements on one path'],
]);

/**
 * POSTs that are semantically READS (search/validate/dry-run). They must still require auth,
 * but must NOT be blocked for a read-only token — searching is exactly what read-only is for.
 */
const READ_SHAPED_POSTS = [
  // The search family lost its `/spaces/:spaceId` prefix at 5.0 — the space moved into the body so a
  // caller can omit it and read across spaces. `traverse` keeps its path: it walks FROM an entity, which
  // lives in exactly one space, so there is nothing to omit.
  '/filter',
  '/similar',
  '/spaces/:spaceId/traverse',
  // Minting a single-use ticket to WATCH the live-events stream is a read (the stream itself allows
  // read-only tokens — "watching is a read"), so it must not be blocked for a read-only token.
  '/spaces/:spaceId/events/ticket',
  '/recall',
  '/:id/validate-schema',
  '/export-space',
  '/config/test',
];

/** @type {{router:string, method:string, routePath:string, chain:string, file:string}[]} */
let routes = [];
/** Guards applied to an ENTIRE router via `xRouter.use(...)` — they cover every route on it. */
let routerLevelGuards = new Map();

/** Every .ts file under the api dir, recursively — routes live in `api/` AND `api/brain/` (A17.3). */
function apiFiles(dir = null, out = []) {
  if (dir === null) {
    for (const d of ROUTER_DIRS) apiFiles(d, out);
    return out;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) apiFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Which routers are reachable from the app, via `_router-mounts.mjs`.
 *
 * This used to resolve the graph here: `app.use('/x', r)` plus a fixed-point walk over
 * `parentRouter.use(childRouter)`, with a comment explaining that without the second form *"every brain
 * route would drop out of the guard check and it would pass on a short list"*. That was right, and it was
 * the SECOND place to work it out; there are now four. `Q-19` extracted the graph, and the shared version
 * also resolves a route registered onto a function's `router` PARAMETER — which this copy did not, so
 * `POST /api/files/:spaceId` was never in the analysis.
 */
const mountedRouters = () => routerMounts();

describe('Route guards — every mutating route must be protected', () => {
  before(() => {
    const mounts = mountedRouters();

    for (const filePath of apiFiles()) {
      const file = path.relative(API_DIR, filePath).replace(/\\/g, '/');
      const src = fs.readFileSync(filePath, 'utf8');

      // Router-level guards must count, or this reports false positives: webhooksRouter does
      // `webhooksRouter.use(globalRateLimit, requireAdminMfa)` and then registers bare routes.
      const useRe = /(\w+Router)\s*\.\s*use\s*\(([^)]*)\)/g;
      let u;
      while ((u = useRe.exec(src)) !== null) {
        const prev = routerLevelGuards.get(u[1]) ?? '';
        routerLevelGuards.set(u[1], prev + ',' + u[2]);
      }

      /*
       * HISTORICAL — the scan this block used to do now lives in `_routes.mjs`, and the note stays because
       * it is what the window in that module is paying for.
       *
       * The middleware chain is the ARGUMENTS between the path and the handler — split at the call's own commas.
       *
       * A WINDOW, converted, and this is what the cap was costing. To find the chain the pattern matched from the
       * path string up to the handler across `[\s\S]{0,400}?`, and **13 of the 209 route registrations in
       * `server/src/api` put their handler further away than that**. Those routes were not reported as unguarded;
       * they were never in the analysis at all — `POST /api/data/backups` sits 1 105 characters in,
       * `GET /api/tokens/rights-catalog` 6 429, and four `schema-library` routes between 489 and 1 870. Raising
       * the number would have moved the line rather than removed it.
       *
       * The handler-SHAPE guess goes with it. Requiring the chain to end at `async (` or `(req` skipped three more
       * registrations whose handler is named or destructures its request differently. The last argument is the
       * handler because it is the last argument, whatever it looks like.
       */
      // `\w*[Rr]outer`, not `\w+Router`: a route registered inside a function names its PARAMETER, and
      // `registerUploadRoute(router: Router)` spells it `router`. `POST /api/files/:spaceId` was never in
      // the analysis until this matched it — not reported as unguarded, absent. The mount graph resolves
      // the parameter to the router its call site passes, so `isMounted` still answers correctly.
    }

    /*
     * THE ROUTES COME FROM `mountedRoutes()` NOW, and the copy they replace is why.
     *
     * This gate carried its own `(\w*[Rr]outer)\.(get|post|…)` scan over `server/src/api`, which is the
     * shape `_routes.mjs` was extracted to stop. It cost exactly what a second implementation costs: when
     * the module learned to see a route declared straight on the express app, every gate built on it saw
     * nine more routes and this one — the guard analysis, the one that matters most — stayed blind.
     *
     * Two blind spots at once, and either alone was enough: the pattern could not match `app.post`, and
     * `apiFiles()` never read `app.ts` in the first place. `POST /api/admin/reload-config`,
     * `POST /api/admin/spaces/:spaceId/wipe` and `…/import` were not reported as unguarded — they were
     * absent, which is the failure this file's own header describes.
     *
     * The method is lower-cased because everything below compares against lower-case verbs.
     */
    for (const r of mountedRoutes()) {
      routes.push({ ...r, method: r.method.toLowerCase(), file: r.file.replace(/^server\/src\//, '') });
    }
  });

  it('router variable names are unique across the api tree (name-keyed analysis must be sound)', () => {
    // Both this guard and audit-route-coverage map `xRouter` -> mount prefix BY NAME. Two modules
    // exporting the same name silently give one of them the other's prefix, so its routes get
    // checked against the wrong rules — or vanish from the check entirely.
    //
    // This has bitten twice for real. A17.3: api/brain's file-metadata router was a second
    // `filesRouter` (api/files.ts already had one), so its routes resolved to /api/files. A17.6:
    // api/sync's `membersRouter`/`votesRouter` collided with api/networks', so the peer routes
    // resolved to /api/networks and reported as unaudited. Both compiled and ran fine — only this
    // analysis noticed. Assert uniqueness so the next split can't reintroduce it.
    const owners = new Map();
    for (const filePath of apiFiles()) {
      const src = fs.readFileSync(filePath, 'utf8');
      const re = /^export const (\w+Router)\s*=/gm;
      let m;
      while ((m = re.exec(src)) !== null) {
        const rel = path.relative(API_DIR, filePath).replace(/\\/g, '/');
        if (!owners.has(m[1])) owners.set(m[1], []);
        owners.get(m[1]).push(rel);
      }
    }
    const dupes = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name} declared in: ${files.join(', ')}`);
    assert.deepEqual(dupes, [], `router names must be unique across server/src/api:\n  ${dupes.join('\n  ')}`);
  });

  it('the parser found the routes (guard the guard — it must not pass vacuously)', () => {
    // If the registration style changes and the regex stops matching, every assertion below
    // would pass on an EMPTY list. That is the exact failure mode this whole test exists to
    // prevent, so it must not be possible here either.
    assert.ok(routes.length > 50, `expected to parse many routes, found ${routes.length}`);

    const mutating = routes.filter(r => MUTATING.has(r.method));
    assert.ok(mutating.length > 30, `expected many mutating routes, found ${mutating.length}`);

    // Brain routes live on per-resource sub-routers since A17.3 (memoriesRouter et al, mounted on
    // brainRouter in api/brain/index.ts) — same URL, same chain, different router variable.
    const sample = routes.find(r => r.router === 'memoriesRouter' && r.routePath === '/spaces/:spaceId/facts' && r.method === 'post');
    assert.ok(sample, 'sanity: POST /spaces/:spaceId/facts should have been parsed');
    assert.match(sample.chain, /requireSpaceAuth/, 'sanity: its chain should contain requireSpaceAuth');
  });

  /** A route is protected by its own chain OR by a guard its router applies to everything. */
  function effectiveChain(r) {
    return r.chain + (routerLevelGuards.get(r.router) ?? '');
  }

  it('every mutating route requires an authenticated identity', () => {
    const unguarded = [];
    for (const r of routes) {
      if (!MUTATING.has(r.method)) continue;
      if (EXEMPT.has(r.router) || EXEMPT_ROUTE.has(`${r.method.toUpperCase()} ${r.routePath}`)) continue;
      if (!AUTH_GUARDS.some(g => effectiveChain(r).includes(g))) {
        unguarded.push(`${r.method.toUpperCase()} ${r.routePath}  (${r.file}: ${r.router})`);
      }
    }
    assert.deepEqual(
      unguarded, [],
      'These mutating routes have NO auth guard — they are reachable without a valid identity. ' +
      'Add one, or add an EXEMPT entry WITH A REASON:\n  ' + unguarded.join('\n  '),
    );
  });

  it('every mutating route blocks a READ-ONLY token', () => {
    // The guard that is easiest to forget, and whose absence no existing test would catch:
    // the red-team suite proves a read-only token is rejected on SOME endpoints, never on ALL.
    const writable = [];
    for (const r of routes) {
      if (!MUTATING.has(r.method)) continue;
      if (EXEMPT.has(r.router) || WRITE_EXEMPT.has(r.router)
          || EXEMPT_ROUTE.has(`${r.method.toUpperCase()} ${r.routePath}`)) continue;
      if (r.method === 'post' && READ_SHAPED_POSTS.includes(r.routePath)) continue;
      if (!WRITE_GUARDS.some(g => effectiveChain(r).includes(g))) {
        writable.push(`${r.method.toUpperCase()} ${r.routePath}  (${r.file}: ${r.router})`);
      }
    }
    assert.deepEqual(
      writable, [],
      'These mutating routes do NOT block a read-only token — a read-only credential could ' +
      'write through them. Add denyReadOnly (or an admin guard), or EXEMPT it with a reason:\n  ' +
      writable.join('\n  '),
    );
  });

  it('space-scoped routes enforce the space scope', () => {
    // A `:spaceId` route without requireSpaceAuth is reachable by a token scoped to a
    // DIFFERENT space — a cross-tenant read/write, not merely a missing login check.
    const unscoped = [];
    for (const r of routes) {
      if (EXEMPT.has(r.router) || EXEMPT_ROUTE.has(`${r.method.toUpperCase()} ${r.routePath}`)) continue;
      if (!/:spaceId\b/.test(r.routePath)) continue;
      // Admin-scoped guards carry the space check themselves.
      const chain = effectiveChain(r);
      if (chain.includes('requireSpaceAuth') || chain.includes('requireAdminMfaScoped')) continue;
      if (chain.includes('requireAdmin')) continue; // full admin — not space-scoped by design
      unscoped.push(`${r.method.toUpperCase()} ${r.routePath}  (${r.file}: ${r.router})`);
    }
    assert.deepEqual(
      unscoped, [],
      'These :spaceId routes do not enforce the space scope — a token scoped to another space ' +
      'could reach them:\n  ' + unscoped.join('\n  '),
    );
  });
});
