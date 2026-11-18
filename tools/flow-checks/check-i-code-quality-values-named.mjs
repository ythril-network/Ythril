#!/usr/bin/env node
/**
 * check-i-code-quality-values-named: no unnamed number literal stands in the source, and no comment repeats the value of an exported constant.
 *
 * Rule (the flow node's stated assertion, read from the tracked non-spec `.ts` of `server/src`, `schema/src` and `client/src/app`; the file lists are
 * `git ls-files`, never a list). The repository has no ESLint, so the probe is its own `no-magic-numbers`:
 *
 *   - `unnamed-literals`: a number literal other than 0 and 1, in code with comments and string contents removed, on a line that does not name it: the
 *                    initialiser of a `const` or `readonly`, an `UPPER_CASE` member or key, or an import or export line.
 *   - `prose-repeats`:   an exported `UPPER_CASE` numeric constant of 100 or more whose value is written again in a comment of its own file (a count
 *                    in prose rots: the comment should say the rule, or name the constant).
 *
 * Neither count is zero today, and neither can be cleared in one bundle, so each is a ratchet: `check-i-code-quality-values-named.allow.json` holds a
 * ceiling `{ id: "<measure>:<root>", max, reason, reviewBy }` per measure and root, and a new unnamed literal or a new repeat is over its ceiling and
 * fails the probe. A ceiling above its measure is reported in the verdict, to be lowered. Whether a constant's NAME carries its reason is review
 * (judgement), not this check.
 *
 * The failure that bought it (Q-875): the check was named by the plan and verify phases and answered "cannot answer" from a placeholder, so a magic
 * number was found by a reader when it was found at all.
 *
 *     node tools/flow-checks/check-i-code-quality-values-named.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyCeilings, today } from './_allow.mjs';

/** The roots the probe reads, each the `src` tree of one package. */
export const ROOTS = Object.freeze(['server/src', 'schema/src', 'client/src/app']);

/** A line that gives its number a name: a `const`/`readonly` declaration, an `UPPER_CASE` member or key, an import or export-from line. */
const NAMING_LINE = /^\s*(?:export\s+)?(?:declare\s+)?(?:const|(?:static\s+)?readonly)\s|^\s*[A-Z][A-Z0-9_]*\s*[:=]|^\s*(?:import|export)\b.*\bfrom\b/;

/** Code with every string and template literal emptied, so a number inside one is not a literal. Built fresh per call. */
const withoutStrings = (code) => code
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
  .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");

/** The number literals other than 0 and 1 on unnamed lines of one source, as `{ line, value }`. */
export function unnamedLiterals(text) {
  const out = [];
  withoutStrings(stripComments(text.replace(/\r/g, ''))).split('\n').forEach((line, i) => {
    if (NAMING_LINE.test(line)) return;
    for (const m of line.matchAll(/(?<![\w.$#])(0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)(?![\w.])/gi)) {
      const v = Number(m[1].replace(/_/g, ''));
      if (v !== 0 && v !== 1) out.push({ line: i + 1, value: m[1] });
    }
  });
  return out;
}

/** The comment text of a source: block comments and the rest of each line after `//` that is not part of a URL. */
const commentsOf = (text) => [...text.matchAll(/\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g)].map((m) => m[0]).join('\n');

/** `[{ name, value }]`: exported numeric `UPPER_CASE` constants of 100 or more whose value a comment of the same source writes again. */
export function proseRepeats(text) {
  const code = stripComments(text.replace(/\r/g, ''));
  const prose = new Set([...commentsOf(text.replace(/\r/g, '')).matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?![\w.])/g)].map((m) => Number(m[1].replace(/,/g, ''))));
  return [...code.matchAll(/^export const ([A-Z][A-Z0-9_]*)(?:\s*:\s*[^=]+)?\s*=\s*(\d[\d_]*)\s*;/gm)]
    .map((m) => ({ name: m[1], value: Number(m[2].replace(/_/g, '')) }))
    .filter((c) => c.value >= 100 && prose.has(c.value));
}

/** The two measures of one root from its sources `{ file, text }`. */
export function measuresOf(root, sources) {
  const lits = sources.reduce((n, s) => n + unnamedLiterals(s.text).length, 0);
  const repeats = sources.reduce((n, s) => n + proseRepeats(s.text).length, 0);
  return [
    { id: `unnamed-literals:${root}`, value: lits, text: `${lits} unnamed number literal(s) in ${root}` },
    { id: `prose-repeats:${root}`, value: repeats, text: `${repeats} comment(s) in ${root} repeating the value of an exported constant` },
  ];
}

/** `byRoot` is `{ [root]: { file, text }[] }`. */
export function decide(byRoot, allow, todayDate) {
  const measures = Object.entries(byRoot).flatMap(([root, sources]) => measuresOf(root, sources));
  const c = applyCeilings(measures, allow, todayDate);
  if (c.problem) return violated(c.problem);
  const files = Object.values(byRoot).reduce((n, s) => n + s.length, 0);
  const tail = `${files} source(s) in ${Object.keys(byRoot).join(', ')}, ${c.used} ceiling(s) used${c.slack.length ? `; ceilings above their measure, lower them: ${c.slack.join('; ')}` : ''}`;
  return c.over.length
    ? violated(`${c.over.length} measure(s) above their ceiling: ${c.over.map((m) => `${m.text} (ceiling ${allow.find((e) => e.id === m.id)?.max ?? 0})`).join('; ')} (${tail})`)
    : holds(`no unnamed literal and no prose repeat beyond the ceilings (${tail})`);
}

/** The sources of the checkout at `root`, per source root. */
export function readSources(root = REPO_ROOT) {
  const byRoot = {};
  for (const dir of ROOTS) {
    const files = trackedSources([dir], { ext: ['.ts'], specs: false, floor: dir === 'schema/src' ? 5 : 100, root }).filter((f) => !f.endsWith('.spec.ts'));
    byRoot[dir] = files.map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
  }
  if (Object.keys(byRoot).length !== ROOTS.length) throw new CannotAnswer('a source root was not read');
  return byRoot;
}

if (isMain(import.meta.url)) await answer(() => decide(readSources(), readAllow(allowFileFor(import.meta.url)), today()));
