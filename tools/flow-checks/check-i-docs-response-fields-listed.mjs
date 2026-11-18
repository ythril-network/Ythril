#!/usr/bin/env node
/**
 * check-i-docs-response-fields-listed: every field a REST route's success answer carries is documented on a page that names the route.
 *
 * Rule (the flow node's stated assertion): derive the response key set from the builder; assert each key appears in the docs section.
 *
 *   - The builder is the route handler. Its success answers are the `res.json({ ... })` and `res.status(2xx).json({ ... })` calls whose body is
 *     written as an object literal in the handler (comments stripped); the keys are that literal's top-level keys. An error status (400 and up)
 *     is left out: the error body is documented once, on the errors page.
 *   - The docs section is the integration guide's pages that print the route (`METHOD /api/path/:param`, or the shortened `POST …/chrono`);
 *     a key is documented when it stands there as a word of its own, case counted.
 *   - A route with a literal answer and no page naming it is a finding. A route whose answer is built elsewhere (`res.json(result)`) or has a
 *     spread is counted in the verdict as not decided here, never as clean. MCP tool answers are not literals in the handler, so they are outside
 *     what a script can derive and are not read here.
 *   - Exceptions live only in `check-i-docs-response-fields-listed.allow.json` beside this file: `{ key, reason, reviewBy }`, where `key` is
 *     `<METHOD route> <field>`. An entry without a reason, or past its reviewBy date, fails the probe; the verdict says how many it used.
 *   - Routes and pages come from `_docs-surface.mjs` (`mountedRoutes`, git's file lists); nothing here lists a route or a page.
 *
 * The failure that bought it (Q-875): the check was named by the audit passes and answered "cannot answer" from a placeholder, so a field added
 * to an answer and not written down was found by an integrator.
 *
 *     node tools/flow-checks/check-i-docs-response-fields-listed.mjs
 */
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import {
  guideParts, pagesNamingRoutes, pagesNamingRoute, printsName, textOf, routesWithSource, successAnswerKeys, allowProblem, readAllowFile, exceptionTail,
} from './_docs-surface.mjs';

const CHECK = 'check-i-docs-response-fields-listed';

/** `routes` is `routesWithSource()`, `parts` is `guideParts()`; `today` is `YYYY-MM-DD`. */
export function decide({ routes, parts, allow, today }) {
  // A probe handed nothing to read answers about nothing: that is "cannot answer", never "holds".
  if (!routes.length || !parts.length) throw new CannotAnswer(`read ${routes.length} route(s) and ${parts.length} page(s): the surface was not read`);
  const bad = allowProblem(allow, today);
  if (bad) return violated(bad);
  const allowed = new Set(allow.map(e => e.key));
  const named = pagesNamingRoutes(parts);
  const findings = [];
  let used = 0, literal = 0, opaque = 0, fields = 0;
  for (const r of routes) {
    const a = successAnswerKeys(r.source);
    if (a.opaque) opaque++;
    if (!a.keys.length) continue;
    literal++;
    const subject = `${r.method} ${r.path}`;
    const files = pagesNamingRoute(named, r.method, r.path);
    const text = files.size ? textOf(parts, files) : '';
    const missing = [];
    for (const k of a.keys) {
      fields++;
      if (printsName(text, k)) continue;
      if (allowed.has(`${subject} ${k}`)) { used++; continue; }
      missing.push(k);
    }
    if (missing.length) findings.push(`${subject} ${files.size ? `answers ${missing.join(', ')}, which its page does not name` : `is printed on no page, so ${missing.join(', ')} are documented nowhere`}`);
  }
  const tail = `${fields} field(s) over ${literal} route(s) with a literal answer of ${routes.length}, ${opaque} route(s) with an answer built elsewhere are not decided here, ${exceptionTail(used, allow.length)}`;
  return findings.length
    ? violated(`${findings.length} route(s) answer a field no page documents: ${findings.slice(0, 6).join('; ')}${findings.length > 6 ? `; and ${findings.length - 6} more` : ''} (${tail})`)
    : holds(`every field a route's literal success answer carries is on a page that names the route (${tail})`);
}

if (isMain(import.meta.url)) {
  await answer(() => decide({
    routes: routesWithSource(),
    parts: guideParts(),
    allow: readAllowFile(import.meta.url, CHECK),
    today: new Date().toISOString().slice(0, 10),
  }));
}
