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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  capabilityMapModel, renderCapabilityMap, renderRestOnlyBlock, routeCell, rungCell, isToolDoorPath,
} from '../testing/standalone/_guide-tables.mjs';

const ROOT = process.cwd();
const read = p => readFileSync(join(ROOT, p), 'utf8');

/**
 * `--write`: fill each generated region of the integration guide from the code, and nothing else.
 *
 * A region is the text between `<!-- generated: NAME -->` and `<!-- /generated: NAME -->`. The gate
 * `the-guide-tables-are-generated-from-code` compares each one with the same render, so a page edited by hand
 * inside its markers is red until this runs. It REFUSES a page whose markers are missing or repeated rather than
 * appending a region somewhere it guessed: a table placed by a script that could not find its place is a table
 * nobody chose. It keeps the page's own line endings (the working tree is CRLF, the commit LF), and writes only
 * the two pages named here. Build the server first; the render reads `server/dist`.
 */
const GENERATED_REGIONS = [
  { page: 'docs/integration-guide/16b-mcp-capability-map.md', name: 'capability-map', render: renderCapabilityMap },
  { page: 'docs/integration-guide/16-mcp.md', name: 'rest-only', render: renderRestOnlyBlock },
];

function writeGeneratedRegions() {
  let failed = false;
  for (const { page, name, render } of GENERATED_REGIONS) {
    const file = join(ROOT, page);
    if (!existsSync(file)) { console.error(`${page} does not exist; the region \`${name}\` has no page to live on.`); failed = true; continue; }
    const text = readFileSync(file, 'utf8');
    const crlf = text.includes('\r\n');
    const nl = crlf ? '\r\n' : '\n';
    const open = `<!-- generated: ${name} -->`;
    const close = `<!-- /generated: ${name} -->`;
    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    if (opens !== 1 || closes !== 1 || text.indexOf(open) > text.indexOf(close)) {
      console.error(`${page} must carry \`${open}\` then \`${close}\` exactly once (found ${opens} and ${closes}); nothing was written to it.`);
      failed = true;
      continue;
    }
    const body = render().replace(/\r\n/g, '\n').split('\n').join(nl);
    // A blank line each side: a table directly under an HTML comment is glued to it and renders as literal pipes.
    const next = text.slice(0, text.indexOf(open) + open.length) + nl + nl + body + nl + nl + text.slice(text.indexOf(close));
    if (next !== text) writeFileSync(file, next, 'utf8');
    console.log(`${page}: \`${name}\` ${next === text ? 'already current' : 'written'}`);
  }
  process.exit(failed ? 1 : 0);
}
if (process.argv.includes('--write')) writeGeneratedRegions();
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
 * The routes, the mapping and the rungs come from `testing/standalone/_guide-tables.mjs`, not from a copy here.
 *
 * THIS SCRIPT HAD ITS OWN, AND IT HAD BEEN FAILING SINCE 2026-08-14 — a month of `todo/_matrix-published.md`
 * sitting there looking current while the generator refused to write it. The refusal was correct and it was
 * also invisible: nothing runs this in CI, so an abort and a success look identical to anyone who only ever
 * reads the output file. The renderer is a module now because the integration guide's capability map is held
 * to it by a gate, and a gate comparing a page with a second renderer is the copy this comment describes.
 *
 * The module throws below a floor rather than returning a short table, which is the guard a hand-written scan
 * drops and the reason a stale table could look complete.
 */
const { rows: baseRows, routes, routeArea } = capabilityMapModel();

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

const rows = baseRows.map(r => ({
  ...r,
  guide: hits(GUIDE, r.tool, r.route),
  user: hits(USER, r.tool, r.route),
  changelog: hits(CHANGELOG, r.tool, r.route).length > 0 || hits(ARCHIVE, r.tool, r.route).length > 0,
}));

const cell = a => (a.length ? a.join(', ') : '**—**');

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
const mappedRoutes = new Set(rows.map(r => r.route).filter(Boolean));
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

/** The PUBLISHED table is `renderCapabilityMap` — the same text the integration guide's generated region is held to. */
writeFileSync(join(ROOT, 'todo/_matrix-published.md'), renderCapabilityMap(rows), 'utf8');
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
  && !isToolDoorPath(r.route);
const noRightsRow = rows.filter(r => r.route && r.restRung === null && SPACE_SCOPED(r));
console.log(JSON.stringify({
  capabilities: rows.length, routes: routes.size, restOnly: restOnly.length,
  noGuide: rows.filter(r => !r.guide.length).length,
  noUser: rows.filter(r => !r.user.length).length,
  noChangelog: rows.filter(r => !r.changelog).length,
  rungMismatch: rungMismatch.map(r => `${r.tool}: REST ${r.restRung} vs MCP ${r.mcpRung}`),
  noRightsRow: noRightsRow.map(r => `${r.tool} -> ${r.route}`),
}));
