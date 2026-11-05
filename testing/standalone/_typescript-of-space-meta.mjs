/**
 * What the tests of the schema package's schema-to-TypeScript converter (`typesOfSpaceMeta`, Q-669) share: the in-memory compile, the
 * type-level assertions a usage source states its expectations with, the guarded call of the converter, and the matcher for its
 * `untranslated` report.
 *
 * ## The question it answers
 *
 * *"Does this generated TypeScript compile, and do the types it declares say what the schema says?"* Seven test files ask it. Each
 * writing its own compiler host would be seven hosts that differ in the one option that decides the answer (`strict`), so the host,
 * the options and the assertion helpers live here once.
 *
 * ## In memory, one program per call
 *
 * The sources never touch the disk: they are virtual files in a directory that does not exist (`VIRTUAL_DIR`), handed to one
 * `ts.createProgram` together (P3: one program compiles every source a test file has, not one program per case). A usage source
 * imports a generated one as `./<name>`. Only the TypeScript lib comes from the disk.
 *
 * ## What it prevents
 *
 * A harness that reported nothing would pass every case below it. `compileInMemory` therefore returns the diagnostics of EVERY virtual
 * file plus the program-level ones, and `generated-typescript-compiles-and-bites.test.js` proves it on planted bad sources (a type
 * error, an unused `@ts-expect-error`, a syntax error).
 *
 * The converter is called through `convert`, which asserts it is exported before it is called: a missing export is then one failing
 * assertion per case that names it, never a module that fails to load and hides every case.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import ts from 'typescript';
import * as schema from '../../schema/dist/index.js';
import { REPO_ROOT } from './_sources.mjs';
import { parseSource } from '../_shared/syntax-tree.mjs';

/** Where the virtual files live: beside the tests, in a directory that does not exist, so no real file can be read in their place. */
export const VIRTUAL_DIR = resolve(REPO_ROOT, 'testing/standalone/__typescript-of-space-meta__');

/** The options every generated source must compile under: `strict`, as the plan's mechanism states (`tsc --strict --noEmit`). */
export const STRICT = Object.freeze({
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
  skipLibCheck: true,
});

/** The stricter variant an app may run (S4): optional members exact, indexed reads possibly undefined. */
export const STRICTER = Object.freeze({ ...STRICT, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true });

/**
 * Type-level assertions for usage sources, added to every program as `./assert-types`. `Expect<Equals<A, B>>` fails to compile
 * unless A and B are the same type (the identity test, so `any` and unions are not loosely accepted); `IsOptional<T, K>` is
 * `true` when `K` may be left out of a `T`.
 */
export const ASSERT_TYPES = `
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type Expect<T extends true> = T;
export type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
export type HasIndex<T> = string extends keyof T ? true : false;
export type Not<T extends boolean> = T extends true ? false : true;
`;

/**
 * Compile `files` (`{ name: source }`, each a virtual `<name>.ts`) in ONE program under `options`.
 *
 * @returns `{ byFile, global }`: per file name its diagnostics as `line N: TSxxxx message`, and the program-level ones.
 */
export function compileInMemory(files, options = STRICT) {
  const all = { 'assert-types': ASSERT_TYPES, ...files };
  const paths = new Map(Object.entries(all).map(([name, source]) => [resolve(VIRTUAL_DIR, `${name}.ts`), { name, source }]));
  const host = ts.createCompilerHost(options);
  const real = { fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host), directoryExists: host.directoryExists?.bind(host) };
  host.fileExists = (f) => paths.has(resolve(f)) || real.fileExists(f);
  host.readFile = (f) => (paths.has(resolve(f)) ? paths.get(resolve(f)).source : real.readFile(f));
  host.directoryExists = (d) => resolve(d) === VIRTUAL_DIR || (real.directoryExists ? real.directoryExists(d) : true);
  const program = ts.createProgram({ rootNames: [...paths.keys()], options, host });
  const byFile = Object.fromEntries(Object.keys(all).map(name => [name, []]));
  const global = [];
  for (const d of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...ts.getPreEmitDiagnostics(program)]) {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0];
    const own = d.file ? paths.get(resolve(d.file.fileName)) : undefined;
    if (!own) { global.push(`TS${d.code} ${text}${d.file ? ` (${d.file.fileName})` : ''}`); continue; }
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    const entry = `line ${line + 1}: TS${d.code} ${text}`;
    if (!byFile[own.name].includes(entry)) byFile[own.name].push(entry);
  }
  return { byFile, global };
}

/** `diagnostics` with the source line each names, for an assertion message a reader can act on. */
export function withLines(diagnostics, source) {
  const lines = source.split('\n');
  return diagnostics.map(d => {
    const n = Number(/^line (\d+):/.exec(d)?.[1]);
    return Number.isFinite(n) ? `${d}\n      | ${(lines[n - 1] ?? '').slice(0, 200)}` : d;
  }).join('\n');
}

/** The converter, called only once the package is known to export it: a missing export is a failing assertion that says so. */
export function convert(meta, options) {
  assert.equal(typeof schema.typesOfSpaceMeta, 'function', 'the schema package exports typesOfSpaceMeta(meta, { library? }) (Q-669)');
  return options === undefined ? schema.typesOfSpaceMeta(meta) : schema.typesOfSpaceMeta(meta, options);
}

/** The converter's answer, checked for its shape: `{ source: string, untranslated: Untranslated[] }` and nothing else. */
export function converted(meta, options) {
  const out = convert(meta, options);
  assert.ok(out && typeof out === 'object', 'typesOfSpaceMeta answers an object');
  assert.deepEqual(Object.keys(out).sort(), ['source', 'untranslated'], 'typesOfSpaceMeta answers { source, untranslated }');
  assert.equal(typeof out.source, 'string');
  assert.ok(Array.isArray(out.untranslated), 'untranslated is a list');
  return out;
}

/** The entries of `untranslated` that carry every field of `like` (a subset match: `{ reason, kind?, type?, field? }`). */
export function reportsLike(untranslated, like) {
  return untranslated.filter(u => Object.entries(like).every(([k, v]) => u?.[k] === v));
}

/** Asserts `untranslated` holds at least one entry like `like`, naming what it holds when it does not. */
export function assertReported(untranslated, like, why) {
  assert.ok(reportsLike(untranslated, like).length > 0,
    `${why}: expected an untranslated entry like ${JSON.stringify(like)}, got ${JSON.stringify(untranslated).slice(0, 1500)}`);
}

/** The names a source exports at its top level, read by the TypeScript parser (never a regex over text a hostile name wrote). */
export function exportedNames(source) {
  const file = parseSource('generated-types.ts', source);
  const names = [];
  for (const s of file.statements) {
    const exported = ts.canHaveModifiers(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(s) || ts.isExportAssignment(s)) { names.push(`<${ts.SyntaxKind[s.kind]}>`); continue; }
    if (!exported) continue;
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) names.push(d.name.getText(file));
    else names.push(s.name?.getText(file) ?? `<${ts.SyntaxKind[s.kind]}>`);
  }
  return names;
}

/** Every comment of a source, as text, read by the scanner (so a `//` inside a string is not taken for one). */
export function commentsOf(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, source);
  const out = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) out.push({ kind: k, text: scanner.getTokenText() });
  }
  return out;
}

/** The text of every token that is neither a comment nor a string literal: where schema text must never appear as code. */
export function codeTokensOf(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, ts.LanguageVariant.Standard, source);
  const out = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral) continue;
    out.push(scanner.getTokenText());
  }
  return out;
}

/** The leading comment of a source (its header), or '' when it does not start with one. */
export function headerOf(source) {
  const first = commentsOf(source)[0];
  return first && source.trimStart().startsWith(first.text) ? first.text : '';
}

/** A TypeScript string literal for `value` (JSON's escaping is valid TypeScript), for usage sources naming a type or property. */
export const lit = (value) => JSON.stringify(value);

/** A union of literals, or `never` for none. */
export const unionOf = (values) => (values.length === 0 ? 'never' : values.map(lit).join(' | '));

/** `SpaceTypes[kind][name][part]` written for a usage source. */
export const at = (kind, name, part = 'properties') => `SpaceTypes[${lit(kind)}][${lit(name)}][${lit(part)}]`;

/** The package, for the tuples a test derives from (KNOWLEDGE_TYPES, the zod shapes, the parses). */
export { schema };
