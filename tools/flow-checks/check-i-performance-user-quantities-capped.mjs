#!/usr/bin/env node
/**
 * check-i-performance-user-quantities-capped: every user-controlled quantity (upload size, page count, result size) has a documented cap.
 *
 * Rule (the flow node's stated assertion): derive the size and count limits from the input schemas; one that lacks `maxItems`, `maximum` or
 * `maxLength`, or that the docs omit, is a finding.
 *
 *   - Counts: every array property of every tool's input schema (`ALL_TOOLS` in the build, walked through nested objects and items) declares
 *     `maxItems`.
 *   - Sizes and pages: every numeric property declares `maximum`, except the result-budget fields (`BUDGET_REQUEST_FIELDS` of
 *     `brain/result-budget.ts`: found there, not listed here), which are capped by the clamp of that file when it still clamps to
 *     `MAX_MAX_BYTES`. A numeric property with neither is a quantity a caller sets without a stated ceiling.
 *   - Bounds the docs must carry: every numeric constant exported by `util/request-bounds.ts` (the one place the request bounds live) is
 *     named in a tracked page under `docs/`, or its value is (digits with a thousands separator, or in KiB or MiB).
 *   - Exceptions live only in `check-i-performance-user-quantities-capped.allow.json` beside this file (`{ id, reason, reviewBy }`, id
 *     `tool.path` or `constant NAME`), through `_allow.mjs`: a quantity the project has decided to leave without a schema ceiling, with the
 *     reason. The verdict says how many it used.
 *   - A build older than its source, or missing, is `cannot answer` with the build command (`_built-registry.mjs`).
 *
 * The failure that bought it (Q-876): the check is named by the plan and audit lenses and answered "cannot answer" from a placeholder, so a new
 * list or page-size parameter was judged by reading whether it had a ceiling.
 *
 *     npm run build:server && node tools/flow-checks/check-i-performance-user-quantities-capped.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holds, violated, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { builtRegistry, SPACE_SCHEMAS } from './_built-registry.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { REPO_ROOT, SERVER_SOURCE_ROOT, readTrackedSources } from '../../testing/standalone/_sources.mjs';
import { CannotAnswer } from './_verdict.mjs';

export const BUDGET_FILE = `${SERVER_SOURCE_ROOT}/brain/result-budget.ts`;
export const BOUNDS_FILE = `${SERVER_SOURCE_ROOT}/util/request-bounds.ts`;

/** The fields the result-budget clamp caps, when the file still clamps to its ceiling; `[]` when it does not (then they are findings). */
export function budgetCappedFields(budgetText) {
  const code = stripComments(budgetText);
  const list = /BUDGET_REQUEST_FIELDS[^=]*=\s*Object\.freeze\(\s*\[([^\]]*)\]/.exec(code);
  if (!list) throw new CannotAnswer(`${BUDGET_FILE} no longer declares BUDGET_REQUEST_FIELDS: the budget fields cannot be read`);
  const clamps = /Math\.min\([^;]*\bMAX_MAX_BYTES\b/.test(code);
  return clamps ? [...list[1].matchAll(/'(\w+)'/g)].map((m) => m[1]) : [];
}

/** `[{ id, text }]`: the arrays without `maxItems` and the numbers without `maximum` of each tool's input schema. */
export function uncappedProperties(tools, schemas, budgetFields) {
  const out = [];
  const budget = new Set(budgetFields);
  for (const t of tools) {
    const walk = (p, path) => {
      if (!p || typeof p !== 'object') return;
      const leaf = path.split('.').pop().replace(/\[\]$/, '');
      if (p.type === 'array' && p.maxItems === undefined) out.push({ id: `${t.name}.${path}`, text: `${t.name}.${path} is a list with no maxItems` });
      if ((p.type === 'number' || p.type === 'integer') && p.maximum === undefined && p.exclusiveMaximum === undefined && !(budget.has(leaf) && path === leaf)) {
        out.push({ id: `${t.name}.${path}`, text: `${t.name}.${path} is a number with no maximum` });
      }
      for (const [k, v] of Object.entries(p.properties ?? {})) walk(v, `${path}.${k}`);
      if (p.items) walk(p.items, `${path}[]`);
    };
    for (const [k, v] of Object.entries(t.inputSchema(schemas).properties ?? {})) walk(v, k);
  }
  return out;
}

/** `[{ name, value }]` for each `export const NAME = <number expression>;` of the bounds file (digits, `_`, `*`). */
export function boundConstants(boundsText) {
  const out = [];
  for (const m of stripComments(boundsText).matchAll(/^export const (\w+)\s*=\s*([\d_ *]+);/gm)) {
    out.push({ name: m[1], value: m[2].split('*').reduce((a, f) => a * Number(f.replace(/[_ ]/g, '')), 1) });
  }
  return out;
}

/** Is the constant stated in the docs: its name, its value with any thousands separator, or its value in KiB or MiB. */
export function documented(c, docsText) {
  if (new RegExp(`\\b${c.name}\\b`).test(docsText)) return true;
  const grouped = String(c.value).replace(/\B(?=(\d{3})+(?!\d))/g, '[ ,._\\u00a0\\u202f]?');
  const forms = [`(?<![\\d.])${grouped}(?![\\d])`];
  if (c.value % 1024 === 0) forms.push(`(?<![\\d.])${c.value / 1024}\\s?(?:KiB|KB|kB)\\b`);
  if (c.value % 1_048_576 === 0) forms.push(`(?<![\\d.])${c.value / 1_048_576}\\s?(?:MiB|MB)\\b`);
  return forms.some((f) => new RegExp(f).test(docsText));
}

export function decide({ tools, schemas, budgetText, boundsText, docsText }, allow, todayDate) {
  const constants = boundConstants(boundsText);
  if (constants.length < 8) throw new CannotAnswer(`only ${constants.length} bound constant(s) read from ${BOUNDS_FILE}: the file was not read`);
  const findings = [
    ...uncappedProperties(tools, schemas, budgetCappedFields(budgetText)),
    ...constants.filter((c) => !documented(c, docsText)).map((c) => ({ id: `constant ${c.name}`, text: `${c.name} (${c.value}) is in no docs page` })),
  ];
  const { problem, open, used } = applyAllow(findings, allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${tools.length} tool(s), ${constants.length} bound constant(s), ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} uncapped or undocumented quantity(ies): ${open.slice(0, 6).map((f) => f.text).join('; ')}${open.length > 6 ? `; and ${open.length - 6} more` : ''} (${tail})`)
    : holds(`every list and number of the tool schemas has its ceiling and every request bound is in the docs (${tail})`);
}

/** The real tree's input for {@link decide}. */
export async function realInput() {
  const reg = await builtRegistry();
  return {
    tools: reg.ALL_TOOLS, schemas: SPACE_SCHEMAS,
    budgetText: readFileSync(join(REPO_ROOT, BUDGET_FILE), 'utf8'), boundsText: readFileSync(join(REPO_ROOT, BOUNDS_FILE), 'utf8'),
    docsText: readTrackedSources(['docs'], { ext: ['.md'], floor: 10 }).map((s) => s.text).join('\n'),
  };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(await realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
