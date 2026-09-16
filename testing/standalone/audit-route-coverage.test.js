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
 * This test derives the route list from the ROUTER SOURCE rather than restating it, so the
 * shadow table can no longer drift silently: add a mutating route, and this fails until it is
 * either audited or explicitly declared exempt.
 *
 * Run: node --test testing/standalone/audit-route-coverage.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'api');
const APP_TS = path.join(__dirname, '..', '..', 'server', 'src', 'app.ts');

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
  // Keyed `/api/sample` because `samplePath` above substitutes every `:param` with `sample`, so the
  // mounted `/api/:tool` reaches this comparison spelled that way. It is the only single-segment `/api`
  // parameter route there is, and `no-tool-name-shadows-a-mounted-router.test.js` keeps it that way.
  ['/api/sample', 'the generic tool door (`POST /api/:tool`) — audited by `callTool` from '
    + '`mcpAuditOperation`, one entry per tool call on both doors. Proved by mcp-audit-coverage.test.js, '
    + 'not by a rule here.'],
  // Machine-to-machine sync: peers write constantly and are authenticated as peers, not
  // users. Auditing every sync push would swamp the log and tell you nothing about a human.
  ['/api/sync', 'peer-to-peer sync traffic — not a user action'],
  // Narrowed in scope by a new rule rather than in text: `/api/notify/trigger` now records
  // `sync.trigger`, because a sync cycle writes peer records locally. This entry covers the peer
  // notifications only, which are machine-to-machine and not a user action.
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
  ['/api/local-agent', 'workstation connector handshake — not a brain mutation'],
  /*
   * `/api/theme` is GONE from this list: it exposes a single GET and no mutating verb, so it never matched the
   * sweep and the entry could only ever mislead a reader into thinking a theme WRITE existed and was exempt.
   * That is the same stale-exemption shape as `/api/spaces/:id/token-access`, which named a route that had been
   * deleted. An exemption is a claim about a route that exists.
   */
  ['/api/metrics', 'Prometheus scrape endpoint'],
  ['/mcp', 'MCP has its own tool-level audit path'],
  // Read-only diagnostic: lists a provider endpoint's models to report reachability. POST only because it
  // takes a target in the body; it mutates no config or state (the media-config PATCH beside it IS audited).
  ['/api/admin/media-config/test-connection', 'read-only connectivity probe — lists models, mutates nothing'],
]);

let resolveOperation;
/** @type {{method: string, routerPath: string, fullPath: string, file: string}[]} */
let routes = [];

/** Every .ts file under the api dir, recursively — routes live in `api/` AND `api/brain/` (A17.3). */
function apiFiles(dir = API_DIR, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) apiFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Map `xxxRouter` -> its mount prefix, read from app.ts (`app.use('/api/xxx', xxxRouter)`). */
function readMounts() {
  const src = fs.readFileSync(APP_TS, 'utf8');
  const mounts = new Map();
  const re = /app\.use\(\s*'([^']+)'\s*,\s*([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(src)) !== null) mounts.set(m[2], m[1]);

  // Sub-routers mounted on a parent router serve the parent's prefix — e.g. api/brain/index.ts does
  // `brainRouter.use(memoriesRouter)`, so memoriesRouter's routes are under /api/brain. Without this
  // the whole brain surface would silently vanish from the audit check.
  const links = [];
  for (const f of apiFiles()) {
    const s = fs.readFileSync(f, 'utf8');
    const childRe = /(\w+Router)\s*\.\s*use\(\s*(\w+Router)\s*\)/g;
    let c;
    while ((c = childRe.exec(s)) !== null) links.push([c[1], c[2]]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [parent, child] of links) {
      if (mounts.has(parent) && !mounts.has(child)) { mounts.set(child, mounts.get(parent)); changed = true; }
    }
  }
  return mounts;
}

/** Substitute `:param` segments with a concrete sample so the rule regexes can be tested. */
function concretise(p) {
  return p.replace(/:([A-Za-z_]\w*)/g, 'sample');
}

describe('Audit coverage — every mutating route must resolve to an operation', () => {
  before(async () => {
    ({ resolveOperation } = await import('../../server/dist/audit/middleware.js'));

    const mounts = readMounts();
    for (const filePath of apiFiles()) {
      const src = fs.readFileSync(filePath, 'utf8');
      // e.g.  memoriesRouter.post('/spaces/:spaceId/facts', ...)   (also multi-line)
      const re = /(\w+Router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const [, routerName, method, routerPath] = m;
        const prefix = mounts.get(routerName);
        if (!prefix) continue; // router not mounted in app.ts (e.g. built dynamically)
        const joined = (prefix + (routerPath === '/' ? '' : routerPath)).replace(/\/+/g, '/');
        routes.push({
          method: method.toUpperCase(),
          routerPath,
          fullPath: concretise(joined),
          file: path.relative(API_DIR, filePath).replace(/\\/g, '/'),
        });
      }
    }
  });

  it('discovers a plausible number of routes (the parser itself must not silently break)', () => {
    // If the regex stops matching (a refactor to a different registration style), every
    // assertion below would vacuously pass. Guard the guard.
    assert.ok(routes.length > 50, `expected to discover many routes, found ${routes.length}`);
    assert.ok(
      routes.some(r => r.fullPath === '/api/brain/spaces/sample/facts' && r.method === 'POST'),
      'sanity: POST /api/brain/spaces/:spaceId/facts should have been discovered',
    );
  });

  it('every mutating route is audited (or explicitly exempt)', () => {
    const unaudited = [];
    for (const r of routes) {
      if (!MUTATING.has(r.method)) continue;
      if ([...EXEMPT.keys()].some(prefix => r.fullPath.startsWith(prefix))) continue;

      // A rule flagged `read: true` is a deliberate classification (search endpoints are
      // POSTs but do not mutate), so it counts as covered. What must never happen is a
      // mutating route with NO rule at all — that is the silent drift.
      const hit = resolveOperation(r.method, r.fullPath);
      if (!hit) {
        unaudited.push(`${r.method} ${r.fullPath}  (${r.file})`);
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
    ];
    for (const [method, p, what] of mustAudit) {
      const hit = resolveOperation(method, p);
      assert.ok(hit && !hit.read, `${what} (${method} ${p}) must produce an audit entry`);
    }
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
