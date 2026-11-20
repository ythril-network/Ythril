/**
 * A test that drives the server asks only for routes the server serves, so a test cannot pass or fail on a path nobody can reach.
 *
 * ## The finding (bundle-269, the full run of 2026-11-20)
 *
 * Three tests were red on paths the server does not serve, and each read as a defect of the code it was written to hold:
 *
 *  - `a-failed-tool-call-is-audited-as-rest-audits-it-db` (e) mounted the real audit middleware over a stub at
 *    `PATCH /api/brain/:space/entities/:id`, the short brain form removed in 2.0. While the audit rules read an optional `spaces/`
 *    segment the stub was audited; once the rules read only the served `/api/brain/spaces/:spaceId/...`, the stub left no row and the
 *    case read as "a write through a served path leaves no audit entry".
 *  - `two-members-derive-the-same-term-iris` and `a-member-that-leaves-before-a-rebase-keeps-its-base` read a space's meta through
 *    `GET /api/spaces/:id`, a route the spaces router has never declared (a 404 with no `space` in its body), so every RDF base
 *    they read was `undefined` and the cases read as "the base never arrived" and "the base moved at the pass".
 *
 * ## What is held
 *
 * Every request a sync or integration test sends through the stack helpers (`get`, `post`, `patch`, `put`, `del`, `delWithBody`) with a
 * literal path under `/api/`, and every route a standalone test mounts beside the real `auditMiddleware`, names a route of the mount graph
 * (`mountedRoutes()`, `_routes.mjs`) for its method. A `${...}` in a literal stands for one path segment. A request that is MEANT to miss
 * (a removed route a test proves is gone) is a row of `MEANT_TO_MISS` with its reason, matched by method and path exactly.
 *
 * Run: node --test testing/standalone/a-test-asks-only-for-routes-the-server-serves.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mountedRoutes } from './_routes.mjs';
import { REPO_ROOT, trackedTestFiles } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The stack helpers of `testing/sync/helpers.js` and the method each sends: `(baseUrl, token, path, ...)`. */
const HELPER_METHODS = { get: 'GET', post: 'POST', patch: 'PATCH', put: 'PUT', del: 'DELETE', delWithBody: 'DELETE' };

/** A request a test sends to prove a route is gone: `METHOD path` as written (a `${...}` kept), with the reason. */
const MEANT_TO_MISS = new Map([
  ['GET /api/brain/general/facts', 'brain.test.js (A1) proves the two-segment brain shape removed in 2.0 answers 404'],
  ['POST /api/brain/general/facts', 'brain.test.js (A1) proves the two-segment brain shape removed in 2.0 answers 404'],
  ['POST /api/brain/spaces/general/chrono/${rec.id}', 'brain-if-match.test.js proves the POST-as-update of a chrono entry removed in 3.0 answers 404, with and without If-Match'],
  ['POST /api/brain/spaces/general/chrono/${chronoId}', 'brain.test.js proves the POST-as-update of a chrono entry removed in 3.0 answers 404 and writes nothing'],
  ['POST /api/notify/trigger', 'sync-doors.test.js proves the sync trigger removed in 5.0 answers 404 to an admin, not 401 or 403'],
  // A stub, not a request: (e) of a-failed-tool-call-is-audited-as-rest-audits-it-db compares the filter tool's row with the row the audit
  // middleware writes under its `brain.filter` rule. The route was removed in 5.0 (filter's REST door is `POST /api/filter`, audited by
  // callTool), and the rule is still in ROUTE_RULES, which is what (e) reads; the rule and this row go together.
  ['POST /api/brain/filter', 'a-failed-tool-call (e) reads the brain.filter rule that outlived its route (removed in 5.0); the rule and this row are removed together'],
]);

/**
 * The string literal that opens at `at` (a quote or a backtick), read to its closing quote: a template's `${...}` is read with its nesting,
 * so a quote inside it (`${encodeURIComponent('x')}`) does not end the literal. `null` when it does not close on its own line.
 */
function literalAt(src, at) {
  const q = src[at];
  let depth = 0;
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\n' && depth === 0) return null;
    if (c === '\\') { i++; continue; }
    if (q === '`' && depth === 0 && c === '$' && src[i + 1] === '{') { depth = 1; i++; continue; }
    if (depth > 0) { if (c === '{') depth++; else if (c === '}') depth--; continue; }
    if (c === q) return src.slice(at + 1, i);
  }
  return null;
}

/** The parts of a literal's path between slashes, the query cut: a literal segment, `{ any: true }` for one whole `${...}`, `{ rest: true }` from a part that only holds one. */
function requestSegments(literal) {
  const placeholders = [];
  const masked = literal.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, (m) => { placeholders.push(m); return '\u0000'; });
  const segs = [];
  for (const s of masked.split('?')[0].split('/').slice(1)) {
    if (s === '\u0000') segs.push({ any: true });
    else if (s.includes('\u0000')) { segs.push({ rest: true }); break; }
    else segs.push(s.toLowerCase());
  }
  return segs;
}

/** Whether a request with these segments can reach the mounted `route` path: a `${...}` stands for any one segment, a part holding more is any rest. */
function reaches(segs, route) {
  const parts = route.split('/').slice(1).filter((p, i, all) => !(p === '' && i === all.length - 1));
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (typeof s === 'object' && s.rest) return parts.length >= i + 1;
    if (i >= parts.length) return false;
    if (typeof s === 'object' || parts[i].startsWith(':')) continue;
    if (parts[i].toLowerCase() !== s) return false;
  }
  return segs.length === parts.length;
}

/** The 1-based line of `index` in `text`, and whether that line is a comment line (a match in a comment is no request). */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const inCommentLine = (text, index) => /^\s*(\*|\/\/|\/\*)/.test(text.slice(text.lastIndexOf('\n', index) + 1, index + 1));

/** Every request a test sends through a stack helper with a literal `/api/` path: `{ file, line, method, literal }`. */
export function helperRequestsIn(file, text) {
  const out = [];
  // The helper's name, then its first two arguments (a call or a member read may stand in either), then the path literal.
  const call = /(?<![\w.])(get|post|patch|put|del|delWithBody)\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*[^,()]+(?:\([^()]*\))?\s*,\s*(?=['`]\/api\/)/g;
  for (const m of text.matchAll(call)) {
    const at = m.index + m[0].length;
    const literal = literalAt(text, at);
    if (literal === null || inCommentLine(text, m.index)) continue;
    out.push({ file, line: lineOf(text, m.index), method: HELPER_METHODS[m[1]], literal });
  }
  return out;
}

/** Every route a test mounts on an express app of its own with a literal `/api/` path, when the file mounts the real audit middleware. */
export function auditStubRoutesIn(file, text) {
  if (!/\.use\(\s*auditMiddleware\s*\)/.test(stripComments(text))) return [];
  const out = [];
  for (const m of text.matchAll(/\bapp\.(get|post|patch|put|delete)\(\s*(?=['`]\/api\/)/g)) {
    const literal = literalAt(text, m.index + m[0].length);
    if (literal === null || inCommentLine(text, m.index)) continue;
    out.push({ file, line: lineOf(text, m.index), method: m[1].toUpperCase(), literal: literal.replace(/:([A-Za-z_]\w*)/g, '${$1}') });
  }
  return out;
}

/** The requests of `asked` that reach no route of `routes` for their method and are not meant to miss. */
export function unservedRequests(asked, routes) {
  const byMethod = new Map();
  for (const r of routes) byMethod.set(r.method, [...(byMethod.get(r.method) ?? []), r.path]);
  return asked.filter(a => !MEANT_TO_MISS.has(`${a.method} ${a.literal}`)
    && !(byMethod.get(a.method) ?? []).some(p => reaches(requestSegments(a.literal), p)));
}

describe('a test asks only for routes the server serves', () => {
  let routes, files;
  before(() => {
    routes = mountedRoutes();
    files = trackedTestFiles({ dirs: ['testing'] });
  });

  it('every literal request of a sync or integration test names a mounted route for its method', () => {
    const asked = files.filter(f => /^testing\/(sync|integration)\//.test(f))
      .flatMap(f => helperRequestsIn(f, readFileSync(join(REPO_ROOT, f), 'utf8')));
    // A floor, so a pattern that stopped matching the helpers' calls cannot report clean about nothing.
    assert.ok(asked.length > 500, `only ${asked.length} literal requests found in the sync and integration tests`);
    const missed = unservedRequests(asked, routes);
    assert.deepEqual(missed.map(a => `${a.file}:${a.line} ${a.method} ${a.literal}`), [],
      'these requests name no route the server mounts; read the route it should be (the mount graph, `_routes.mjs`), or add a MEANT_TO_MISS row with its reason');
  });

  it('every route a test mounts beside the real audit middleware is one the server mounts', () => {
    const stubs = files.flatMap(f => auditStubRoutesIn(f, readFileSync(join(REPO_ROOT, f), 'utf8')));
    assert.ok(stubs.length >= 4, `only ${stubs.length} stub routes found beside the audit middleware`);
    const missed = unservedRequests(stubs, routes);
    assert.deepEqual(missed.map(a => `${a.file}:${a.line} ${a.method} ${a.literal}`), [],
      'a stub beside the real audit middleware holds the rules to a path nobody can request; mount it at the served route');
  });

  it('the matcher tells a served path from an unserved one (positive and negative controls)', () => {
    const served = [
      { method: 'PATCH', path: '/api/brain/spaces/:spaceId/entities/:id' }, { method: 'GET', path: '/api/spaces/:id/meta' },
      { method: 'POST', path: '/api/brain/spaces/:spaceId/facts' },
    ];
    const asked = [
      { method: 'PATCH', literal: '/api/brain/spaces/${S}/entities/${id}' },
      { method: 'PATCH', literal: '/api/brain/${S}/entities/${id}' },
      { method: 'GET', literal: '/api/spaces/${S}/meta?resolve=0' },
      { method: 'GET', literal: '/api/spaces/${S}' },
      { method: 'POST', literal: '/api/spaces/${S}/meta' },
      { method: 'POST', literal: '/api/brain/spaces/${S}/${kind}' },
      { method: 'POST', literal: '/api/brain/spaces/${S}${p}' },
      { method: 'POST', literal: '/api/brain/spaces/${S}/edges' },
    ];
    assert.deepEqual(unservedRequests(asked, served).map(a => `${a.method} ${a.literal}`),
      ['PATCH /api/brain/${S}/entities/${id}', 'GET /api/spaces/${S}', 'POST /api/spaces/${S}/meta', 'POST /api/brain/spaces/${S}/edges']);
    const text = "await get(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`);\nawait patch(base, t, '/api/x', {});\n"
      + " * get(a, b, '/api/in/a/comment')\nawait get(a, b, `/api/c/${enc('x')}/d`);";
    assert.deepEqual(helperRequestsIn('f', text).map(a => [a.line, a.method, a.literal]),
      [[1, 'GET', '/api/spaces/${SPACE}'], [2, 'PATCH', '/api/x'], [4, 'GET', "/api/c/${enc('x')}/d"]]);
    const stub = "app.use(auditMiddleware);\napp.patch('/api/brain/:space/entities/:id', answer);";
    assert.deepEqual(auditStubRoutesIn('f', stub).map(a => [a.method, a.literal]), [['PATCH', '/api/brain/${space}/entities/${id}']]);
  });
});
