#!/usr/bin/env node
/**
 * check-i-docs-parameters-listed: every parameter a REST route or an MCP tool accepts is listed on a page that names it.
 *
 * Rule (the flow node's stated assertion): per route and tool, the accepted keys from the code; each appears on the page.
 *
 *   - REST: the keys a route accepts (its body keys and the query keys its handler reads, `routeAcceptKeys` over `mountedRoutes`, so the five
 *     routes on the express app are in) against the integration guide's pages that print the route (`METHOD /api/path/:param`, or the shortened
 *     `POST …/chrono`). A route whose keys the reader cannot name is counted in the verdict as not decided here, never read as "accepts nothing".
 *     A route with keys that no page prints is a finding: nothing says it exists.
 *   - MCP: the properties of each tool's input schema (`ALL_TOOLS` in the built server, the registry the dispatcher serves) against the guide's
 *     pages that name the tool. A tool no page names is a finding.
 *   - "Lists" means the key stands on the page as a word of its own (`ttlDays`, never a part of `ttlDaysMax`), case counted.
 *   - Exceptions live only in `check-i-docs-parameters-listed.allow.json` beside this file: `{ key, reason, reviewBy }`, where `key` is
 *     `<METHOD route | tool> <parameter>`. An entry without a reason, or past its reviewBy date, fails the probe; the verdict says how many it used.
 *   - The surface and the pages come from `_docs-surface.mjs` (git's file lists, the server's own registries); nothing here lists a route, a tool or a page.
 *
 * The failure that bought it (Q-875): the check was named by the planning and audit passes and answered "cannot answer" from a placeholder, so a
 * parameter added to a route and left off its page was found by a reader when it was found at all.
 *
 *     node tools/flow-checks/check-i-docs-parameters-listed.mjs      (needs `npm run build:server`: a missing or stale build answers "cannot answer")
 */
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import {
  guideParts, pagesNamingRoutes, pagesNamingRoute, printsName, textOf, restSurface, toolSurface, allowProblem, readAllowFile, exceptionTail,
} from './_docs-surface.mjs';

const CHECK = 'check-i-docs-parameters-listed';

/** The pages (whole files) that print a tool's name as a word of its own. Built fresh per tool: a shared global regex keeps its position. */
const pagesNamingTool = (parts, name) => new Set(parts.filter(p => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(p.text)).map(p => p.file));

/** `rest` is `restSurface()`, `tools` is `toolSurface()`, `parts` is `guideParts()`; `today` is `YYYY-MM-DD`. */
export function decide({ rest, tools, parts, allow, today }) {
  // A probe handed nothing to read answers about nothing: that is "cannot answer", never "holds".
  if (!rest.length || !tools.length || !parts.length) throw new CannotAnswer(`read ${rest.length} route(s), ${tools.length} tool(s) and ${parts.length} page(s): the surface was not read`);
  const bad = allowProblem(allow, today);
  if (bad) return violated(bad);
  const allowed = new Set(allow.map(e => e.key));
  const named = pagesNamingRoutes(parts);
  const findings = [];
  let used = 0, unread = 0, checked = 0;
  const unlisted = (subject, keys, text) => {
    const missing = [];
    for (const k of keys) {
      checked++;
      if (printsName(text, k)) continue;
      if (allowed.has(`${subject} ${k}`)) { used++; continue; }
      missing.push(k);
    }
    return missing;
  };
  for (const r of rest) {
    if (r.unresolved) { unread++; continue; }
    const subject = `${r.method} ${r.route}`;
    const keys = [...new Set([...(r.keys ?? []), ...(r.queryKeys ?? [])])];
    if (!keys.length) continue;
    const files = pagesNamingRoute(named, r.method, r.route);
    const missing = unlisted(subject, keys, files.size ? textOf(parts, files) : '');
    if (missing.length) findings.push(`${subject} ${files.size ? `lacks ${missing.join(', ')}` : `is printed on no page, so ${missing.join(', ')} are listed nowhere`}`);
  }
  for (const t of tools) {
    if (!t.keys.length) continue;
    const files = pagesNamingTool(parts, t.name);
    const missing = unlisted(t.name, t.keys, files.size ? textOf(parts, files) : '');
    if (missing.length) findings.push(`tool ${t.name} ${files.size ? `lacks ${missing.join(', ')}` : `is named on no page, so ${missing.join(', ')} are listed nowhere`}`);
  }
  const tail = `${checked} parameter(s) over ${rest.length} route(s) and ${tools.length} tool(s), ${unread} route(s) whose keys cannot be read are not decided here, ${exceptionTail(used, allow.length)}`;
  return findings.length
    ? violated(`${findings.length} surface(s) with a parameter no page lists: ${findings.slice(0, 6).join('; ')}${findings.length > 6 ? `; and ${findings.length - 6} more` : ''} (${tail})`)
    : holds(`every readable parameter is listed on a page that names its route or tool (${tail})`);
}

if (isMain(import.meta.url)) {
  await answer(async () => decide({
    rest: await restSurface(),
    tools: await toolSurface(),
    parts: guideParts(),
    allow: readAllowFile(import.meta.url, CHECK),
    today: new Date().toISOString().slice(0, 10),
  }));
}
