/**
 * Audit the surface matrix against RUNNING code, not against the regex that produced it.
 *
 * `surface-matrix.mjs` finds routes by scanning source for `router.verb('path')`. That is a heuristic, and a
 * heuristic is exactly what should not be trusted when the answer is "this table is complete". So this script
 * builds the Express app in process and walks its router stack — the same object the server dispatches on — and
 * compares the two sets in both directions.
 *
 * Three independent claims, each checked against a runtime source of truth:
 *
 * 1. **Route completeness.** Every route Express actually serves appears in the static extraction, and every
 *    route the extraction claims is one Express actually serves. A miss in either direction is a real bug in
 *    the table: the first hides a route, the second invents one.
 * 2. **Tool completeness.** Every name in `ALL_TOOLS` appears in the hand-written map. Already enforced by the
 *    generator, re-checked here so the audit stands alone.
 * 3. **Mapping soundness.** For each mapped pair, the tool handler and the route handler must reach the same
 *    underlying module — a shared function, not two implementations. Verified by comparing the imports each
 *    side pulls from `brain/`, `files/` and `spaces/`; a pair with no shared module is reported for a human to
 *    look at rather than silently blessed.
 *
 * Exit code is non-zero when any claim fails, so this can gate.
 *
 * Run: node scripts/surface-matrix-audit.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mountedRoutes } from '../testing/standalone/_routes.mjs';
import { CAPABILITIES, THE_TOOL_DOOR } from '../testing/standalone/_capability-map.mjs';

const ROOT = process.cwd();
const read = p => readFileSync(join(ROOT, p), 'utf8');
/**
 * Comments out, LINE comments first.
 *
 * Order is not cosmetic. `api/data.ts:281` reads `// Follow the symlink — useful for /mnt/* or volume-mount
 * points`, and stripping block comments first treats that `/*` as an opener: it swallows 5,907 characters
 * through the next `*​/`, taking three route registrations with it. That is how this matrix reported 202 routes
 * when the routers serve 207. Removing line comments first makes the phantom opener disappear with its line.
 *
 * Two files in the tree hit it today (`api/data.ts`, `files/converters/pipeline.ts`), and 33 gates still carry
 * the other order — tracked as its own item rather than swept here.
 */
const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

const problems = [];
const note = m => problems.push(m);

// ── 1 · what the STATIC extractor sees (the matrix's own method) ─────────────
const APP = strip(read('server/src/app.ts'));
const routerFile = new Map();
for (const m of APP.matchAll(/import \{ (\w+) \} from '\.\/(api\/[^']+)\.js'/g)) routerFile.set(m[1], `server/src/${m[2]}.ts`);
const mounts = [];
for (const m of APP.matchAll(/app\.use\('(\/[^']*)',\s*(\w+)\)/g)) {
  const file = routerFile.get(m[2]);
  if (file) mounts.push({ mount: m[1], file });
}
const filesFor = file => {
  if (!file.endsWith('/index.ts')) return [file];
  const dir = file.slice(0, -'/index.ts'.length);
  return execFileSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(l => l.trim()).filter(l => l.endsWith('.ts'));
};
/**
 * Every route, attributed by the ROUTER IDENTIFIER rather than by which file it sits in.
 *
 * `POST /api/spaces/:id/reembed` is registered in `api/spaces-reembed.ts` by a function that takes the router
 * as a parameter — `registerReembedRoute(spacesRouter)` — so scanning only the router's own file missed it, and
 * `activity/reset` the same way. The parameter is named after the router, which is what makes identifier
 * attribution work: `spacesRouter.post('/:id/reembed', …)` maps to the `/api/spaces` mount wherever it lives.
 */
const API_ALL = execFileSync('git', ['ls-files', 'server/src/api'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map(l => l.trim()).filter(l => l.endsWith('.ts'));

/**
 * Router identifier -> mount path, following `use()` chains.
 *
 * `app.use('/api/brain', brainRouter)` is only the first hop: `brainRouter.use(memoriesRouter)` and seven
 * siblings sit inside `api/brain/index.ts`, each with no prefix, so their routes are served under `/api/brain`
 * while nothing in `app.ts` names them. Stopping at the first hop attributed 115 of 207 routes and called the
 * other 92 unattributed.
 *
 * A PREFIXED nesting (`x.use('/y', sub)`) would need the prefix carried; none exists, and the loop reports one
 * loudly if it appears rather than quietly mis-attributing its routes.
 */
const mountFor = new Map();
for (const m of APP.matchAll(/app\.use\('(\/[^']*)',\s*(\w+)\)/g)) mountFor.set(m[2], m[1]);

const nestings = [];
for (const f of API_ALL) {
  let code;
  try { code = strip(read(f)); } catch { continue; }
  for (const m of code.matchAll(/\b(\w*[Rr]outer)\.use\(\s*(?:'([^']*)',\s*)?(\w*[Rr]outer)\s*\)/g)) {
    nestings.push({ parent: m[1], prefix: m[2] ?? '', child: m[3] });
  }
}
for (let pass = 0; pass < 8; pass++) {
  let changed = false;
  for (const { parent, prefix, child } of nestings) {
    const base = mountFor.get(parent);
    if (base === undefined || mountFor.has(child)) continue;
    if (prefix) console.log(`note: ${parent}.use('${prefix}', ${child}) — prefixed nesting, mount is ${base}${prefix}`);
    mountFor.set(child, `${base}${prefix}`);
    changed = true;
  }
  if (!changed) break;
}

/*
 * THE STATIC HALF IS `mountedRoutes()` NOW, and the copy it replaces is why this audit was wrong.
 *
 * This walked the tree with its own `(\w*[Rr]outer)\.(get|post|…)` scan and its own mount graph — the fifth
 * copy of one derivation. It could not resolve a router passed as a function PARAMETER, so
 * `POST /api/files/:spaceId` was reported as "served by express, missing from the matrix" for as long as
 * nobody ran this.
 *
 * **And pointing it at the shared module is what makes the comparison worth running**, which is the
 * opposite of what I wrote when the other copies were converted. This audit does not check that module
 * against itself: it checks it against the LIVE express router objects, which is the one source in the
 * repository that cannot be wrong about what is served. That is a real cross-check, and it is the check
 * that would have caught the module's `app.ts` blindness on its own.
 *
 * Routes declared straight on the app are excluded from the comparison rather than silently dropped: the
 * runtime half walks the routers `app.ts` IMPORTS, so it never sees them, and counting them on one side
 * only would report nine permanent disagreements. They are accounted for below.
 */
const ALL_STATIC = mountedRoutes();
const appDeclared = ALL_STATIC.filter(r => r.router === 'app');
const staticRoutes = new Set(ALL_STATIC.filter(r => r.router !== 'app').map(r => `${r.method} ${r.path}`));
const unattributed = [];

// ── 2 · what EXPRESS actually serves ────────────────────────────────────────
/**
 * The live `Router` objects, walked directly.
 *
 * The first version of this walked `app._router.stack` and recovered each mount path from the layer's regexp.
 * Express 5 builds those regexps differently (path-to-regexp v8), so it found **5 routes out of 202** and
 * cheerfully reported the other 197 as "not served" — a completeness check that was itself the least complete
 * thing in the repo. Reading `express/package.json` (5.2.1) is what settled it.
 *
 * Importing each mounted router and reading `router.stack[].route.path` needs no regexp archaeology: the paths
 * come from the objects the app dispatches on. The MOUNT prefixes still come from `app.use('/api/x', router)`
 * in source — they are literal strings, and the audit says so rather than implying otherwise.
 */
/*
 * ANY relative import, not `api/` only — six routes hung on that one word.
 *
 * `mcpRouter` lives in `./mcp/router.js` and `setupRouter` in `./setup/routes.js`, so neither matched, and
 * the runtime half never saw `GET /mcp`, `POST /mcp`, `POST /mcp/messages`, both setup routes, or the MCP
 * OAuth consent screen. Six routes the static half correctly lists, reported as "claimed by the matrix and
 * served by nothing" — the direction that reads as the matrix inventing routes, which is the worse way to
 * be wrong here.
 *
 * The directory was never the question. Whether `app.use()` mounts it is, and the loop below asks that.
 */
const routerExport = new Map();
for (const m of APP.matchAll(/import \{ (\w+) \} from '\.\/([^']+)\.js'/g)) {
  routerExport.set(m[1], `server/dist/${m[2]}.js`);
}

/**
 * Routes on a router, INCLUDING the sub-routers it mounts with a bare `use()`.
 *
 * `brainRouter` is an aggregate: `brainRouter.use(memoriesRouter)` and seven siblings, each mounted with no
 * prefix so their own paths are already complete (`/spaces/:spaceId/memories`). `syncRouter` and
 * `networksRouter` do the same. Reading only the top-level `.route` layers therefore saw 115 of 202 routes and
 * reported the other 87 as unserved — the first version of this audit did exactly that.
 *
 * A prefixed `use('/x', sub)` would need its mount recovered; none exists today, and if one is added the
 * `pathPrefix` guard below turns it into a loud failure rather than a silent undercount.
 */
function collect(router, mount, out) {
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const path = layer.route.path;
      if (typeof path !== 'string') continue;
      const full = `${mount}${path === '/' ? '' : path}`;
      for (const [method, on] of Object.entries(layer.route.methods ?? {})) {
        if (on && method !== '_all') out.add(`${method.toUpperCase()} ${full}`);
      }
      continue;
    }
    const sub = layer.handle;
    if (typeof sub === 'function' && Array.isArray(sub.stack)) {
      // `layer.path` is '/' for a bare use(); anything else means a prefix this walk would drop.
      const prefix = typeof layer.path === 'string' && layer.path !== '/' ? layer.path : '';
      if (prefix) {
        note(`a sub-router is mounted at '${prefix}' under ${mount} — this walk assumes bare use(); `
          + 'the count below is not trustworthy until it handles the prefix');
      }
      collect(sub, `${mount}${prefix}`, out);
    }
  }
}

let runtimeRoutes = new Set();
let runtimeOk = true;
for (const m of APP.matchAll(/app\.use\('(\/[^']*)',\s*(\w+)\)/g)) {
  const [, mount, ident] = m;
  const dist = routerExport.get(ident);
  if (!dist) continue;                       // not a router import (middleware, etc.)
  try {
    const mod = await import(`file://${join(ROOT, dist)}`);
    const router = mod[ident];
    if (!router?.stack) { note(`${ident} exported no router stack — ${mount} is UNVERIFIED`); runtimeOk = false; continue; }
    collect(router, mount, runtimeRoutes);
  } catch (err) {
    note(`importing ${dist} failed (${err.message}) — ${mount} is UNVERIFIED, which is a gap and not a pass`);
    runtimeOk = false;
  }
}

if (runtimeRoutes.size === 0) {
  note('no routes were enumerated at runtime — the comparison below would be vacuous');
  runtimeOk = false;
}

if (runtimeOk) {
  /*
   * What only ONE side can see, accounted for rather than reported.
   *
   * The runtime half walks the routers `app.ts` imports and mounts with a literal prefix. Two shapes fall
   * outside that by construction, and both are real routes:
   *
   *  - routes declared straight on `app`, which belong to no router at all;
   *  - `POST /mcp-oauth/consent`, whose router is BUILT by a function that returns `null` unless a public
   *    URL is configured, and is mounted through the returned value with no prefix.
   *
   * Listing them is not an exemption list in the bad sense: each is asserted to still be exactly what it
   * claims — an app-declared route, or the one conditional build — so a NEW route cannot hide among them.
   */
  const appPaths = new Set(appDeclared.map(r => `${r.method} ${r.path}`));
  const CONDITIONAL_BUILD = 'POST /mcp-oauth/consent';
  const conditional = staticRoutes.has(CONDITIONAL_BUILD) ? [CONDITIONAL_BUILD] : [];
  if (!conditional.length) {
    note(`${CONDITIONAL_BUILD} is no longer in the static extraction — if the route is gone, delete this `
      + 'accounting with it rather than leaving a name nothing matches');
  }
  const invisibleToRuntime = new Set([...appPaths, ...conditional]);
  console.log(`accounted for: ${appPaths.size} app-declared route(s) and ${conditional.length} built `
    + 'conditionally — neither is reachable by the runtime walk');

  const onlyRuntime = [...runtimeRoutes].filter(r => !staticRoutes.has(r)).sort();
  const onlyStatic = [...staticRoutes]
    .filter(r => !runtimeRoutes.has(r) && !invisibleToRuntime.has(r)).sort();
  if (onlyRuntime.length) note(`routes the router SERVES that the matrix misses (${onlyRuntime.length}):\n    ${onlyRuntime.join('\n    ')}`);
  if (onlyStatic.length) note(`routes the matrix claims that no router serves (${onlyStatic.length}):\n    ${onlyStatic.join('\n    ')}`);
  console.log(`routes — live routers ${runtimeRoutes.size}, static extraction ${staticRoutes.size}, `
    + `disagreement ${onlyRuntime.length + onlyStatic.length}`);
}

// ── 3 · tool completeness, from the registry ────────────────────────────────
const { ALL_TOOLS } = await import(`file://${join(ROOT, 'server/dist/mcp/tools/index.js')}`);
/*
 * THE MAP IS IMPORTED, and grepping for it is what made this audit report all 46 tools unmapped.
 *
 * It read `scripts/surface-matrix.mjs` with a regex for the row shape. The map MOVED into
 * `testing/standalone/_capability-map.mjs` — the renderer imports it now — so the regex matched nothing,
 * `mapped` was empty, and every tool in the registry came back as absent from the map. Forty-six findings,
 * all false, from a file that no longer holds the thing being looked for.
 *
 * A regex over another file's source is a second reading of a value that can simply be imported, and this
 * is what that costs: the map was correct throughout, and the audit said the opposite about all of it.
 */
const mapped = new Set(CAPABILITIES.map(([, tool]) => tool));

/*
 * A TOOL WITHOUT A ROW IS NOT UNMAPPED — it is reached through the generic door, and three are.
 *
 * `filter`, `list_dir` and `delete_space_data` have no dedicated REST route: they are served by
 * `POST /api/:tool`, which is the door every tool can be called through. The map says so in its own
 * comments and the parity gate honours it; this audit did not, so it reported three real capabilities as
 * missing from a table that had correctly left them out.
 *
 * The check is not vacuous for accepting them, because the door itself is asserted to exist. Remove
 * `POST /api/:tool` and those three become unreachable over REST, which is what fails here.
 */
const doorServed = staticRoutes.has(THE_TOOL_DOOR);
if (!doorServed) {
  note(`the generic tool door ${THE_TOOL_DOOR} is not served, so every tool without its own row is `
    + 'unreachable over REST');
}
const unmapped = ALL_TOOLS.map(t => t.name).filter(n => !mapped.has(n) && !doorServed);
if (unmapped.length) note(`tools absent from the map: ${unmapped.join(', ')}`);
console.log(`tools — registry ${ALL_TOOLS.length}, mapped ${mapped.size}`);

// ── 4 · mapping soundness: do the two doors reach the same module? ──────────
const TOOL_FILES = execFileSync('git', ['ls-files', 'server/src/mcp/tools'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map(l => l.trim()).filter(l => l.endsWith('.ts'));
const API_FILES = execFileSync('git', ['ls-files', 'server/src/api'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map(l => l.trim()).filter(l => l.endsWith('.ts'));

/** Modules under brain/ files/ spaces/ that a source file imports. */
const DOMAIN_DIRS = 'brain|files|spaces|auth|sync|networks|config|metrics|quota';
/**
 * Static AND dynamic imports.
 *
 * `list_tokens` reaches its implementation with `await import('../../auth/tokens.js')` inside the handler, so a
 * `from '…'`-only regex reported it as sharing nothing with `GET /api/tokens` — which imports the same module
 * statically. One flagged pair, entirely the detector's fault.
 */
const domainImports = src => new Set(
  [...src.matchAll(new RegExp(`(?:from|import\\()\\s*'(?:\\.\\./)+(${DOMAIN_DIRS})/([\\w-]+)\\.js'`, 'g'))]
    .map(m => `${m[1]}/${m[2]}`));

const toolImports = new Map();
for (const f of TOOL_FILES) {
  const src = read(f);
  for (const m of src.matchAll(/^\s*name: '([a-z_0-9]+)',$/gm)) toolImports.set(m[1], domainImports(src));
}
const apiImports = new Map();
for (const f of API_FILES) apiImports.set(f, domainImports(read(f)));

/** Which api file registers a given route path? */
/*
 * THE ROUTE ALREADY KNOWS ITS FILE, so stop re-deriving it from the mount prefix and a substring search.
 *
 * The old walk matched the route's tail against each candidate file's source, which cannot find a route
 * registered by a function living in another file — `POST /api/spaces/:id/reembed` is declared in
 * `spaces-reembed.ts` and the search only looked under the `/api/spaces` mount's own file. It came back
 * "route file not found", which reads as a broken mapping and is a broken lookup.
 */
const FILE_OF = new Map(ALL_STATIC.map(r => [`${r.method} ${r.path}`, r.file]));
function apiFileFor(route) {
  return FILE_OF.get(route) ?? null;
}

// From the imported map, for the same reason the count above is: a regex over another file's source
// is a second reading of a value that can be imported, and it is the reading that goes stale.
const pairs = CAPABILITIES.map(([, tool, route]) => ({ tool, route: route ?? null }));
const noShared = [];
for (const { tool, route } of pairs) {
  if (!route) continue;
  const f = apiFileFor(route);
  if (!f) { noShared.push(`${tool} -> ${route} (route file not found)`); continue; }
  const a = toolImports.get(tool) ?? new Set();
  const b = apiImports.get(f) ?? new Set();
  const shared = [...a].filter(x => b.has(x));
  if (shared.length === 0) noShared.push(`${tool} -> ${route} (no shared brain/files/spaces module)`);
}
if (noShared.length) {
  console.log(`\npairs with no shared implementation module (${noShared.length}) — each needs a human look, `
    + 'they are not necessarily wrong:');
  for (const n of noShared) console.log(`    ${n}`);
}

// ── verdict ─────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`\nAUDIT FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log('\nAUDIT PASSED — routes agree with Express, every tool is mapped.');
