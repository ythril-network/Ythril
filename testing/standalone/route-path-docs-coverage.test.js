/**
 * Every API path named in the docs exists in a router, AND every `/api` route the code declares is named in the docs.
 *
 * The second direction was added on 2026-08-13 and did not exist before: this file checked docs -> code only, while
 * `release-gate.mjs` printed *"every API route path is documented"* beside it — a label for the opposite of what was
 * measured, on the report an owner reads before cutting a tag. Building the missing direction found eight genuinely
 * undocumented endpoints; all eight are documented now.
 *
 * Slice 3 of the pre-release documentation audit. A documented endpoint that does not exist is the
 * most expensive doc bug there is: someone writes an integration against it, gets a 404, and has
 * nothing to tell them the endpoint was never real.
 *
 * All 182 documented endpoints check out today, so this ships as a gate rather than a correction.
 *
 * ── Resolving the routes is the whole difficulty ────────────────────────────────────────────────
 *
 * A naive extractor proposed 89 findings out of 182 — roughly half the documented API — which is a
 * broken scanner, not a doc crisis. Five separate defects had to be fixed, each found by opening the
 * source rather than believing the output:
 *
 *   1. PATH-LESS composition. The whole sync API is built as `syncRouter.use(syncDocsRouter)`, with no
 *      path argument, so every `/api/sync/*` route was invisible.
 *   2. Routes declared straight on the app — `app.post('/api/admin/reload-config')` — rather than on a
 *      mounted router.
 *   3. Routers mounted at MORE THAN ONE path. `setupRouter` used to serve both `/api/setup` and `/setup`;
 *      keeping one prefix per router made every setup endpoint look missing.
 *   4. Concrete example values in the docs. `PATCH /api/spaces/research` is an example of
 *      `/api/spaces/:id`, not a different endpoint, so comparison has to be structural.
 *   5. Brace alternation shorthand: `/api/brain/spaces/:id/{memories,entities,edges,chrono}` documents
 *      four endpoints in one line.
 *
 * If this test ever fails, check it against that list before editing a doc — the most likely
 * explanation for a new failure is a routing pattern the extractor has not met yet.
 *
 * Run: node --test testing/standalone/route-path-docs-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== 'dist') walk(p, out); }
    else out.push(p);
  }
  return out;
}

const VERBS = 'get|post|put|patch|delete';
/**
 * One spelling for a path parameter, whichever convention the doc used.
 *
 * `<...>` is the third convention and it was NOT handled, which produced this file's sixth extractor
 * defect: `POST /api/<tool-name>` — the generic tool door, the shape the whole REST surface is moving to —
 * was truncated at the `<` by the character class below, normalised to `POST /api`, and reported as a
 * documented endpoint no router declares. The finding was about the extractor, not the docs, exactly as
 * this file's header warns.
 */
const norm = (p) => p
  .replace(/:[A-Za-z0-9_]+/g, ':P')
  .replace(/\{[^}]+\}/g, ':P')
  .replace(/<[^>]+>/g, ':P')
  .replace(/\/+$/, '');

function knownRoutes() {
  const files = walk(join(ROOT, 'server', 'src')).filter(f => f.endsWith('.ts'));
  const sources = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));

  // (1) mount prefixes — a router may have several.
  const prefixes = new Map();
  const addPrefix = (v, p) => {
    if (!prefixes.has(v)) prefixes.set(v, new Set());
    prefixes.get(v).add(p);
  };
  for (const m of sources.get(join(ROOT, 'server', 'src', 'app.ts')).matchAll(
    /app\.use\(\s*'([^']+)'\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) addPrefix(m[2], m[1]);

  /*
   * (1b) REGISTER FUNCTIONS: `registerUploadRoute(fileStoreRouter)` in one file, and
   * `export function registerUploadRoute(router: Router)` declaring the routes in another.
   *
   * The parameter carries the caller's prefixes. Without this the extractor sees `router.post('/:spaceId')`
   * with no prefix for `router` and the route resolves to nothing — a documented endpoint reported as
   * missing, which is the sixth extractor defect this file has had and the same shape as the other five.
   *
   * `spaces-reembed.ts` predates this and resolved anyway, by NAMING its parameter `spacesRouter` — the same
   * identifier the caller uses. That is a coincidence rather than a mechanism: renaming the variable in
   * `api/spaces.ts` would have silently dropped its route from this gate's view, with nothing to say so.
   */
  /*
   * Keyed by the DECLARING FILE, not by the parameter name — and that distinction is the whole difficulty.
   *
   * The first version added the prefix under the bare parameter name, `router`. `mcp/oauth.ts` builds its own
   * router into a local `const router` and declares `/mcp-oauth/consent` on it, so it inherited `/api/files`
   * and this gate reported `POST /api/files/mcp-oauth/consent` as an undocumented route. A name is not an
   * identity: the same one means different things in different files, which is exactly why the rest of this
   * extractor resolves module-level variables and nothing narrower.
   */
  const registrars = new Map();          // fn name -> { file, param }
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/export\s+function\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*:\s*Router\b/g)) {
      registrars.set(m[1], { file, param: m[2] });
    }
  }
  /** A prefix that applies to one identifier in one file only. */
  const scoped = (file, name) => `${file}::${name}`;

  // (2) nested mounts, both prefixed and path-less, to a fixed point.
  for (let pass = 0; pass < 5; pass++) {
    for (const src of sources.values()) {
      for (const m of src.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.use\(\s*'([^']+)'\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) {
        for (const p of prefixes.get(m[1]) ?? []) addPrefix(m[3], p + m[2]);
      }
      for (const m of src.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.use\(\s*([A-Za-z_][A-Za-z0-9_]*Router)\s*\)/g)) {
        for (const p of prefixes.get(m[1]) ?? []) addPrefix(m[2], p);
      }
      /*
       * A register function's parameter inherits the prefixes of whatever router it is handed.
       *
       * Matched by splitting on the call rather than by building a regex around the name. Inside a template
       * literal `\b`, `\s` and `\w` are not escapes — they collapse to the bare letters — so a pattern
       * assembled that way silently matches nothing, which here would look exactly like "no caller found".
       */
      for (const [fn, { file, param }] of registrars) {
        for (const piece of src.split(`${fn}(`).slice(1)) {
          const arg = piece.match(/^\s*([A-Za-z_]\w*)\s*\)/);
          if (arg) for (const p of prefixes.get(arg[1]) ?? []) addPrefix(scoped(file, param), p);
        }
      }
    }
  }

  const routes = new Set();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\.(${VERBS})\\(\\s*'([^']*)'`, 'g'))) {
      const [, v, method, path] = m;
      // Module-level prefixes, plus any that belong to this identifier IN THIS FILE — a register function's
      // parameter. Both, because a file can declare routes on an imported router and on its parameter.
      const applies = [...(prefixes.get(v) ?? []), ...(prefixes.get(scoped(file, v)) ?? [])];
      for (const prefix of applies) {
        routes.add(`${method.toUpperCase()} ${norm((prefix + (path === '/' ? '' : path)) || '/')}`);
      }
    }
    // (3) app-level routes
    for (const m of src.matchAll(new RegExp(`\\bapp\\.(${VERBS})\\(\\s*'(/[^']*)'`, 'g'))) {
      routes.add(`${m[1].toUpperCase()} ${norm(m[2])}`);
    }
  }
  return routes;
}

/** Expand `{a,b,c}` alternation into one path each. */
function expand(path) {
  const m = path.match(/\{([^}]*,[^}]*)\}/);
  if (!m) return [path];
  return m[1].split(',').flatMap(opt => expand(path.replace(m[0], opt.trim())));
}

function documentedEndpoints() {
  const out = new Map();
  // Recursive: the integration guide is 17 files under `docs/integration-guide/` now, and a one-level
  // listing would have quietly stopped scanning almost every documented endpoint in the product.
  const mdFiles = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) mdFiles(full, out);
      else if (e.name.endsWith('.md')) out.push(full);
    }
    return out;
  };
  for (const full of mdFiles(join(ROOT, 'docs'))) {
    const f = full.split(/[\\/]docs[\\/]/)[1];
    const src = readFileSync(full, 'utf8');
    const record = (verb, rawPath) => {
      for (const path of expand(rawPath)) {
        const key = `${verb} ${norm(path)}`;
        if (!out.has(key)) out.set(key, new Set());
        out.get(key).add(f);
      }
    };
    // Prose and fenced form: `POST /api/duplicates/scan`.
    // `<` and `>` are in the class because a path parameter is written three ways in these docs and this
    // was the one nobody had met: truncating at the `<` turns `/api/<tool-name>` into `/api`, which is a
    // real path and therefore a finding rather than a parse error.
    for (const m of src.matchAll(new RegExp(`\\b(GET|POST|PUT|PATCH|DELETE)\\s+(/api/[A-Za-z0-9_\\-/:{},.<>]*)`, 'g'))) {
      record(m[1], m[2]);
    }
    // TABLE form, where the verb and the path are separate cells. The adjacency pattern above cannot see it: it requires
    // whitespace between the two, and a table puts a backtick, a pipe and more backticks there.
    //
    // Found by building the REVERSE check (route → docs) and getting 33 findings, two of which were spot-checked and
    // turned out to be documented in exactly this form. Filing that count would have repeated the mistake this file's own
    // header warns about — and the one that produced a wrong customer-facing claim earlier the same day: a scanner that
    // under-detects usage manufactures findings, and a count from it is worse than no count.
    for (const m of src.matchAll(
      /\|\s*`?(GET|POST|PUT|PATCH|DELETE)`?\s*\|\s*`?(\/api\/[A-Za-z0-9_\-/:{},.<>]*)/g,
    )) {
      record(m[1], m[2]);
    }
  }
  return out;
}

/** Structural match: a route's :P matches any single documented segment. */
function matches(known, docKey) {
  if (known.has(docKey)) return true;
  const [dm, dp] = docKey.split(' ');
  const dSegs = dp.split('/');
  for (const k of known) {
    const [km, kp] = k.split(' ');
    if (km !== dm) continue;
    const kSegs = kp.split('/');
    if (kSegs.length === dSegs.length && kSegs.every((s, i) => s === ':P' || s === dSegs[i])) return true;
  }
  return false;
}

describe('documented API paths exist', () => {
  const known = knownRoutes();
  const documented = documentedEndpoints();

  it('resolves the routing table and the docs (the check itself works)', () => {
    // Without this, an extractor regression that finds nothing would make the assertion below pass by
    // examining nothing — the failure mode where a gate silently stops gating.
    assert.ok(known.size > 150, `expected to resolve the routing table, found ${known.size} routes`);
    assert.ok(documented.size > 100, `expected documented endpoints, found ${documented.size}`);
  });

  /**
   * Routes that exist and are deliberately not in the integration guide, each with the reason.
   *
   * Scoped to `/api/` on purpose: `/health`, `/ready`, `/metrics`, `/setup`, `/mcp` and the local agent's own `/v1` are
   * documented as OPERATIONS or TRANSPORT rather than as REST endpoints, and the doc extractor only recognises `/api/`
   * paths. Widening the extractor to chase them would trade a real check for a bigger one that reports noise.
   */
  const EXEMPT_UNDOCUMENTED = {};

  it('every /api route is documented SOMEWHERE — the direction the release gate claims', () => {
    // This direction did not exist. The file checked docs -> code only, while `release-gate.mjs` printed
    // "every API route path is documented" beside it — a label for the opposite of what was measured, on the report an
    // owner reads before cutting a tag.
    //
    // Building it found EIGHT genuinely undocumented endpoints: spaces/reorder, token-access, the media
    // embedding-queue pair, browse-dirs, and the three local-connector routes. All eight are documented now, so this
    // ships green rather than as a ratchet over a backlog.
    const undocumented = [...known]
      .filter(k => k.split(' ')[1]?.startsWith('/api/'))
      .filter(k => !(k in EXEMPT_UNDOCUMENTED))
      .filter(k => ![...documented.keys()].some(docKey => matches(new Set([k]), docKey)));

    assert.deepEqual(undocumented.sort(), [],
      'These routes exist and no doc names them. An integrator cannot use what they cannot find, and this is the '
      + `direction the release gate has been claiming to check:\n  ${undocumented.sort().join('\n  ')}`);
  });

  it('the reverse check is not vacuous', () => {
    // Both filters could go wrong quietly: `startsWith('/api/')` matching nothing, or `matches` returning true for
    // everything. Either would make the assertion above pass for ever while measuring nothing.
    const api = [...known].filter(k => k.split(' ')[1]?.startsWith('/api/'));
    assert.ok(api.length > 150, `expected the /api surface, found ${api.length}`);
    assert.ok(!api.some(k => matches(new Set([k]), 'GET /api/definitely-not-a-real-route')),
      'the matcher accepts a route that is documented nowhere — it is matching too loosely to detect anything');
  });

  it('every exemption carries a reason, and names a route that exists', () => {
    for (const [key, reason] of Object.entries(EXEMPT_UNDOCUMENTED)) {
      assert.ok(reason && reason.length > 30, `${key}: an exemption needs a reason, not a placeholder`);
      assert.ok(!/todo|later|for now|not yet/i.test(reason),
        `${key}: "${reason}" is a deferral, not a reason`);
      assert.ok(known.has(key), `${key} is exempted but no router declares it — a stale exemption covers nothing`);
    }
  });

  it('every documented endpoint resolves to a real route', () => {
    const missing = [...documented.entries()]
      .filter(([key]) => !matches(known, key))
      .map(([key, docs]) => `  ${key}  (in ${[...docs].join(', ')})`);

    assert.equal(missing.length, 0,
      `These endpoints are documented but no router declares them — an integration written against ` +
      `one would 404 with nothing to explain it:\n${missing.join('\n')}\n\n` +
      'Before editing a doc, check the header of this file: five separate extractor defects produced ' +
      'false findings here, and a new routing pattern is the likelier cause.');
  });
});
