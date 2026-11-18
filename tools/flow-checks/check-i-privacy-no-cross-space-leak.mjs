#!/usr/bin/env node
/**
 * check-i-privacy-no-cross-space-leak: no read path crosses spaces or tenants.
 *
 * Rule (the flow node's stated assertion): every read route and tool applies a space scope check before it reads.
 *
 *   - Read routes: every `GET` route, and every route whose `ROUTE_RIGHTS` row asks only the read rung (`POST /api/brain/recall` is a read).
 *     Each one acts on a space or does not, and the probe asks the code that decides it:
 *       a space in the path (`/spaces/:x` or a `:spaceId` segment)  the chain names a guard that refuses a token without that space
 *                                                                     (the `enforceSpaceScope` of `auth/middleware.ts`, found in the guard's
 *                                                                     body by `_route-chains.mjs`) or an instance admin, who reaches every
 *                                                                     space by definition, or the handler calls the peer's own space refusal
 *       a `ROUTE_RIGHTS` row scoped by the body's `space`          the chain names the body-scoped guard (it calls `spacesForBodyScopedRequest`)
 *       a row that iterates the reachable spaces                   the chain names a guard that attaches the token (the handler filters by it)
 *     A read with none of these (an instance-level route: tokens, settings, health) names no space and is outside the rule.
 *   - Tools: every tool whose input schema takes a `space` is priced in `TOOL_RIGHTS`, or carries the flag (`admin`, `spaceAdmin`,
 *     `createsSpaces`, `ownerScoped`) that has the dispatcher refuse it per named space. A tool that takes a space and has neither is
 *     dispatched with no rung asked of the caller for that space.
 *   - Exceptions live only in `check-i-privacy-no-cross-space-leak.allow.json` beside this file (`{ id, reason, reviewBy }`, id
 *     `route METHOD path` or `tool name`), through `_allow.mjs`. The verdict says how many it used.
 *   - A build older than its source, or missing, is `cannot answer` with the build command (`_built-registry.mjs`).
 *
 * The failure that bought it (Q-876): the check is named by the audit lenses and answered "cannot answer" from a placeholder, so each bundle that
 * added a read judged by reading whether it asked the space question before it read (`mcp-tool-rights` and `route-guard-coverage` hold the
 * runtime half; this reads the same decision from the code at the door of the next route).
 *
 *     npm run build:server && node tools/flow-checks/check-i-privacy-no-cross-space-leak.mjs
 */
import { holds, violated, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { routesWithChains, guardFacts, limiterNames, chainFacts, serverSources, middlewareText, dispatchesThroughCallTool } from './_route-chains.mjs';
import { builtRegistry, SPACE_SCHEMAS } from './_built-registry.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';

/** A space in the path: `/spaces/:x`, or a parameter named for one. */
export const hasSpaceParam = (path) => /\/spaces\/:\w+/.test(path) || /\/:space\w*(?:\/|$)/.test(path);

/** The functions a handler calls to refuse a peer a space it does not share: declared `refuse...Space` in the server's code. Found, not listed. */
export function peerSpaceRefusals(sources) {
  const out = new Set();
  for (const { text } of sources) for (const m of stripComments(text).matchAll(/^export\s+(?:async\s+)?function\s+(refuse\w*Space)\b/gm)) out.add(m[1]);
  return out;
}

/** `[{ id, text }]`: the read routes whose scope decision is not made before the handler reads. */
export function leakyRoutes({ routes, guards, limiters, ROUTE_RIGHTS, peerRefusals }) {
  const rowOf = new Map(ROUTE_RIGHTS.map((r) => [`${r.method} ${r.route}`, r]));
  const out = [];
  for (const r of routes) {
    const row = rowOf.get(`${r.method} ${r.path}`);
    const isRead = r.method === 'GET' || row?.needs === 'read';
    if (!isRead) continue;
    const f = chainFacts(r.all, guards, limiters);
    // A route that hands the call to `callTool` reads under the tool's own space check: the dispatcher refuses a space the token lacks, and
    // `unpricedSpaceTools` below holds that every tool that takes a space is priced for it.
    if (dispatchesThroughCallTool(r.source)) continue;
    const handlerRefuses = [...peerRefusals].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(r.source ?? ''));
    const fail = (why) => out.push({ id: `route ${r.method} ${r.path}`, text: `${r.method} ${r.path} (${r.file}): ${why}` });
    if (row?.scope === 'body') { if (!f.spaceScope) fail('its row scopes by the body space and no guard in its chain refuses a space the token lacks'); continue; }
    if (row?.scope === 'iterates') { if (!f.metered) fail('it iterates the reachable spaces and its chain names no guard that attaches the token'); continue; }
    if (row?.scope === 'path' || hasSpaceParam(r.path)) {
      if (!f.spaceScope && !f.instanceAdmin && !handlerRefuses) fail('it reads a space named in the path and nothing in its chain or handler refuses a token without that space');
    }
  }
  return out;
}

/** `[{ id, text }]`: the tools that take a `space` and are neither priced per space nor flagged. */
export function unpricedSpaceTools({ tools, TOOL_RIGHTS }) {
  const priced = new Set(TOOL_RIGHTS.map((r) => r.tool));
  return tools
    .filter((t) => 'space' in (t.inputSchema(SPACE_SCHEMAS).properties ?? {}))
    .filter((t) => !priced.has(t.name) && !t.admin && !t.spaceAdmin && !t.createsSpaces && !t.ownerScoped)
    .map((t) => ({ id: `tool ${t.name}`, text: `tool ${t.name} takes a space and has no TOOL_RIGHTS row and no admin, spaceAdmin, createsSpaces or ownerScoped flag` }));
}

export function decide(input, allow, todayDate) {
  const findings = [...leakyRoutes(input), ...unpricedSpaceTools(input)];
  const reads = input.routes.filter((r) => r.method === 'GET' || input.ROUTE_RIGHTS.some((x) => x.method === r.method && x.route === r.path && x.needs === 'read')).length;
  const spaceTools = input.tools.filter((t) => 'space' in (t.inputSchema(SPACE_SCHEMAS).properties ?? {})).length;
  if (reads < 30 || spaceTools < 20) throw new Error(`only ${reads} read route(s) and ${spaceTools} space tool(s) found: the scan broke, not the code`);
  const { problem, open, used } = applyAllow(findings, allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${reads} read route(s), ${spaceTools} tool(s) taking a space, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} read path(s) with no space scope check: ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`every read route and space-taking tool asks the space question before it reads (${tail})`);
}

/** The real tree's input for {@link decide}. */
export async function realInput() {
  const reg = await builtRegistry();
  const sources = serverSources();
  return {
    routes: routesWithChains(), guards: guardFacts(middlewareText()), limiters: limiterNames(sources), tools: reg.ALL_TOOLS,
    ROUTE_RIGHTS: reg.ROUTE_RIGHTS, TOOL_RIGHTS: reg.TOOL_RIGHTS, peerRefusals: peerSpaceRefusals(sources),
  };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(await realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
