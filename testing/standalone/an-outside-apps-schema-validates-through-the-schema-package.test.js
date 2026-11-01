/**
 * An app that writes a space schema validates it through `@ythril/schema`, and the server runs the same code — never a copy of it.
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
 * - **An outside app's schema validates through the package**, offline: the three space metas Lia generates (fixtures, copied with
 *   their `id` stripped) pass `validateSpaceMeta` and `parseSpaceMeta(meta, { against: {} })`, and the package and the server answer
 *   alike for a good meta and a bad one, refusal text included.
 * - **The server's names ARE the package's**: every schema export a server module re-exports is the same object, not an equal one.
 * - **No second definition is left in the server**: the moved bodies, parses, tuples, limits and helpers are declared nowhere under
 *   `server/src`.
 * - **The package reads no instance**: its source imports zod, the CEL engine, Node built-ins and itself, and a `$ref` is checked
 *   against the library HANDED to it.
 * - **The package is publishable**: not private, with `exports`, `files`, a version, the repository's licence and a README.
 *
 * Run: node --test testing/standalone/an-outside-apps-schema-validates-through-the-schema-package.test.js
 * (requires a prior `npm run build:server`, which builds `schema/` first)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
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

describe('an outside app\'s schema validates through @ythril/schema', () => {
  it('finds the fixtures it is about (three space metas Lia generates)', () => {
    assert.deepEqual(fixtures.map(f => f.name).sort(), ['lia-characters.json', 'lia-workshop.json', 'lia-worlds.json']);
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
    assert.equal(r.message, pkg.brokenRefsError(['service-v1']));
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
    pkg.withSchemaLibrary([entry], () => assert.equal(pkg.findBrokenLibraryRefs(meta.typeSchemas).length, 0));
    assert.deepEqual(pkg.findBrokenLibraryRefs(meta.typeSchemas, []), ['service-v1']);
  });
});

describe('the server\'s schema names are the package\'s, not copies', () => {
  /** [server module, its label, the names it re-exports from the package]. */
  const REEXPORTS = [
    [bodies, 'spaces/body-schemas', ['PropertySchemaZ', 'EndpointMemberZ', 'TypeSchemaZ', 'InlineTypeSchemaZ', 'TypeSchemasZ', 'SpaceMetaBody',
      'collectionScopeIssues', 'findBrokenLibraryRefs', 'withoutBrokenLibraryRefs', 'brokenRefsError', 'findWrongKindLibraryRefs', 'wrongKindRefsError',
      'SERVER_OWNED_META_FIELDS', 'stripServerOwnedMeta', 'parseSpaceMeta', 'readPeerMeta', 'readStoredMeta', 'parseTypeSchema', 'parseInlineDefinition',
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
        assert.ok(name in pkgInternal, `@ythril/schema/internal exports ${name}`);
        assert.ok(mod[name] !== undefined, `server ${label} exports ${name}`);
        assert.equal(mod[name], pkgInternal[name], `server ${label}.${name} is the package's, not a copy`);
      }
    });
  }

  it('an app\'s entry point carries the schema API, and the server-only helpers stay behind /internal', () => {
    for (const name of ['validateSpaceMeta', 'parseSpaceMeta', 'parseTypeSchema', 'SpaceMetaBody', 'TypeSchemasZ', 'KNOWLEDGE_TYPES', 'MERGE_FNS',
      'withSchemaLibrary', 'hasReDoSRisk', 'refusalOfParse']) {
      assert.ok(name in pkg, `@ythril/schema exports ${name}`);
    }
    for (const name of ['LruMap', 'compileRule', 'ruleEngine', 'render']) {
      assert.ok(!(name in pkg), `${name} is not part of the app API`);
      assert.ok(name in pkgInternal, `${name} is in /internal for the server`);
    }
  });
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
  it('its source imports zod, the CEL engine, Node built-ins and its own modules — nothing of the server', () => {
    const allowed = /^(zod|@bufbuild\/cel|node:[a-z_/]+|\.\/[a-z-]+\.js)$/;
    const bad = [];
    let seen = 0;
    for (const file of tsFiles('schema/src')) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // A static import or re-export (`import ... from`, `export ... from`, a bare `import '...'`) and a dynamic `import('...')`.
      const specifiers = [
        ...[...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
        ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
        ...[...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
      ];
      seen += specifiers.length;
      for (const spec of specifiers) if (!allowed.test(spec)) bad.push(`${file}: ${spec}`);
    }
    assert.ok(seen >= 30, `the scanner found ${seen} imports in the package: it is blind`);
    assert.deepEqual(bad, []);
  });

  it('it reads no environment variable and no file', () => {
    for (const file of tsFiles('schema/src')) {
      const src = stripComments(readFileSync(file, 'utf8'));
      assert.doesNotMatch(src, /process\.env|readFileSync|from ['"]node:fs/, `${file} reads the environment or a file`);
    }
  });
});

describe('the package is publishable', () => {
  const manifest = JSON.parse(readFileSync('schema/package.json', 'utf8'));
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const server = JSON.parse(readFileSync('server/package.json', 'utf8'));

  it('is named, versioned, licensed as the repository and not private', () => {
    assert.equal(manifest.name, '@ythril/schema');
    assert.equal(manifest.private, undefined);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.version, root.version, 'versioned with the release it is cut from');
    assert.equal(manifest.license, root.license);
    assert.equal(manifest.type, 'module', 'ESM: the CEL engine is loaded with a top-level await');
  });

  it('exports its built entry points with types, and ships only dist, the README and the licence', () => {
    assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './internal', './package.json']);
    for (const entry of ['.', './internal']) {
      for (const cond of ['types', 'import']) assert.match(manifest.exports[entry][cond], /^\.\/dist\//);
    }
    assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE', 'NOTICE']);
    assert.ok(readFileSync('schema/README.md', 'utf8').includes('validateSpaceMeta'), 'the README says how an app validates a schema');
  });

  it('is a workspace of this repository, and the server depends on it and builds it first', () => {
    assert.ok(root.workspaces.includes('schema'));
    assert.equal(server.dependencies['@ythril/schema'], manifest.version);
    assert.match(server.scripts.prebuild ?? '', /tsc -p \.\.\/schema/);
  });
});
