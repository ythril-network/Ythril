#!/usr/bin/env node
/**
 * check-i-ux-unsaved-changes-guard: every editable form guards unsaved changes, and every route that loads a page registers the leave guard.
 *
 * Rule (the flow node's stated assertion, read from the client source with comments stripped; every list comes from `git ls-files`):
 *
 *   - Routes. Each tracked route table (`*.routes.ts` under `client/src`) is built through `guardEveryPage(...)`, so every `loadComponent` or
 *     `component` in it sits inside that call, and `guardEveryPage` in `core/unsaved-edits.ts` really adds `unsavedEditsGuard` to a route that
 *     loads a component, as a `canDeactivate` guard. A route table written as a bare array, or a route outside the call, can be left without asking.
 *   - Forms. Each tracked non-spec `*.component.ts` whose template holds an editable control (`<input`, `<textarea`, `<select`, `contenteditable`)
 *     calls `holdUnsavedEdits(`, or is listed in `NOT_A_DRAFT` of `client/src/app/testing/unsaved-edits-are-held.spec.ts`, which carries its
 *     reason. The probe reads that one list from the spec's own source and keeps none of its own.
 *
 * The failure that bought it (Q-875): the check was named by the verify phases and answered "cannot answer" from a placeholder, although the
 * client spec (vitest) holds the same rule: a flow run that cannot start the client suite had no answer. This probe needs only git and files.
 *
 *     node tools/flow-checks/check-i-ux-unsaved-changes-guard.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';

const GUARD_SPEC = 'client/src/app/testing/unsaved-edits-are-held.spec.ts';
const GUARD_MODULE = 'client/src/app/core/unsaved-edits.ts';
const CONTROL = /<(?:input|textarea|select)\b|\bcontenteditable\b/;

/** The text between the parenthesis at `open` and its match, strings and template literals skipped; null when it never closes. */
function balanced(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i += 1; i < code.length && code[i] !== c; i += code[i] === '\\' ? 2 : 1);
    } else if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return { from: open, to: i }; }
  }
  return null;
}

/** `[{ file, line, problem }]`: what is wrong with one route table's source (comments already stripped), empty when every page route is guarded. */
export function unguardedRoutes(file, code) {
  const loads = [...code.matchAll(/\b(?:loadComponent|component)\s*:/g)].map((m) => m.index);
  if (!loads.length) return [];
  const call = /\bguardEveryPage\s*\(/.exec(code);
  const range = call ? balanced(code, call.index + call[0].length - 1) : null;
  const lineOf = (at) => code.slice(0, at).split('\n').length;
  if (!range) return [{ file, line: lineOf(loads[0]), problem: 'the route table is not built through guardEveryPage(...)' }];
  return loads.filter((at) => at < range.from || at > range.to).map((at) => ({ file, line: lineOf(at), problem: 'a route that loads a component stands outside guardEveryPage(...)' }));
}

/** Does `guardEveryPage` in the guard module add `unsavedEditsGuard` to a route that loads a component, as `canDeactivate`? */
export function guardModuleAddsGuard(code) {
  const at = /\bfunction\s+guardEveryPage\b/.exec(code);
  if (!at) return false;
  const body = code.slice(at.index, at.index + 2000);
  return /loadComponent/.test(body) && /canDeactivate/.test(body) && /unsavedEditsGuard/.test(body);
}

/** The file keys of the spec's `NOT_A_DRAFT` (`'src/app/...'`, relative to `client/`), as `client/src/app/...`. */
export function notADraft(specText) {
  const at = /\bNOT_A_DRAFT\b[^=]*=\s*\{/.exec(specText);
  if (!at) throw new CannotAnswer(`${GUARD_SPEC} has no NOT_A_DRAFT list to read`);
  const rest = specText.slice(at.index + at[0].length);
  const end = rest.search(/^\};/m);
  const keys = [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/^\s*'(src\/app\/[^']+)'\s*:/gm)].map((m) => `client/${m[1]}`);
  if (!keys.length) throw new CannotAnswer(`${GUARD_SPEC}: NOT_A_DRAFT holds no entries: the read is broken`);
  return new Set(keys);
}

/** `[file]`: components with an editable control that neither hold a draft nor are listed as holding none. */
export function silentForms(components, listed) {
  return components
    .filter(({ code }) => CONTROL.test(code) && !/\bholdUnsavedEdits\s*\(/.test(code))
    .map(({ file }) => file)
    .filter((file) => !listed.has(file));
}

export function decide({ tables, guardCode, components, listed }) {
  const bad = tables.flatMap(({ file, code }) => unguardedRoutes(file, code));
  if (!guardModuleAddsGuard(guardCode)) bad.push({ file: GUARD_MODULE, line: 1, problem: 'guardEveryPage no longer adds unsavedEditsGuard to a route that loads a component as canDeactivate' });
  if (bad.length) return violated(`${bad.length} route problem(s): ${bad.slice(0, 5).map((b) => `${b.file}:${b.line} ${b.problem}`).join('; ')}`);
  const silent = silentForms(components, listed);
  if (silent.length) return violated(`${silent.length} component(s) hold an editable control and register no draft (holdUnsavedEdits) nor sit in NOT_A_DRAFT: ${silent.slice(0, 5).join(', ')}${silent.length > 5 ? `, and ${silent.length - 5} more` : ''}`);
  const holders = components.filter(({ code }) => /\bholdUnsavedEdits\s*\(/.test(code)).length;
  return holds(`${tables.length} route table(s) are built through guardEveryPage, and every one of ${components.filter(({ code }) => CONTROL.test(code)).length} component(s) with an editable control holds its draft (${holders}) or is listed in NOT_A_DRAFT (${listed.size})`);
}

/** The inputs from the checkout at `root`: comment-stripped route tables and components, the guard module and the spec's list. */
export function readClient(root = REPO_ROOT) {
  const files = trackedSources(['client/src'], { ext: ['.ts'], specs: false, floor: 100, root }).filter((f) => !f.endsWith('.spec.ts'));
  const read = (f) => stripComments(readFileSync(join(root, f), 'utf8'));
  const tables = files.filter((f) => /\.routes\.ts$/.test(f)).map((file) => ({ file, code: read(file) }));
  if (!tables.length) throw new CannotAnswer('no tracked *.routes.ts under client/src');
  const components = files.filter((f) => f.endsWith('.component.ts')).map((file) => ({ file, code: read(file) }));
  if (components.length < 20) throw new CannotAnswer(`only ${components.length} component(s) found under client/src: the listing is broken`);
  return { tables, guardCode: read(GUARD_MODULE), components, listed: notADraft(readFileSync(join(root, GUARD_SPEC), 'utf8')) };
}

if (isMain(import.meta.url)) await answer(() => decide(readClient()));
