#!/usr/bin/env node
/**
 * check-i-docs-userguide-half-present: a parameter both APIs take is also on the operator page for its surface.
 *
 * Rule (the flow node's stated assertion): derive the parameters from both API schemas; grep the user-guide page.
 *
 *   - "Both APIs": a capability the capability map (`testing/standalone/_capability-map.mjs`, the pairing the parity gates use) gives to an MCP tool
 *     AND a REST route. Its parameters are the keys the tool's input schema declares that the route's reader also names (`space`, the transport key,
 *     is never one). A capability whose route cannot be read is counted in the verdict, never taken for one that takes nothing in common.
 *   - Only a parameter the client sends can have a control the operator's page describes: one whose name the client's own source (`client/src`,
 *     specs left out) never writes is an API-level option, counted in the verdict as not decided here.
 *   - "The operator page for its surface": the capability's section in that map (`Brain — facts` is the surface `Brain`) names the user-guide
 *     pages (`docs/userguide/*.md`) whose file name or whose heading (levels 1 to 3) holds the surface's word. A surface that no operator page holds is
 *     a finding. The map's surface list is not written here.
 *   - On the page: the parameter stands in one of those pages as a word of its own (case counted), or in words: `votingDeadlineHours` is named by
 *     "voting deadline hours" or "voting deadline", since the guide says what a control is called, not what the wire calls it.
 *   - Exceptions live only in `check-i-docs-userguide-half-present.allow.json` beside this file: `{ key, reason, reviewBy }`, where `key` is the
 *     parameter's name (an operator never types it, so the guide never names it). An entry without a reason, or past its reviewBy date, fails the
 *     probe; the verdict says how many it used.
 *
 * The failure that bought it (Q-875): the check was named by the audit passes and answered "cannot answer" from a placeholder, so an option
 * added to both doors reached the integration guide and the operator was never told it exists.
 *
 *     node tools/flow-checks/check-i-docs-userguide-half-present.mjs      (needs `npm run build:server`)
 */
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { CAPABILITIES } from '../../testing/standalone/_capability-map.mjs';
import { readTrackedSources } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { userguideParts, printsName, restSurface, toolSurface, allowProblem, readAllowFile, exceptionTail } from './_docs-surface.mjs';

const CHECK = 'check-i-docs-userguide-half-present';

/** Keys that are transport on one door and a path segment on the other, so never a parameter of the capability (`a-tool-and-its-route-take-the-same-parameters`). */
const TRANSPORT = new Set(['space']);

/** Every identifier the client's own source writes: a parameter in this set is one the operator's pages can show a control for. */
export function clientWords(sources) {
  const words = new Set();
  for (const { text } of sources) for (const m of stripComments(text).matchAll(/[A-Za-z_$][\w$]*/g)) words.add(m[0]);
  return words;
}

/**
 * How the guide says a parameter in words: `votingDeadlineHours` is "voting deadline hours" and "voting deadline" (the unit word may be left off),
 * `syncSchedule` is "sync schedule". A one-word name has no spoken form but itself. Built from the name, never from a list.
 */
export function spokenForms(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
  if (words.length < 2) return [];
  return [words.join(' '), ...(words.length > 2 ? [words.slice(0, -1).join(' ')] : [])];
}

/** Whether the page names the parameter: its own name as a word, or a spoken form of it (hyphen or space between the words, case ignored). */
export function pageNames(text, name) {
  if (printsName(text, name)) return true;
  const flat = text.toLowerCase().replace(/[-_*`]+/g, ' ').replace(/\s+/g, ' ');
  return spokenForms(name).some(f => flat.includes(f));
}

/** The surface a capability section names: `Brain — facts` is `Brain`. */
export const surfaceOf = (section) => section.split(/\s[—-]\s/)[0].trim();

/** The user-guide pages that hold a surface: the file name, or a heading of level 1 to 3, names it (case does not matter). */
export function pagesForSurface(parts, surface) {
  const w = surface.toLowerCase();
  return parts.filter(p => p.file.toLowerCase().includes(w)
    || p.text.split(/\r?\n/).some(l => /^#{1,3}\s/.test(l) && l.toLowerCase().includes(w)));
}

/** `rest` is `restSurface()`, `tools` is `toolSurface()`, `parts` is `userguideParts()`; `today` is `YYYY-MM-DD`. */
export function decide({ rest, tools, parts, client, allow, today, capabilities = CAPABILITIES }) {
  // A probe handed nothing to read answers about nothing: that is "cannot answer", never "holds".
  if (!rest.length || !tools.length || !parts.length || !client.size || !capabilities.length) {
    throw new CannotAnswer(`read ${rest.length} route(s), ${tools.length} tool(s), ${parts.length} page(s), ${client.size} client word(s) and ${capabilities.length} capabilit(ies): the surface was not read`);
  }
  const bad = allowProblem(allow, today);
  if (bad) return violated(bad);
  const allowed = new Set(allow.map(e => e.key));
  const routes = new Map(rest.filter(r => !r.unresolved).map(r => [`${r.method} ${r.route}`, r]));
  const byTool = new Map(tools.map(t => [t.name, t]));
  const findings = [];
  const noPage = new Set();
  /** parameter name -> the `tool (surface)` pairs whose page never names it. */
  const absent = new Map();
  const usedKeys = new Set();
  const apiOnly = new Set();
  let compared = 0, unread = 0;
  for (const [section, tool, routeSpec] of capabilities) {
    const t = byTool.get(tool);
    const r = routes.get(routeSpec);
    if (!t) { findings.push(`the capability map names the tool ${tool}, which the server does not register`); continue; }
    if (!r) { unread++; continue; }
    const surface = surfaceOf(section);
    const pages = pagesForSurface(parts, surface);
    const text = pages.map(p => p.text).join('\n');
    const accepted = new Set([...(r.keys ?? []), ...(r.queryKeys ?? [])]);
    const both = t.keys.filter(k => accepted.has(k) && !TRANSPORT.has(k));
    if (both.length && !pages.length) { noPage.add(surface); continue; }
    for (const k of both) {
      // An API-level option the client never sends has no control the operator's page could describe.
      if (!client.has(k)) { apiOnly.add(k); continue; }
      compared++;
      if (pageNames(text, k)) continue;
      if (allowed.has(k)) { usedKeys.add(k); continue; }
      if (!absent.has(k)) absent.set(k, new Set());
      absent.get(k).add(`${tool} (${surface})`);
    }
  }
  for (const s of noPage) findings.push(`no user-guide page holds the surface ${s}`);
  if (absent.size) findings.push(`${absent.size} parameter(s) both doors take and the client sends that the user-guide page of their surface never names: ${[...absent].map(([k, who]) => `${k} (${[...who][0]}${who.size > 1 ? ` +${who.size - 1}` : ''})`).join(', ')}`);
  const tail = `${compared} parameter(s) the client sends, over ${capabilities.length} capabilit(ies); ${apiOnly.size} parameter name(s) the client never sends and ${unread} capabilit(ies) whose route cannot be read are not decided here; ${exceptionTail(usedKeys.size, allow.length)}`;
  return findings.length
    ? violated(`${findings.join('; ')} (${tail})`)
    : holds(`every parameter both doors take is on the user-guide page of its surface (${tail})`);
}

if (isMain(import.meta.url)) {
  await answer(async () => decide({
    rest: await restSurface(),
    tools: await toolSurface(),
    parts: userguideParts(),
    client: clientWords(readTrackedSources(['client/src'], { ext: ['.ts', '.html'], specs: false, floor: 100 })),
    allow: readAllowFile(import.meta.url, CHECK),
    today: new Date().toISOString().slice(0, 10),
  }));
}
