/**
 * Standalone tests: every mutating route must resolve to an audit operation.
 *
 * The audit middleware keeps a hand-maintained ROUTE_RULES table — a second, shadow copy of
 * the router's path table. Nothing kept the two in sync, and they had drifted badly:
 *
 *   - `POST /api/files/:space/upload` — a route that has NEVER existed. The real upload is
 *     `POST /api/files/:spaceId?path=…`, so the rule matched nothing and every file upload
 *     was silently unlogged.
 *   - the DELETE/PATCH file rules required a trailing slash after the space segment, but the
 *     real routes carry the path in the QUERY STRING (which the middleware strips before
 *     matching) — so file deletes and moves were unlogged too.
 *   - `PATCH /api/spaces/:id/rename` was not matched by the anchored `…/([^/]+)$` rule, so
 *     SPACE RENAMES were unaudited — the one operation that, done wrong, hides a space's data.
 *   - there was no PUT rule at all, so every schema write was unaudited.
 *
 * None of it was caught because the audit tests only ever asserted `memory.create`,
 * `token.create`/`token.delete` and `auth.failed` — the handful of rules that happened to be
 * correct. Same trap as every other bug in this class: coverage that exercises only the cases
 * that cannot fail.
 *
 * This test derives the route list from the MOUNT GRAPH (`mountedRoutes()` in `_routes.mjs`, which reads every file of `server/src`
 * and resolves each router's prefix, and reads the `app` itself) rather than restating it, so the shadow table can no longer drift
 * silently: add a mutating route, and this fails until it is either audited or explicitly declared exempt.
 *
 * It used to scan `server/src/api` for `xxxRouter.verb(...)` alone, which is the same blind spot `_routes.mjs` documents: the
 * routes declared straight on the express app (wiping, importing and exporting a space, rotating the signing key) and the routes
 * in `mcp/` (the OAuth consent) were never in the set, so this gate reported clean about the five most destructive doors and a
 * door that approves a client's access. The `/mcp` prefix exemption below hid the consent route the same way: `startsWith('/mcp')`
 * matches `/mcp-oauth/consent`.
 *
 * Run: node --test testing/standalone/audit-route-coverage.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes that intentionally produce no audit entry. Each needs a REASON — an exemption
 * without one is how the table rots.
 */
const EXEMPT = new Map([
  /*
   * THE TOOL DOOR — audited, just not from `ROUTE_RULES`, and that distinction is the whole reason this
   * entry needs a paragraph rather than a clause.
   *
   * `POST /api/:tool` serves every tool there is. A rule here would have to be one pattern standing for
   * forty-five different operations, so the audit entry is written by `callTool` instead, which derives the
   * operation from `mcpAuditOperation(toolName)` — the same mapping the MCP door has used all along. One
   * act is therefore logged under one operation whichever door it came through, which is more than a rule
   * here could have given.
   *
   * `mcp-audit-coverage.test.js` is what holds that up: it asserts every registered tool resolves to an
   * operation, that no mutating tool is recorded as a read, and that the dispatch actually calls the
   * recorder with a status taken from the result. So this is not an unaudited route wearing an exemption —
   * it is a route whose coverage is proved somewhere the coverage actually lives.
   */
  // Matched by its declared path, exactly (see EXACT): it is the only single-segment `/api` parameter route there is, and
  // `no-tool-name-shadows-a-mounted-router.test.js` keeps it that way.
  ['/api/:tool', 'the generic tool door (`POST /api/:tool`) — audited by `callTool` from '
    + '`mcpAuditOperation`, one entry per tool call on both doors. Proved by mcp-audit-coverage.test.js, '
    + 'not by a rule here.'],
  // Personal views (Q-531). The shared acts (`spaces/view-acts.ts`) write the audit row for REST and MCP alike, so a row cannot leave one door with
  // the view's name in it: the request path would carry the name, which is why the generic path-matching rule is the wrong writer here. The
  // row names the owner key and the member count (`view.create|update|delete|copy|claim`, `space.retired_id.purge`).
  ['/api/views', 'a personal view\'s lifecycle is audited by `auditViewAct` from the shared act, with the owner key and member count and never the view\'s name'],
  ['/api/admin/views', 'the orphan, claim and purge doors are audited by `auditViewAct` from the shared act (claim, purge); orphans and migration are reads'],
  // Machine-to-machine sync: peers write constantly and are authenticated as peers, not
  // users. Auditing every sync push would swamp the log and tell you nothing about a human.
  ['/api/sync', 'peer-to-peer sync traffic — not a user action'],
  // The reason is now true of the WHOLE router, which it was not when it was written. It covered a
  // `/api/notify/trigger` that started sync cycles, and that route is removed in 5.0 — so what is left is
  // peer notifications, which are machine-to-machine. An exemption whose reason fits one route and is
  // applied to every route on the router is the shape the y-flows convention `convention-a-test-derives-its-set` warns about; this one stopped being it.
  ['/api/notify', 'peer notifications — machine-to-machine, not a user action'],
  // First-run setup happens before any token exists, so there is nobody to attribute it to.
  ['/api/setup', 'first-run setup — runs before any identity exists'],
  // Auth/session endpoints have their own dedicated audit events (auth.failed, token.*).
  // Narrowed from `/api/mfa`, which read "covered by its own auth events" and was not true: the map holds
  // exactly one auth event (`auth.failed`), so enabling and disabling the second factor were both silent.
  // They are audited now (`mfa.enable` / `mfa.disable`); only the read-only code check stays exempt.
  ['/api/mfa/verify', 'checks a TOTP code and returns valid/invalid — mutates nothing'],
  /*
   * `/api/auth/oidc-info` — the reason here USED to read "covered by auth events", which is the identical
   * wording that was disproved next door for `/api/mfa`: the map holds exactly one auth event, `auth.failed`, so
   * nothing was covering anything. The exemption itself was right for a different reason, and a false reason on a
   * correct decision is worse than it sounds — it is what the next person reads before exempting something real
   * on the same basis, which is precisely how enabling and disabling MFA came to be silent.
   *
   * What is actually true: this is a GET that returns the issuer's discovery data and mutates nothing. OIDC is
   * bearer-JWT validation in `auth/middleware.ts`, not a login route, so there is no session event to record —
   * and every audited action already names its actor, `oidcSubject` included.
   */
  ['/api/oidc', 'GET of the IdP discovery data — mutates nothing; OIDC is bearer validation, not a login route'],
  /*
   * NARROWED from the whole `/api/invite` prefix, which read "peer-facing" and hid two things that are not.
   * `generate` is an instance admin producing join material; `finalize` calls `saveConfig` and is the moment
   * another instance becomes a member. Both are audited now — see `network.invite.generate` and
   * `network.member.join` in the rule map. Only the session registration stays exempt.
   */
  ['/api/invite/apply', 'registers an in-memory handshake session — writes nothing, and the handshakeId is the credential'],
  // F-41: a published pub/sub key opening a session. It writes nothing either; the membership it can lead to is
  // audited where it happens, at finalize (`network.member.join`).
  ['/api/invite/redeem', 'opens an in-memory handshake session for a published pub/sub key — writes nothing; the join it leads to is audited at finalize'],
  ['/api/local-agent', 'workstation connector handshake — not a brain mutation'],
  /*
   * `/api/theme` is GONE from this list: it exposes a single GET and no mutating verb, so it never matched the
   * sweep and the entry could only ever mislead a reader into thinking a theme WRITE existed and was exempt.
   * That is the same stale-exemption shape as `/api/spaces/:id/token-access`, which named a route that had been
   * deleted. An exemption is a claim about a route that exists.
   */
  ['/api/metrics', 'Prometheus scrape endpoint'],
  // The MCP transport's two doors, as EXACT paths and not the `/mcp` prefix this row used to be: `startsWith('/mcp')` also matched
  // `/mcp-oauth/consent`, the route that approves a client's access to the instance, and exempted it with a reason that was
  // never true of it. The consent has its own rule (`mcp.oauth.consent`).
  ['/mcp', 'the MCP transport door (`POST /mcp`) — every tool call is audited by `callTool`, one entry per call, proved by mcp-audit-coverage.test.js'],
  ['/mcp/messages', 'the MCP SSE message door (`POST /mcp/messages`) — the same tool dispatch, audited by `callTool`'],
  // Read-only diagnostic: lists a provider endpoint's models to report reachability. POST only because it
  // takes a target in the body; it mutates no config or state (the media-config PATCH beside it IS audited).
  ['/api/admin/media-config/test-connection', 'read-only connectivity probe — lists models, mutates nothing'],
]);

/** Exemptions that name one route exactly; every other key is a prefix that holds from a segment boundary (`/api/sync` and `/api/sync/x`, never `/api/syncfoo`). */
const EXACT = new Set(['/api/:tool', '/mcp', '/mcp/messages']);

/** The reason a route is exempt, or null. */
function exemptionOf(routePath) {
  for (const [key, reason] of EXEMPT) {
    if (EXACT.has(key) ? routePath === key : routePath === key || routePath.startsWith(`${key}/`)) return reason;
  }
  return null;
}

/**
 * The audited NON-MUTATING acts: a GET that hands data out, or that is itself the thing an auditor asks about, is audited though it
 * changes nothing. An export of a whole space is the data leaving the instance, and the export of the audit log is the read someone
 * covering their tracks does first. Each needs a rule that is NOT flagged `read` (a `read` rule is dropped when `audit.logReads` is off,
 * and an export must be written whichever way the operator set it), under the operation named here.
 */
const AUDITED_NON_MUTATING = [
  ['GET', '/api/admin/audit-log/export', 'audit.export'],
  ['GET', '/api/admin/spaces/:spaceId/export', 'space.export'],
];

/** Substitute `:param` segments with a concrete sample so the rule regexes can be tested. */
function concretise(p) {
  return p.replace(/:([A-Za-z_]\w*)/g, 'sample');
}

let resolveOperation;
/** @type {{method: string, path: string, file: string}[]} */
let routes = [];

describe('Audit coverage — every mutating route must resolve to an operation', () => {
  before(async () => {
    ({ resolveOperation } = await import('../../server/dist/audit/middleware.js'));
    routes = mountedRoutes().map(r => ({ method: r.method, path: r.path, file: r.file }));
  });

  it('discovers a plausible number of routes, the ones declared on the app and in mcp/ among them', () => {
    // `mountedRoutes` throws below its own floor; the cases below are what a scan that stopped seeing a whole KIND of registration
    // would lose, which a count cannot tell: the app's own routes and the OAuth router are exactly what the old scan never read.
    assert.ok(routes.length > 150, `expected to discover many routes, found ${routes.length}`);
    for (const [method, path] of [
      ['POST', '/api/brain/spaces/:spaceId/facts'], ['POST', '/api/admin/spaces/:spaceId/wipe'], ['POST', '/api/admin/spaces/:spaceId/import'],
      ['GET', '/api/admin/spaces/:spaceId/export'], ['POST', '/api/admin/rotate-signing-key'], ['POST', '/mcp-oauth/consent'], ['POST', '/mcp'],
    ]) {
      assert.ok(routes.some(r => r.method === method && r.path === path), `sanity: ${method} ${path} should have been discovered`);
    }
  });

  it('every mutating route is audited (or explicitly exempt)', () => {
    const unaudited = [];
    for (const r of routes) {
      if (!MUTATING.has(r.method)) continue;
      if (exemptionOf(r.path)) continue;

      // A rule flagged `read: true` is a deliberate classification (search endpoints are
      // POSTs but do not mutate), so it counts as covered. What must never happen is a
      // mutating route with NO rule at all — that is the silent drift.
      const hit = resolveOperation(r.method, concretise(r.path));
      if (!hit) {
        unaudited.push(`${r.method} ${r.path}  (${r.file.replace('server/src/', '')})`);
      }
    }

    assert.deepEqual(
      unaudited, [],
      'These mutating routes produce NO audit entry. Either add a rule to ROUTE_RULES in ' +
      'server/src/audit/middleware.ts, or add an EXEMPT entry here WITH A REASON:\n  ' +
      unaudited.join('\n  '),
    );
  });

  it('the specific routes that had drifted are now audited', () => {
    // Pin the exact regressions, so a future "cleanup" of the rules cannot quietly undo them.
    //
    // The invite pair is here because their exemption's REASON was what hid them: "peer-facing" is true
    // about who calls them and irrelevant to what they change. `finalize` calls `saveConfig` and is the
    // moment another instance becomes a member of a network on this one.
    const mustAudit = [
      ['POST', '/api/files/sample', 'file upload'],
      ['POST', '/api/invite/generate', 'an admin producing join material'],
      ['POST', '/api/invite/finalize', 'another instance becoming a member — writes config'],
      ['DELETE', '/api/files/sample', 'file delete'],
      ['PATCH', '/api/files/sample', 'file move/rename'],
      ['PATCH', '/api/spaces/sample/rename', 'space rename'],
      ['PUT', '/api/spaces/sample/schema', 'space schema write'],
      ['POST', '/api/spaces/reorder', 'space reorder'],
      // `DELETE /api/brain/spaces/:spaceId/files` was pinned here and its ROUTE is gone (5.0) — the
      // metadata-only delete was a second door onto half of one act. Pinning a rule for a route nobody
      // serves would keep this list green while describing something unreachable, which is the opposite of
      // what pinning is for.
      ['POST', '/api/mfa/setup', 'MFA enable / secret rotation'],
      ['DELETE', '/api/mfa', 'MFA disable'],
      // The routes declared on the app and in mcp/ that the scan did not read until it came from the mount graph: restoring a space from
      // a body, rotating the key every peer verifies this instance's signatures with, and approving a client's access to the instance.
      ['POST', '/api/admin/spaces/sample/import', 'a space import'],
      ['POST', '/api/admin/rotate-signing-key', 'rotating the signing key'],
      ['POST', '/mcp-oauth/consent', 'a client\'s consent to access'],
    ];
    for (const [method, p, what] of mustAudit) {
      const hit = resolveOperation(method, p);
      assert.ok(hit && !hit.read, `${what} (${method} ${p}) must produce an audit entry`);
    }
  });

  it('the import, the key rotation and the consent are recorded under operations of their own', () => {
    assert.equal(resolveOperation('POST', '/api/admin/spaces/my-space/import')?.operation, 'space.import');
    assert.equal(resolveOperation('POST', '/api/admin/spaces/my-space/import')?.spaceId, 'my-space');
    assert.equal(resolveOperation('POST', '/api/admin/rotate-signing-key')?.operation, 'signing.rotate');
    assert.equal(resolveOperation('POST', '/mcp-oauth/consent')?.operation, 'mcp.oauth.consent');
  });

  it('a GET that hands data out is audited under its own operation, whichever way the operator set logReads', () => {
    // The set is an explicit list of audited non-mutating acts, each of which must be a route that is mounted (an entry for a route that
    // is gone is a licence), and each must have a rule that is NOT `read: true` — a read rule is dropped when `audit.logReads` is off.
    for (const [method, path, operation] of AUDITED_NON_MUTATING) {
      assert.ok(routes.some(r => r.method === method && r.path === path), `${method} ${path} is no longer a mounted route: delete its row`);
      const hit = resolveOperation(method, concretise(path));
      assert.ok(hit, `${method} ${path} is an audited non-mutating act and has no rule in ROUTE_RULES`);
      assert.equal(hit.operation, operation, `${method} ${path} is recorded under ${hit.operation}, not ${operation}`);
      assert.equal(hit.read, false, `${method} ${path} is flagged read: it is dropped when logReads is off, and an export must not be`);
    }
  });

  it('every GET route that exports is in that list (a new export cannot arrive unaudited)', () => {
    const listed = new Set(AUDITED_NON_MUTATING.map(([m, p]) => `${m} ${p}`));
    const exports = routes.filter(r => r.method === 'GET' && /(^|\/)export$/.test(r.path)).map(r => `${r.method} ${r.path}`);
    assert.ok(exports.length >= 2, `only ${exports.length} export routes discovered: ${exports.join(', ')}`);
    assert.deepEqual(exports.filter(e => !listed.has(e)), [],
      'a GET route named export hands data out and is neither in AUDITED_NON_MUTATING nor audited');
  });

  it('turning the second factor off is distinguishable in the log', () => {
    // Not just "audited" — named. An operator scanning for how MFA came to be off needs the entry to say
    // so, and `mfa.disable` beside `mfa.enable` is what makes a rotation and a removal tell apart.
    assert.equal(resolveOperation('DELETE', '/api/mfa')?.operation, 'mfa.disable');
    assert.equal(resolveOperation('POST', '/api/mfa/setup')?.operation, 'mfa.enable');
    // The read-only code check stays out of the log — it is the one MFA route that changes nothing, and
    // it is also the one a health-check hits repeatedly.
    assert.equal(resolveOperation('POST', '/api/mfa/verify'), null);
  });

  it('a space rename is recorded as space.rename, not swallowed by space.update', () => {
    // Rule order matters: the generic `/api/spaces/:id` PATCH rule would otherwise shadow it.
    const hit = resolveOperation('PATCH', '/api/spaces/my-space/rename');
    assert.equal(hit?.operation, 'space.rename');
    assert.equal(hit?.spaceId, 'my-space');
  });
});
