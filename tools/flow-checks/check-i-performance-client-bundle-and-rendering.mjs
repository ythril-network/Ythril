#!/usr/bin/env node
/**
 * check-i-performance-client-bundle-and-rendering: the client carries size budgets, its build meets them, every routed page loads lazily, and a
 * search box that asks the server does not ask on every key.
 *
 * Rule (the flow node's stated assertion): bundle size budget in CI; router file: heavy routes lazy; search inputs debounced.
 *
 *   - BUDGETS. The client's `angular.json` names a default build configuration, and that configuration must carry budgets: an `initial` budget
 *     with a hard (`maximumError`) limit at least, and a budget for a component's styles. Absent: a finding (`budgets`).
 *   - THE BUILD MEETS THEM. The build output (the folder `outputPath` names) is read: `initial` is the sum of the files `index.html` loads (scripts,
 *     module preloads, stylesheets), `any` the largest file, `all` every file, each against its `maximumError` (a size is bytes, `kB`/`MB` are
 *     1024-based as Angular reads them). A build over a limit is a finding. NO BUILD is `cannot answer` with the command that makes it, never a pass.
 *   - LAZY. Every route of the router file loads its page with `loadComponent`, not `component:`, and the router file imports no page statically
 *     (`import { XComponent } from './pages/...'`): a page the router holds eagerly is in the initial bundle. Layout routes that name no page are not
 *     pages. A finding is `route <path>` or `import <name>`.
 *   - DEBOUNCED. A search box is an `<input>` of `type="search"`, or one whose placeholder or label names a search. When it asks something
 *     (its change handler calls a method, rather than only setting a local signal), the component, or a module it imports from the client tree, must
 *     hold a debounce (`debounceTime(`, `debounce(`, `setTimeout(`, or the `latestWins` helper whose `after` is the shared one). A finding is
 *     `search <file>`.
 *   - Exceptions live only in `check-i-performance-client-bundle-and-rendering.allow.json` beside this file (`{ id, reason, reviewBy }`), through
 *     `_allow.mjs`. The verdict says how many it used.
 *
 * The failure that bought it (Q-917): named by the performance lens and answered "cannot answer" from a placeholder, while the owner reported
 * (2026-09-27) the app as "unbearable": each keystroke of a search ran a full server search, and a page added to the router as an eager
 * `component:` ships in everybody's first download.
 *
 *     node tools/flow-checks/check-i-performance-client-bundle-and-rendering.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { ROUTES_FILE } from './_axe.mjs';

const CLIENT = join(REPO_ROOT, 'client');

/** The sizes Angular's budgets name: `500kb`, `1MB`, `8mb`, a bare number is bytes. 1024-based, as Angular reads them. */
export function bytesOf(text) {
  const m = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*$/i.exec(String(text ?? ''));
  if (!m) throw new CannotAnswer(`a budget size the reader does not understand: ${JSON.stringify(text)}`);
  return Math.round(Number(m[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase()]);
}

/** The budgets of the default build configuration of the client's `angular.json` text. */
export function budgetsOf(angularJson) {
  const project = Object.values(JSON.parse(angularJson).projects ?? {}).find((p) => p.architect?.build);
  if (!project) throw new CannotAnswer('angular.json holds no project with a build target');
  const build = project.architect.build;
  const name = build.defaultConfiguration;
  if (!name) throw new CannotAnswer('the build target names no defaultConfiguration: the configuration CI builds was not read');
  return { name, budgets: build.configurations?.[name]?.budgets ?? [], outputPath: build.options?.outputPath };
}

/** `[{ id, text }]`: what is wrong with the budgets themselves. */
export function budgetFindings(budgets, name) {
  const out = [];
  const initial = budgets.find((b) => b.type === 'initial');
  if (!initial?.maximumError) out.push({ id: 'budgets', text: `the ${name} build has no initial-bundle budget with a hard limit (maximumError)` });
  if (!budgets.some((b) => b.type === 'anyComponentStyle')) out.push({ id: 'budgets component styles', text: `the ${name} build has no budget for a component's styles` });
  return out;
}

/** `[{ id, text }]`: the budgets the build output breaks. `dist` is `{ files: [{ file, bytes }], initial: string[] }` (`initial` the files index.html loads). */
export function sizeFindings(budgets, dist) {
  const out = [];
  const size = new Map(dist.files.map((f) => [f.file, f.bytes]));
  const initial = dist.initial.reduce((n, f) => n + (size.get(f) ?? 0), 0);
  const measures = { initial, any: Math.max(0, ...dist.files.map((f) => f.bytes)), all: dist.files.reduce((n, f) => n + f.bytes, 0) };
  for (const b of budgets) {
    if (!(b.type in measures) || !b.maximumError) continue;
    const limit = bytesOf(b.maximumError);
    if (measures[b.type] > limit) out.push({ id: `size ${b.type}`, text: `the ${b.type} size is ${measures[b.type]} bytes, over its ${b.maximumError} limit (${limit} bytes)` });
  }
  return out;
}

/** Where the files of one folder are, recursively, as `[{ file, bytes }]` relative to it. */
function filesUnder(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? filesUnder(p, base) : [{ file: posix.relative(base.split('\\').join('/'), p.split('\\').join('/')), bytes: statSync(p).size }];
  });
}

/** The build output, or `null` when there is none: `{ files, initial }`. */
export function readDist(outputPath) {
  const folder = join(CLIENT, outputPath?.base ?? 'dist', outputPath?.browser ?? 'browser');
  if (!existsSync(join(folder, 'index.html'))) return null;
  const html = readFileSync(join(folder, 'index.html'), 'utf8');
  const initial = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"'#?]+\.(?:js|css|mjs))["']/g)].map((m) => m[1].replace(/^\.?\//, ''));
  return { files: filesUnder(folder), initial };
}

/** `[{ id, text }]`: routes held eagerly, from the router file's text (comments in). */
export function eagerRoutes(routerText) {
  const code = stripComments(routerText);
  const out = [];
  for (const m of code.matchAll(/\bpath\s*:\s*['"`]([^'"`]*)['"`]([^{}]*?)(?:\bcomponent\s*:\s*(\w+))/g)) {
    if (/\bloadComponent\b/.test(m[2])) continue;
    out.push({ id: `route ${m[1] || '/'}`, text: `the route '${m[1]}' holds ${m[3]} eagerly (component:), so its page is in the first download` });
  }
  for (const m of code.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*\/pages\/[^'"]*)['"]/gm)) {
    out.push({ id: `import ${m[1].trim()}`, text: `the router imports ${m[1].trim()} statically from ${m[2]}, so its page is in the first download` });
  }
  return out;
}

/** A debounce: the call forms the client uses. Built fresh per use. */
const debounceRe = () => /\b(?:debounceTime|debounce|setTimeout|latestWins)\s*\(/;

/** The search boxes of a component source (comments stripped): `[{ asks }]`, `asks` when the change handler calls a method. */
export function searchBoxes(code) {
  const out = [];
  for (const m of code.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\btype\s*=\s*["']search["']/.test(tag) && !/(?:placeholder|aria-label)[^>]*?search/i.test(tag)) continue;
    const handler = /\((?:input|ngModelChange)\)\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? '';
    const bound = /\[\(ngModel\)\]|\bformControl(?:Name)?\b/.test(tag);
    out.push({ asks: bound || (handler !== '' && !/\.(?:set|update|emit)\s*\(/.test(handler)) });
  }
  return out;
}

/**
 * `[{ id, text }]`: component sources with a search box that asks and no debounce in it or in what it imports from the client tree (one level).
 *
 * @param {{ file: string, text: string }[]} sources client sources, specs out, comments in
 */
export function undebouncedSearches(sources) {
  const byFile = new Map(sources.map((s) => [s.file, stripComments(s.text)]));
  const out = [];
  for (const { file } of sources) {
    const code = byFile.get(file);
    if (!searchBoxes(code).some((b) => b.asks)) continue;
    const imported = [...code.matchAll(/from\s*['"](\.[^'"]+)['"]/g)].map((m) => posix.normalize(posix.join(posix.dirname(file), m[1])));
    const reach = [file, ...imported.flatMap((p) => [`${p}.ts`, `${p}/index.ts`]).filter((p) => byFile.has(p))];
    if (!reach.some((p) => debounceRe().test(byFile.get(p)))) out.push({ id: `search ${file}`, text: `${file} has a search box that asks on every change and no debounce reaches it` });
  }
  return out;
}

export function decide(input, allow, todayDate) {
  const { budgets, name, dist, routerText, sources } = input;
  if (sources.length < 100) throw new CannotAnswer(`only ${sources.length} client sources read: the listing was not read`);
  if (!/\bpath\s*:/.test(routerText)) throw new CannotAnswer('the router file holds no route: it was not read');
  if (!dist) throw new CannotAnswer('no client build to measure: run npm run build:client, then ask again');
  const findings = [...budgetFindings(budgets, name), ...sizeFindings(budgets, dist), ...eagerRoutes(routerText), ...undebouncedSearches(sources)];
  const { problem, open, used } = applyAllow(findings, allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${budgets.length} budget(s) of the ${name} build, ${dist.files.length} built file(s), ${sources.length} client sources, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} finding(s): ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`budgets are set and met, every page loads lazily and every asking search box is debounced (${tail})`);
}

/** The real tree's input for {@link decide}; `dist` is `null` without a build. */
export function realInput() {
  const { budgets, name, outputPath } = budgetsOf(readFileSync(join(CLIENT, 'angular.json'), 'utf8'));
  const files = trackedSources(['client/src'], { ext: ['.ts'], floor: 100, specs: false }).filter((f) => !/\/testing\//.test(f));
  return {
    budgets, name, dist: readDist(outputPath), routerText: readFileSync(ROUTES_FILE, 'utf8'),
    sources: files.map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') })),
  };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
