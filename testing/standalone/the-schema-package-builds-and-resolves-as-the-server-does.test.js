/**
 * `@ythril/schema` resolves its dependencies to the server's copies, builds from a clean `dist`, and the tooling reads its entries from
 * one table (Q-668: I2, L1, I4, S-A4).
 *
 * ## The defects this prevents
 *
 * - **I2 — two specs, two copies.** The package and the server both depend on `zod` and `@bufbuild/cel`. When their specs differ, npm
 *   may nest a second copy under `schema/node_modules`, which the image never copies (`Dockerfile` copies the root `node_modules`): the
 *   package then fails at runtime in the image only — or two zod copies disagree about `instanceof`. Every shared spec is equal.
 * - **L1 — an undeclared runtime dependency.** The package's CEL engine runs on `@bufbuild/protobuf`; the server pins it exactly
 *   (`2.16.0`), the package did not declare it, so an app installing the package got whatever the engine's range allowed. The package
 *   declares it at the server's exact version.
 * - **I4 — a stale build.** `tsc` never deletes: a module removed from `schema/src` lived on in `schema/dist` and kept being exported
 *   locally, and `.dockerignore`'s `dist/` matched the ROOT only, so a local `schema/dist` entered the build context. The package's
 *   build clears `dist` first, portably (`node -e` + `rmSync`, no `rm -rf`), and `.dockerignore` matches `dist/` and `node_modules/` at
 *   any depth.
 * - **S-A4 — a second table of the entries.** `testing/_shared/server-program.mjs` wrote the package's two entry paths by hand beside
 *   `SCHEMA_PACKAGE_ENTRIES` (`_relative-specifier.mjs`), so a new entry would resolve in one reader and not the other.
 * - **Q-687 — a third entry with no row.** `./from-typescript` is exported by `package.json`; a gate that follows the server's imports resolves a bare
 *   `@ythril/schema/from-typescript` through the same table, so the table's keys are held to the package's `exports` (derived, never a second list) and
 *   every row to a file of the package.
 *

 * Run: node --test testing/standalone/the-schema-package-builds-and-resolves-as-the-server-does.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { SCHEMA_PACKAGE_ENTRIES, resolveSpecifier } from './_relative-specifier.mjs';
import { trackedSources } from './_sources.mjs';

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const schema = json('schema/package.json');
const server = json('server/package.json');

describe('the package depends as the server does (I2, L1)', () => {
  it('every dependency the two share has the same spec', () => {
    const shared = Object.keys(schema.dependencies ?? {}).filter(n => n in (server.dependencies ?? {}));
    assert.ok(shared.length >= 2, `the package shares only [${shared.join(', ')}] with the server: the read is broken`);
    const differing = shared.filter(n => schema.dependencies[n] !== server.dependencies[n])
      .map(n => `${n}: schema ${schema.dependencies[n]}, server ${server.dependencies[n]}`);
    assert.deepEqual(differing, [], 'a shared dependency with two specs can install a second copy the image never ships');
  });

  it('@bufbuild/protobuf, which the CEL engine runs on, is a dependency of the package at the server\'s exact version', () => {
    const spec = schema.dependencies?.['@bufbuild/protobuf'];
    assert.ok(spec, 'schema/package.json does not declare @bufbuild/protobuf');
    assert.match(spec, /^\d+\.\d+\.\d+$/, `@bufbuild/protobuf is declared as ${spec}, not an exact version`);
    assert.equal(spec, server.dependencies['@bufbuild/protobuf']);
  });
});

describe('the package builds from a clean dist (I4)', () => {
  it('its build script removes dist with node\'s rmSync before tsc runs', () => {
    const steps = String(schema.scripts?.build ?? '').split('&&').map(s => s.trim());
    const clean = steps.findIndex(s => /^node -e\b/.test(s) && /rmSync\(\s*\\?['"]dist\\?['"]/.test(s) && /recursive\s*:\s*true/.test(s));
    const compile = steps.findIndex(s => /^tsc\b/.test(s));
    assert.ok(clean >= 0, `the build (${schema.scripts?.build}) has no portable dist clean (node -e ... rmSync('dist', { recursive: true, ... }))`);
    assert.ok(compile > clean, 'the dist clean must run before tsc');
    assert.ok(!steps.some(s => /\brm\s+-r|\brimraf\b|\brmdir\b|\bdel\b/.test(s)), 'the clean is a shell command that does not run on every platform');
  });

  it('.dockerignore matches dist/ and node_modules/ at any depth', () => {
    const lines = readFileSync('.dockerignore', 'utf8').split(/\r?\n/).map(l => l.trim());
    for (const pattern of ['**/dist/', '**/node_modules/']) {
      assert.ok(lines.includes(pattern), `.dockerignore lacks ${pattern}: a workspace's own ${pattern.slice(3)} enters the build context`);
    }
  });
});

describe('the table holds every entry the package exports (Q-687: the from-typescript entry)', () => {
  /** The bare specifier an `exports` key names: `.` is the package, `./internal` is `@ythril/schema/internal`. `./package.json` is no entry. */
  const specifiersOf = (exportsMap) => Object.keys(exportsMap).filter(k => k !== './package.json')
    .map(k => (k === '.' ? schema.name : `${schema.name}/${k.slice(2)}`)).sort();

  it('SCHEMA_PACKAGE_ENTRIES names exactly the entries package.json exports (a new export with no row would resolve in no reader)', () => {
    assert.deepEqual(Object.keys(SCHEMA_PACKAGE_ENTRIES).sort(), specifiersOf(schema.exports));
  });

  it('it holds @ythril/schema/from-typescript, at its source module, and every row points at a file of the package', () => {
    assert.equal(SCHEMA_PACKAGE_ENTRIES['@ythril/schema/from-typescript'], 'schema/src/from-typescript.ts');
    assert.ok('./from-typescript' in schema.exports, 'schema/package.json does not export ./from-typescript');
    const tracked = new Set(trackedSources('schema/src', { floor: 15, untracked: true }));
    const missing = Object.values(SCHEMA_PACKAGE_ENTRIES).filter(p => !tracked.has(p));
    assert.deepEqual(missing, [], `the table points at files the package does not have: ${missing.join(', ')}`);
  });

  it('the reader resolves each row through the one specifier function (planted: an export with no row, a row with no export)', () => {
    const has = (p) => Object.values(SCHEMA_PACKAGE_ENTRIES).includes(p);
    for (const [spec, path] of Object.entries(SCHEMA_PACKAGE_ENTRIES)) assert.equal(resolveSpecifier(spec, 'server/src/x.ts', has), path);
    assert.deepEqual(specifiersOf({ '.': {}, './internal': {}, './extra': {}, './package.json': './package.json' }).filter(s => !(s in SCHEMA_PACKAGE_ENTRIES)), ['@ythril/schema/extra']);
    assert.equal(resolveSpecifier('@ythril/schema/extra', 'server/src/x.ts', has), null);
  });
});

describe('the tooling reads the package\'s entries from one table (S-A4)', () => {
  it('testing/_shared/server-program.mjs imports SCHEMA_PACKAGE_ENTRIES and writes no entry path of its own', () => {
    const src = stripComments(readFileSync('testing/_shared/server-program.mjs', 'utf8'));
    assert.match(src, /import\s*\{[^}]*\bSCHEMA_PACKAGE_ENTRIES\b[^}]*\}\s*from\s*['"][^'"]*_relative-specifier\.mjs['"]/,
      'server-program.mjs does not import SCHEMA_PACKAGE_ENTRIES');
    const handCopies = Object.values(SCHEMA_PACKAGE_ENTRIES).filter(p => src.includes(p));
    assert.deepEqual(handCopies, [], `server-program.mjs writes the entry paths by hand: ${handCopies.join(', ')}`);
  });
});
