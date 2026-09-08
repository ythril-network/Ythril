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
import fs from 'node:fs';
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

const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

/** Any of these means "an authenticated identity is required to reach this route". */
const AUTH_GUARDS = [
  'requireSpaceAuth',
  'requireAuth',
  'requireAdminMfaScoped',
  'requireAdminMfa',
  'requireAdmin',
  // `mcpRouter.use(requireMcpAuth)` guards every MCP route, but this list did not know the name — so the
  // router was EXEMPTED instead, under a reason ("authorises at the tool dispatcher") that described its
  // read-only enforcement rather than its authentication. Between that and the scan never reaching
  // `server/src/mcp`, the entire agent-facing API sat outside this gate.
  'requireMcpAuth',
];

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
  // The trigger now carries `requireAdmin`, which this gate can see. The exemption narrowed to the ONE route
  // it was ever about, in `EXEMPT_ROUTE` above. An exemption whose reason covers one route and is applied to
  // the whole router is the shape `CLAUDE.md` warns about, and this file is where it should have been caught.
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
]);

/**
 * POSTs that are semantically READS (search/validate/dry-run). They must still require auth,
 * but must NOT be blocked for a read-only token — searching is exactly what read-only is for.
 */
const READ_SHAPED_POSTS = [
  '/spaces/:spaceId/query',
  '/spaces/:spaceId/recall',
  '/spaces/:spaceId/find-similar',
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
      const re = /(\w*[Rr]outer)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const [, router, method, routePath] = m;
        if (!mounts.isMounted(router)) continue;
        const args = argumentsOf(src, src.indexOf('(', m.index), `${routePath}: the route registration`);
        // Argument 0 is the path and the last is the handler; everything between them is the chain.
        const chain = args.slice(1, -1).join(',');
        routes.push({ router, method, routePath, chain, file });
      }
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
    const sample = routes.find(r => r.router === 'memoriesRouter' && r.routePath === '/spaces/:spaceId/memories' && r.method === 'post');
    assert.ok(sample, 'sanity: POST /spaces/:spaceId/memories should have been parsed');
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
