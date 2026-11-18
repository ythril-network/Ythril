#!/usr/bin/env node
/**
 * check-i-ux-deep-route-set-derived: a browser sweep takes its routes from the router file, never from a list written in the script, and the
 * count it swept is recorded.
 *
 * Rule (the flow node's stated assertion): routes parsed from the router file; count recorded.
 *
 *   - The subject is every tracked script that drives the client in a browser (a call of `.goto(`), outside the test folders and the probes'
 *     own folder: found by what it does, so a sweep written next year is read the day it lands.
 *   - The reference is the router: `readRoutes()` of `_axe.mjs` reads `app.routes.ts` and returns the pages it serves. A script holds a LITERAL
 *     ROUTE LIST when it names at least three of those routes as string literals (`'/brain'`, `"/settings/tokens"`, with a query or not). That
 *     is measured against the router, not against a pattern of "something that looks like a path", so a script that names two pages for its own
 *     reason (a login page, a deep link) is not a list.
 *   - A script that reads the router (`app.routes`, `deriveRoutes`, `readRoutes`) derives; its literal routes, if any, are a seed it adds to
 *     (the Files tab is a query on `/brain`, not a route).
 *   - The verdict says how many routes the router serves: that is the count a derived sweep covers, and the figure to record beside a sweep run.
 *   - Exceptions live only in `check-i-ux-deep-route-set-derived.allow.json` (id: the script's path), through `_allow.mjs`.
 *
 * The failure that bought it (Q-917): the check is named by the UX lens and answered "cannot answer" from a placeholder; the two sweeps the
 * repository has each carry a written route list (`testing/responsive-sweep.mjs` sixteen paths, `testing/ux-drift-sweep.mjs` a page table), so a
 * page added to the router is never swept and nothing says so (a measurement built from the subject's own list reports clean about it).
 *
 *     node tools/flow-checks/check-i-ux-deep-route-set-derived.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { readRoutes } from './_axe.mjs';

/** Folders whose files are tests or probes, not sweeps: they name routes to test them, and are read by their own gates. */
const NOT_A_SWEEP = [/^testing\/standalone\//, /^tools\/flow-checks\//, /^client\/src\//, /(?:^|\/)node_modules\//];

/** How many of the router's routes a script may name before it holds a list. */
export const LIST_FLOOR = 3;

/** A script that drives the client in a browser: one that navigates it. */
export const drivesTheClient = (code) => /\.\s*goto\s*\(/.test(code);

/** A script that reads the router. */
export const readsTheRouter = (code) => /\bapp\.routes\b|\bderiveRoutes\b|\breadRoutes\b/.test(code);

/** The router's routes a script names as string literals, `['/brain', ...]`: a query on a route counts as the route. Built fresh per use. */
export function namedRoutes(code, routes) {
  const wanted = new Set(routes.map((r) => `/${r}`));
  const found = new Set();
  for (const m of code.matchAll(/(['"`])(\/[A-Za-z0-9_\-/]*)(?:\?[^'"`]*)?\1/g)) if (wanted.has(m[2])) found.add(m[2]);
  return [...found];
}

/**
 * `[{ id, text }]` for every browser script that holds a written route list and does not read the router.
 *
 * @param {{ file: string, text: string }[]} scripts tracked scripts, comments in
 * @param {string[]} routes the router's routes, no leading slash
 */
export function writtenRouteLists(scripts, routes) {
  const out = [];
  for (const { file, text } of scripts) {
    const code = stripComments(text);
    if (!drivesTheClient(code) || readsTheRouter(code)) continue;
    const named = namedRoutes(code, routes);
    if (named.length >= LIST_FLOOR) out.push({ id: file, text: `${file} sweeps a written list of ${named.length} routes (${named.slice(0, 3).join(', ')}${named.length > 3 ? ', ...' : ''}) and does not read the router, so a page added to the router is never swept` });
  }
  return out;
}

export function decide({ scripts, routes }, allow, todayDate) {
  if (routes.length < 10) throw new CannotAnswer(`only ${routes.length} routes derived from the router: it was not read`);
  const sweeps = scripts.filter((s) => drivesTheClient(stripComments(s.text)));
  if (!sweeps.length) throw new CannotAnswer('no tracked script drives the client in a browser: the listing was not read');
  const { problem, open, used } = applyAllow(writtenRouteLists(scripts, routes), allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${routes.length} routes derived from the router, ${sweeps.length} browser script(s) read, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} sweep(s) with a written route list: ${open.map((f) => f.text).join('; ')} (${tail})`)
    : holds(`every browser sweep takes its routes from the router or names too few to be a list (${tail})`);
}

/** The real tree's input for {@link decide}. */
export function realInput() {
  const files = trackedSources(['testing', 'tools', 'scripts'], { ext: ['.mjs', '.js'], floor: 20 }).filter((f) => !NOT_A_SWEEP.some((re) => re.test(f)));
  return { scripts: files.map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') })), routes: readRoutes().routes };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
