/**
 * Every source `typesOfSpaceMeta` writes compiles, in one program, under `strict` and again with `exactOptionalPropertyTypes` and
 * `noUncheckedIndexedAccess`; and the types bite: the compiler refuses what the schema refuses (Q-669, design v3 item 8; slice-B S4, P3).
 *
 * ## What is held
 *
 * - **The harness first.** `compileInMemory` (`_typescript-of-space-meta.mjs`) is proven on planted bad sources before anything relies
 *   on it: a type error, an unused `@ts-expect-error` (TS2578, the error every "must be refused" line below depends on), a syntax error
 *   and an import of a name a virtual file lacks are each reported on their own file, and a clean source and a resolved virtual import
 *   are not. A harness that reported nothing would pass every case after it.
 * - **One program** compiles the sources of the three garden fixtures, the benchmark library and a meta with every property kind on
 *   every knowledge type, beside a usage source; then one more program does the same with the two stricter flags an app may set.
 * - **The types bite.** In the usage source each of these is a `@ts-expect-error` line that must fire: a create without a required
 *   key, a value outside the enum, and an undeclared key on a strict `Properties`. A stored record is accepted with an undeclared key
 *   and without the required one (`StoredProperties`), with no directive.
 *
 * Run: node --test testing/standalone/generated-typescript-compiles-and-bites.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema, compileInMemory, converted, withLines, STRICT, STRICTER, at } from './_typescript-of-space-meta.mjs';
import { REPO_ROOT } from './_sources.mjs';

const { KNOWLEDGE_TYPES } = schema;
const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
const GARDENS = ['garden-plants', 'garden-beds', 'garden-season'].map(name => [name, readJson(`testing/fixtures/outside-app-schemas/${name}.json`)]);
const BENCHMARK = readJson('benchmarks/space/schema.json');

const EVERY_KIND = {
  colour: { type: 'string', enum: ['red', 'green'], description: 'the colour' },
  size: { type: 'number', minimum: 0, maximum: 9, mergeFn: 'max' },
  ok: { type: 'boolean', mergeFn: 'and' },
  on: { type: 'date' },
  any: {},
  code: { type: 'string', pattern: '^[A-Z]{2}$' },
  name: { type: 'string', required: true },
  rank: { type: 'number', required: true, default: 1 },
};
const KINDS_META = {
  validationMode: 'strict',
  typeSchemas: Object.fromEntries(KNOWLEDGE_TYPES.map(kind => [kind, { item: { propertySchemas: EVERY_KIND }, bare: {} }])),
};
const BENCHMARK_META = {
  typeSchemas: Object.fromEntries(KNOWLEDGE_TYPES.map(kind => [kind,
    Object.fromEntries(BENCHMARK.filter(e => e.knowledgeType === kind).map(e => [e.name, { $ref: `library:${e.name}` }]))])),
};

const USAGE = `import type { SpaceTypes } from './kinds';
type Create = ${at('entity', 'item')};
type Stored = ${at('entity', 'item', 'stored')};
export const fine: Create = { name: 'n', colour: 'red', size: 3, ok: true, on: '2026-11-02', code: 'AB' };
export const least: Create = { name: 'n' };
// @ts-expect-error a create without the required key 'name'
export const missingRequired: Create = { colour: 'red' };
// @ts-expect-error a value outside the enum
export const outOfEnum: Create = { name: 'n', colour: 'blue' };
// @ts-expect-error an undeclared key on the strict create contract
export const undeclared: Create = { name: 'n', shade: 'dark' };
export const storedExtra: Stored = { colour: 'red', retired: 'yes', since: 3 };
export const storedWithoutRequired: Stored = {};
`;

let memo;
function sources() {
  if (memo) return memo;
  const files = {};
  for (const [name, meta] of GARDENS) files[name] = converted(meta).source;
  files.benchmark = converted(BENCHMARK_META, { library: BENCHMARK }).source;
  files.kinds = converted(KINDS_META).source;
  files.usage = USAGE;
  memo = files;
  return memo;
}

function assertClean(result, files, label) {
  assert.deepEqual(result.global, [], `${label}: global diagnostics`);
  for (const f of Object.keys(files)) assert.equal(result.byFile[f].length, 0, `${label}, ${f}:\n${withLines(result.byFile[f], files[f])}`);
}

describe('the harness, proven on planted sources', () => {
  it('reports a type error, an unused @ts-expect-error, a syntax error and a missing import, each on its own file', () => {
    const planted = {
      typeError: "export const n: number = 'a';\n",
      unusedDirective: '// @ts-expect-error nothing is wrong on the next line\nexport const n: number = 1;\n',
      syntaxError: 'export interface Broken { a: string;\n',
      target: 'export interface Here { a: string }\n',
      missingImport: "import type { NotHere } from './target';\nexport type T = NotHere;\n",
      resolvedImport: "import type { Here } from './target';\nexport const h: Here = { a: 'x' };\n",
      clean: 'export const ok: string = "x";\n',
    };
    const { byFile, global } = compileInMemory(planted);
    assert.deepEqual(global, []);
    assert.ok(byFile.typeError.some(d => d.includes('TS2322')), `type error: ${byFile.typeError}`);
    assert.ok(byFile.unusedDirective.some(d => d.includes('TS2578')), `unused directive: ${byFile.unusedDirective}`);
    assert.ok(byFile.syntaxError.some(d => /TS1\d{3}/.test(d)), `syntax error: ${byFile.syntaxError}`);
    assert.ok(byFile.missingImport.some(d => d.includes('TS2305')), `missing import: ${byFile.missingImport}`);
    for (const f of ['target', 'resolvedImport', 'clean']) assert.deepEqual(byFile[f], [], `${f} is clean`);
  });

  it('compiles under strict: an implicit any is refused, and the stricter flags change what an indexed read is', () => {
    const files = {
      implicitAny: 'export function f(x) { return x; }\n',
      indexed: 'const r: Record<string, string> = {};\nexport const s: string = r["k"];\n',
    };
    const strict = compileInMemory(files, STRICT);
    assert.ok(strict.byFile.implicitAny.some(d => d.includes('TS7006')), `strict is on: ${strict.byFile.implicitAny}`);
    assert.deepEqual(strict.byFile.indexed, []);
    const stricter = compileInMemory(files, STRICTER);
    assert.ok(stricter.byFile.indexed.some(d => d.includes('TS2322')), `noUncheckedIndexedAccess is on: ${stricter.byFile.indexed}`);
  });
});

describe('every generated source compiles in one program', () => {
  it('under strict: the garden fixtures, the benchmark library, every property kind, and the usage source', () => {
    const files = sources();
    assertClean(compileInMemory(files, STRICT), files, 'strict');
  });

  it('again with exactOptionalPropertyTypes and noUncheckedIndexedAccess', () => {
    const files = sources();
    assertClean(compileInMemory(files, STRICTER), files, 'strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess');
  });
});

describe('the types bite', () => {
  it('a missing required key, an out-of-enum value and an undeclared key are refused; a stored record takes an undeclared key', () => {
    const files = sources();
    const { byFile } = compileInMemory(files, STRICT);
    // Every directive fired (no TS2578) and nothing else failed: the three refusals happened, the four acceptances compiled.
    assert.equal(byFile.usage.length, 0, `usage:\n${withLines(byFile.usage, files.usage)}`);
    assert.equal((USAGE.match(/@ts-expect-error/g) ?? []).length, 3, 'the usage source states three refusals');
  });
});
