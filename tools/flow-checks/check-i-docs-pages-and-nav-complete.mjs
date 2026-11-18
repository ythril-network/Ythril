#!/usr/bin/env node
/**
 * check-i-docs-pages-and-nav-complete: every docs page is reachable from the navigation, every navigation entry has a page, and every feature the
 * changelog adds has a page.
 *
 * Rule (the flow node's stated assertion): docs files not in nav, nav entries without a file, changelog feature headings without a page.
 *
 *   - Navigation is the markdown links the documentation itself carries: a page in a split guide (`docs/x/NN-topic.md` with a sibling `docs/x.md`,
 *     the same structural rule `docs/_docs.mjs` reads a split by) is in the navigation when its index `docs/x.md` links it; any other page when
 *     the README or another docs page links it. A page nothing links is an orphan.
 *   - A navigation entry without a file: a markdown link in the README or an index (`docs/x.md` with a sibling directory) to a `.md` file that git
 *     does not track.
 *   - A changelog feature without a page: in the newest section of `CHANGELOG.md` (the one under `## [Unreleased]`, else the first version), each
 *     `### Added` bullet's routes (`METHOD /api/...`) and MCP tools (a backticked name the server's tool files define) must stand in the
 *     documentation: a route printed as `METHOD /api/path/:param` (or the shortened `POST …/tail`), a tool as a word of its own.
 *   - Exceptions live only in `check-i-docs-pages-and-nav-complete.allow.json` beside this file: `{ key, reason, reviewBy }`, where `key` is
 *     `orphan <page>`, `dead <page> <target>` or `changelog <route or tool>`. An entry without a reason, or past its reviewBy date, fails the probe;
 *     the verdict says how many it used.
 *   - File lists come from `git ls-files` through `testing/standalone/_sources.mjs`; nothing here lists a page, an index or a tool.
 *
 * The failure that bought it (Q-875): the check was named by the audit passes and answered "cannot answer" from a placeholder, so a page added
 * and linked from nowhere, or a changelog line naming a route nobody documented, was found by a reader.
 *
 *     node tools/flow-checks/check-i-docs-pages-and-nav-complete.mjs
 */
import { posix } from 'node:path';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { readTrackedSources } from '../../testing/standalone/_sources.mjs';
import { pagesNamingRoutes, pagesNamingRoute, printsName, allowProblem, readAllowFile, exceptionTail } from './_docs-surface.mjs';

const CHECK = 'check-i-docs-pages-and-nav-complete';

/** A markdown link to a markdown file, without its fragment. Built fresh per use: a shared global regex keeps its position between pages. */
const mdLinkRe = () => /\]\(\s*<?([^)\s#>]+\.md)(?:#[^)\s>]*)?>?[^)]*\)/g;

/** `[{ to, line }]`: every markdown link in `text` that is a relative path, resolved against the directory of `file`. */
export function linksOf(file, text) {
  const out = [];
  for (const m of text.matchAll(mdLinkRe())) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    out.push({ to: posix.normalize(posix.join(posix.dirname(file), m[1])), line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** The index of a split guide page: `docs/x/NN.md` is held by `docs/x.md` when that file exists (the split is detected, never listed). */
const indexOf = (page, tracked) => {
  const m = /^(docs\/[^/]+)\/[^/]+\.md$/.exec(page);
  return m && tracked.has(`${m[1]}.md`) ? `${m[1]}.md` : null;
};

/** The newest changelog section's `### Added` bullets: the text between that heading and the next heading of its level or higher. */
export function addedBullets(changelog) {
  const lines = changelog.split(/\r?\n/);
  const heads = lines.map((l, i) => (/^##\s+\[/.test(l) ? i : -1)).filter(i => i >= 0);
  if (!heads.length) return [];
  const section = lines.slice(heads[0], heads[1] ?? lines.length);
  const from = section.findIndex(l => /^###\s+Added\b/.test(l));
  if (from < 0) return [];
  const rest = section.slice(from + 1);
  const end = rest.findIndex(l => /^#{1,3}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).filter(l => /^\s*[-*]\s/.test(l));
}

/** The names the server's tool files define: `name: 'save_fact'` in each tracked tool source. */
export const toolNamesOf = (sources) => new Set(sources.flatMap(s => [...s.text.matchAll(/\bname:\s*'([a-z][a-z0-9_]+)'/g)].map(m => m[1])));

/**
 * @param {{ docs: {file,text}[], readme: {file,text}[], changelog: string, toolNames: Set<string>, allow: object[], today: string }} i
 * `docs` are the tracked `docs/**` pages; `readme` the README and the other root pages whose links count as navigation.
 */
export function decide({ docs, readme, changelog, toolNames, allow, today }) {
  // A probe handed nothing to read answers about nothing: that is "cannot answer", never "holds".
  if (!docs.length || !readme.length || !changelog.trim() || !toolNames.size) {
    throw new CannotAnswer(`read ${docs.length} docs page(s), ${readme.length} root page(s), ${changelog.length} changelog character(s) and ${toolNames.size} tool name(s): the documentation was not read`);
  }
  const bad = allowProblem(allow, today);
  if (bad) return violated(bad);
  const allowed = new Set(allow.map(e => e.key));
  const tracked = new Set(docs.map(d => d.file));
  const findings = [];
  let used = 0;
  const flag = (key, text) => { if (allowed.has(key)) used++; else findings.push(text); };

  const links = [...docs, ...readme].flatMap(p => linksOf(p.file, p.text).map(l => ({ from: p.file, ...l })));
  for (const page of tracked) {
    const index = indexOf(page, tracked);
    const held = index ? links.some(l => l.from === index && l.to === page) : links.some(l => l.from !== page && l.to === page);
    if (!held) flag(`orphan ${page}`, `${page} is in no navigation (${index ? `${index} does not link it` : 'no page or README links it'})`);
  }
  const navPages = [...docs.filter(d => [...tracked].some(t => t.startsWith(`${d.file.slice(0, -3)}/`))), ...readme];
  for (const p of navPages) {
    for (const l of linksOf(p.file, p.text)) {
      if (!tracked.has(l.to) && l.to.startsWith('docs/')) flag(`dead ${p.file} ${l.to}`, `${p.file}:${l.line} links ${l.to}, which git does not track`);
    }
  }

  const named = pagesNamingRoutes(docs);
  const docText = docs.map(d => d.text).join('\n');
  const bullets = addedBullets(changelog);
  for (const b of bullets) {
    for (const m of b.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[A-Za-z0-9_:/.-]*)/g)) {
      if (!pagesNamingRoute(named, m[1], m[2].replace(/[.,;)]+$/, '')).size) flag(`changelog ${m[1]} ${m[2]}`, `the changelog adds ${m[1]} ${m[2]}, which no docs page prints`);
    }
    for (const m of b.matchAll(/`([a-z][a-z0-9_]+)`/g)) {
      if (toolNames.has(m[1]) && !printsName(docText, m[1])) flag(`changelog ${m[1]}`, `the changelog adds the tool ${m[1]}, which no docs page names`);
    }
  }
  const tail = `${tracked.size} docs page(s), ${links.length} link(s), ${bullets.length} changelog bullet(s) under Added, ${exceptionTail(used, allow.length)}`;
  return findings.length
    ? violated(`${findings.length} gap(s): ${[...new Set(findings)].slice(0, 6).join('; ')}${findings.length > 6 ? `; and ${findings.length - 6} more` : ''} (${tail})`)
    : holds(`every docs page is in a navigation, every navigation link has a file, and every route and tool the changelog adds is documented (${tail})`);
}

if (isMain(import.meta.url)) {
  await answer(() => decide({
    docs: readTrackedSources(['docs'], { ext: ['.md'], floor: 30 }),
    readme: readTrackedSources(['README.md', 'CONTRIBUTING.md'], { ext: ['.md'], floor: 2 }),
    changelog: readTrackedSources(['CHANGELOG.md'], { ext: ['.md'], floor: 1 })[0].text,
    toolNames: toolNamesOf(readTrackedSources(['server/src/mcp/tools'], { ext: ['.ts'], floor: 20, specs: false })),
    allow: readAllowFile(import.meta.url, CHECK),
    today: new Date().toISOString().slice(0, 10),
  }));
}
