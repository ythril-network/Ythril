/**
 * A line of product source holds one statement: no statement terminator followed, on the same line, by a declaration or a module
 * statement (bundle-267 lens sweep, F1).
 *
 * ## The rule
 *
 * In every tracked `.ts`, `.js`, `.mjs` and `.cjs` under `server/src`, `schema/src` and `client/src`, with comments and the text of
 * strings and template literals blanked (line numbers kept), no line holds a `;` followed by `import`, `export`, `const`, `let`, `var`,
 * `function`, `async function`, `class`, `enum`, `interface` or a `type` alias. A `for (…; …; …)` header is not matched: what follows its
 * `;` is an expression.
 *
 * ## What bought it
 *
 * `server/src/brain/ttl.ts:14` read `import { … } from '../config/types.js';export { … };` (74092aad, b267-dup). It compiles, and it was
 * the second time: b299cde3 fixed the same slip by hand ("the sweep keeps one statement per line") with no check, so it came back. The
 * server has no ESLint; this is the `max-statements-per-line` rule for the statements a reader skims for.
 *
 * ## What it leaves alone
 *
 * A `;` inside an object type (`{ a: string; type: string }`): `type` there is a property, not an alias (an alias is `type Name =`).
 * An Angular template's `@for (…; let i = $index)`: it is template-literal text, blanked before the line is read.
 *
 * ## It cannot pass by reading nothing
 *
 * The files come from `git ls-files` through `trackedSources` (floor inside), and the matcher is proven red on the old `ttl.ts` line and
 * on each spelling, in memory.
 *
 * Run: node --test testing/standalone/a-source-line-holds-one-statement.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const DIRS = ['server/src', 'schema/src', 'client/src'];
const EXT = ['.ts', '.js', '.mjs', '.cjs'];
const FLOOR = 1000;

/** A `;` then a keyword that starts a declaration or a module statement. */
const SECOND_STATEMENT = /;\s*(?:import\b|export\b|const\b|let\b|var\b|(?:async\s+)?function\b|class\b|enum\b|interface\b|type\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=(?!=))/;

/** Characters after which a `/` opens a regular expression literal, not a division. */
const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * `src` with the text of every string, template literal and regular expression literal blanked (newlines kept), comments already blanked by
 * `blankComments`. Code inside a template's `${…}` is kept.
 */
function blankLiterals(src) {
  const code = blankComments(src);
  const blank = ch => (ch === '\n' ? '\n' : ' ');
  let out = '';
  let i = 0;
  /** The `{` depth of each open `${`, innermost last: a `}` at that depth returns to the template. */
  const templates = [];
  let depth = 0;
  let prev = '';
  const template = () => {
    // At the character after an opening backtick (or a `}` closing a substitution): copy blanks to the closing backtick or the next `${`.
    while (i < code.length) {
      if (code[i] === '\\') { out += blank(code[i]) + blank(code[i + 1] ?? ''); i += 2; continue; }
      if (code[i] === '`') { out += '`'; i++; prev = '`'; return; }
      if (code[i] === '$' && code[i + 1] === '{') { out += '${'; i += 2; templates.push(depth); depth++; prev = '{'; return; }
      out += blank(code[i++]);
    }
  };
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      out += ch; i++;
      while (i < code.length && code[i] !== ch && code[i] !== '\n') {
        if (code[i] === '\\') { out += blank(code[i]) + blank(code[i + 1] ?? ''); i += 2; continue; }
        out += blank(code[i++]);
      }
      if (i < code.length) out += code[i++];
      prev = ch;
      continue;
    }
    if (ch === '`') { out += '`'; i++; template(); continue; }
    if (ch === '{') { depth++; out += ch; i++; prev = ch; continue; }
    if (ch === '}') {
      depth--; out += ch; i++; prev = ch;
      if (templates.length > 0 && templates[templates.length - 1] === depth) { templates.pop(); template(); }
      continue;
    }
    if (ch === '/' && REGEX_BEFORE.has(prev) && code[i + 1] !== '/' && code[i + 1] !== '*') {
      out += '/'; i++;
      let inClass = false;
      while (i < code.length && code[i] !== '\n') {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) break;
        out += blank(code[i++]);
      }
      if (i < code.length && code[i] === '/') { out += '/'; i++; }
      prev = '/x';
      continue;
    }
    out += ch; i++;
    if (!/\s/.test(ch)) prev = /[\w$)\]]/.test(ch) ? 'w' : ch;
  }
  return out;
}

/** Each line of `src` holding a second statement, as `line: text` (1-based). */
function secondStatements(src) {
  const lines = blankLiterals(src).split('\n');
  const raw = src.split('\n');
  const out = [];
  lines.forEach((line, n) => {
    // A `for` header's `;` is followed by an expression; only what follows the header is read.
    const head = line.replace(/^\s*for\s*(?:await\s*)?\([^)]*\)/, '');
    if (SECOND_STATEMENT.test(head)) out.push(`${n + 1}: ${raw[n].trim().slice(0, 160)}`);
  });
  return out;
}

describe('a source line holds one statement', () => {
  it('the matcher refuses the ttl.ts line and each spelling, and leaves the look-alikes', () => {
    const planted = [
      "import { COLLECTION_SUFFIX, BRAIN_COLLECTIONS, RECORD_COLLECTION } from '../config/types.js';export { COLLECTION_SUFFIX, BRAIN_COLLECTIONS, RECORD_COLLECTION };",
      "import { a } from './a.js'; import { b } from './b.js';",
      'const a = f(); const b = g();',
      'x(); let y = 1;',
      'done(); function next() {}',
      'go(); async function later() {}',
      'a(); class B {}',
      'a(); type T = string;',
      'a(); type G<X> = X[];',
      'a(); interface I { x: number }',
      'a(); enum E { A }',
      'a(); var v = 1;',
      'for (const n of nodes) { if (n) return n; const hit = walk(n); }',
    ];
    for (const line of planted) assert.deepEqual(secondStatements(line).length, 1, `not refused: ${line}`);
    const alike = [
      'const x: { id: string; type: string; label: string } = f();',
      'for (let i = 0; i < n; i++) total += i;',
      "const s = 'a; const b';",
      'const t = `@for (x of xs; track x; let i = $index) { ${a} }`;',
      'const r = /; const /g;',
      '// a(); const b = 1;',
      'x(); /* ; const y */',
      'const ok = a === b; // ; let c',
      'f(a); g(b);',
      'if (x) { a(); return; }',
      'type Narrow = { a: string; type: string };',
    ];
    for (const line of alike) assert.deepEqual(secondStatements(line), [], `refused a look-alike: ${line}`);
  });

  it('no tracked product source holds a second statement on a line', () => {
    const files = readTrackedSources(DIRS, { ext: EXT, floor: FLOOR });
    const found = [];
    for (const { file, text } of files) for (const hit of secondStatements(text)) found.push(`${file}:${hit}`);
    assert.deepEqual(found, [], `split each onto its own line:\n  ${found.join('\n  ')}`);
  });
});
