/**
 * An app that writes a space schema validates it through the schema package, and the server runs the same code — never a copy of it.
 *
 * ## The defect this closes
 *
 * Apps that write to Ythril (a space template, a generator, a flow) kept a hand-written mirror of the TypeSchema types, the limits and
 * the validator, and learned whether a schema was valid only when an instance answered 400 at deploy time. A mirror in another
 * repository drifts from the server on the first change to either, and no test in either repository can see the drift. The vocabulary
 * and the validator are now a package, `schema/` in this repository, and the server imports it.
 *
 * ## What is held here
 *
 * - **An outside app's schema validates through the package**, offline: three space metas of the shape an app generates (made-up
 *   fixtures of a garden-planning app: types of every kind, properties, edges, CEL rules and usage notes, no `$ref`, no `id`) pass `validateSpaceMeta` and `parseSpaceMeta(meta, { against: {} })`, and the package and the server answer
 *   alike for a good meta and a bad one, refusal text included.
 * - **The server's names ARE the package's**: every schema export a server module re-exports is the same object, not an equal one.
 * - **No second definition is left in the server**: the moved bodies, parses, tuples, limits and helpers are declared nowhere under
 *   `server/src`.
 * - **The package reads no instance**: its source imports zod, the CEL engine, Node built-ins and itself, with ONE carve-out: the
 *   from-typescript entry (`from-typescript.ts`) names `typescript` through a dynamic literal `import('typescript')` (and
 *   `import type`) and nowhere else, so the caller's own compiler is loaded on first use and never with the main entry (Q-687; the carve-out
 *   is `_schema-package-imports.mjs`, the same one decision 19's import sentence is held to). A static import of the compiler, a non-literal
 *   `import()`, `new Function`, `eval`, `createRequire` and `require` are refused in every file of `schema/src`; `.sys` and
 *   `createCompilerHost` outside `from-typescript.ts`. A `$ref` is checked against the library HANDED to it.
 * - **The package is publishable**: not private, with `exports`, `files`, a version, a README, and its own licence (Apache-2.0, owner
 *   2026-11-01) in its own committed LICENSE and NOTICE: the repository's licence is not the package's (Q-668).
 * - The app entry's names are held in `the-schema-packages-app-entry-names-a-fixed-surface.test.js`.
 *
 * Run: node --test testing/standalone/an-outside-apps-schema-validates-through-the-schema-package.test.js
 * (requires a prior `npm run build:server`, which builds `schema/` first)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { SCHEMA_PACKAGE_NAME, RETIRED_SCHEMA_PACKAGE_NAME, schemaSpecifierSource } from './_relative-specifier.mjs';
import { TYPESCRIPT_CARVE_OUT, schemaSourceProblems, carveOutUses, sentenceProblems } from './_schema-package-imports.mjs';
import { isApacheLicenceText } from './_notice-closure.mjs';
import * as pkg from '../../schema/dist/index.js';
import * as pkgInternal from '../../schema/dist/internal.js';
import * as bodies from '../../server/dist/spaces/body-schemas.js';
import * as rules from '../../server/dist/spaces/schema-rules.js';
import * as knowledge from '../../server/dist/config/types-knowledge.js';
import * as shared from '../../server/dist/spaces/_shared.js';
import * as logMod from '../../server/dist/util/log.js';
import * as redos from '../../server/dist/util/redos.js';
import * as metaFields from '../../server/dist/spaces/meta-fields.js';
import * as datePolicy from '../../server/dist/brain/chrono-date-policy.js';
import * as recordView from '../../server/dist/brain/record-view.js';
import * as plainObject from '../../server/dist/util/plain-object.js';
import * as internalKeys from '../../server/dist/util/object-internal-keys.js';
import * as lru from '../../server/dist/util/lru-map.js';
import * as canonical from '../../server/dist/util/canonical-json.js';
import * as refName from '../../server/dist/spaces/library-ref-name.js';
import * as refExpansion from '../../server/dist/spaces/library-ref-expansion.js';

const FIXTURES = 'testing/fixtures/outside-app-schemas';
const fixtures = readdirSync(FIXTURES).filter(f => f.endsWith('.json'))
  .map(f => ({ name: f, meta: JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) }));

describe('an outside app\'s schema validates through the schema package', () => {
  it('finds the fixtures it is about (three space metas an outside app generates)', () => {
    assert.deepEqual(fixtures.map(f => f.name).sort(), ['garden-beds.json', 'garden-plants.json', 'garden-season.json']);
    for (const { name, meta } of fixtures) {
      assert.ok(meta.typeSchemas && Object.keys(meta.typeSchemas).length > 0, `${name} carries type schemas`);
      assert.ok(!('id' in meta), `${name} is a meta, not a space: its id is stripped`);
    }
    // At least one carries CEL rules, so the rule engine is exercised and not only the bodies.
    assert.ok(fixtures.some(f => JSON.stringify(f.meta).includes('"rules"')), 'a fixture carries CEL rules');
  });

  for (const { name, meta } of fixtures) {
    it(`${name} passes validateSpaceMeta and parseSpaceMeta(meta, { against: {} })`, () => {
      // An app has no instance: the library is what it hands in (none here, and these metas reference none).
      const dry = pkg.validateSpaceMeta(meta, { library: [] });
      assert.equal(dry.ok, true, dry.ok ? '' : `${dry.message}\n${dry.failed.join('\n')}`);
      assert.deepEqual(dry.unknown, []);
      const parsed = pkg.parseSpaceMeta(meta, { against: {} });
      assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.message);
    });

    it(`${name}: the package and the server parse it to the same meta`, () => {
      assert.deepEqual(pkg.parseSpaceMeta(meta), bodies.parseSpaceMeta(meta));
    });
  }

  it('a bad meta is refused by the package in the words the server uses', () => {
    const bad = {
      validationMdoe: 'strict',
      typeSchemas: {
        entity: { person: { propertySchemas: { email: { pattern: '(a+)+$' } }, endpoints: { from: ['x'] } } },
        edge: { knows: { rules: { 'Bad Name': { rule: 'self.label == ""', message: 'm' } } } },
      },
    };
    const fromPackage = pkg.validateSpaceMeta(bad, { library: [] });
    const fromServer = bodies.parseSpaceMeta(bad);
    assert.equal(fromPackage.ok, false);
    assert.deepEqual(fromPackage, fromServer);
    assert.match(fromPackage.message, /quantified group/);
    assert.match(fromPackage.message, /unrecognized key: validationMdoe/);
    assert.ok(fromPackage.failed.some(f => f.startsWith('entity:person — endpoints')), fromPackage.failed.join('\n'));

    const type = pkg.parseTypeSchema('entity', 'person', { functional: true });
    assert.deepEqual(type, bodies.parseTypeSchema('entity', 'person', { functional: true }));
    assert.equal(type.ok, false);
    assert.deepEqual(Object.keys(type.refusal).sort(), ['error', 'issues'], 'the single-type refusal is { error, issues }');
  });

  it('a rule this instance could not apply is refused offline, by the CEL checks', () => {
    const r = pkg.validateSpaceMeta({ typeSchemas: { entity: { person: { rules: { reads: { rule: 'self.properties.age > 1', message: 'm' } } } } } }, { library: [] });
    assert.equal(r.ok, false);
    assert.match(r.message, /does not declare/);
  });
});

describe('a $ref is checked against the library handed in, never an instance\'s', () => {
  const entry = { name: 'service-v1', knowledgeType: 'entity', schema: { propertySchemas: { url: { type: 'string' } } } };
  const meta = { typeSchemas: { entity: { service: { $ref: 'library:service-v1' } } } };

  it('without a library, an entry it names does not exist', () => {
    const r = pkg.validateSpaceMeta(meta, { library: [] });
    assert.equal(r.ok, false);
    // The wording is package-internal (Q-668, 4'): an app reads it from the answer, never builds it.
    assert.equal(r.message, pkgInternal.brokenRefsError(['service-v1']));
  });

  it('with the entry, the reference is accepted, and a round-tripped definition is taken back', () => {
    assert.equal(pkg.validateSpaceMeta(meta, { library: [entry] }).ok, true);
    const roundTrip = { typeSchemas: { entity: { service: { $ref: 'library:service-v1', ...entry.schema } } } };
    const r = pkg.validateSpaceMeta(roundTrip, { library: [entry] });
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    assert.deepEqual(r.meta.typeSchemas.entity.service, { $ref: 'library:service-v1' });
    const edited = { typeSchemas: { entity: { service: { $ref: 'library:service-v1', propertySchemas: { url: { type: 'number' } } } } } };
    assert.equal(pkg.validateSpaceMeta(edited, { library: [entry] }).ok, false);
  });

  it('an entry filed under another kind is refused, naming both', () => {
    const r = pkg.validateSpaceMeta(meta, { library: [{ ...entry, knowledgeType: 'edge' }] });
    assert.equal(r.ok, false);
    assert.match(r.message, /filed under edge, so it cannot define the entity type 'service'/);
  });

  it('a library scoped to one call does not outlive it', () => {
    // Asked through the one $ref refusal every door runs (Q-668, 4'), never the finders behind it.
    assert.equal(typeof pkg.libraryRefRefusal, 'function', 'the schema package exports libraryRefRefusal, the one $ref refusal');
    pkg.withSchemaLibrary([entry], () => assert.equal(pkg.libraryRefRefusal(meta.typeSchemas), null));
    assert.equal(pkg.libraryRefRefusal(meta.typeSchemas, [])?.message, pkgInternal.brokenRefsError(['service-v1']));
  });
});

describe('the server\'s schema names are the package\'s, not copies', () => {
  /** [server module, its label, the names it re-exports from the package]. */
  const REEXPORTS = [
    [bodies, 'spaces/body-schemas', ['PropertySchemaZ', 'EndpointMemberZ', 'TypeSchemaZ', 'InlineTypeSchemaZ', 'TypeSchemasZ', 'SpaceMetaBody',
      'collectionScopeIssues', 'withoutBrokenLibraryRefs', 'SERVER_OWNED_META_FIELDS', 'stripServerOwnedMeta', 'parseSpaceMeta', 'readPeerMeta', 'readStoredMeta', 'parseTypeSchema', 'parseInlineDefinition',
      'LIBRARY_SCHEMA_KEYS', 'libraryDeletePathProblem', 'withTypeSchemas', 'derivedFromStored']],
    [rules, 'spaces/schema-rules', ['MAX_RULE_LENGTH', 'MAX_MESSAGE_LENGTH', 'MAX_RULES_PER_TYPE', 'MAX_RULES_PER_SPACE', 'MAX_APPLICABLE_RULES',
      'RULE_NAME_PATTERN', 'LONGEST_CHECKED_STRING', 'TypeRuleZ', 'SpaceRuleZ', 'typeRuleIssues', 'spaceRuleIssues', 'applicableRuleIssues',
      'ruleMapIssues', 'readingStoredRules']],
    [knowledge, 'config/types-knowledge', ['KNOWLEDGE_TYPES', 'MERGE_FNS', 'NUMERIC_MERGE_FNS', 'BOOLEAN_MERGE_FNS']],
    [shared, 'spaces/_shared', ['SPACE_PURPOSE_MAX', 'SCHEMA_DESCRIPTION_MAX', 'PROPERTY_DESCRIPTION_MAX']],
    [logMod, 'util/log', ['peerText', 'peerList', 'logSafe', 'refusalOfParse', 'unrecognizedKeysIssue', 'redactSecrets', 'NAME_QUOTED',
      'LOG_VALUE_MAX', 'REFUSAL_NAMES_MAX']],
    [redos, 'util/redos', ['hasReDoSRisk', 'REDOS_REFUSAL', 'MAX_PATTERN_LENGTH']],
    [metaFields, 'spaces/meta-fields', ['META_FIELD_KINDS', 'metaFieldKind', 'PER_TYPE_META_FIELD', 'eachTypeDefinition', 'mergeTypeDefinition',
      'mergeMetaFields', 'unknownMetaFields', 'MAX_UNKNOWN_NAMES', 'boundedNames']],
    [datePolicy, 'brain/chrono-date-policy', ['DATE_PASSED_VALUES']],
    [recordView, 'brain/record-view', ['VIEW_FIELDS', 'ALL_VIEW_FIELDS']],
    [plainObject, 'util/plain-object', ['isPlainObject', 'ownValue']],
    [internalKeys, 'util/object-internal-keys', ['isObjectInternalKey', 'isObjectPrototypeName']],
    [lru, 'util/lru-map', ['LruMap']],
    [canonical, 'util/canonical-json', ['canonicalJson']],
    [refName, 'spaces/library-ref-name', ['LIBRARY_REF_PREFIX', 'libraryEntryNameOf']],
    [refExpansion, 'spaces/library-ref-expansion', ['takeBackLibraryDefinition']],
  ];

  for (const [mod, label, names] of REEXPORTS) {
    it(`${label} re-exports the package's own objects`, () => {
      for (const name of names) {
        assert.ok(name in pkgInternal, `the schema package's internal entry exports ${name}`);
        assert.ok(mod[name] !== undefined, `server ${label} exports ${name}`);
        assert.equal(mod[name], pkgInternal[name], `server ${label}.${name} is the package's, not a copy`);
      }
    });
  }

});

/** Every `.ts` file under `dir`. */
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('no second definition is left in the server', () => {
  /** A declaration of a name the package owns. */
  const DECLARATIONS = [
    /\bconst (PropertySchemaZ|EndpointMemberZ|TypeSchemaZ|InlineTypeSchemaZ|TypeSchemasZ|SpaceMetaBody|TypeRuleZ|SpaceRuleZ|SchemaPatternZ)\s*[=:]/,
    /\bfunction (parseSpaceMeta|parseTypeSchema|parseInlineDefinition|readStoredMeta|readPeerMeta|collectionScopeIssues|takeBackLibraryDefinition|typeRuleIssues|spaceRuleIssues|applicableRuleIssues|ruleMapIssues|hasReDoSRisk|refusalOfParse|peerText|peerList|libraryEntryNameOf|canonicalJson|isPlainObject|isObjectInternalKey|boundedNames|mergeMetaFields)\s*[(<]/,
    /\bconst (KNOWLEDGE_TYPES|MERGE_FNS|NUMERIC_MERGE_FNS|BOOLEAN_MERGE_FNS|DATE_PASSED_VALUES|SPACE_PURPOSE_MAX|SCHEMA_DESCRIPTION_MAX|PROPERTY_DESCRIPTION_MAX|MAX_RULE_LENGTH|MAX_RULES_PER_TYPE|META_FIELD_KINDS|VIEW_FIELDS|REDOS_REFUSAL)\s*[=:]/,
    /\binterface (PropertySchema|TypeSchema|SpaceMeta|SchemaRule|SpaceSchemaRule)\s*[{<]/,
    /\bclass LruMap\b/,
  ];

  it('the scanner sees each declaration in the package (it is not blind)', () => {
    const pkgSrc = tsFiles('schema/src').map(f => stripComments(readFileSync(f, 'utf8'))).join('\n');
    for (const re of DECLARATIONS) assert.match(pkgSrc, re, `the package declares ${re}`);
  });

  it('server/src declares none of them', () => {
    const found = [];
    for (const file of tsFiles('server/src')) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const re of DECLARATIONS) {
        const m = src.match(re);
        if (m) found.push(`${file}: ${m[0]}`);
      }
    }
    assert.deepEqual(found, [], `a moved definition is declared in the server again:\n${found.join('\n')}`);
  });

  it('server/src reaches the package by its name, never by a path into its source', () => {
    // A relative import of `schema/src` would be a second copy of the module — and of its state, the installed library.
    const offenders = tsFiles('server/src').filter(file => /from\s+['"](?:\.\.\/)+schema\//.test(readFileSync(file, 'utf8')));
    assert.deepEqual(offenders, []);
  });
});

describe('the package reads no instance', () => {
  const ENTRY = TYPESCRIPT_CARVE_OUT.file;
  /** Every file of the package's source, uncommitted ones too: the entry is written before it is committed. */
  const sources = () => trackedSources('schema/src', { floor: 15, untracked: true });

  it('its source imports zod, the CEL engine, Node built-ins and its own modules, and in the one carve-out file the dynamic literal import(\'typescript\') (typescript only through from-typescript.ts)', () => {
    const files = sources();
    const problems = files.flatMap(file => schemaSourceProblems(file, readFileSync(file, 'utf8')));
    // The scanner has a floor: it saw imports (a blind scan passes about nothing).
    const seen = files.reduce((n, f) => n + (stripComments(readFileSync(f, 'utf8')).match(/\b(?:import|export)\b[^;]*?\bfrom\s*['"]|\bimport\s*\(/g) ?? []).length, 0);
    assert.ok(seen >= 30, `the scanner found ${seen} imports in the package: it is blind`);
    assert.deepEqual(problems, []);
  });

  it('the carve-out is used: the entry is a file of the package and names typescript by the dynamic literal', () => {
    assert.ok(sources().includes(ENTRY), `${ENTRY} is not a file of the package: the carve-out admits an import nobody makes`);
    assert.ok(carveOutUses(readFileSync(ENTRY, 'utf8')) >= 1, `${ENTRY} has no dynamic literal import('typescript')`);
  });

  describe('the scanner bites (mutation rows, planted as strings: nothing of them is in the repository)', () => {
    const OTHER = 'schema/src/vocabulary.ts';
    const admitted = "import type ts from 'typescript';\nconst load = () => import('typescript');\nconst x = ts.sys.readFile;\n";

    it('admits the carve-out in its own file: the dynamic literal, import type, and .sys', () => {
      assert.deepEqual(schemaSourceProblems(ENTRY, admitted), []);
    });

    it('refuses the specifier in a second file', () => {
      assert.match(schemaSourceProblems(OTHER, "const m = await import('typescript');").join(), /dynamic import of 'typescript' outside schema\/src\/from-typescript\.ts/);
      assert.match(schemaSourceProblems(OTHER, "import type ts from 'typescript';").join(), /static import of 'typescript' outside/);
    });

    it('refuses the static form, in the entry too', () => {
      assert.match(schemaSourceProblems(ENTRY, "import ts from 'typescript';").join(), /static import of 'typescript' loads the compiler/);
      assert.match(schemaSourceProblems(ENTRY, "import { createProgram } from 'typescript';").join(), /static import of 'typescript'/);
      assert.match(schemaSourceProblems(ENTRY, "import 'typescript';").join(), /static import of 'typescript'/);
      assert.match(schemaSourceProblems(ENTRY, "export * from 'typescript';").join(), /static import of 'typescript'/);
    });

    it('refuses a non-literal import(), in the entry too', () => {
      for (const form of ['const m = await import(name);', "const m = await import('type' + 'script');", 'const m = await import(`typescript`);', "const m = await import(...['typescript']);"]) {
        assert.match(schemaSourceProblems(ENTRY, form).join(), /non-literal import\(\)/, form);
        assert.match(schemaSourceProblems(OTHER, form).join(), /non-literal import\(\)/, form);
      }
    });

    it('refuses a planted .sys and createCompilerHost outside the entry, and admits them inside', () => {
      assert.match(schemaSourceProblems(OTHER, 'const f = ts.sys.readFile;').join(), /\.sys outside/);
      assert.match(schemaSourceProblems(OTHER, "const f = ts['sys'];").join(), /\.sys outside/);
      assert.match(schemaSourceProblems(OTHER, 'const h = ts.createCompilerHost(o);').join(), /createCompilerHost outside/);
      assert.deepEqual(schemaSourceProblems(ENTRY, 'const h = ts.createCompilerHost(o); const f = ts.sys.readFile;'), []);
    });

    it('refuses new Function, eval, createRequire and require anywhere, the entry included', () => {
      for (const [form, what] of [['new Function("return 1")', 'new Function'], ['eval(code)', 'eval'],
        ["import { createRequire } from 'node:module'; createRequire(import.meta.url)", 'createRequire'], ["const t = require('typescript')", 'require']]) {
        assert.match(schemaSourceProblems(ENTRY, form).join(), new RegExp(`${what} names a module`), form);
        assert.match(schemaSourceProblems(OTHER, form).join(), new RegExp(`${what} names a module`), form);
      }
    });

    it('refuses an import that is not the closure\'s, and an entry module reaching from-typescript', () => {
      assert.match(schemaSourceProblems(OTHER, "import fs from 'node:fs'; import x from 'left-pad';").join(), /static import of 'left-pad'/);
      assert.match(schemaSourceProblems(OTHER, "const m = await import('typescript-6');").join(), /dynamic import of 'typescript-6'/);
      assert.match(schemaSourceProblems('schema/src/index.ts', "export * from './from-typescript.js';").join(), /reaches from-typescript/);
      assert.match(schemaSourceProblems('schema/src/internal.ts', "export type { NotRead } from './from-typescript.js';").join(), /reaches from-typescript/);
      assert.deepEqual(schemaSourceProblems(OTHER, "import { z } from 'zod'; import { a } from './limits.js'; const p = import('./x.js');"), []);
    });

    it('does not read comments as code, and counts the carve-out\'s literal only', () => {
      assert.deepEqual(schemaSourceProblems(OTHER, "// import('typescript') and eval(x), ts.sys, new Function\n/* import ts from 'typescript' */\nconst a = 1;"), []);
      assert.equal(carveOutUses("const a = () => import('typescript');"), 1);
      assert.equal(carveOutUses("// import('typescript')\nconst a = import(name);"), 0);
    });
  });

  it('this file\'s header and title state the closure with the carve-out (tied to the one carve-out, so the statement cannot go stale)', () => {
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    const bullet = /\*\*The package reads no instance\*\*:[\s\S]*?(?=\n \* - \*\*|\n \*\n)/.exec(self)?.[0].replace(/\s*\n \*\s*/g, ' ');
    assert.ok(bullet, 'the header has no "The package reads no instance" bullet');
    assert.deepEqual(sentenceProblems(bullet), [], 'the header bullet does not state the closure the gate enforces');
    const title = /it\('(its source imports[^\n]*?)', \(\) => \{/.exec(self)?.[1];
    assert.ok(title, 'the closure test has no title starting "its source imports"');
    assert.deepEqual(sentenceProblems(title.replace(/\\'/g, "'")), [], 'the test title does not state the closure the gate enforces');
  });

  it('the old wording of the closure is refused by the tie (planted copy)', () => {
    const old = 'its source imports zod, the CEL engine, Node built-ins and its own modules — nothing of the server';
    assert.ok(sentenceProblems(old).length >= 2, 'the old statement passed: the tie does not bite');
  });

  it('it reads no environment variable and no file', () => {
    for (const file of tsFiles('schema/src')) {
      const src = stripComments(readFileSync(file, 'utf8'));
      assert.doesNotMatch(src, /process\.env|readFileSync|from ['"]node:fs/, `${file} reads the environment or a file`);
    }
  });
});

/** Whether an npm script runs the package's own build script, by workspace name. A fresh RegExp per use; the name comes from the manifest through the one specifier source. */
const buildsThePackage = (script) => new RegExp(`npm run build -w ${schemaSpecifierSource([''])}(?:\\s|&&|$)`).test(script);

describe('the package is publishable', () => {
  const manifest = JSON.parse(readFileSync('schema/package.json', 'utf8'));
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const server = JSON.parse(readFileSync('server/package.json', 'utf8'));

  it('is named, versioned and not private', () => {
    assert.equal(manifest.name, SCHEMA_PACKAGE_NAME);
    assert.equal(manifest.private, undefined);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.version, root.version, 'versioned with the release it is cut from');
    assert.equal(manifest.type, 'module', 'ESM: the CEL engine is loaded with a top-level await');
  });

  it('is licensed Apache-2.0, with its own committed LICENSE and NOTICE', () => {
    // The owner's ruling (2026-11-01): the package an outside app installs is Apache-2.0, not the repository's licence. Its LICENSE and
    // NOTICE are committed in `schema/`, so the tarball and the image carry the package's own and never a copy of the root's.
    assert.equal(manifest.license, 'Apache-2.0');
    assert.ok(existsSync('schema/LICENSE'), 'schema/LICENSE is committed');
    assert.ok(isApacheLicenceText(readFileSync('schema/LICENSE', 'utf8')), 'schema/LICENSE holds the Apache License 2.0 text');
    assert.ok(existsSync('schema/NOTICE'), 'schema/NOTICE is committed');
  });

  it('exports its built entry points with types, and ships only dist, the README and the licence', () => {
    assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './from-typescript', './internal', './package.json']);
    for (const entry of ['.', './internal', './from-typescript']) {
      for (const cond of ['types', 'import']) assert.match(manifest.exports[entry][cond], /^\.\/dist\//);
    }
    assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE', 'NOTICE']);
    assert.ok(readFileSync('schema/README.md', 'utf8').includes('validateSpaceMeta'), 'the README says how an app validates a schema');
  });

  it('is a workspace of this repository, and the server depends on it and builds it first', () => {
    assert.ok(root.workspaces.includes('schema'));
    assert.equal(server.dependencies[SCHEMA_PACKAGE_NAME], manifest.version);
    // Through the package's OWN build script (Q-668, S-C4), so the dist clean it runs first is not skipped by a bare `tsc -p`.
    for (const script of ['predev', 'prebuild']) {
      assert.ok(buildsThePackage(server.scripts[script] ?? ''), `server ${script} builds the package by its build script`);
    }
  });

  it('the builds-the-package reader names the package by its manifest name only (planted: the retired name builds nothing)', () => {
    assert.equal(buildsThePackage(`npm run build -w ${SCHEMA_PACKAGE_NAME}`), true);
    assert.equal(buildsThePackage(`npm run build -w ${SCHEMA_PACKAGE_NAME} && tsx x`), true);
    assert.equal(buildsThePackage(`npm run build -w ${RETIRED_SCHEMA_PACKAGE_NAME}`), false);
    assert.equal(buildsThePackage(`npm run build -w ${SCHEMA_PACKAGE_NAME}-extra`), false);
  });
});
