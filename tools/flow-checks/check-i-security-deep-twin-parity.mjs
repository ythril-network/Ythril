#!/usr/bin/env node
/**
 * check-i-security-deep-twin-parity: every route and its agent-tool twin ask the same of the caller; one weaker door is the finding.
 *
 * Rule (the flow node's stated assertion): build the door-by-door matrix, diff each twin pair, and a diff line is a finding.
 *
 *   - The pairs are the project's capability map (`capabilityMapModel`: a tool and the REST route that does the same thing); the rows that
 *     only pair a tool with the generic tool door (`POST /api/<tool>`) are not pairs, they are one handler.
 *   - Per pair, the matrix reads each door from the code that decides it, never from a list here:
 *       guard       the strongest requirement of the route's chain (`_route-chains.mjs` reads what each guard of `auth/middleware.ts` does:
 *                   instance admin, admin of the space, create-spaces, the area rung of its `ROUTE_RIGHTS` row, a token) against the tool's
 *                   (`admin`, `spaceAdmin`, `createsSpaces` flags, its `TOOL_RIGHTS` rung, a token), on one scale. A door lower than its twin
 *                   is the diff line, and it says which door is the weaker.
 *       read-only   a route refuses a read-only token when its chain names `denyReadOnly`, or asks at least the write rung or an admin; a tool
 *                   refuses it when it is `mutating`. The two must agree.
 *       narrowing   a route whose row scopes by the body's `space` (`scope: 'body'`) is the tool that takes `space` as a list (`spaceList`).
 *       rights row  a route priced in `ROUTE_RIGHTS` is a tool priced in `TOOL_RIGHTS` or by a flag, and the area agrees where both have one.
 *     Two doors that are one implementation are not compared: a route whose handler calls `callTool` is the tool (`dispatchesThroughCallTool`),
 *     and a route priced in an area no tool has a `TOOL_RIGHTS` row in (the Networks column, decided inside the shared act) is compared on the
 *     read-only refusal only. Both are derived from the code and the two tables, never listed.
 *     The caps each door applies and the error text it answers are not in a registry: `a-tool-and-its-route-agree-on-bounds`,
 *     `a-tool-and-its-route-take-the-same-parameters` and `an-mcp-edit-leaves-the-change-list-its-rest-twin-does` pin them, and this probe
 *     does not restate them.
 *   - Exceptions live only in `check-i-security-deep-twin-parity.allow.json` beside this file (`{ id, reason, reviewBy }`, id
 *     `<tool> <-> <METHOD path> :: <kind>`), through `_allow.mjs`. The verdict says how many it used.
 *   - A build older than its source, or missing, is `cannot answer` with the build command (`_built-registry.mjs`).
 *
 * The failure that bought it (Q-876): the check is named by the audit lenses and answered "cannot answer" from a placeholder, so each bundle
 * judged by reading whether one of two doors had gone weaker (the 2026-08-13 owner ruling found `delete_fact` allowed where its route refused).
 *
 *     npm run build:server && node tools/flow-checks/check-i-security-deep-twin-parity.mjs
 */
import { holds, violated, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { routesWithChains, guardFacts, limiterNames, chainFacts, serverSources, middlewareText, dispatchesThroughCallTool, READ_ONLY_GUARD } from './_route-chains.mjs';
import { builtRegistry } from './_built-registry.mjs';

/** The strength of a requirement on one scale, lowest first: a token, the area rungs, space admin, instance admin. */
const RUNG_RANK = { read: 2, write: 3, admin: 4 };
const RANK_NAME = ['public', 'a token', 'read rung', 'write rung (or create-spaces)', 'admin rung or space admin', 'instance admin'];

/** What a route asks of the caller, as a rank. `row` is its `ROUTE_RIGHTS` row or undefined. */
export function routeRank(facts, row) {
  return Math.max(
    facts.instanceAdmin ? 5 : 0, facts.spaceAdmin ? 4 : 0, facts.createsSpaces ? 3 : 0,
    row ? RUNG_RANK[row.needs] ?? 0 : 0, facts.metered ? 1 : 0,
  );
}

/** What a tool asks of the caller, as a rank. `row` is its `TOOL_RIGHTS` row or undefined. */
export function toolRank(tool, row) {
  return Math.max(tool.admin ? 5 : 0, tool.spaceAdmin ? 4 : 0, tool.createsSpaces ? 3 : 0, row ? RUNG_RANK[row.needs] ?? 0 : 0, 1);
}

/**
 * The diff lines of one twin pair, `[{ kind, text }]`.
 *
 * @param {{ tool: string, route: string }} pair the capability row
 * @param {object} tool the registry entry
 * @param {{ facts: object, rest: string }} door the route's chain facts and its chain text
 * @param {object|undefined} row the route's `ROUTE_RIGHTS` row
 * @param {object|undefined} trow the tool's `TOOL_RIGHTS` row
 */
export function diffPair(pair, tool, door, row, trow) {
  const out = [];
  const rr = routeRank(door.facts, row);
  const tr = toolRank(tool, trow);
  if (rr !== tr && !door.actPriced) out.push({ kind: 'guard', text: `the ${rr < tr ? 'route' : 'tool'} is the weaker door: the route asks ${RANK_NAME[rr]}, the tool asks ${RANK_NAME[tr]}` });
  const restRefusesReadOnly = door.facts.readOnly || rr >= 3;
  const toolRefusesReadOnly = Boolean(tool.mutating) || tr >= 3;
  if (restRefusesReadOnly !== toolRefusesReadOnly) {
    out.push({ kind: 'read-only', text: `a read-only token is ${restRefusesReadOnly ? 'refused by the route and let through the tool' : 'let through the route and refused by the tool'} (tool mutating: ${Boolean(tool.mutating)}, route names ${READ_ONLY_GUARD}: ${door.facts.readOnly})` });
  }
  if (row && (row.scope === 'body') !== Boolean(tool.spaceList)) {
    out.push({ kind: 'narrowing', text: `the route scopes by ${row.scope} and the tool ${tool.spaceList ? 'takes' : 'does not take'} a list of spaces` });
  }
  const flagged = Boolean(tool.admin || tool.spaceAdmin || tool.createsSpaces);
  if (row && !trow && !flagged && !door.actPriced) out.push({ kind: 'rights-row', text: `the route is priced (${row.area}: ${row.needs}) and the tool has no TOOL_RIGHTS row and no admin flag` });
  if (!row && trow) out.push({ kind: 'rights-row', text: `the tool is priced (${trow.area}: ${trow.needs}) and the route has no ROUTE_RIGHTS row` });
  if (row && trow && row.area !== trow.area) out.push({ kind: 'rights-row', text: `the route is priced in ${row.area}, the tool in ${trow.area}` });
  return out;
}

/** `[{ id, text }]` for every diff line of every twin pair. */
export function matrixFindings({ rows, routes, guards, limiters, tools, ROUTE_RIGHTS, TOOL_RIGHTS, isToolDoorPath }) {
  const byRoute = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
  const rowOf = new Map(ROUTE_RIGHTS.map((r) => [`${r.method} ${r.route}`, r]));
  const trowOf = new Map(TOOL_RIGHTS.map((r) => [r.tool, r]));
  const toolOf = new Map(tools.map((t) => [t.name, t]));
  /*
   * An area no tool has a `TOOL_RIGHTS` row in (the Networks column) is priced inside the act both doors share, so a route's row in it
   * has no tool row to be compared with. Derived from the two tables, not listed.
   */
  const toolAreas = new Set(TOOL_RIGHTS.map((r) => r.area));
  const actAreas = new Set(ROUTE_RIGHTS.map((r) => r.area).filter((a) => !toolAreas.has(a)));
  const out = [];
  let pairs = 0;
  let dispatched = 0;
  for (const p of rows) {
    if (!p.route || isToolDoorPath(p.route, p.tool)) continue;
    const route = byRoute.get(p.route);
    const tool = toolOf.get(p.tool);
    if (!route || !tool) throw new Error(`${p.tool} <-> ${p.route}: the pair names a ${route ? 'tool' : 'route'} the registry does not hold`);
    pairs++;
    if (dispatchesThroughCallTool(route.source)) { dispatched++; continue; }
    const row = rowOf.get(p.route);
    const trow = trowOf.get(p.tool);
    const door = { facts: chainFacts(route.all, guards, limiters), rest: route.all, actPriced: Boolean(row && !trow && actAreas.has(row.area)) };
    for (const d of diffPair(p, tool, door, row, trow)) {
      out.push({ id: `${p.tool} <-> ${p.route} :: ${d.kind}`, text: `${p.tool} <-> ${p.route}: ${d.text}` });
    }
  }
  if (pairs < 30) throw new Error(`only ${pairs} twin pair(s) found: the capability map was not read`);
  return { findings: out, pairs, dispatched };
}

export function decide(input, allow, todayDate) {
  const { findings, pairs, dispatched } = matrixFindings(input);
  const { problem, open, used } = applyAllow(findings, allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${pairs} twin pair(s), ${dispatched} of them one dispatcher behind both doors, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} door difference(s): ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`every route and its tool ask the same of the caller on guard, read-only refusal, space narrowing and rights row (${tail})`);
}

/** The real tree's input for {@link decide}. */
export async function realInput() {
  const reg = await builtRegistry();
  const { isToolDoorPath } = await import('../../testing/standalone/_guide-tables.mjs');
  return {
    rows: reg.capabilityMapModel().rows, routes: routesWithChains(), guards: guardFacts(middlewareText()),
    limiters: limiterNames(serverSources()), tools: reg.ALL_TOOLS, ROUTE_RIGHTS: reg.ROUTE_RIGHTS, TOOL_RIGHTS: reg.TOOL_RIGHTS, isToolDoorPath,
  };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(await realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
