/**
 * What `schema/src` may import, load and call: the ONE rule, and its one carve-out, for the gates that hold something else to it.
 *
 * ## The question it answers
 *
 * *"Is this line of a file under `schema/src` allowed to reach outside the package's closed set (zod, the CEL engine, Node built-ins,
 * itself), and if so, why?"* Two gates ask it: the package-closure gate (`an-outside-apps-schema-validates-through-the-schema-package.test.js`,
 * which scans `schema/src`) and the decision lint (`decision-19s-import-sentence-names-what-the-schema-gate-admits.test.js`, which holds the
 * sentence of decision 19 that states the closure to the same carve-out). A copy in the second would drift from the first on the day the
 * carve-out moves, and the decision would then state a closure the gate no longer enforces.
 *
 * ## What the carve-out is, and why it is that narrow (Q-687, design v3 item 12)
 *
 * `@ythril/schema/from-typescript` reads TypeScript source with the CALLER'S OWN compiler, so the package may name `typescript`, and only
 * so: the dynamic literal `import('typescript')` (and `import type`, which erases) in `schema/src/from-typescript.ts`. A static import
 * would load the compiler with the main entry and install it for every app; a non-literal `import()`, `new Function`, `eval`,
 * `createRequire` and `require` are each a way to name a module the gate cannot read, so they are refused in EVERY file of the package,
 * the carve-out's included. `.sys` and `createCompilerHost` give a compiler the file system, so they are refused outside the one file that
 * builds the closed host.
 */
import { stripComments } from './_strip-comments.mjs';

/** The one file allowed to name the compiler, and the one specifier it may name. */
export const TYPESCRIPT_CARVE_OUT = Object.freeze({ file: 'schema/src/from-typescript.ts', specifier: 'typescript' });

/** The specifiers a file of the package may import besides the carve-out: zod, the CEL engine, Node built-ins and its own modules. */
export const ADMITTED_SPECIFIER = /^(zod|@bufbuild\/cel|node:[a-z_/]+|\.\/[a-z-]+\.js)$/;

/**
 * What a sentence that states the package's closure must name, by the specifier the gate admits: the words a reader finds it by.
 * One row per admitted specifier family; the carve-out's row is derived from {@link TYPESCRIPT_CARVE_OUT}.
 */
export const CLOSURE_WORDS = Object.freeze([
  { admits: 'zod', words: ['zod'] },
  { admits: '@bufbuild/cel', words: ['CEL engine'] },
  { admits: 'node:*', words: ['Node built-ins'] },
  { admits: TYPESCRIPT_CARVE_OUT.specifier, words: [TYPESCRIPT_CARVE_OUT.specifier, TYPESCRIPT_CARVE_OUT.file.replace(/^schema\/src\//, ''), 'dynamic'] },
]);

/** The two entry modules that must never reach `from-typescript` (the entry is re-exported by neither `.` nor `./internal`). */
const MAIN_ENTRIES = Object.freeze(['schema/src/index.ts', 'schema/src/internal.ts']);

/**
 * Whether the `import` at `at` starts a CALL, not a word of prose inside a string ("... installs its own at import (server/...)"): what precedes it, past
 * whitespace, is not a word (unless a keyword an expression can follow: `await`, `return`, `typeof`, ...) and not a member access.
 */
function inCodePosition(src, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 0) return true;
  if (src[i] === '.') return false;
  if (!/[\w$]/.test(src[i])) return true;
  let j = i;
  while (j >= 0 && /[\w$]/.test(src[j])) j--;
  return /^(?:await|return|typeof|yield|void|case|in|of|else|default|extends|throw)$/.test(src.slice(j + 1, i + 1));
}

/** `file` with `text` read as source: every way it breaks the rule, as sentences. Empty when it holds. */
export function schemaSourceProblems(file, text) {
  const src = stripComments(text);
  const inCarveOut = file === TYPESCRIPT_CARVE_OUT.file;
  const spec = TYPESCRIPT_CARVE_OUT.specifier;
  const problems = [];

  /** One specifier, read from a static or a dynamic form. `typeOnly` is an `import type` / `export type`. */
  const check = (specifier, form, typeOnly) => {
    if (specifier === spec) {
      if (!inCarveOut) problems.push(`${file}: ${form} of '${spec}' outside ${TYPESCRIPT_CARVE_OUT.file}`);
      else if (form === 'static import' && !typeOnly) problems.push(`${file}: a static import of '${spec}' loads the compiler with the module (only the dynamic literal and import type are admitted)`);
    } else if (!ADMITTED_SPECIFIER.test(specifier)) problems.push(`${file}: ${form} of '${specifier}'`);
  };

  const statics = [
    ...src.matchAll(/(?:^|;)\s*((?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"])/gm),
    ...src.matchAll(/(?:^|;)\s*(import\s*['"]([^'"]+)['"])/gm),
  ];
  for (const m of statics) check(m[2], 'static import', /^(?:import|export)\s+type\b/.test(m[1]));

  for (const m of src.matchAll(/\bimport\s*\(/g)) {
    if (!inCodePosition(src, m.index)) continue;
    const literal = /^\bimport\s*\(\s*(['"])([^'"\\]*)\1\s*\)/.exec(src.slice(m.index));
    if (literal) check(literal[2], 'dynamic import', false);
    else problems.push(`${file}: a non-literal import() the gate cannot read`);
  }

  for (const [re, what] of [
    [/\bnew\s+Function\b/, 'new Function'], [/\beval\s*\(/, 'eval'], [/\bcreateRequire\b/, 'createRequire'], [/\brequire\s*\(/, 'require'],
  ]) if (re.test(src)) problems.push(`${file}: ${what} names a module the gate cannot read`);

  if (!inCarveOut) {
    if (/\.sys\b|\[\s*['"]sys['"]\s*\]/.test(src)) problems.push(`${file}: .sys outside ${TYPESCRIPT_CARVE_OUT.file}`);
    if (/\bcreateCompilerHost\b/.test(src)) problems.push(`${file}: createCompilerHost outside ${TYPESCRIPT_CARVE_OUT.file}`);
  }
  if (MAIN_ENTRIES.includes(file) && /from-typescript/.test(src)) problems.push(`${file}: reaches from-typescript (the entry is behind its own export, never re-exported)`);
  return problems;
}

/** How many dynamic literal `import('typescript')` the carve-out file holds: a carve-out nobody uses is a hole for nothing. */
export const carveOutUses = (text) => [...stripComments(text).matchAll(/\bimport\s*\(\s*(['"])typescript\1\s*\)/g)].length;

/** The sentence of a decision that begins "The package imports", whitespace collapsed, or `null` when there is none. */
export function importSentenceOf(markdown) {
  const flat = markdown.replace(/\s+/g, ' ');
  const at = flat.indexOf('The package imports');
  if (at < 0) return null;
  const rest = flat.slice(at);
  const end = rest.search(/\.(?=\s|$)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** What a closure sentence fails to name of what the gate admits, as sentences. */
export function sentenceProblems(sentence) {
  const lower = String(sentence).toLowerCase();
  return CLOSURE_WORDS.flatMap(row => row.words.filter(w => !lower.includes(w.toLowerCase())).map(w => `the sentence does not name '${w}' (the gate admits ${row.admits})`));
}
