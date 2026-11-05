/**
 * The schema package's app entry (`.`) exports exactly the names listed here, values and types; the server-only helpers are behind
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
 * - The app entry's VALUE names (`Object.keys` of the built `schema/dist/index.js`) equal `APP_VALUES`.
 * - Its TYPE names (the TypeScript checker's `getExportsOfModule` over `schema/dist/index.d.ts`, the names with no value) equal
 *   `APP_TYPES`. `Object.keys` cannot see a type, and `export *` hands types on as silently as values.
 * - The server-only helpers are absent from `.` and present in `./internal`; `libraryRefRefusal` (what `validateSpaceMeta` runs) and
 *   `withSchemaLibrary` (how an app scopes a library) are in `.`.
 *
 * A new public name is a deliberate edit of a list in `_schema-app-entry-names.mjs`, made in the same change as the export; the package README's
 * export table is held to the same lists by `the-schema-readme-names-every-name-of-the-app-entry.test.js`.
 *
 * Run: node --test testing/standalone/the-schema-packages-app-entry-names-a-fixed-surface.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { declaredExports } from './_declared-exports.mjs';
import * as app from '../../schema/dist/index.js';
import * as internal from '../../schema/dist/internal.js';
import { APP_VALUES, APP_TYPES } from './_schema-app-entry-names.mjs';

/** What the server uses and an app must not: the nine server-only helpers, the installer, and the $ref finders and their wording. */
const SERVER_ONLY = [
  'mergeMetaFields', 'mergeTypeDefinition', 'eachTypeDefinition', 'boundedNames', 'withTypeSchemas', 'derivedFromStored', 'readPeerMeta',
  'readStoredMeta', 'useSchemaLibrary', 'withoutBrokenLibraryRefs',
  'findBrokenLibraryRefs', 'findWrongKindLibraryRefs', 'brokenRefsError', 'wrongKindRefsError',
  // The server's machinery that never was app API (the earlier hand list), held here so it cannot drift in.
  'LruMap', 'compileRule', 'ruleEngine', 'render',
];

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
    for (const name of ['libraryRefRefusal', 'withSchemaLibrary', 'validateSpaceMeta']) assert.ok(name in app, `the schema package exports ${name}`);
    for (const name of Object.keys(app)) assert.equal(internal[name], app[name], `./internal re-exports ${name} as the same object`);
  });
});
