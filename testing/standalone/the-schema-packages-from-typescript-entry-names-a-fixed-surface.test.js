/**
 * `@ythril/schema/from-typescript` exports exactly the names listed in `_schema-app-entry-names.mjs`, values and types, and neither `.` nor
 * `./internal` carries any of them (Q-687, design v3 items 1, 11 and 12).
 *
 * ## The defect this prevents
 *
 * The entry reads TypeScript source with the caller's own compiler, so it is behind an export of its own: an app that never reads TypeScript must
 * not pay for it, and the main entry must not name, load or type-check against `typescript`. Two ways it goes wrong in silence. A new export
 * lands in the entry without anyone deciding it is public (the defect `the-schema-packages-app-entry-names-a-fixed-surface.test.js` closed for
 * the main entry: `export *` hands every helper on as API). Or the entry's names are re-exported by `.` or `./internal` for convenience, and the
 * compiler becomes part of the surface of every app. A closed reason list that grows without a README line leaves an app's `switch` blind.
 *
 * ## What is held
 *
 * - The built entry (`schema/dist/from-typescript.js`) exists, and its VALUE names (`Object.keys`) equal `FROM_TYPESCRIPT_VALUES`.
 * - Its TYPE names (the TypeScript checker over `schema/dist/from-typescript.d.ts`, via `_declared-exports.mjs`) equal `FROM_TYPESCRIPT_TYPES`,
 *   and its declared values agree with what the build exports.
 * - `UNREPRESENTED_REASONS` is a closed, non-empty list of distinct names, and every name of both lists is absent from `.` and `./internal`.
 * - The package.json `exports` entry for `./from-typescript` carries `types` and `import` under `./dist`.
 * - The reader is proven on a planted declaration file, in a temp directory: a type and a value are told apart, and a name re-exported with `export *`
 *   is seen.
 *
 * A new public name is a deliberate edit of a list in `_schema-app-entry-names.mjs`, made in the same change as the export and its README row; the
 * README is held to the same lists by `the-schema-readme-names-every-name-of-the-from-typescript-entry.test.js`.
 *
 * Run: node --test testing/standalone/the-schema-packages-from-typescript-entry-names-a-fixed-surface.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { declaredExports } from './_declared-exports.mjs';
import { APP_VALUES, APP_TYPES, FROM_TYPESCRIPT_VALUES, FROM_TYPESCRIPT_TYPES } from './_schema-app-entry-names.mjs';
import * as app from '../../schema/dist/index.js';
import * as internal from '../../schema/dist/internal.js';

const BUILT = join(process.cwd(), 'schema/dist/from-typescript.js');
const DECLARED = join(process.cwd(), 'schema/dist/from-typescript.d.ts');

describe('the lists this gate stands on', () => {
  it('are whole, and share no name with the app entry\'s lists', () => {
    assert.ok(FROM_TYPESCRIPT_VALUES.length >= 2 && FROM_TYPESCRIPT_TYPES.length >= 2, 'the entry lists are read short');
    const all = [...FROM_TYPESCRIPT_VALUES, ...FROM_TYPESCRIPT_TYPES];
    assert.equal(new Set(all).size, all.length, 'a name is in both lists, or in one twice');
    const shared = all.filter(n => APP_VALUES.includes(n) || APP_TYPES.includes(n));
    assert.deepEqual(shared, [], 'the entry names what the main entry already exports: one of them is a copy');
  });

  it('the reader tells a type from a value and follows export * (planted declaration files)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ythril-declared-'));
    try {
      writeFileSync(join(dir, 'inner.d.ts'), 'export declare const INNER: number;\nexport interface InnerShape { a: string }\n');
      writeFileSync(join(dir, 'outer.d.ts'), "export * from './inner.js';\nexport declare function run(): void;\nexport type Result = { ok: boolean };\n");
      const { values, types } = declaredExports(join(dir, 'outer.d.ts'));
      assert.deepEqual(values, ['INNER', 'run']);
      assert.deepEqual(types, ['InnerShape', 'Result']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the from-typescript entry names a fixed surface', () => {
  it('is built (schema/dist/from-typescript.js and its declarations exist)', () => {
    assert.ok(existsSync(BUILT), 'schema/dist/from-typescript.js does not exist: the entry is not built (or not written)');
    assert.ok(existsSync(DECLARED), 'schema/dist/from-typescript.d.ts does not exist');
  });

  it('its values are the list, and the declared values agree with the build', async () => {
    assert.ok(existsSync(BUILT), 'schema/dist/from-typescript.js does not exist');
    const entry = await import(pathToFileURL(BUILT).href);
    assert.deepEqual(Object.keys(entry).sort(), [...FROM_TYPESCRIPT_VALUES].sort());
    assert.deepEqual(declaredExports(DECLARED).values, Object.keys(entry).sort());
  });

  it('its types are the list', () => {
    assert.ok(existsSync(DECLARED), 'schema/dist/from-typescript.d.ts does not exist');
    assert.deepEqual(declaredExports(DECLARED).types, [...FROM_TYPESCRIPT_TYPES].sort());
  });

  it('UNREPRESENTED_REASONS is a closed list of distinct names', async () => {
    assert.ok(existsSync(BUILT), 'schema/dist/from-typescript.js does not exist');
    const { UNREPRESENTED_REASONS } = await import(pathToFileURL(BUILT).href);
    assert.ok(Array.isArray(UNREPRESENTED_REASONS), 'the entry exports UNREPRESENTED_REASONS as an array');
    assert.ok(UNREPRESENTED_REASONS.length >= 12, `UNREPRESENTED_REASONS holds ${UNREPRESENTED_REASONS.length} names: design v3 names at least twelve refusal reasons`);
    assert.equal(new Set(UNREPRESENTED_REASONS).size, UNREPRESENTED_REASONS.length, 'a reason is listed twice');
    for (const r of UNREPRESENTED_REASONS) assert.match(r, /^[a-z]+(?:-[a-z]+)*$/, `reason ${r} is not a lower-case dashed name`);
  });

  it('neither . nor ./internal carries a name of it (the entry is behind its own export)', () => {
    const names = [...FROM_TYPESCRIPT_VALUES, ...FROM_TYPESCRIPT_TYPES];
    assert.deepEqual(names.filter(n => n in app), [], 'the app entry exports a from-typescript name');
    assert.deepEqual(names.filter(n => n in internal), [], './internal exports a from-typescript name');
    for (const dts of ['index.d.ts', 'internal.d.ts']) {
      const { values, types } = declaredExports(join(process.cwd(), 'schema/dist', dts));
      assert.deepEqual(names.filter(n => values.includes(n) || types.includes(n)), [], `${dts} declares a from-typescript name`);
    }
  });

  it('package.json exports ./from-typescript with types and import under ./dist', () => {
    const exp = JSON.parse(readFileSync('schema/package.json', 'utf8')).exports['./from-typescript'];
    assert.ok(exp, 'schema/package.json does not export ./from-typescript');
    assert.equal(exp.types, './dist/from-typescript.d.ts');
    assert.equal(exp.import, './dist/from-typescript.js');
  });
});
