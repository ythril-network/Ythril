#!/usr/bin/env node
/**
 * check-i-docs-deep-pages-older-than-their-code: list each documentation page by its last commit beside the last commit of the code it
 * describes, and a page whose code changed after it did is read, or this check is violated.
 *
 * Rule (the flow node's stated assertion): per page `git log -1 --format=%cs` against the last commit of its source; the list is the output
 * (reading the listed pages is the finding step, not this check, so the probe takes the pages the run read as `--read <file>`, one path per line).
 *
 *   - The pages are every tracked `docs/**` markdown page (listed through `_sources.mjs`, so its floor and `git ls-files` are inside).
 *   - A page's SOURCE is what it names, read from the page and never listed here: a route it prints (`METHOD /api/path`, collapsed by
 *     `_docs-surface.mjs normalPath`) is the file that mounts the route; a tool it names in backticks is the tool file that defines it
 *     (`name: '<tool>'` in a tracked tool source); a repository path it names in backticks that git tracks is that file (a test and a markdown page are not the code a page describes). A page that names
 *     nothing has no source and is counted in the verdict, not taken for current.
 *   - The dates are the committer dates of the last commit that touched each file, read in one `git log --name-only` pass (a per-file `git log`
 *     per page and source is hundreds of processes). A page is OLDER than its code when its date is before the newest date of its sources.
 *   - A shallow checkout has every file at one commit and every page current: that is `cannot answer`, never a pass.
 *   - Without `--read` the probe cannot tell which stale pages were read: it is `cannot answer` and lists them; with it, a stale page not in
 *     the file is the violation. No stale page holds either way.
 *
 * The failure that bought it (Q-917): the check is named by the docs lens and answered "cannot answer" from a placeholder, while a page's
 * wording about a route or a setting ages silently behind the code that moved (the lens found a refusal text two releases old by reading).
 *
 *     node tools/flow-checks/check-i-docs-deep-pages-older-than-their-code.mjs --read <file of page paths>
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readTrackedSources, trackedSources, isTestFile, REPO_ROOT, SERVER_SOURCE_ROOT } from '../../testing/standalone/_sources.mjs';
import { holds, violated, CannotAnswer, answer, isMain, flagsOf } from './_verdict.mjs';
import { pagesNamingRoutes, normalPath, routesWithSource } from './_docs-surface.mjs';

/** The documentation pages: every tracked markdown file under the docs folder. */
export const docsPages = () => readTrackedSources(['docs'], { ext: ['.md'], floor: 30 });

/** Every tracked tool source: where `name: '<tool>'` is declared. */
const toolSources = () => readTrackedSources([`${SERVER_SOURCE_ROOT}/mcp/tools`], { ext: ['.ts'], floor: 20, specs: false });

/** `Map<tool name, file>`: every `name: '<tool>'` a tool source declares at the top of an object. */
export function toolFiles(sources) {
  const out = new Map();
  for (const { file, text } of sources) for (const m of text.matchAll(/^\s*name:\s*'([a-z][a-z0-9_]+)'/gm)) if (!out.has(m[1])) out.set(m[1], file);
  return out;
}

/** The backticked words of a page. Built fresh per use. */
const backticked = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());

/**
 * `Map<page, Set<source file>>`: what each page describes, from what it names.
 *
 * @param {{ file: string, text: string }[]} pages
 * @param {{ routeFiles: Map<string, string>, tools: Map<string, string>, tracked: Set<string> }} world
 *   `routeFiles` maps `METHOD /normal/path` to the file mounting it; `tools` maps a tool name to its file; `tracked` is every tracked path
 */
export function sourcesOfPages(pages, { routeFiles, tools, tracked }) {
  const named = pagesNamingRoutes(pages);
  const out = new Map(pages.map((p) => [p.file, new Set()]));
  for (const [key, files] of named) {
    const file = routeFiles.get(key);
    if (file) for (const page of files) out.get(page)?.add(file);
  }
  for (const { file: page, text } of pages) {
    for (const word of backticked(text)) {
      if (tools.has(word)) out.get(page).add(tools.get(word));
      else if (tracked.has(word) && !isTestFile(word) && !word.endsWith('.md')) out.get(page).add(word);
    }
  }
  return out;
}

/** `Map<file, 'YYYY-MM-DD'>`: the committer date of the last commit that touched each file, newest first, from one `git log` pass. */
export function lastCommitDates(logText) {
  const dates = new Map();
  let date = null;
  for (const line of logText.split('\n')) {
    const head = /^@(\d{4}-\d{2}-\d{2})$/.exec(line.trim());
    if (head) { date = head[1]; continue; }
    const file = line.trim();
    if (file && date && !dates.has(file)) dates.set(file, date);
  }
  return dates;
}

/** `[{ page, pageDate, sourceDate, source }]`: the pages dated before the newest of their sources. */
export function stalePages(sourceMap, dates) {
  const out = [];
  for (const [page, sources] of sourceMap) {
    const pageDate = dates.get(page);
    if (!pageDate) continue;
    let newest = null;
    for (const s of sources) { const d = dates.get(s); if (d && (!newest || d > newest.date)) newest = { date: d, file: s }; }
    if (newest && newest.date > pageDate) out.push({ page, pageDate, sourceDate: newest.date, source: newest.file });
  }
  return out.sort((a, b) => a.page.localeCompare(b.page));
}

/** `read` is the set of page paths the run read, or `null` when the run did not say. */
export function decide({ stale, pages, withSource }, read) {
  if (pages < 30) throw new CannotAnswer(`only ${pages} documentation pages read: the listing was not read`);
  if (withSource < 5) throw new CannotAnswer(`only ${withSource} page(s) name a route, tool or file the code holds: the sources were not read`);
  const tail = `${pages} pages, ${withSource} with a source, ${stale.length} older than their code`;
  const line = (s) => `${s.page} (${s.pageDate}) is older than ${s.source} (${s.sourceDate})`;
  if (!stale.length) return holds(`no page is older than the code it names (${tail})`);
  if (read === null) throw new CannotAnswer(`${stale.length} page(s) are older than their code and the run named no read list (--read <file>): ${stale.slice(0, 5).map(line).join('; ')}${stale.length > 5 ? `; and ${stale.length - 5} more` : ''}`);
  const unread = stale.filter((s) => !read.has(s.page));
  return unread.length
    ? violated(`${unread.length} page(s) older than their code were not read: ${unread.slice(0, 5).map(line).join('; ')}${unread.length > 5 ? `; and ${unread.length - 5} more` : ''} (${tail})`)
    : holds(`every page older than its code was read (${tail})`);
}

/** What `sourcesOfPages` reads from the checkout: the pages, the file mounting each route, the file of each tool, every tracked path. */
export function realWorld() {
  const pages = docsPages();
  const tracked = new Set(trackedSources(['.'], { ext: null, floor: 200 }));
  const routeFiles = new Map(routesWithSource().map((r) => [`${r.method} ${normalPath(r.path)}`, r.file]));
  return { pages, world: { routeFiles, tools: toolFiles(toolSources()), tracked } };
}

/** The real tree's input for {@link decide}. */
export function realInput() {
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() === 'true') {
    throw new CannotAnswer('the checkout is shallow: every file has one commit date, so no page can be older than its code');
  }
  const { pages, world } = realWorld();
  const sourceMap = sourcesOfPages(pages, world);
  const log = execFileSync('git', ['log', '--name-only', '--no-renames', '--format=@%cs', '--', '.'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return { stale: stalePages(sourceMap, lastCommitDates(log)), pages: pages.length, withSource: [...sourceMap.values()].filter((s) => s.size).length };
}

if (isMain(import.meta.url)) {
  await answer(async () => {
    const { read } = flagsOf(process.argv.slice(2));
    const readSet = read === undefined ? null : new Set(readFileSync(read, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    return decide(realInput(), readSet);
  });
}
