#!/usr/bin/env node
/**
 * check-i-legal-about-page-attribution: the in-product About page attributes every third party whose licence requires it, and NOTICE names each.
 *
 * Rule (the flow node's stated assertion: every package in the licence report whose licence requires attribution appears in the About source and in
 * NOTICE). The licence report is the lock file; the set is derived, never listed:
 *
 *   - Packages: the direct production `dependencies` of `server/package.json` and `client/package.json` (what ships in the image and the browser bundle,
 *     the set `notice-coverage.test.js` holds), less the repository's own packages. A package's licence is its entry in `package-lock.json`
 *     (`node_modules/<name>`, or under its workspace). A licence expression needs attribution unless one alternative of it is a no-attribution
 *     licence (0BSD, CC0-1.0, Unlicense, WTFPL); a package whose lock entry states no licence counts as needing it.
 *   - `notice:<name>`: NOTICE carries the package's name (case-insensitive, as `notice-coverage.test.js` reads it).
 *   - `about:unattributed`: the About source (the tracked `about.component.ts` and the `about.*` keys of the English locale file) names every such package,
 *     or carries a pointer to the notices (`NOTICE`, "third-party", "open source", "licence"). An About page with neither attributes nobody.
 *
 * Exceptions live only in `check-i-legal-about-page-attribution.allow.json` (`{ id, reason, reviewBy }`); one with no reason, past its reviewBy, or that
 * excuses nothing any more fails the probe; the verdict says how many it used.
 *
 * The failure that bought it (Q-875): the check was named by the verify phases and answered "cannot answer" from a placeholder, so the About page went on
 * showing an instance's identity and disk use and no attribution, and nothing noticed.
 *
 *     node tools/flow-checks/check-i-legal-about-page-attribution.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { packagesOf } from '../../testing/standalone/_notice-closure.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';

const NO_ATTRIBUTION = new Set(['0BSD', 'CC0-1.0', 'Unlicense', 'WTFPL']);
/** A pointer to the notices: the file's name (exactly as NOTICE is spelt) or the words a reader finds the licences by. */
const hasPointer = (text) => /\bNOTICE\b/.test(text) || /third[- ]party|open[- ]source|\blicen[cs]es?\b/i.test(text);
const MIN_PACKAGES = 25;

/** Does a licence expression (`MIT`, `(MPL-2.0 OR Apache-2.0)`, null) need attribution? One no-attribution alternative of an OR frees it. */
export function requiresAttribution(expression) {
  if (!expression) return true;
  const alternatives = String(expression).replace(/[()]/g, '').split(/\s+OR\s+/i).map((a) => a.trim());
  return !alternatives.some((a) => NO_ATTRIBUTION.has(a));
}

/** `[{ where, name, license }]`: the direct production dependencies of the workspaces, less the repository's own packages. */
export function productionPackages(manifests, packages, ownNames = []) {
  const own = new Set([...manifests.map((m) => m.manifest.name), ...ownNames]);
  const out = [];
  for (const { where, manifest } of manifests) {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (own.has(name)) continue;
      const entry = packages[`${where}/node_modules/${name}`] ?? packages[`node_modules/${name}`];
      out.push({ where, name, license: entry?.license ?? null });
    }
  }
  return out;
}

/** `[{ id, text }]`. `aboutText` is the About page's source text, `notice` the NOTICE text. */
export function findings(pkgs, aboutText, notice) {
  const need = pkgs.filter((p) => requiresAttribution(p.license));
  const noticeLc = notice.toLowerCase();
  const aboutLc = aboutText.toLowerCase();
  /** The package's name as a whole token: `marked` is not named by `remarked`, nor `zod` by `zodiac`. */
  const named = (p) => new RegExp(`(?<![\\w@/-])${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`).test(aboutLc);
  const out = need.filter((p) => !noticeLc.includes(p.name.toLowerCase())).map((p) => ({ id: `notice:${p.name}`, text: `NOTICE does not name ${p.name} (${p.license ?? 'no licence in the lock'})` }));
  const unnamed = need.filter((p) => !named(p));
  if (unnamed.length && !hasPointer(aboutText)) out.push({ id: 'about:unattributed', text: `the About page names ${need.length - unnamed.length} of ${need.length} package(s) that need attribution and carries no pointer to NOTICE or the third-party licences (unnamed: ${unnamed.slice(0, 4).map((p) => p.name).join(', ')}${unnamed.length > 4 ? ', ...' : ''})` });
  return out;
}

export function decide({ pkgs, aboutText, notice }, allow, todayDate) {
  if (pkgs.length < MIN_PACKAGES) throw new CannotAnswer(`only ${pkgs.length} production dependencies were read (floor ${MIN_PACKAGES}): the manifests or the lock are broken`);
  const { problem, open, used } = applyAllow(findings(pkgs, aboutText, notice), allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${pkgs.filter((p) => requiresAttribution(p.license)).length} of ${pkgs.length} package(s) need attribution, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} attribution gap(s): ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`NOTICE names every package that needs attribution and the About page names it or points to the notices (${tail})`);
}

/** The inputs from the checkout at `root`: the one About component and the one English locale file are found by `git ls-files`. */
export function readInputs(root = REPO_ROOT) {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const tracked = trackedSources(['client'], { ext: null, floor: 100, root });
  const about = tracked.filter((f) => /(^|\/)about\.component\.ts$/.test(f));
  const en = tracked.filter((f) => /\/i18n\/en\.json$/.test(f));
  if (about.length !== 1 || en.length !== 1) throw new CannotAnswer(`expected one About component and one English locale file, found ${about.length} and ${en.length}`);
  const keys = Object.entries(JSON.parse(read(en[0]))).filter(([k]) => k.startsWith('about.')).map(([k, v]) => `${k}: ${v}`).join('\n');
  const manifests = ['server', 'client'].map((where) => ({ where, manifest: JSON.parse(read(`${where}/package.json`)) }));
  return { pkgs: productionPackages(manifests, packagesOf(read('package-lock.json')), [JSON.parse(read('schema/package.json')).name]), aboutText: `${stripComments(read(about[0]))}\n${keys}`, notice: read('NOTICE') };
}

if (isMain(import.meta.url)) await answer(() => decide(readInputs(), readAllow(allowFileFor(import.meta.url)), today()));
