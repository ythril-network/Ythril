/**
 * The capability × surface matrix.
 *
 * Rows are CAPABILITIES — one MCP tool and the REST route that does the same thing — because that is the pair
 * the owner's parity rule is about. Every mapped route is verified to EXIST in the extracted route set, and
 * every tool is verified to exist in `ALL_TOOLS`: an unresolvable row throws rather than being published,
 * because a reference nobody can trust is worse than no reference.
 *
 * A second table lists the REST routes no tool covers, so the REST-only surface is visible rather than implied.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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

// ── routes, as before ───────────────────────────────────────────────────────
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

const routes = new Set();
const routeArea = new Map();
const unattributed = [];
for (const f of API_ALL) {
  let code;
  try { code = strip(read(f)); } catch { continue; }
  for (const m of code.matchAll(/\b(\w*[Rr]outer)\.(get|post|patch|put|delete)\(\s*'(\/[^']*)'/g)) {
    const mount = mountFor.get(m[1]);
    if (!mount) { unattributed.push(`${f}: ${m[1]}.${m[2]}('${m[3]}')`); continue; }
    const key = `${m[2].toUpperCase()} ${mount}${m[3] === '/' ? '' : m[3]}`;
    routes.add(key);
    routeArea.set(key, mount);
  }
}
if (unattributed.length) {
  console.error(`route registrations on an unknown router (${unattributed.length}) — the table is INCOMPLETE:`);
  for (const u of unattributed) console.error(`    ${u}`);
  process.exit(1);
}

const { ALL_TOOLS } = await import(`file://${join(ROOT, 'server/dist/mcp/tools/index.js')}`);
const tools = new Set(ALL_TOOLS.map(t => t.name));
const { ROUTE_RIGHTS, NOT_AREA_SCOPED } = await import(`file://${join(ROOT, 'server/dist/auth/space-rights.js')}`);

/** `METHOD route` -> the rung a token needs, from the rights matrix that actually gates the request. */
const RUNG = new Map(ROUTE_RIGHTS.map(r => [`${r.method} ${r.route}`, r.needs]));
const AREA_OF = new Map(ROUTE_RIGHTS.map(r => [`${r.method} ${r.route}`, r.area]));
const EXEMPT_ROUTES = new Set(NOT_AREA_SCOPED.map(r => r.route));

/**
 * What a TOKEN needs, per door.
 *
 * REST comes from `ROUTE_RIGHTS` — the per-space area and rung the middleware enforces. MCP has a coarser gate:
 * `mutating` tools are hidden from a read-only token and `admin` tools from a non-admin one, which maps onto the
 * same three rungs. Reporting both is the point: a tool hidden from a token whose REST route would have accepted
 * it (or the reverse) is a real asymmetry, and it is invisible unless the two are put side by side.
 */
const toolRung = t => (t.admin ? 'admin' : t.mutating ? 'write' : 'read');

// ── the mapping, by hand and verified ───────────────────────────────────────
// `null` REST means the capability exists on MCP only; a note says why.
const MAP = [
  ['Brain — memories', 'save_fact', 'POST /api/brain/spaces/:spaceId/memories'],
  ['Brain — memories', 'update_fact', 'PATCH /api/brain/spaces/:spaceId/memories/:id'],
  ['Brain — memories', 'delete_fact', 'DELETE /api/brain/spaces/:spaceId/memories/:id'],
  ['Brain — entities', 'save_entity', 'POST /api/brain/spaces/:spaceId/entities'],
  ['Brain — entities', 'update_entity', 'PATCH /api/brain/spaces/:spaceId/entities/:id'],
  ['Brain — entities', 'delete_entity', 'DELETE /api/brain/spaces/:spaceId/entities/:id'],
  ['Brain — entities', 'graph_merge', 'POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId'],
  ['Brain — edges', 'save_edge', 'POST /api/brain/spaces/:spaceId/edges'],
  ['Brain — edges', 'update_edge', 'PATCH /api/brain/spaces/:spaceId/edges/:id'],
  ['Brain — edges', 'delete_edge', 'DELETE /api/brain/spaces/:spaceId/edges/:id'],
  ['Brain — chrono', 'save_chrono', 'POST /api/brain/spaces/:spaceId/chrono'],
  ['Brain — chrono', 'update_chrono', 'PATCH /api/brain/spaces/:spaceId/chrono/:id'],
  ['Brain — chrono', 'delete_chrono', 'DELETE /api/brain/spaces/:spaceId/chrono/:id'],
  ['Brain — search', 'recall', 'POST /api/brain/spaces/:spaceId/recall'],
  ['Brain — search', 'query', 'POST /api/brain/spaces/:spaceId/query'],
  ['Brain — search', 'find_similar', 'POST /api/brain/spaces/:spaceId/find-similar'],
  ['Brain — search', 'graph_traverse', 'POST /api/brain/spaces/:spaceId/traverse'],
  ['Brain — bulk', 'save_bulk', 'POST /api/brain/spaces/:spaceId/bulk'],
  ['Brain — ops', 'space_stats', 'GET /api/brain/spaces/:spaceId/stats'],
  ['Brain — ops', 'space_reindex', 'POST /api/brain/spaces/:spaceId/reindex'],
  ['Brain — ops', 'list_embed_jobs', 'GET /api/brain/spaces/:spaceId/embedding-queue/records'],
  ['Brain — ops', 'retry_embed_record', 'POST /api/brain/spaces/:spaceId/embedding-queue/records/retry'],
  ['Brain — ops', 'retry_failed_embeddings', 'POST /api/brain/spaces/:spaceId/embedding-queue/retry-failed'],
  ['Files', 'read_file', 'GET /api/files/:spaceId'],
  ['Files', 'write_file', 'POST /api/files/:spaceId'],
  ['Files', 'delete_file', 'DELETE /api/files/:spaceId'],
  ['Files', 'move_file', 'PATCH /api/files/:spaceId'],
  ['Files', 'list_dir', 'GET /api/files/:spaceId'],
  ['Files', 'create_dir', 'POST /api/files/:spaceId/mkdir'],
  ['Files', 'retry_embed_file', 'POST /api/files/:spaceId/retry_embedding'],
  ['Files', 'update_file_meta', 'PATCH /api/brain/spaces/:spaceId/files'],
  ['Spaces', 'list_spaces', 'GET /api/spaces'],
  ['Spaces', 'save_space', 'POST /api/spaces'],
  ['Spaces', 'update_space', 'PATCH /api/spaces/:id'],
  ['Spaces', 'space_meta', 'GET /api/spaces/:id/meta'],
  ['Spaces', 'schema_update', 'PUT /api/spaces/:id/schema'],
  ['Spaces', 'delete_space_data', null, 'MCP wipes every collection in one call; REST has one DELETE per collection '
    + '(`/memories`, `/entities`, `/edges`, `/chrono`), so the composite is MCP-only.'],
  ['Tokens', 'list_tokens', 'GET /api/tokens'],
  ['Networks / sync', 'network_peers', 'GET /api/networks'],
  ['Networks / sync', 'network_sync', 'POST /api/networks/:id/sync'],
  ['Meta', 'help', null, 'Self-documenting guide for tool callers. Its REST counterpart is the integration '
    + 'guide itself, which is why there is no route.'],
];

const missingTools = MAP.map(r => r[1]).filter(t => !tools.has(t));
if (missingTools.length) throw new Error(`mapped tools that do not exist: ${missingTools.join(', ')}`);
const missingRoutes = MAP.map(r => r[2]).filter(r => r && !routes.has(r));
if (missingRoutes.length) throw new Error(`mapped routes that do not exist: ${missingRoutes.join(' | ')}`);
const unmapped = [...tools].filter(t => !MAP.some(r => r[1] === t)).sort();
if (unmapped.length) throw new Error(`tools missing from the map: ${unmapped.join(', ')}`);

// ── doc corpora ─────────────────────────────────────────────────────────────
const corpus = dir => execFileSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map(l => l.trim()).filter(l => l.endsWith('.md')).map(f => ({ f, text: read(f) }));
const GUIDE = corpus('docs/integration-guide');
const USER = corpus('docs/userguide');
const CHANGELOG = [{ f: 'CHANGELOG.md', text: read('CHANGELOG.md') }];
const ARCHIVE = corpus('changelog');

const short = f => f.split('/').pop().replace(/\.md$/, '');
/** Files in `list` naming either the tool or the route tail. */
function hits(list, tool, route) {
  const tail = route ? route.split(' ')[1].replace(/^\/api\//, '') : null;
  const loose = tail ? new RegExp(tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\\?\w+/g, '[^/\\s)`"\']+')) : null;
  const byName = new RegExp(`\\b${tool}\\b`);
  const out = [];
  for (const { f, text } of list) if (byName.test(text) || (loose && loose.test(text))) out.push(short(f));
  return out;
}

const rows = MAP.map(([area, tool, route, note]) => {
  const t = ALL_TOOLS.find(x => x.name === tool);
  const mcpRung = toolRung(t);
  const restRung = route ? (RUNG.get(route) ?? (EXEMPT_ROUTES.has(route.split(' ').slice(1).join(' ')) ? 'exempt' : null)) : null;
  return {
    area, tool, route, note, mcpRung, restRung,
    restArea: route ? (AREA_OF.get(route) ?? null) : null,
    guide: hits(GUIDE, tool, route),
    user: hits(USER, tool, route),
    changelog: hits(CHANGELOG, tool, route).length > 0 || hits(ARCHIVE, tool, route).length > 0,
  };
});

const cell = a => (a.length ? a.join(', ') : '**—**');

/**
 * One cell for the token requirement.
 *
 * `read` / `write` / `admin` when both doors agree — the common case, and what a reader wants at a glance. When
 * they differ, BOTH are named with the door, because that difference is the interesting thing: it means the same
 * capability is reachable by tokens of different strength depending on which client you happen to hold.
 */
function rungCell(r) {
  if (!r.route) return `${r.mcpRung} (MCP)`;
  // The per-space rights matrix governs SPACE-scoped areas. `/api/spaces`, `/api/tokens` and `/api/networks`
  // are instance-level and deliberately outside it, so 'no row' there is the design rather than a gap.
  if (r.restRung === null) return `${r.mcpRung} (MCP) · instance-level`;
  if (r.restRung === 'exempt') return `${r.mcpRung} (MCP) · REST exempt`;
  const area = r.restArea ? ` \`${r.restArea}\`` : '';
  if (r.restRung === r.mcpRung) return `${r.restRung}${area}`;
  return `**REST ${r.restRung}${area} · MCP ${r.mcpRung}**`;
}

const out = [];
out.push('| capability | MCP tool | REST route | token needs | integration guide | userguide | CHANGELOG |');
out.push('|---|---|---|---|---|---|---|');
let area = null;
for (const r of rows) {
  if (r.area !== area) { area = r.area; out.push(`| **${area}** | | | | | | |`); }
  out.push(`| | \`${r.tool}\` | ${r.route ? `\`${r.route}\`` : '**MCP only**'} | ${rungCell(r)} `
    + `| ${cell(r.guide)} | ${cell(r.user)} | ${r.changelog ? 'y' : '**—**'} |`);
}

// ── REST routes no tool covers ──────────────────────────────────────────────
const mappedRoutes = new Set(MAP.map(r => r[2]).filter(Boolean));
const restOnly = [...routes].filter(r => !mappedRoutes.has(r)).sort();
const byArea = new Map();
for (const r of restOnly) {
  const a = routeArea.get(r) ?? '?';
  byArea.set(a, [...(byArea.get(a) ?? []), r]);
}
const rest = [];
rest.push('| mount | routes with no MCP tool | count |');
rest.push('|---|---|---|');
for (const [a, list] of [...byArea].sort((x, y) => y[1].length - x[1].length)) {
  rest.push(`| \`${a}\` | ${list.map(r => `\`${r.split(' ')[0]} ${r.split(' ')[1].slice(a.length) || '/'}\``).join(' ')} | ${list.length} |`);
}

writeFileSync(join(ROOT, 'todo/_matrix-capabilities.md'), out.join('\n'), 'utf8');

/**
 * The PUBLISHED table: capability, both doors, and the token level. No doc columns.
 *
 * An integrator cannot act on "which of our files mentions this" — that is our bookkeeping, and publishing it
 * would also publish a `—` that means "our name-matcher missed it", which reads as a gap that is not there.
 * What they can act on is: does this exist on my door, and what does my token need.
 */
const pub = [];
pub.push('| capability | MCP tool | REST route | token needs |');
pub.push('|---|---|---|---|');
let pubArea = null;
for (const r of rows) {
  if (r.area !== pubArea) { pubArea = r.area; pub.push(`| **${pubArea}** | | | |`); }
  pub.push(`| | \`${r.tool}\` | ${r.route ? `\`${r.route}\`` : '**MCP only**'} | ${rungCell(r)} |`);
}
writeFileSync(join(ROOT, 'todo/_matrix-published.md'), pub.join('\n'), 'utf8');
writeFileSync(join(ROOT, 'todo/_matrix-rest-only.md'), rest.join('\n'), 'utf8');
const rungMismatch = rows.filter(r => r.route && r.restRung && r.restRung !== 'exempt' && r.restRung !== r.mcpRung);
const noRightsRow = rows.filter(r => r.route && r.restRung === null);
console.log(JSON.stringify({
  capabilities: rows.length, routes: routes.size, restOnly: restOnly.length,
  noGuide: rows.filter(r => !r.guide.length).length,
  noUser: rows.filter(r => !r.user.length).length,
  noChangelog: rows.filter(r => !r.changelog).length,
  rungMismatch: rungMismatch.map(r => `${r.tool}: REST ${r.restRung} vs MCP ${r.mcpRung}`),
  noRightsRow: noRightsRow.map(r => `${r.tool} -> ${r.route}`),
}));
