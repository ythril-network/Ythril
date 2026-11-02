/**
 * `@ythril/schema`'s app entry (`.`) exports exactly the names listed here, values and types; the server-only helpers are behind
 * `./internal` (Q-668, 5', S2, S3, B6).
 *
 * ## The defect this prevents
 *
 * `schema/src/index.ts` re-exported `space-meta.ts` and `meta-fields.ts` with `export *`, so every helper the server needed became app
 * API the day it was written: `mergeMetaFields`, `readStoredMeta`, `useSchemaLibrary` and the rest were importable by an outside app,
 * documented by its presence, and a breaking change to a server internal became a breaking change to a published package. A hand list
 * of a few names "in" and a few "out" (the earlier test) saw none of it: a new export was in the API without anyone deciding so.
 *
 * ## What is held
 *
 * - The app entry's VALUE names (`Object.keys` of the built `schema/dist/index.js`) equal {@link APP_VALUES}.
 * - Its TYPE names (the TypeScript checker's `getExportsOfModule` over `schema/dist/index.d.ts`, the names with no value) equal
 *   {@link APP_TYPES}. `Object.keys` cannot see a type, and `export *` hands types on as silently as values.
 * - The server-only helpers are absent from `.` and present in `./internal`; `libraryRefRefusal` (what `validateSpaceMeta` runs) and
 *   `withSchemaLibrary` (how an app scopes a library) are in `.`.
 *
 * A new public name is a deliberate edit of a list below, made in the same change as the export.
 *
 * Run: node --test testing/standalone/the-schema-packages-app-entry-names-a-fixed-surface.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ts from 'typescript';
import * as app from '../../schema/dist/index.js';
import * as internal from '../../schema/dist/internal.js';

/** The app entry's values. */
const APP_VALUES = [
  'ALL_VIEW_FIELDS', 'BOOLEAN_MERGE_FNS', 'DATE_PASSED_VALUES', 'EndpointMemberZ', 'InlineTypeSchemaZ', 'KNOWLEDGE_TYPES',
  'LIBRARY_REF_PREFIX', 'LIBRARY_SCHEMA_KEYS', 'LOG_VALUE_MAX', 'LONGEST_CHECKED_STRING', 'MAX_APPLICABLE_RULES', 'MAX_MESSAGE_LENGTH',
  'MAX_PATTERN_LENGTH', 'MAX_RULES_PER_SPACE', 'MAX_RULES_PER_TYPE', 'MAX_RULE_LENGTH', 'MAX_UNKNOWN_NAMES', 'MERGE_FNS',
  'META_FIELD_KINDS', 'NAME_QUOTED', 'NUMERIC_MERGE_FNS', 'PER_TYPE_META_FIELD', 'PROPERTY_DESCRIPTION_MAX', 'PropertySchemaZ',
  'REDOS_REFUSAL', 'REFUSAL_NAMES_MAX', 'RULE_NAME_PATTERN', 'SCHEMA_DESCRIPTION_MAX', 'SERVER_OWNED_META_FIELDS', 'SPACE_PURPOSE_MAX',
  'SpaceMetaBody', 'SpaceRuleZ', 'TypeRuleZ', 'TypeSchemaZ', 'TypeSchemasZ', 'VIEW_FIELDS', 'applicableRuleIssues',
  'collectionScopeIssues', 'currentSchemaLibrary', 'hasReDoSRisk', 'libraryDefinitionOf', 'libraryDeletePathProblem',
  'libraryEntryNameOf', 'libraryRefRefusal', 'metaFieldKind', 'parseInlineDefinition', 'parseSpaceMeta', 'parseTypeSchema', 'peerList',
  'peerText', 'readingStoredRules', 'refusalOfParse', 'ruleMapIssues', 'spaceRuleIssues', 'stripServerOwnedMeta',
  'takeBackLibraryDefinition', 'typeRuleIssues', 'unknownMetaFields', 'unrecognizedKeysIssue', 'validateSpaceMeta', 'withSchemaLibrary',
];

/** The app entry's types (names with no value). */
const APP_TYPES = [
  'BooleanMergeFn', 'ChangedRuleParts', 'DatePassedPolicy', 'KnowledgeType', 'MergeFn', 'MetaFieldKind', 'MetaParse',
  'MetaParseOptions', 'NumericMergeFn', 'ParseIssueLike', 'ParseRefusal', 'ParseRefusalIssue', 'ParseRefusalOptions', 'ParsedSpaceMeta',
  'ParsedTypeSchema', 'PropertySchema', 'RuleIssue', 'SchemaLibraryEntryLike', 'SchemaLibrarySource', 'SchemaRule', 'SpaceMeta',
  'SpaceSchemaRule', 'TypeSchema', 'ValidateSpaceMetaOptions', 'ValidationMode', 'ViewField', 'ViewKind', 'WrongKindLibraryRef',
];

/** What the server uses and an app must not: the nine server-only helpers, the installer, and the $ref finders and their wording. */
const SERVER_ONLY = [
  'mergeMetaFields', 'mergeTypeDefinition', 'eachTypeDefinition', 'boundedNames', 'withTypeSchemas', 'derivedFromStored', 'readPeerMeta',
  'readStoredMeta', 'useSchemaLibrary', 'withoutBrokenLibraryRefs',
  'findBrokenLibraryRefs', 'findWrongKindLibraryRefs', 'brokenRefsError', 'wrongKindRefsError',
  // The server's machinery that never was app API (the earlier hand list), held here so it cannot drift in.
  'LruMap', 'compileRule', 'ruleEngine', 'render',
];

/** Every name `dts` exports, split into values and type-only names, read by the TypeScript checker (`export *` followed). */
function declaredExports(dts) {
  const program = ts.createProgram([dts], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dts);
  assert.ok(source, `the checker cannot read ${dts}: build the package first`);
  const values = [];
  const types = [];
  for (const s of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    (target.flags & ts.SymbolFlags.Value ? values : types).push(s.name);
  }
  return { values: values.sort(), types: types.sort() };
}

describe('the readers this gate stands on', () => {
  it('the checker sees through export * and tells a type from a value', () => {
    const { values, types } = declaredExports(join(process.cwd(), 'schema/dist/index.d.ts'));
    // Floors: an unread declaration file gives empty lists, and an empty list equals nothing below only by accident.
    assert.ok(values.length >= 50 && types.length >= 20, `read ${values.length} values and ${types.length} types: the reader is broken`);
    assert.ok(types.includes('TypeSchema') && values.includes('validateSpaceMeta'));
    // The planted copy: the internal entry adds `LruMap` (a value) and `LruWeight` (a type), and the reader sees both as such.
    const inner = declaredExports(join(process.cwd(), 'schema/dist/internal.d.ts'));
    assert.ok(inner.values.includes('LruMap') && inner.types.includes('LruWeight') && !values.includes('LruMap'));
  });
});

describe('the app entry names a fixed surface', () => {
  it('its values are the list', () => {
    assert.deepEqual(Object.keys(app).sort(), [...APP_VALUES].sort());
  });

  it('its declared values agree with what the build exports (no value only in the types, none only in the code)', () => {
    assert.deepEqual(declaredExports(join(process.cwd(), 'schema/dist/index.d.ts')).values, Object.keys(app).sort());
  });

  it('its types are the list', () => {
    assert.deepEqual(declaredExports(join(process.cwd(), 'schema/dist/index.d.ts')).types, [...APP_TYPES].sort());
  });

  it('the server-only helpers are behind ./internal, not in the app entry', () => {
    const leaked = SERVER_ONLY.filter(name => name in app);
    assert.deepEqual(leaked, [], `the app entry exports server-only helpers: ${leaked.join(', ')}`);
    const missing = SERVER_ONLY.filter(name => !(name in internal));
    assert.deepEqual(missing, [], `./internal lacks: ${missing.join(', ')}`);
  });

  it('the app entry carries libraryRefRefusal and withSchemaLibrary, and ./internal hands on all of it', () => {
    for (const name of ['libraryRefRefusal', 'withSchemaLibrary', 'validateSpaceMeta']) assert.ok(name in app, `@ythril/schema exports ${name}`);
    for (const name of Object.keys(app)) assert.equal(internal[name], app[name], `./internal re-exports ${name} as the same object`);
  });
});
