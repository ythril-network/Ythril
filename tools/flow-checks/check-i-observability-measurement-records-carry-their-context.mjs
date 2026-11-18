#!/usr/bin/env node
/**
 * check-i-observability-measurement-records-carry-their-context: every record of a measurement store carries what it was, where it was taken,
 * the layout it was written in, the key a re-run is found by and the mark that says it was finished.
 *
 * Rule (the flow node's stated assertion): outcome, scope, layout version, re-run key and end marker are present on each store's records, so
 * that a re-run does not overwrite a red first attempt, two shards do not collide, a slow local run or a partial selection does not enter the
 * same baseline, and a cancelled job's torn file does not read as whole.
 *
 *   - The stores are the record types the repository declares: every export of `scripts/_shared/telemetry-record.mjs` that is a spec (an object
 *     with a `type` and a `schema`: `Test-Run`, `Trade`, `Preflight-Run` and the next). A spec an export holds that `TELEMETRY_SPECS` (the list the
 *     recorders and the type declaration read) does not hold is a finding of its own: a store written outside the list is declared nowhere.
 *   - Per store, read from its schema: `outcome` (a field named so), `scope` (likewise), `layout version` (`formatVersion`, the number a reader
 *     skips a layout it does not know by), `re-run key` (`recordKey`, a required string: that it names the attempt and the shard is the writers'
 *     own key tests', which this probe does not restate), and `end marker` (the `outcome` field's values hold `incomplete`, or the schema names an `endedAt`,
 *     `endsAt`, `complete`, `sentinel` or `endMarker` field: the way a torn file is told from a whole one).
 *   - `--base <ref>` scopes the question to the stores a change touches: a store is in scope when a file of `git diff --name-only <ref>` holds its
 *     spec's name. Without it every store is read.
 *   - Exceptions live only in `check-i-observability-measurement-records-carry-their-context.allow.json` beside this file (`{ id, reason,
 *     reviewBy }`, id `<type> :: <field>`), through `_allow.mjs`. The verdict says how many it used.
 *
 * The failure that bought it (Q-917): named by the observability lens and answered "cannot answer" from a placeholder, while a measurement store
 * that lacked one of the five (a record keyed by run id alone, a baseline that took local runs) was found by reading its writer after the fact.
 *
 *     node tools/flow-checks/check-i-observability-measurement-records-carry-their-context.mjs [--base <ref>]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { holds, violated, CannotAnswer, answer, isMain, flagsOf } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';

const END_MARKER_FIELDS = ['endedAt', 'endsAt', 'complete', 'sentinel', 'endMarker'];

/** `[{ id, text }]`: what one store's schema lacks. `spec` is `{ type, schema }`. */
export function storeFindings(spec) {
  const s = spec.schema ?? {};
  const out = [];
  const lacks = (field, why) => out.push({ id: `${spec.type} :: ${field}`, text: `${spec.type} has no ${field}: ${why}` });
  if (!s.outcome) lacks('outcome', 'a failed or cut-short measurement reads like a good one');
  if (!s.scope) lacks('scope', 'a partial selection or a slow local run enters the same baseline as a full one');
  if (s.formatVersion?.type !== 'number') lacks('layout version', 'a reader cannot skip a record of a layout it does not know (formatVersion)');
  if (s.recordKey?.type !== 'string' || s.recordKey.required !== true) lacks('re-run key', 'a re-run cannot be found by its identity (a required recordKey)');
  const marked = (s.outcome?.values ?? []).includes('incomplete') || END_MARKER_FIELDS.some((f) => s[f]);
  if (!marked) lacks('end marker', 'a cancelled job\'s torn file reads as whole (no incomplete outcome and no end field)');
  return out;
}

/**
 * The stores in scope and the findings.
 *
 * @param {{ exportedSpecs: object[], registry: object[], changed: Set<string>|null, filesHolding: (name: string) => string[] }} input
 *   `exportedSpecs` every spec the declaring module exports, with `name`; `registry` the list the recorders read; `changed` the files of the diff, or null
 */
export function measurementFindings({ exportedSpecs, registry, changed, filesHolding }) {
  const registered = new Set(registry);
  const inScope = exportedSpecs.filter((s) => !changed || filesHolding(s.name).some((f) => changed.has(f)));
  const out = [];
  for (const s of inScope) {
    if (!registered.has(s.spec)) out.push({ id: `${s.spec.type} :: registry`, text: `${s.spec.type} (${s.name}) is declared and is not in TELEMETRY_SPECS, so the recorders and the type declaration do not know it` });
    out.push(...storeFindings(s.spec));
  }
  return { findings: out, stores: inScope.length };
}

export function decide(input, allow, todayDate) {
  if (input.exportedSpecs.length < 3) throw new CannotAnswer(`only ${input.exportedSpecs.length} measurement store(s) found in the declaring module: it was not read`);
  const { findings, stores } = measurementFindings(input);
  const { problem, open, used } = applyAllow(findings, allow, todayDate);
  if (problem) return violated(problem);
  const scope = input.changed ? `${stores} of ${input.exportedSpecs.length} store(s) touched by the diff` : `${stores} store(s)`;
  const tail = `${scope}, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} missing: ${open.slice(0, 6).map((f) => f.text).join('; ')}${open.length > 6 ? `; and ${open.length - 6} more` : ''} (${tail})`)
    : holds(`every measurement store carries outcome, scope, layout version, re-run key and an end marker (${tail})`);
}

/** The module that declares the stores, repo-relative. */
export const DECLARING_MODULE = 'scripts/_shared/telemetry-record.mjs';

/** The real tree's input for {@link decide}; `base` is a git ref or undefined. */
export async function realInput(base) {
  const mod = await import(new URL(`../../${DECLARING_MODULE}`, import.meta.url).href);
  const exportedSpecs = Object.entries(mod)
    .filter(([name, v]) => /_SPEC$/.test(name) && v && typeof v === 'object' && typeof v.type === 'string' && v.schema && typeof v.schema === 'object')
    .map(([name, spec]) => ({ name, spec }));
  if (!Array.isArray(mod.TELEMETRY_SPECS)) throw new CannotAnswer('the declaring module exports no TELEMETRY_SPECS list');
  let changed = null;
  if (base !== undefined) {
    try { changed = new Set(execFileSync('git', ['diff', '--name-only', base], { cwd: REPO_ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)); }
    catch (e) { throw new CannotAnswer(`git cannot diff against ${base}: ${String(e.message).split('\n')[0]}`); }
  }
  const files = trackedSources(['scripts', 'testing/_shared'], { ext: ['.mjs'], floor: 20 }).map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));
  const filesHolding = (name) => files.filter((f) => new RegExp(`\\b${name}\\b`).test(f.text)).map((f) => f.file);
  return { exportedSpecs, registry: mod.TELEMETRY_SPECS, changed, filesHolding };
}

if (isMain(import.meta.url)) {
  await answer(async () => {
    const { base } = flagsOf(process.argv.slice(2));
    return decide(await realInput(base), readAllow(allowFileFor(import.meta.url)), today());
  });
}
