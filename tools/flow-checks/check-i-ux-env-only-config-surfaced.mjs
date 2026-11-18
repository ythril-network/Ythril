#!/usr/bin/env node
/**
 * check-i-ux-env-only-config-surfaced: a setting an environment variable pins shows in the settings UI as locked, never as an editable field the
 * server then refuses.
 *
 * Rule (the flow node's stated assertion, in the shape this repository has it). The pinnable settings are the field paths the server lets an
 * operator fix from the environment, `PINNABLE_FIELD_PATHS` (the tracked server module that exports it; the probe reads that one list and keeps none).
 * Each such path the settings UI shows as a control must be answered by a lock marker, in the settings components' source (comments stripped):
 *
 *   - shown:   a component under `client/src/app/pages/settings` reads the path as a member access (`documentProcessing!.renderDpi`, `vision!.baseUrl`),
 *              or, for a top-level field, as `.<field>`. A field no component reads has no control to lock.
 *   - locked:  the path is named inside a lock call (`isLocked('a.b')`, `xLocked('a.b')`); or its leaf is passed to the area's own lock helper
 *              (`embeddingLocked('model')` for `embedding.model`, `faceLocked(...)` for `faceRecognition.*`); or a lock call covers the whole area
 *              (`isLocked('modelSlots.' + slot)`, `` isLocked(`rerank.${field}`) ``).
 *
 * Exceptions live only in `check-i-ux-env-only-config-surfaced.allow.json`: `{ id: "<path>", reason, reviewBy }`. One that has no reason, is past its
 * reviewBy, or excuses a path that is now locked fails the probe; the verdict says how many exceptions it used.
 *
 * The failure that bought it (Q-875): the check was named by the verify phases and answered "cannot answer" from a placeholder; the server refuses a write
 * to a pinned field with a 403, so an input left editable is a control that cannot be saved, with nothing on the page to say why.
 *
 *     node tools/flow-checks/check-i-ux-env-only-config-surfaced.mjs
 */
import { trackedSources, SERVER_CODE_ROOTS, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';

const UI_ROOT_RE = /^client\/src\/app\/pages\/settings\//;

/** The strings of the exported `PINNABLE_FIELD_PATHS` array in a server source (comments stripped), or null when it does not export one. */
export function pinnablePaths(code) {
  const at = /\bexport\s+const\s+PINNABLE_FIELD_PATHS\b[^=]*=\s*\[/.exec(code);
  if (!at) return null;
  const rest = code.slice(at.index + at[0].length);
  const end = rest.indexOf('];');
  return [...rest.slice(0, end < 0 ? undefined : end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is `path` read as a control's model in some component source of `components` (`{ code }`)? */
export function isShown(path, components) {
  const segments = path.split('.');
  const re = segments.length === 1
    ? new RegExp(`\\.\\s*${esc(segments[0])}(?![\\w$])`)
    : new RegExp(`(?<![\\w$])${segments.map(esc).join('[!?]*\\.')}(?![\\w$])`);
  return components.some(({ code }) => re.test(code));
}

/** Is `path` answered by a lock marker somewhere in `sources` (`{ code }`)? */
export function isLockMarked(path, sources) {
  const [area, leaf] = path.split('.');
  const code = sources.map((s) => s.code).join('\n');
  const literal = new RegExp(`\\b\\w*[lL]ocked\\([^)]*['"\`]${esc(path)}['"\`]`);
  if (literal.test(code)) return true;
  if (leaf === undefined) return false;
  for (const m of code.matchAll(new RegExp(`\\b(\\w+?)Locked\\(\\s*['"]${esc(leaf)}['"]`, 'g'))) {
    if (area.toLowerCase().startsWith(m[1].toLowerCase())) return true;
  }
  const dynamic = new RegExp(`\\b\\w*[lL]ocked\\(\\s*(?:['"]${esc(area)}\\.['"]\\s*\\+|\`${esc(area)}\\.\\$\\{)`);
  return dynamic.test(code);
}

/** `[{ id, text }]`: a path the UI shows as a control and nothing locks. */
export function findings(paths, components, sources) {
  return paths
    .filter((p) => isShown(p, components) && !isLockMarked(p, sources))
    .map((p) => ({ id: p, text: `${p} is shown as a control with no lock marker` }));
}

export function decide({ paths, components, sources }, allow, todayDate) {
  const { problem, open, used } = applyAllow(findings(paths, components, sources), allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${paths.length} pinnable path(s), ${components.length} settings component(s), ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} pinnable field(s) shown editable although an environment pin refuses their write: ${open.slice(0, 8).map((f) => f.id).join(', ')}${open.length > 8 ? `, and ${open.length - 8} more` : ''} (${tail})`)
    : holds(`every pinnable field the settings UI shows carries a lock marker (${tail})`);
}

/** The inputs from the checkout at `root`. */
export function readInputs(root = REPO_ROOT) {
  const read = (f) => stripComments(readFileSync(join(root, f), 'utf8'));
  const serverFiles = trackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], specs: false, floor: 100, root });
  const holder = serverFiles.map((file) => ({ file, code: read(file) })).filter(({ code }) => /\bexport\s+const\s+PINNABLE_FIELD_PATHS\b/.test(code));
  if (holder.length !== 1) throw new CannotAnswer(`expected one server module exporting PINNABLE_FIELD_PATHS, found ${holder.length}`);
  const paths = pinnablePaths(holder[0].code);
  if (!paths || paths.length < 30) throw new CannotAnswer(`PINNABLE_FIELD_PATHS read as ${paths?.length ?? 0} path(s): the read is broken`);
  const ui = trackedSources(['client/src/app'], { ext: ['.ts'], specs: false, floor: 100, root }).filter((f) => UI_ROOT_RE.test(f) && !f.endsWith('.spec.ts'));
  const sources = ui.map((file) => ({ file, code: read(file) }));
  const components = sources.filter((s) => s.file.endsWith('.component.ts'));
  if (components.length < 10) throw new CannotAnswer(`only ${components.length} settings component(s) found: the listing is broken`);
  return { paths, components, sources };
}

if (isMain(import.meta.url)) await answer(() => decide(readInputs(), readAllow(allowFileFor(import.meta.url)), today()));
