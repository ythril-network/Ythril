/**
 * The client asks "is this a plain object" in one place, `core/plain-object.ts` (bundle-285 S13, lens finding 3).
 *
 * ## What it prevents
 *
 * `typeof v === 'object' && v !== null && !Array.isArray(v)` was written as a private `isRecord` six times, four of them by one bundle, each in its own
 * spelling (`!!v &&` in front, `v !== null` in the middle). Each copy is the line a reader skims, and the half a copy drops (`typeof null === 'object'`,
 * an array being an object) is the defect. This gate refuses a seventh: a declaration whose whole body is that test, under any name, in any tracked
 * app source but the module.
 *
 * ## What counts
 *
 * A `const`/`let` arrow or a `function` declared on one line whose body (the arrow's expression, or the function's single `return`) tests
 * `typeof <param> === 'object'` and `!Array.isArray(<param>)` joined by `&&`, and does nothing else: a coercion that answers a value
 * (`v && typeof v === 'object' && !Array.isArray(v) ? v : {}`) asks a different question and is not counted. The detector runs over snippets
 * first, so a gate that cannot match reports nothing.
 *
 * ## Seen red
 *
 * Red at 877a5d3c5: the six copies (`core/conversion-api.service.ts`, `core/conversion-step-words.ts`, `core/forks-api.service.ts`,
 * `core/type-change-words.ts`, `core/vote-round-view.ts`, `pages/settings/vote-conversion-block.component.ts`); the seventh, `isPlainObject` in
 * `pages/settings/space-settings-state.service.ts`, was found by this gate and swapped too.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';

/** The one module that answers the question. */
const MODULE = 'src/app/core/plain-object.ts';

/** `text` without the parentheses that wrap all of it: `((a && b))` is `a && b`, and `(a) && (b)` stays as it is. */
function unwrap(text: string): string {
  let s = text.trim();
  for (;;) {
    if (!s.startsWith('(') || !s.endsWith(')')) return s;
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0 && i < s.length - 1) { closesAtEnd = false; break; }
    }
    if (!closesAtEnd) return s;
    s = s.slice(1, -1).trim();
  }
}

/** Is `body` nothing but the plain-object test of `param`, its clauses joined by `&&`? */
function isPlainObjectTest(body: string, param: string): boolean {
  const clauses = unwrap(body).split('&&').map(c => unwrap(c));
  const p = param.replace(/[$]/g, '\\$');
  const typeofObject = new RegExp(`^typeof\\s+${p}\\s*===?\\s*['"]object['"]$`);
  const notArray = new RegExp(`^!\\s*Array\\.isArray\\(\\s*${p}\\s*\\)$`);
  const allowed = [typeofObject, notArray, new RegExp(`^!!\\s*${p}$`), new RegExp(`^${p}$`), new RegExp(`^${p}\\s*!==?\\s*null$`), new RegExp(`^null\\s*!==?\\s*${p}$`)];
  return clauses.some(c => typeofObject.test(c)) && clauses.some(c => notArray.test(c)) && clauses.every(c => allowed.some(a => a.test(c)));
}

/** The names of the plain-object tests `code` declares, with their lines. */
function plainObjectCopies(code: string): { name: string; line: number }[] {
  const found: { name: string; line: number }[] = [];
  const shapes = [
    /\b(?:const|let)\s+(\w+)\s*=\s*\(\s*(\w+)\s*(?::[^)]*)?\)\s*(?::[^=]*)?=>\s*([^;\n]+?)\s*;?\s*$/gm,
    /\bfunction\s+(\w+)\s*\(\s*(\w+)\s*(?::[^)]*)?\)\s*(?::[^{]*)?\{\s*return\s+([^;\n]+?)\s*;?\s*\}/gm,
  ];
  for (const shape of shapes) {
    for (const m of code.matchAll(shape)) {
      if (isPlainObjectTest(m[3]!, m[2]!)) found.push({ name: m[1]!, line: code.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

describe('the detector sees what it hunts', () => {
  it.each([
    ['the arrow with !! in front', "const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);"],
    ['the arrow with null in the middle', "const isObj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);"],
    ['a function declaration', "function isMap(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }"],
    ['an exported arrow in parentheses', "export const plain = (o: unknown): boolean => (o !== null && typeof o === 'object' && !Array.isArray(o));"],
  ])('finds %s', (_name, snippet) => {
    expect(plainObjectCopies(snippet)).toHaveLength(1);
  });

  it.each([
    ['a coercion that answers a value', "const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});"],
    ['a test that also reads a key', "const isStep = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v) && 'op' in v;"],
    ['an inline test in a condition', "if (typeof v === 'object' && v !== null && !Array.isArray(v)) read(v);"],
    ['a primitive test', "const isPlain = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';"],
  ])('passes %s', (_name, snippet) => {
    expect(plainObjectCopies(snippet)).toEqual([]);
  });
});

describe('the client asks whether a value is a plain object in one module', () => {
  const sources = trackedAppSources();

  it('no tracked app source but core/plain-object.ts declares its own copy', () => {
    const offenders = sources
      .filter(p => p !== MODULE)
      .flatMap(p => plainObjectCopies(stripComments(readFileSync(resolve(CLIENT_ROOT, p), 'utf8'))).map(c => `${p}:${c.line}  ${c.name}`));
    expect(offenders, `import isPlainObject from core/plain-object.ts instead:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
