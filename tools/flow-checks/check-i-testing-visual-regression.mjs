#!/usr/bin/env node
/**
 * check-i-testing-visual-regression: a redesign cannot silently break a page, because a visual test exists and its screenshot list covers every
 * route the router serves.
 *
 * Rule (the flow node's stated assertion): a visual-test config is present; the screenshot test list covers every derived route.
 *
 *   - The routes are `readRoutes()` of `_axe.mjs` (the router file, nested children joined): derived, never written here.
 *   - A visual test is a tracked test or script (outside the probes' and the standalone suite's own folders, which name the matchers to test
 *     them) that calls an image-comparing matcher: `toHaveScreenshot(`, `toMatchImageSnapshot(`, `matchImageSnapshot(` or `pixelmatch(`. A
 *     visual-test config is one of those files, a tracked `package.json` that depends on a visual-regression service or tool (Percy, Chromatic,
 *     Loki, BackstopJS, reg-suit), or a tracked screenshot snapshot folder. None of them is a finding of its own: no config is ONE finding.
 *   - With a config, each route is covered when a visual test names it as a string literal, or the test reads the router itself (`app.routes`,
 *     `deriveRoutes`, `readRoutes`: it covers whatever the router serves). A route no visual test covers is a finding, id `route <path>`.
 *   - Exceptions live only in `check-i-testing-visual-regression.allow.json` beside this file (`{ id, reason, reviewBy }`; ids `no visual-test
 *     config` and `route <path>`), through `_allow.mjs`. An exception for a config that now exists is refused ("excuses nothing"): adding the
 *     tests removes the entry and the per-route findings start.
 *
 * The failure that bought it (Q-917): named by the UX and testing lenses and answered "cannot answer" from a placeholder, while the repository's
 * only screenshots are taken by a sweep that needs a running instance and reads no baseline: a redesign that breaks a page shows nowhere until
 * the owner looks at it.
 *
 *     node tools/flow-checks/check-i-testing-visual-regression.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { readRoutes } from './_axe.mjs';

/** Where a matcher is named to be tested, not used. */
const NAMES_THE_MATCHERS = [/^testing\/standalone\//, /^tools\/flow-checks\//, /(?:^|\/)node_modules\//];

/** The image-comparing calls. Built fresh per use. */
const matcherRe = () => /\b(?:toHaveScreenshot|toMatchImageSnapshot|matchImageSnapshot|pixelmatch)\s*\(/;

/** A visual-regression tool a package manifest may depend on. */
const VISUAL_DEPENDENCY = /["'](?:@percy\/[\w-]+|chromatic|loki|backstopjs|reg-suit|@loki\/[\w-]+|jest-image-snapshot|playwright-visual-regression)["']\s*:/;

/** A tracked folder that holds baseline screenshots. */
const SNAPSHOT_FOLDER = /(?:^|\/)(?:__screenshots__|__image_snapshots__|[\w.-]+-snapshots)\//;

/** The tracked scripts and tests that call an image matcher: `[{ file, text }]` of `sources` (comments in), the visual tests. */
export const visualTests = (sources) => sources.filter(({ file, text }) => /\.(?:[cm]?js|ts)$/.test(file) && matcherRe().test(stripComments(text)));

/** The router read by a test: it covers whatever the router serves. */
const readsTheRouter = (code) => /\bapp\.routes\b|\bderiveRoutes\b|\breadRoutes\b/.test(code);

/**
 * The evidence of a visual-test config, as strings: the visual tests, a manifest that depends on a visual tool, a snapshot folder.
 *
 * @param {{ file: string, text: string }[]} sources tracked text files outside the folders that name the matchers
 * @param {string[]} allFiles every tracked path (for the snapshot folders)
 */
export function configEvidence(sources, allFiles) {
  const out = visualTests(sources).map((t) => `${t.file} calls an image comparison`);
  for (const { file, text } of sources) if (/(?:^|\/)package\.json$/.test(file) && VISUAL_DEPENDENCY.test(text)) out.push(`${file} depends on a visual-regression tool`);
  const folder = allFiles.find((f) => SNAPSHOT_FOLDER.test(f));
  if (folder) out.push(`${folder} is a snapshot folder`);
  return out;
}

/** `[{ id, text }]`: no config is one finding; with a config, every route no visual test covers. */
export function visualFindings({ sources, allFiles, routes }) {
  if (!configEvidence(sources, allFiles).length) {
    return [{ id: 'no visual-test config', text: `no tracked test compares a screenshot with a baseline (no image matcher, visual-regression dependency or snapshot folder), so none of the ${routes.length} routes is covered` }];
  }
  const tests = visualTests(sources).map((t) => stripComments(t.text));
  if (tests.some(readsTheRouter)) return [];
  const named = (route) => tests.some((code) => code.includes(`'/${route}'`) || code.includes(`"/${route}"`) || code.includes(`\`/${route}\``) || code.includes(`'${route}'`) || code.includes(`"${route}"`));
  return routes.filter((r) => !named(r)).map((r) => ({ id: `route ${r}`, text: `no visual test covers the route /${r}` }));
}

export function decide(input, allow, todayDate) {
  if (input.routes.length < 10) throw new CannotAnswer(`only ${input.routes.length} routes derived from the router: it was not read`);
  if (input.sources.length < 20) throw new CannotAnswer(`only ${input.sources.length} tracked text files read: the listing was not read`);
  const { problem, open, used } = applyAllow(visualFindings(input), allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${input.routes.length} routes derived from the router, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} gap(s) in visual regression: ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`a visual-test config exists and its screenshot tests cover every route (${tail})`);
}

/** The real tree's input for {@link decide}. */
export function realInput() {
  const allFiles = trackedSources(['.'], { ext: null, floor: 200 });
  const files = allFiles.filter((f) => !NAMES_THE_MATCHERS.some((re) => re.test(f)) && /\.(?:[cm]?js|ts|json)$/.test(f));
  return { allFiles, sources: files.map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') })), routes: readRoutes().routes };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
