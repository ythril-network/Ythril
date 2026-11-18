/**
 * What an integrator can call, and what the documentation says about it: the one reader the four docs-surface probes share.
 *
 * ## What it prevents
 *
 * `check-i-docs-parameters-listed`, `-response-fields-listed`, `-userguide-half-present` and `-pages-and-nav-complete` each need the same
 * two halves: the surface as the CODE declares it (the REST routes the server mounts with the keys each accepts and the keys each success
 * answer carries; the MCP tools with their input-schema properties) and the pages that talk about it. Written four times, one probe would
 * read a smaller surface than the others and report clean about the difference. Here the surface is read once, from the code, and every
 * probe asks its own question of it.
 *
 * ## Where the surface comes from, never a list in this file
 *
 *  - Routes: `mountedRoutesWithSource()` (every route the server mounts, the `app` ones included) and `routeAcceptKeys()`, the readers the
 *    parity gates already use. A route whose accepted keys cannot be read comes back `unresolved` WITH its reason and is counted in the verdict,
 *    never taken for a route that accepts nothing.
 *  - Tools: `ALL_TOOLS` in the built `server/dist` (the same registry the dispatcher serves). A missing or stale build throws `CannotAnswer`.
 *  - Pages: the tracked `docs/**` markdown, listed through `readTrackedSources` (its floor is inside).
 *
 * ## What "a page names a route" means
 *
 * The integration guide writes a route as `METHOD /api/path/:param`. Parameter names differ between the guide and the code (`:id` against
 * `:spaceId`), so both sides are read with every `:name` collapsed to `:`. A page "names" a route when it prints that method and path.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readTrackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { staleBuilds } from '../../testing/_shared/stale-build.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { mountedRoutesWithSource } from '../../testing/standalone/_routes.mjs';
import { routeAcceptKeys } from '../../testing/standalone/_route-accept-keys.mjs';
import { argumentsOf } from '../../testing/standalone/_structural-window.mjs';
import { CannotAnswer } from './_verdict.mjs';

/** The integration guide's parts, read: `[{ file, text }]`. */
export const guideParts = () => readTrackedSources(['docs/integration-guide'], { ext: ['.md'], floor: 30 });

/** The user guide's parts, read: `[{ file, text }]`. */
export const userguideParts = () => readTrackedSources(['docs/userguide'], { ext: ['.md'], floor: 5 });

/** A route path with every `:name` collapsed, the trailing punctuation a sentence adds and the trailing slash dropped. */
export const normalPath = (p) => p.replace(/:[A-Za-z]+/g, ':').replace(/[.,;)]+$/, '').replace(/\/+$/, '') || '/';

/** Built fresh per use: a shared global regex keeps its position between pages. */
const namedRouteRe = () => /\b(GET|POST|PUT|PATCH|DELETE)\b[`\s|]+(\/[A-Za-z0-9_:/.{}*-]*)/g;

/** The shortened form the guide uses once a page has named the full path: `POST …/chrono` (or `...`). Built fresh per use. */
const shortRouteRe = () => /\b(GET|POST|PUT|PATCH|DELETE)\b[`\s|]+(?:…|\.\.\.)(\/[A-Za-z0-9_:/.-]*)/g;

/**
 * `Map<'METHOD /normal/path', Set<file>>`: the pages that print each route, whole. A route printed in the shortened form is under
 * `'METHOD …/tail'` and is reached through {@link pagesNamingRoute}.
 */
export function pagesNamingRoutes(parts) {
  const named = new Map();
  const add = (k, file) => { if (!named.has(k)) named.set(k, new Set()); named.get(k).add(file); };
  for (const { file, text } of parts) {
    for (const m of text.matchAll(namedRouteRe())) add(`${m[1]} ${normalPath(m[2])}`, file);
    for (const m of text.matchAll(shortRouteRe())) add(`${m[1]} …${normalPath(m[2])}`, file);
  }
  return named;
}

/** The pages that print a route: whole, or in the shortened form whose tail the route's path ends with. A `Set<file>`, empty when none does. */
export function pagesNamingRoute(named, method, path) {
  const full = `${method.toUpperCase()} ${normalPath(path)}`;
  const files = new Set(named.get(full) ?? []);
  const prefix = `${method.toUpperCase()} …`;
  for (const [k, v] of named) {
    if (k.startsWith(prefix) && full.endsWith(k.slice(prefix.length))) for (const f of v) files.add(f);
  }
  return files;
}

/** Whether `text` prints `name` as a word of its own: not a part of a longer identifier. Case matters (`ttlDays` is not `TTLDAYS`). */
export const printsName = (text, name) => new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`).test(text);

/** The text of the parts a set of file names picks. */
export const textOf = (parts, files) => parts.filter(p => files.has(p.file)).map(p => p.text).join('\n');

/** The server's build, or `CannotAnswer`: a probe that reads `server/dist` answers about a stale build as if it were the code. */
export async function fromDist(rel) {
  const stale = staleBuilds(REPO_ROOT);
  if (stale.length) throw new CannotAnswer(stale[0]);
  return import(pathToFileURL(join(REPO_ROOT, 'server/dist', rel)).href);
}

/**
 * The key sets the route reader cannot see from inside a route file, from the build: the exported field lists and the zod bodies declared in
 * the spaces and networks modules. Supplied, never guessed (`a-tool-and-its-route-take-the-same-parameters` builds the same sets).
 */
export async function exportedKeySets() {
  const { trackedSources } = await import('../../testing/standalone/_sources.mjs');
  const query = await fromDist('brain/query.js');
  const bodySchemas = await fromDist('spaces/body-schemas.js');
  const networkActs = Object.assign({}, ...await Promise.all(trackedSources(['server/src/networks/*.ts'], { floor: 3 })
    .map(f => fromDist(f.replace('server/src/', '').replace(/\.ts$/, '.js')))));
  const sets = {
    QUERY_BODY_FIELDS: query.QUERY_BODY_FIELDS,
    TRAVERSE_BODY_FIELDS: query.TRAVERSE_BODY_FIELDS,
    FIND_SIMILAR_BODY_FIELDS: query.FIND_SIMILAR_BODY_FIELDS,
  };
  for (const [name, v] of [...Object.entries(bodySchemas), ...Object.entries(networkActs)]) {
    const shape = v?.shape ?? v?._def?.schema?.shape;
    if (shape) sets[name] = Object.keys(shape);
  }
  return sets;
}

/**
 * Every REST route with what it accepts: `[{ method, route, keys, queryKeys }]` (readable) and `[{ method, route, unresolved }]` (named, never
 * taken for "accepts nothing").
 */
export async function restSurface() {
  return routeAcceptKeys({ exportedSets: await exportedKeySets() });
}

/** Every MCP tool with the properties its input schema declares: `[{ name, keys }]`. */
export async function toolSurface() {
  const { ALL_TOOLS } = await fromDist('mcp/tools/index.js');
  // A tool's `inputSchema` is a function of the space schemas the dispatcher injects (`ToolSchemas`); the `space` property's own shape is not asked here.
  const spaceProperty = { type: 'string' };
  const schemas = { requiredSpace: spaceProperty, optionalSpace: spaceProperty };
  const tools = ALL_TOOLS.map(t => ({
    name: t.name,
    keys: Object.keys((typeof t.inputSchema === 'function' ? t.inputSchema(schemas) : t.inputSchema)?.properties ?? {}),
  }));
  const withKeys = tools.filter(t => t.keys.length).length;
  // A reader that finds no parameters on most tools has read the wrong thing, and every probe over it would hold about nothing.
  if (tools.length < 25 || withKeys < tools.length * 0.6) {
    throw new CannotAnswer(`${tools.length} MCP tools read from server/dist, ${withKeys} with input properties: the registry was not read`);
  }
  return tools;
}

/** The top-level keys of an object literal `{ ... }`, and whether a spread (whose keys are not written here) was in it. */
export function literalKeys(literal) {
  const keys = [];
  let spread = false;
  for (const member of argumentsOf(literal, 0, 'a response literal').map(s => s.trim()).filter(Boolean)) {
    if (member.startsWith('...')) { spread = true; continue; }
    const m = /^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))/.exec(member);
    if (m) keys.push(m[1] ?? m[2]);
  }
  return { keys, spread };
}

/**
 * The keys a route's success answers carry where the handler writes them as a literal: `res.json({ a, b: 1 })` and `res.status(2xx).json({ ... })`.
 * An error status (400 and up) is left out: the error body is documented once, on the errors page. `{ keys, opaque }`: `opaque` counts the
 * success answers whose body is not a literal here (`res.json(result)`) or has a spread, so a caller names them and never counts them as clean.
 */
export function successAnswerKeys(handlerSource) {
  const src = stripComments(handlerSource);
  const keys = new Set();
  let opaque = 0;
  for (const m of src.matchAll(/\bres\s*(?:\.\s*status\(\s*(\d+)\s*\)\s*)?\.\s*json\(\s*/g)) {
    if (m[1] && Number(m[1]) >= 400) continue;
    const open = m.index + m[0].lastIndexOf('(');
    const first = (argumentsOf(src, open, 'res.json')[0] ?? '').trim();
    if (!first.startsWith('{')) { opaque++; continue; }
    const lit = literalKeys(first);
    for (const k of lit.keys) keys.add(k);
    if (lit.spread) opaque++;
  }
  return { keys: [...keys], opaque };
}

/** Every mounted route with the source of its handler: `[{ method, path, source, file }]`. */
export const routesWithSource = () => mountedRoutesWithSource();

/**
 * An allow list is data the probe reads (`<check>.allow.json` beside it): `[{ key, reason, reviewBy }]`. A problem with it is a message, `null` when
 * every entry is whole: a key, a reason, a `YYYY-MM-DD` review date that has not passed. `today` is `YYYY-MM-DD`.
 */
export function allowProblem(allow, today) {
  if (!Array.isArray(allow)) return 'the allow list is not an array';
  for (const e of allow) {
    if (!e?.key || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy ?? '')) return `an exception needs its key, a reason and a reviewBy date: ${JSON.stringify(e)}`;
    if (e.reviewBy < today) return `the exception for "${e.key}" is past its reviewBy date ${e.reviewBy}: review it, then move the date`;
  }
  return null;
}

/** The allow list beside a probe, read: `import.meta.url` of the probe, its check name. */
export function readAllowFile(metaUrl, check) {
  const file = join(dirname(fileURLToPath(metaUrl)), `${check}.allow.json`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new CannotAnswer(`${file} unreadable: ${e.message}`); }
}

/** One line a verdict ends with, saying how many exceptions the run used. */
export const exceptionTail = (used, total) => `${used} of ${total} exception(s) used`;
