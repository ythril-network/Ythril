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
import { mountedRoutes } from '../testing/standalone/_routes.mjs';
import { CAPABILITIES } from '../testing/standalone/_capability-map.mjs';

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

/*
 * The routes come from `mountedRoutes`, not from a fourth copy of the mount resolution.
 *
 * THIS SCRIPT HAD ITS OWN, AND IT HAD BEEN FAILING SINCE 2026-08-14 — a month of `todo/_matrix-published.md`
 * sitting there looking current while the generator refused to write it. The refusal was correct and it was
 * also invisible: nothing runs this in CI, so an abort and a success look identical to anyone who only ever
 * reads the output file.
 *
 * What it could not resolve was `registerUploadRoute(router: Router)` — a route registered inside a
 * function names its PARAMETER, and the copy here only understood `xRouter.use(...)` chains. That is
 * exactly the case `routerMounts` was extracted for, one module down.
 *
 * So the copy is gone. The shared module throws below a floor rather than returning a short list, which is
 * the guard a hand-written scan drops and the reason a stale table could look complete.
 */
const allRoutes = mountedRoutes();
const routes = new Set(allRoutes.map(r => `${r.method} ${r.path}`));
const routeArea = new Map(allRoutes.map(r => [`${r.method} ${r.path}`, r.path]));

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
 * REST comes from `ROUTE_RIGHTS`. MCP comes from `TOOL_RIGHTS` FIRST and from the coarse flags only for a tool
 * that has no row — because a tool governed by a row is not governed by its flags, and reading the flags
 * reports the rung it would have had.
 *
 * **That is what this line got wrong, and the mistake is instructive.** `schema_update` moved from a flag to
 * a `TOOL_RIGHTS` row of `schema: admin`; a comment in `space-rights.ts` recorded that the two doors now
 * agreed and that *"`surface-matrix.mjs` no longer reports it"*. It reported it again from that day on,
 * because this function still read the flag — and nobody saw, because this script had been aborting on an
 * unrelated error since 2026-08-14. A claim about a checker, in a file the checker does not read, verified
 * by a checker nobody ran.
 *
 * Reporting both rungs is still the point: a tool hidden from a token whose REST route would have accepted
 * it (or the reverse) is a real asymmetry, and it is invisible unless the two are put side by side.
 */
const { TOOL_RIGHTS } = await import(`file://${join(ROOT, 'server/dist/auth/space-rights.js')}`);
const TOOL_RUNG = new Map(TOOL_RIGHTS.map(r => [r.tool, r.needs]));
/**
 * What a token needs for this tool, in one word.
 *
 * `spaceAdmin` is checked BEFORE the mutating fallback, and the order is the whole point: since 5.0 it is
 * its own grant rather than four area rungs read together, so a tool carrying it would otherwise render as
 * `write` — which is both weaker than the truth and unreachable by setting the four rungs. Published, a
 * reader would configure a token that cannot make the call.
 */
const toolRung = t => TOOL_RUNG.get(t.name)
  ?? (t.admin ? 'instance-admin' : t.spaceAdmin ? 'space-admin' : t.mutating ? 'write' : 'read');

/*
 * The mapping is IMPORTED, not kept here.
 *
 * This file held its own and it was the copy nobody ran — it mapped `GET /api/files/:spaceId` to
 * `read_file` and published that as covered for a month, while the bytes route has no MCP tool at all and
 * `read_file` answers the extracted-TEXT route. One rule, three implementations, and the published one was
 * the wrong one.
 *
 * `every-rest-route-is-answered-or-declared.test.js` now asserts the same structure against every mounted
 * route, so what this renders is what a gate holds true rather than what somebody last remembered.
 */
/**
 * The hand-classified pairings, plus a row for every tool that has no OLDER route.
 *
 * Since 5.0 every tool is `POST /api/<tool-name>`, served by one generic `/:tool` route over the same
 * `callTool` the MCP door uses — so a tool with no row in `CAPABILITIES` is not unmapped, it is a tool
 * whose only shape is the canonical one. Demanding a hand-written row for each of those would be
 * forty-five copies of a mapping the route's own definition already holds, and the row nobody wrote would
 * stop the generator dead, which is how it stopped today.
 *
 * `section` is `Tools` for these: they are grouped by what they do in the guide, not here.
 */
const TOOL_DOOR = 'POST /api/:tool';
const paired = new Set(CAPABILITIES.map(r => r[1]));
const MAP = [
  ...CAPABILITIES,
  ...[...tools].filter(t => !paired.has(t)).sort().map(t => ['Tools — one shape only', t, `POST /api/${t}`]),
];

const missingTools = MAP.map(r => r[1]).filter(t => !tools.has(t));
if (missingTools.length) throw new Error(`mapped tools that do not exist: ${missingTools.join(', ')}`);
// A `POST /api/<tool-name>` row resolves to the generic mount, which is the route that serves it.
const missingRoutes = MAP.map(r => r[2])
  .filter(r => r && !routes.has(r) && !(/^POST \/api\/[a-z0-9_]+$/.test(r) && routes.has(TOOL_DOOR)));
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
 * The REST cell — the CANONICAL path first, and the older one named as older.
 *
 * This column used to print the mapped route and nothing else, which for `save_fact` meant
 * `POST /api/brain/spaces/:spaceId/facts`. True, still mounted, and the wrong answer to the question a
 * reader brings: since 5.0 every tool is `POST /api/<tool-name>` taking the space in the BODY, and a table
 * showing only the path form being retired teaches the shape that is going away. The owner read it that way
 * on sight — *"i see still space id in the route"* — which is the table failing, not the reader.
 *
 * Both are shown because both are true: the legacy route works until `B-9` deletes it, and a reader
 * maintaining an existing integration needs to find their own path here.
 */
const routeCell = (r) => {
  const canonical = `\`POST /api/${r.tool}\``;
  if (!r.route) return canonical;
  if (r.route === `POST /api/${r.tool}`) return canonical;
  return `${canonical}<br>legacy: \`${r.route}\``;
};

/**
 * One cell for the token requirement.
 *
 * `read` / `write` / `admin` when both doors agree — the common case, and what a reader wants at a glance. When
 * they differ, BOTH are named with the door, because that difference is the interesting thing: it means the same
 * capability is reachable by tokens of different strength depending on which client you happen to hold.
 */
function rungCell(r) {
  if (!r.route) return `${r.mcpRung} (MCP)`;
  /*
   * The canonical tool path. It has no `ROUTE_RIGHTS` row and is not instance-level either: one generic
   * `/:tool` route serves every tool, so the requirement is the TOOL's and both doors read it from
   * `TOOL_RIGHTS`. Labelling it "instance-level" — which the branch below would — tells a reader the
   * opposite of the truth about a per-space capability.
   */
  if (/^POST \/api\/[a-z0-9_]+$/.test(r.route)) return `${r.mcpRung} · both doors`;
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
  out.push(`| | \`${r.tool}\` | ${routeCell(r)} | ${rungCell(r)} `
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
  pub.push(`| | \`${r.tool}\` | ${routeCell(r)} | ${rungCell(r)} |`);
}
writeFileSync(join(ROOT, 'todo/_matrix-published.md'), pub.join('\n'), 'utf8');
writeFileSync(join(ROOT, 'todo/_matrix-rest-only.md'), rest.join('\n'), 'utf8');
const rungMismatch = rows.filter(r => r.route && r.restRung && r.restRung !== 'exempt' && r.restRung !== r.mcpRung);
/*
 * A mapped route with no rights row.
 *
 * `ROUTE_RIGHTS` and `NOT_AREA_SCOPED` govern the SPACE-scoped surface — `every-space-route-has-an-area`
 * enumerates that surface and holds both lists to it, and it rejects an exemption for a path outside it.
 * So tokens and networks belong to neither: a token is governed by token administration and a network is
 * instance-shaped, and neither has a space whose area could be checked.
 *
 * Asking them the space question produced five false findings, and "add a row to quiet it" put five
 * exemptions into a list that then failed its own gate for naming routes that surface does not contain.
 * The question is scoped instead.
 */
/*
 * ...and neither is the generic tool door, for a third reason worth its own clause: `POST /api/<tool-name>`
 * is served by one `/:tool` route that answers forty-five capabilities, so one area and one rung could not
 * describe it. Each tool is priced in `TOOL_RIGHTS` and enforced per call by `callTool`; the route carries
 * a `NOT_AREA_SCOPED` row saying exactly that. Asking it the space question produces a finding whose only
 * available fix would be to area-scope a route the design says is not.
 */
const SPACE_SCOPED = r => !/\/api\/(tokens|networks)(\/|$)/.test(r.route ?? '')
  && !/^POST \/api\/[a-z0-9_]+$/.test(r.route ?? '');
const noRightsRow = rows.filter(r => r.route && r.restRung === null && SPACE_SCOPED(r));
console.log(JSON.stringify({
  capabilities: rows.length, routes: routes.size, restOnly: restOnly.length,
  noGuide: rows.filter(r => !r.guide.length).length,
  noUser: rows.filter(r => !r.user.length).length,
  noChangelog: rows.filter(r => !r.changelog).length,
  rungMismatch: rungMismatch.map(r => `${r.tool}: REST ${r.restRung} vs MCP ${r.mcpRung}`),
  noRightsRow: noRightsRow.map(r => `${r.tool} -> ${r.route}`),
}));
