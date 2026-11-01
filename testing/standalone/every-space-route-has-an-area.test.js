/**
 * Every space-scoped route is classified into an area, or the build fails.
 *
 * ## What this is for
 *
 * The per-space rights matrix only governs what it knows about. A route nobody assigned to an area is not
 * refused and does not warn — it keeps working at whatever access the old model gave it, while the UI shows
 * a grid implying otherwise. That is the failure this repo keeps meeting: a control that looks complete
 * because nothing contradicts it.
 *
 * So the inventory in `server/src/auth/space-rights.ts` is checked against the ROUTE SURFACE, discovered
 * here from source. A route that is neither classified nor explicitly exempt fails, and the message names
 * it. Adding a space-scoped route without deciding what it means becomes impossible rather than merely
 * discouraged.
 *
 * ## Why the surface is discovered rather than listed
 *
 * A hand-written list of routes is the same artefact as the inventory, so comparing them would prove
 * nothing — both would be edited in the same commit by the same person making the same assumption. The
 * surface is read out of the mount graph instead (`mountedRoutes()`, which also reads the routes declared on the express app: the first
 * version of this gate scanned `server/src/api` for router calls and never saw wiping, exporting or importing a space).
 *
 * Run: node --test testing/standalone/every-space-route-has-an-area.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';
import { SPACE_AREAS } from '../../server/dist/config/rights-shape.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const INVENTORY = 'server/src/auth/space-rights.ts';

/**
 * The mounts of the routers whose every route is space-scoped.
 *
 * The routes themselves are DERIVED (`mountedRoutes()`: every file of `server/src`, each router's resolved prefix, and the express
 * `app`), so a route that is registered anywhere is in front of this gate. What a route file cannot say is whether its router is
 * wholly about spaces, and that is the one thing kept here, as the prefix each such router is mounted at:
 *
 * - the brain, the files, the duplicate / contradiction / conflict queues (which scope by ITERATING the token's spaces rather than
 *   by taking one in the path — the reason `scope` exists on a `RouteRight` at all), the spaces router (some routes address the
 *   COLLECTION, `GET /api/spaces`, and are exempted with reasons, not left unasked), the networks router (a network carries spaces),
 *   the personal views and webhooks routers (each names spaces and is owner- or instance-scoped, exempted with a reason);
 * - the tool door, `POST /api/:tool`, whose space is a BODY parameter (see `TOOL_DOOR`).
 *
 * A route outside these mounts is space-scoped too when it NAMES a space in its path (`:spaceId`): that is how the instance-admin
 * doors on the app itself (`/api/admin/spaces/:spaceId/wipe`, `/export`, `/import`) were in no gate's view — this file scanned
 * `server/src/api` for router calls only, and `app.ts` registers them on `app`. The derivation is the surface, not a second list of it.
 */
const SPACE_MOUNTS = [
  '/api/brain', '/api/files', '/api/duplicates', '/api/contradictions', '/api/conflicts', '/api/spaces', '/api/networks',
  '/api/views', '/api/admin/views', '/api/admin/webhooks',
];

/**
 * THE TOOL DOOR — `POST /api/:tool`, the one route that serves every tool. It is space-scoped without a `:spaceId` in the path (the space
 * is a body parameter) and resolves to a `NOT_AREA_SCOPED` row rather than an area: forty-five capabilities cannot share one rung, so each
 * is priced in `TOOL_RIGHTS` and enforced per call by `callTool`.
 */
const TOOL_DOOR = '/api/:tool';

const underMount = (p) => SPACE_MOUNTS.some(m => p === m || p.startsWith(`${m}/`));
const namesASpace = (p) => /\/:(spaceId|space)(\/|$)/.test(p);

let discovered;
/** Every space-scoped route, as `METHOD path`, derived from the mount graph. */
function discoveredRoutes() {
  discovered ??= new Set(mountedRoutes()
    .filter(r => underMount(r.path) || namesASpace(r.path) || r.path === TOOL_DOOR)
    .map(r => `${r.method} ${r.path}`));
  return discovered;
}

/** Everything the inventory claims, as the same `METHOD route` key. */
function classifiedRoutes() {
  const code = read(INVENTORY);
  const out = new Set();
  for (const m of code.matchAll(/route:\s*'([^']+)',\s*method:\s*'([A-Z]+)'/g)) {
    out.add(`${m[2]} ${m[1]}`);
  }
  return out;
}

function exemptRoutes() {
  const code = read(INVENTORY);
  const block = code.slice(code.indexOf('NOT_AREA_SCOPED'));
  return new Set([...block.matchAll(/route:\s*'([^']+)'/g)].map(m => m[1]));
}

/**
 * Does this route exist on the real surface? Takes `METHOD path` or a bare path.
 *
 * Extracted because the two staleness checks below need the identical question, and this repo's most-produced
 * defect is one rule with two implementations where the weaker one wins.
 *
 * It used to have a second implementation anyway. Routes under `/api/spaces/` took a branch that concatenated
 * three source files and asked `code.includes("'/:id'")` — **a substring search that discarded the METHOD**. So
 * `GET /api/spaces/:id` was reported to exist because some other verb was registered on that path, and the
 * inventory carried a row for a route that has never existed. The branch was written to compensate for the
 * spaces router being absent from `SPACE_ROUTERS`; now that it is present, one implementation answers for
 * every router and the weaker copy is gone.
 */
function routeExists(methodAndPath) {
  const space = methodAndPath.indexOf(' ');
  const bare = space === -1 ? methodAndPath : methodAndPath.slice(space + 1);
  const found = discoveredRoutes();
  // A bare path matches any verb registered on it, which is what a method-less exemption means.
  return space === -1
    ? [...found].some(r => r.slice(r.indexOf(' ') + 1) === bare)
    : found.has(methodAndPath);
}

describe('every space-scoped route is classified', () => {
  it('discovers a real route surface', () => {
    // A gate that enumerates nothing passes vacuously, and would keep passing if a router moved.
    const found = discoveredRoutes();
    assert.ok(found.size >= 100, `expected the space routers to yield many routes, found ${found.size}`);
    assert.ok([...found].some(r => r.includes(':spaceId')), 'no :spaceId route found — re-point SPACE_MOUNTS');
    // A whole KIND of registration a scan can stop seeing, which a count cannot tell: the routes declared on the app, by their space param.
    for (const r of ['POST /api/admin/spaces/:spaceId/wipe', 'GET /api/admin/spaces/:spaceId/export', 'POST /api/admin/spaces/:spaceId/import']) {
      assert.ok(found.has(r), `${r} is a route that names a space and was not derived`);
    }
  });

  it('the inventory is not empty and every rights area has a route classified into it', () => {
    /*
     * The areas come from `SPACE_AREAS`, which is the one list the type, the validator and both rights maps
     * are built from. Four names were written out here — so a fifth area would arrive with a validator, a
     * type and a token control, and this case would keep reporting that the inventory names them all.
     *
     * The title lost its count with them. A number in a title is a second copy of a fact the code holds.
     */
    const code = read(INVENTORY);
    for (const area of SPACE_AREAS) {
      assert.match(code, new RegExp(`area:\\s*'${area}'`),
        `no route is classified as ${area}, so a whole rights area governs nothing and a token granted it `
        + 'reaches no route at all');
    }
  });

  it('no discovered route is unclassified', () => {
    const classified = classifiedRoutes();
    const exempt = exemptRoutes();
    const missing = [...discoveredRoutes()].filter(r => {
      if (classified.has(r)) return false;
      const path = r.slice(r.indexOf(' ') + 1);
      return !exempt.has(path);
    }).sort();
    assert.deepEqual(
      missing,
      [],
      `these space-scoped routes belong to no area and are not exempt, so the rights matrix does not govern `
      + `them:\n  ${missing.join('\n  ')}\nAdd each to ROUTE_RIGHTS with its area, the lowest rung that may `
      + `call it, and whether it scopes by 'path' or 'iterates' — or to NOT_AREA_SCOPED with a reason.`,
    );
  });

  it('the inventory claims no route that does not exist', () => {
    // The other direction, and the one that rots quietly: a classified route that was deleted or renamed
    // leaves a rule guarding nothing, and the count still looks healthy.
    const stale = [...classifiedRoutes()].filter(r => !routeExists(r)).sort();
    assert.deepEqual(stale, [], `the inventory classifies routes that no longer exist:\n  ${stale.join('\n  ')}`);
  });

  it('and the EXEMPTION list claims none either', () => {
    /*
     * The same rot, on the list nobody was checking. `/api/spaces/:id/token-access` sat in NOT_AREA_SCOPED
     * with a two-line reason for a route that does not exist anywhere in the server — the only token-access
     * route is the brain one, which has its own entry. Found by reading the list while fixing the runtime,
     * not by any gate: the staleness check above iterated `classifiedRoutes()` alone, so an exemption could
     * name anything at all.
     *
     * Worth its own test rather than a wider one, because a stale exemption is the more dangerous of the two.
     * A stale CLASSIFICATION guards nothing and enforces nothing. A stale EXEMPTION is a standing licence:
     * the day a route with that path is added, it arrives pre-excused from the rights matrix and no gate
     * objects, because the excuse was written before the route existed.
     *
     * Exemptions carry no method, so existence is checked path-only — `routeExists` takes either shape.
     */
    const stale = [...exemptRoutes()].filter(r => !routeExists(r)).sort();
    assert.deepEqual(stale, [], 'NOT_AREA_SCOPED exempts routes that do not exist. Delete the entry — an '
      + 'exemption for a path nothing serves is a standing licence for whatever is added there next:\n  '
      + stale.join('\n  '));
  });

  it('every data-quality route scopes by iterating, not by path', () => {
    // The finding this whole file exists to protect. Those routes take no space and walk the token's
    // accessible ones, so their enforcement point is the ITERATION SET. Classifying one as 'path' would
    // produce a guard that reads correctly and never fires.
    const code = read(INVENTORY);
    for (const m of code.matchAll(/area:\s*'dataQuality',\s*needs:\s*'\w+',\s*scope:\s*'(\w+)'/g)) {
      assert.equal(m[1], 'iterates',
        'a data-quality route is classified as path-scoped; those routes take no space in the URL');
    }
  });
});
