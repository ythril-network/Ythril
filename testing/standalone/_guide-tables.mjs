/**
 * The tables the integration guide publishes about the tool surface — rendered from the code, held once.
 *
 * ## Why a module
 *
 * Two readers need the same render. `scripts/surface-matrix.mjs` writes it for a human to paste or `--write`,
 * and `the-guide-tables-are-generated-from-code.test.js` compares the guide's generated regions against it.
 * The renderer lived inside the script, so the gate could not call it without running a script that writes
 * files; and a gate holding the page to a SECOND renderer would have been the same sentence written twice,
 * the weaker copy winning silently. That is how `16-mcp.md` came to describe a capability map nobody
 * regenerated: it named `query POST /api/filter` for a route deleted long before, left `space_reembed` out,
 * and said the REST-only list was empty while `parity.ts` held rows.
 *
 * ## What it renders, and what it deliberately does not
 *
 * **The capability map**: capability, MCP tool, REST route, and the rung a token needs, per door — from
 * `CAPABILITIES` and `THE_TOOL_DOOR` (the pairing), `ROUTE_RIGHTS` (REST) and `TOOL_RIGHTS` (MCP, which wins
 * over the coarse tool flags for a tool that has a row). **The REST-only block**: what `help()` reports under
 * `restOnly`, taken from `restOnlyCapabilityMap()` itself rather than from a copy of its rows.
 *
 * A tool's hand-written note about its token requirement (`TOOL_NOTES` in `_capability-map.mjs`) follows the
 * computed cell, so a fact an integrator relied on survives the table being generated.
 *
 * It does NOT render the documentation-hit columns (which of our files mentions a tool). They describe our
 * own bookkeeping, and a published region containing them would change every time any page is edited, so the
 * gate that compares the region would be circular. Those stay in the script, over the rows this returns.
 *
 * ## The floor is inside
 *
 * A render over an empty registry is an empty table, and an empty table equals an empty region. This throws
 * below a floor on the tools, the pairings and the rows, and on every mapped tool or route that does not
 * exist, so a caller cannot receive a short table quietly. It reads the BUILT server (`server/dist`): a stale
 * build renders a stale region, so build the server before regenerating.
 *
 * It reads source files relative to the repository root. `mountedRoutes` resolves its own files against the
 * working directory, so a caller runs from the repository root, as the test runner and the script both do.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { mountedRoutes } from './_routes.mjs';
import { CAPABILITIES, THE_TOOL_DOOR, TOOL_NOTES } from './_capability-map.mjs';

const fromDist = rel => import(pathToFileURL(join(REPO_ROOT, 'server/dist', rel)).href);
const { ALL_TOOLS } = await fromDist('mcp/tools/index.js');
const { ROUTE_RIGHTS, NOT_AREA_SCOPED, TOOL_RIGHTS } = await fromDist('auth/space-rights.js');
const { restOnlyCapabilityMap } = await fromDist('mcp/parity.js');

/** The fewest tools, pairings and rows that mean the registry and the map were really read. */
const FLOOR = 30;

/** A canonical tool-door route: `POST /api/<tool-name>`, served by the one generic `/:tool` route. */
export const isToolDoorPath = route => /^POST \/api\/[a-z0-9_]+$/.test(route ?? '');

/** The REST cell — the canonical path first, and the older one named as older. */
export function routeCell(r) {
  const canonical = `\`POST /api/${r.tool}\``;
  if (!r.route) return canonical;
  if (r.route === `POST /api/${r.tool}`) return canonical;
  // No `<br>`: the docs lint refuses inline HTML, and the generated page is linted like any other.
  return `${canonical} · legacy: \`${r.route}\``;
}

/**
 * One cell for the token requirement: `read` / `write` / `admin` when both doors agree, and both named with
 * their door when they differ, because the difference is the interesting thing.
 */
export function rungCell(r) {
  if (!r.route) return `${r.mcpRung} (MCP)`;
  // One generic `/:tool` route serves every tool, so the requirement is the TOOL's and both doors read it
  // from `TOOL_RIGHTS`. Calling it instance-level would say the opposite about a per-space capability.
  if (isToolDoorPath(r.route)) return `${r.mcpRung} · both doors`;
  // The per-space matrix governs SPACE-scoped areas; `/api/spaces`, `/api/tokens` and `/api/networks` sit
  // outside it by design, so 'no row' there is the design rather than a gap.
  if (r.restRung === null) return `${r.mcpRung} (MCP) · instance-level`;
  if (r.restRung === 'exempt') return `${r.mcpRung} (MCP) · REST exempt`;
  const area = r.restArea ? ` \`${r.restArea}\`` : '';
  if (r.restRung === r.mcpRung) return `${r.restRung}${area}`;
  return `**REST ${r.restRung}${area} · MCP ${r.mcpRung}**`;
}

/**
 * Everything the map is made of: the mounted routes, the capability rows with both rungs, and the checks
 * that every mapped tool and route exists.
 *
 * @returns {{ rows: object[], map: string[][], routes: Set<string>, routeArea: Map<string,string>, tools: object[] }}
 */
export function capabilityMapModel() {
  const allRoutes = mountedRoutes();
  const routes = new Set(allRoutes.map(r => `${r.method} ${r.path}`));
  const routeArea = new Map(allRoutes.map(r => [`${r.method} ${r.path}`, r.path]));
  const toolNames = new Set(ALL_TOOLS.map(t => t.name));

  const RUNG = new Map(ROUTE_RIGHTS.map(r => [`${r.method} ${r.route}`, r.needs]));
  const AREA_OF = new Map(ROUTE_RIGHTS.map(r => [`${r.method} ${r.route}`, r.area]));
  const EXEMPT_ROUTES = new Set(NOT_AREA_SCOPED.map(r => r.route));
  const TOOL_RUNG = new Map(TOOL_RIGHTS.map(r => [r.tool, r.needs]));
  /*
   * `TOOL_RIGHTS` FIRST and the coarse flags only for a tool with no row, and `spaceAdmin` before the mutating
   * fallback: since 5.0 it is its own grant rather than four area rungs, so a tool carrying it would
   * otherwise render as `write` — weaker than the truth and unreachable by setting the four rungs.
   */
  const toolRung = t => TOOL_RUNG.get(t.name)
    ?? (t.admin ? 'instance-admin' : t.spaceAdmin ? 'space-admin' : t.mutating ? 'write' : 'read');

  const paired = new Set(CAPABILITIES.map(r => r[1]));
  const map = [
    ...CAPABILITIES,
    ...[...toolNames].filter(t => !paired.has(t)).sort().map(t => ['Tools — one shape only', t, `POST /api/${t}`]),
  ];

  if (toolNames.size < FLOOR || CAPABILITIES.length < FLOOR || map.length < FLOOR) {
    throw new Error(
      `the capability map read ${toolNames.size} tool(s) and ${CAPABILITIES.length} pairing(s), below a floor of ${FLOOR}. `
      + 'The registry or the map was not read; an empty table would equal an empty region and pass.');
  }
  const missingTools = map.map(r => r[1]).filter(t => !toolNames.has(t));
  if (missingTools.length) throw new Error(`mapped tools that do not exist: ${missingTools.join(', ')}`);
  // A `POST /api/<tool-name>` row resolves to the generic mount, which is the route that serves it.
  const missingRoutes = map.map(r => r[2])
    .filter(r => r && !routes.has(r) && !(isToolDoorPath(r) && routes.has(THE_TOOL_DOOR)));
  if (missingRoutes.length) throw new Error(`mapped routes that do not exist: ${missingRoutes.join(' | ')}`);
  const unmapped = [...toolNames].filter(t => !map.some(r => r[1] === t)).sort();
  if (unmapped.length) throw new Error(`tools missing from the map: ${unmapped.join(', ')}`);

  const strayNotes = [...TOOL_NOTES.keys()].filter(t => !toolNames.has(t));
  if (strayNotes.length) throw new Error(`capability notes for tools that do not exist: ${strayNotes.join(', ')}`);
  const noted = new Set();
  const rows = map.map(([area, tool, route]) => {
    const t = ALL_TOOLS.find(x => x.name === tool);
    // A tool paired with two routes states its note once, on its first row.
    const note = noted.has(tool) ? undefined : TOOL_NOTES.get(tool);
    noted.add(tool);
    const restRung = route
      ? (RUNG.get(route) ?? (EXEMPT_ROUTES.has(route.split(' ').slice(1).join(' ')) ? 'exempt' : null))
      : null;
    return { area, tool, route, note, mcpRung: toolRung(t), restRung, restArea: route ? (AREA_OF.get(route) ?? null) : null };
  });
  return { rows, map, routes, routeArea, tools: ALL_TOOLS };
}

/**
 * The PUBLISHED capability table: capability, both doors, the token level. No documentation columns.
 *
 * An integrator cannot act on "which of our files mentions this", and publishing it would also publish a
 * dash that means "our name-matcher missed it", which reads as a gap that is not there.
 */
export function renderCapabilityMap(rows = capabilityMapModel().rows) {
  const pub = ['| capability | MCP tool | REST route | token needs |', '|---|---|---|---|'];
  let area = null;
  for (const r of rows) {
    if (r.area !== area) { area = r.area; pub.push(`| **${area}** | | | |`); }
    pub.push(`| | \`${r.tool}\` | ${routeCell(r)} | ${rungCell(r)}${r.note ? ` — ${r.note}` : ''} |`);
  }
  return pub.join('\n');
}

/**
 * The REST-only block, exactly as `help()` publishes it under `structuredContent.restOnly`.
 *
 * Empty is a legitimate state, so there is no floor on the rows; the floor is that the note is there, which
 * is what says the registry was read rather than stubbed.
 */
export function renderRestOnlyBlock() {
  const map = restOnlyCapabilityMap();
  if (typeof map?.note !== 'string' || !Array.isArray(map.capabilities)) {
    throw new Error('restOnlyCapabilityMap() did not return {note, capabilities[]}; the REST-only block cannot be rendered.');
  }
  return '```json\n' + JSON.stringify({ restOnly: map }, null, 2) + '\n```';
}
