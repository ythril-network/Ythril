/**
 * Every CALL of a named function in the server source, with the outermost function it is written in — answered once, for the gates that ask
 * "is every call of X inside Y".
 *
 * ## The question it answers
 *
 * *"Where is `name(` called in `server/src`, and inside which function would a reader say each call sits?"* A gate over a rule such as "a round is
 * concluded only inside `settleRounds`" needs the sites DERIVED from the source and each attributed by NAME RESOLUTION to its outermost function
 * (`_source-helpers.mjs`, `outermostFunctionAt`), because the innermost enclosing block of a call inside `.forEach(() => …)` is an arrow and reads as outside.
 *
 * ## The guards a hand-written copy drops
 *
 * - **The source set has a floor** (`trackedSources(…, { floor: 100 })`): an empty listing passes every loop written over it.
 * - **Comments are blanked, not stripped**, so an offset in the blanked text is the same offset in the original source the function is resolved in.
 * - **A definition is not a call**: `function name(` is skipped, and so is a method access (`obj.name(`), which is another function.
 *
 * ## What it does not do
 *
 * It does not say what a call must satisfy: the caller asserts that, and states its exemptions with their reasons.
 */
import fs from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { outermostFunctionAt } from './_source-helpers.mjs';

let loaded;
/** The server's TypeScript sources, read once: `{ files, raw, blanked }`. Exported so a gate that also matches other shapes reads the same set. */
export function serverSources() {
  if (!loaded) {
    const files = trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts'));
    const raw = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
    loaded = { files, raw, blanked: new Map([...raw].map(([f, t]) => [f, blankComments(t)])) };
  }
  return loaded;
}

/** The text between the parentheses a call opens at `from` (just after the `(`). */
function argumentText(text, from) {
  let depth = 1;
  let i = from;
  for (; i < text.length && depth > 0; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
  return text.slice(from, i - 1);
}

/** Every call of `name(`: `{ file, at, fn, args }`, where `fn` is the outermost function's name or `null` at module scope. */
export function callSitesOf(name) {
  const { blanked, raw } = serverSources();
  const out = [];
  for (const [file, text] of blanked) {
    for (const m of text.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g'))) {
      if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      out.push({ file, at: m.index, fn: outermostFunctionAt(file, raw.get(file), m.index)?.name ?? null, args: argumentText(text, m.index + m[0].length) });
    }
  }
  return out;
}
