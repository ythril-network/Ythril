#!/usr/bin/env node
/**
 * check-i-testing-contract-tests: every public surface has a contract test.
 *
 * Rule (the flow node's stated assertion): derive the public routes and tools from the registries; each is referenced by a test under the
 * project's test directories.
 *
 *   - Routes: every mounted route (`testing/standalone/_routes.mjs`) except the root redirect and the single-page-app fallback (`/{*path}`),
 *     which are the client's, not an API surface. A route is referenced when some tracked test file under `testing/` writes its path, a
 *     parameter being any one segment (a literal, or a template hole `${...}`), and the path ends there (`/api/x/:id` is not met by `/api/x/:id/y`).
 *   - Tools: every entry of `ALL_TOOLS` in the build (`_built-registry.mjs`); referenced when a test names it as a word.
 *   - Tests: `trackedTestFiles({ dirs: ['testing'] })`, from `git ls-files` (its floor is inside, so an empty listing is `cannot answer`).
 *     A test that imports a flow-check probe tests the probe, not the product, and is left out (`surfaceTests`).
 *     "Referenced" is the rule's own word: the probe cannot say a test drives the surface well, only that some test names it, and a surface no
 *     test names has no contract test.
 *   - Exceptions live only in `check-i-testing-contract-tests.allow.json` beside this file (`{ id, reason, reviewBy }`, id `route METHOD path` or
 *     `tool name`), through `_allow.mjs`: each is a surface that still lacks its test, with the date it is reviewed by. The verdict says how many.
 *
 * The failure that bought it (Q-876): the check is named by the plan and audit lenses and answered "cannot answer" from a placeholder, so a
 * route or a tool added with no test naming it was found by a reviewer reading the diff, when it was found.
 *
 *     npm run build:server && node tools/flow-checks/check-i-testing-contract-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holds, violated, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { builtRegistry } from './_built-registry.mjs';
import { routesWithChains } from './_route-chains.mjs';
import { REPO_ROOT, trackedTestFiles } from '../../testing/standalone/_sources.mjs';

/** The root redirect and the single-page-app fallback answer the client, not the API. */
export const isApiSurface = (path) => path !== '/' && !path.includes('{*');

/** A regular expression matching `path` as a test writes it: each parameter one segment, the path ending there. Built per use (a global is shared state). */
export function pathPattern(path) {
  const segments = path.split('/').map((s) => (s.startsWith(':') ? '(?:[^/\\s\'"`?]+|\\$\\{[^}]*\\})' : s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)));
  return new RegExp(`${segments.join('/')}(?![\\w/-])`);
}

/** `[{ id, text }]` for every route and tool no test text names. `testText` is every test file's text joined. */
export function unreferenced({ routes, tools, testText }) {
  const out = [];
  for (const r of routes.filter((x) => isApiSurface(x.path))) {
    if (!pathPattern(r.path).test(testText)) out.push({ id: `route ${r.method} ${r.path}`, text: `${r.method} ${r.path} (${r.file})` });
  }
  for (const t of tools) {
    if (!new RegExp(`\\b${t.name}\\b`).test(testText)) out.push({ id: `tool ${t.name}`, text: `tool ${t.name}` });
  }
  return out;
}

export function decide({ routes, tools, testText, files }, allow, todayDate) {
  const { problem, open, used } = applyAllow(unreferenced({ routes, tools, testText }), allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${routes.length} route(s), ${tools.length} tool(s), ${files} test file(s), ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} surface(s) no test names: ${open.slice(0, 6).map((f) => f.text).join('; ')}${open.length > 6 ? `; and ${open.length - 6} more` : ''} (${tail})`)
    : holds(`every route and every tool is named by a test under testing/ (${tail})`);
}

/**
 * The tests that exercise the product, as `{ file, text }`: a test that imports a flow-check probe (`tools/flow-checks/`) tests that probe,
 * and the routes and tools it names are the ones it plants a defect in, not ones it drives. Found by what the file imports, never by its name.
 */
export const surfaceTests = (tests) => tests.filter((t) => !/tools\/flow-checks\//.test(t.text));

/** The real tree's input for {@link decide}. */
export async function realInput() {
  const reg = await builtRegistry();
  const tests = surfaceTests(trackedTestFiles({ dirs: ['testing'], floor: 50 }).map((f) => ({ file: f, text: readFileSync(join(REPO_ROOT, f), 'utf8') })));
  return { routes: routesWithChains(), tools: reg.ALL_TOOLS, testText: tests.map((t) => t.text).join('\n'), files: tests.length };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(await realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
