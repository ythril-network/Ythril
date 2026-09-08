/**
 * A `ROUTE_RIGHTS` row promises a rung. The route must actually be reachable at it.
 *
 * ## The defect
 *
 * `POST /api/spaces/:id/validate-schema` carried a row of `schema` / `read` and was guarded by
 * `requireAdminOrSpaceAdminMfaScoped` — instance admin, or a SPACE administrator, which needs `admin` on all
 * FOUR areas. So the rung the rights panel advertised could never open the door.
 *
 * The canary operator (2026-09-08T1400Z) granted SCHEMA exactly as the panel asked, got
 * `Admin token required`, read that as INSTANCE admin, and concluded the route was instance-only. It cost
 * them an afternoon twice — and, worse, it is what made them distrust the panel's other rows enough to ask
 * whether a schema administrator could DELETE a space. (It cannot: `enforceAdmin` runs first there, proven
 * by firing the call.)
 *
 * Their observation is the shape of it: the mapping "is enforced for at least one row and not for another".
 * `GET /:id/meta`, same area, one call apart, honours the rung.
 *
 * ## The rule this asserts
 *
 * **A row whose guard demands admin is a row that lies**, unless the row itself says `admin` is what it
 * needs — and even then the area rung is not what admits the caller. So: a route with a `ROUTE_RIGHTS` row
 * must be guarded by one of the guards that CONSULTS the rung, not by one that requires instance or space
 * admin first.
 *
 * A route that genuinely is admin-shaped belongs in `NOT_AREA_SCOPED` with its reason — that is the
 * distinction `CLAUDE.md` calls the trap, and it is why this is a gate rather than a comment.
 *
 * ## Derived, and it starts with an exemption list that should SHRINK
 *
 * The pairs come from the rights table and the route sources, not from a list here. The rows that are still
 * mismatched are named in `KNOWN_MISMATCH` with what they need — they are `D-2`/`D-4` work, agreed in
 * principle and not yet built. Each one that ships deletes a line here, and a NEW mismatch fails.
 *
 * Run: node --test testing/standalone/a-rights-row-is-reachable-at-the-rung-it-names.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');

/** Guards that require instance admin, or a four-area space admin, BEFORE any rung is consulted. */
const ADMIN_FIRST = [
  'requireAdmin',
  'requireAdminMfa',
  'requireAdminMfaScoped',
  'requireAdminOrSpaceAdmin',
  'requireAdminOrSpaceAdminMfa',
  'requireAdminOrSpaceAdminMfaScoped',
];

/**
 * Rows known to be guarded above their stated rung, with what each needs. `D-2` and `D-4` are the decisions
 * that settle them; this list is the visible cost of not having built them yet, and it must only shrink.
 */
const KNOWN_MISMATCH = {};

const src = f => stripComments(readFileSync(f, 'utf8'));

/**
 * Where each router hangs, resolved from the `use()` calls rather than guessed.
 *
 * The first draft matched a row to a registration by asking whether the row's route ENDED WITH the
 * registration's path, across every router in the tree. Four routers declare `/:id`, so `PATCH /api/spaces/:id`
 * was answered by the first `/:id` the scan happened to reach and the gate reported a guard belonging to a
 * different route — a wrong reason attached to a real row, which is worse than no finding at all.
 */
function mountPrefixes() {
  const edges = [];
  const allSources = trackedSources(['server/src'], { floor: 50 });
  for (const f of allSources) {
    const s = src(f);
    for (const m of s.matchAll(/\b(\w+)\.use\(\s*'([^']*)'\s*,\s*(\w+)/g)) {
      edges.push({ parent: m[1], prefix: m[2], child: m[3] });
    }
    /*
     * `brainRouter.use(memoriesRouter)` — mounted at the parent's own path with NO prefix argument.
     *
     * Reading only the two-argument form resolved 117 of 217 registrations, and the hundred it missed were
     * the whole brain tree — fifty of the eighty-five `ROUTE_RIGHTS` rows. They were not reported as
     * unmatched; they were absent, and the floor below passed comfortably on what remained. A gate
     * concluding about every row while reading two fifths of them is this file's own subject.
     */
    for (const m of s.matchAll(/\b(\w+)\.use\(\s*(\w+Router)\s*\)/g)) {
      edges.push({ parent: m[1], prefix: '', child: m[2] });
    }
    /*
     * A route registered by a FUNCTION, onto the router it is handed:
     *
     *     export function registerUploadRoute(router: Router) { router.post('/:spaceId', ...) }
     *     registerUploadRoute(fileStoreRouter);            // in another file
     *
     * The registration names its parameter, so the scan sees a router called `router` that nothing mounts.
     * `registerReembedRoute` gets away with it only because its parameter happens to be spelled
     * `spacesRouter` — luck, not design, and `POST /api/files/:spaceId` had no such luck: a real row on a
     * real route, invisible. Bind the parameter to whatever the single call site passes.
     */
    for (const m of s.matchAll(/export function (\w+)\(\s*(\w+)\s*:\s*Router/g)) {
      const callers = allSources
        .flatMap(g => [...src(g).matchAll(new RegExp(`\\b${m[1]}\\(\\s*(\\w+)\\s*\\)`, 'g'))].map(c => c[1]));
      // Only when every call site passes the SAME router. Two callers would make one parameter mean two
      // prefixes, and a guess there is worse than the gap it fills.
      if (callers.length && callers.every(c => c === callers[0])) {
        edges.push({ parent: callers[0], prefix: '', child: m[2], alias: true });
      }
    }
  }
  const at = { app: '' };
  // Mounts can nest (`app` → `brainRouter` → `searchRouter`), and the file order says nothing about the
  // depth, so walk to a fixed point instead of once.
  for (let pass = 0; pass < 10; pass++) {
    let grew = false;
    for (const e of edges) {
      if (e.parent in at && !(e.child in at)) { at[e.child] = at[e.parent] + e.prefix; grew = true; }
    }
    if (!grew) break;
  }
  return at;
}

/** Every `router.verb('path', …guards)` registration in the API tree, with the guards named on it. */
function registrations(at) {
  const out = [];
  for (const f of trackedSources(['server/src/api'], { floor: 10 })) {
    const s = src(f);
    for (const m of s.matchAll(/(\w*[Rr]outer)\.(get|post|patch|put|delete)\(\s*'([^']*)'/g)) {
      const prefix = at[m[1]];
      if (prefix === undefined) continue;   // a router nobody mounts serves nothing
      // From the path to the handler: the guards are the arguments between them.
      const from = m.index + m[0].length;
      const to = s.indexOf('=>', from);
      out.push({
        method: m[2].toUpperCase(),
        route: (prefix + m[3]).replace(/\/$/, '') || '/',
        guards: to > from ? s.slice(from, to) : '',
      });
    }
  }
  return out;
}

describe('a rights row is reachable at the rung it names', () => {
  const regs = registrations(mountPrefixes());

  it('found the registrations', () => {
    // A floor: an empty scan passes the loop below while checking nothing.
    assert.ok(regs.length > 100, `only ${regs.length} route registrations found — the scan is wrong`);
  });

  it('every exemption still names a real row', () => {
    // An exemption for a row that no longer exists is a licence for whatever takes its place.
    const rows = new Set(ROUTE_RIGHTS.map(r => `${r.method} ${r.route}`));
    const stale = Object.keys(KNOWN_MISMATCH).filter(k => !rows.has(k));
    assert.deepEqual(stale, [], `these exemptions name rows that are gone: ${stale.join(', ')}`);
  });

  it('every path-scoped row reaches a real registration', () => {
    /*
     * THE HOLE THIS CLOSES, and it was open in the first version of this file.
     *
     * The case below reads `if (!hit) continue;` — a row that matches no registration checks nothing and
     * says nothing. That is fine only while the matcher can see the whole surface, and it could not: the
     * brain routers mount without a prefix argument, so fifty of the eighty-five rows silently found no
     * registration and the gate reported clean about every one of them.
     *
     * Deriving the subject set is not enough on its own — the set has to be shown to have ARRIVED. An
     * `iterates` row is exempt because it names no path: its enforcement point is the loop, not the call.
     */
    const missing = ROUTE_RIGHTS
      .filter(row => row.scope === 'path')
      .filter(row => !regs.some(r => r.method === row.method && r.route === row.route))
      .map(row => `${row.method} ${row.route}`);
    assert.deepEqual(missing, [],
      'these rights rows match no route registration, so nothing below checks them — either the route is '
      + `gone and the row is stale, or the scan cannot see it:\n  ${missing.join('\n  ')}`);
  });

  it('no row is guarded above the rung it advertises', () => {
    const offenders = [];
    for (const row of ROUTE_RIGHTS) {
      const key = `${row.method} ${row.route}`;
      if (key in KNOWN_MISMATCH) continue;
      const hit = regs.find(r => r.method === row.method && r.route === row.route);
      if (!hit) continue;   // unmatched is an instrument gap, not a finding — the floor above covers vacuity
      // Whole identifiers: `requireAdmin` is a SUBSTRING of `requireAdminOrSpaceAdminMfaScoped`, and reading
      // the wrong guard here would report the wrong reason for the right row, or invent one.
      const names = [...hit.guards.matchAll(/\b(require[A-Za-z]+)\b/g)].map(m => m[1]);
      const blocking = names.filter(n => ADMIN_FIRST.includes(n));
      if (blocking.length) offenders.push(`${row.area}/${row.needs}  ${key}  guarded by ${blocking.join(', ')}`);
    }
    assert.deepEqual(offenders, [],
      'these advertise an area rung that cannot open the door — the guard demands instance or space admin '
      + `first, so the rung is decoration:\n  ${offenders.join('\n  ')}`);
  });
});
