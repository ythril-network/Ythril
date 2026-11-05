/**
 * A space's type schemas become TypeScript property types: one export, `typesOfSpaceMeta(meta, { library? })`, answering
 * `{ source, untranslated }` (Q-669, design v3).
 *
 * ## The rules held here
 *
 * - **Every property kind has one member type.** string, number and boolean as declared; date is `string` (stored as an ISO string);
 *   an enum is the union of its members FILTERED by the declared type (`{ type: 'string', enum: ['a', 1] }` is `'a'`), `never` when
 *   nothing is left, and that emptying is reported (`enum-emptied`); an untyped property is per kind (below).
 * - **The per-kind value rule (S2).** An entity's property values are primitives, so its untyped and open members are
 *   `string | number | boolean`; a fact's, an edge's and a chrono entry's may be any JSON, so theirs are `unknown`. A declared typed
 *   property keeps its declared type on every kind.
 * - **`<Kind><Name>Properties` is the strict create contract, closed.** A required property without a default is a required member;
 *   one with a default (applied before validation on insert) and every other property are optional; no index signature.
 * - **`<Kind><Name>StoredProperties` is what a stored record may hold.** Every declared member optional and `unknown` (a stored value
 *   may predate the schema, or have been accepted under warn or off), plus `[key: string]: unknown`.
 * - **`SpaceTypes` is the lookup map**: one key per knowledge type (from `KNOWLEDGE_TYPES`, never a copy), each mapping the real type
 *   names to `{ properties, stored }`; a kind with no types is an empty map.
 * - **The header** is a leading block comment that says a patch is `Partial<...>` and that warn and off accept more than the strict
 *   contract the types state.
 *
 * Each rule is checked by the compiler, not by matching text: a usage source per rule states its expectations as `Expect<Equals<...>>`
 * lines over `SpaceTypes[kind][name]`, so the test does not depend on how the converter spells an identifier. All sources compile in one
 * in-memory program (`_typescript-of-space-meta.mjs`).
 *
 * Run: node --test testing/standalone/a-space-schema-becomes-typescript-property-types.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  schema, compileInMemory, converted, assertReported, headerOf, withLines, lit, unionOf, at,
} from './_typescript-of-space-meta.mjs';

const { KNOWLEDGE_TYPES } = schema;

/** An entity type with every property kind: name -> [definition, the member type it must become]. */
const ENTITY_KINDS = {
  s: [{ type: 'string' }, 'string'],
  n: [{ type: 'number' }, 'number'],
  b: [{ type: 'boolean' }, 'boolean'],
  d: [{ type: 'date' }, 'string'],
  u: [{}, 'string | number | boolean'],
  e: [{ type: 'string', enum: ['a', 'b'] }, "'a' | 'b'"],
  en: [{ type: 'number', enum: [1, 2] }, '1 | 2'],
  eb: [{ type: 'boolean', enum: [true] }, 'true'],
  emix: [{ type: 'string', enum: ['a', 1, true] }, "'a'"],
  euntyped: [{ enum: ['a', 1, true] }, "'a' | 1 | true"],
  eempty: [{ type: 'string', enum: [1] }, 'never'],
  mf: [{ type: 'number', mergeFn: 'avg', minimum: 0, maximum: 10, description: 'a mean' }, 'number'],
  p: [{ type: 'string', pattern: '^[a-z]+$' }, 'string'],
  r: [{ type: 'string', required: true }, 'string'],
  rd: [{ type: 'string', required: true, default: 'x' }, 'string'],
};

/** The same for the other kinds: untyped is `unknown` there; declared types are kept. */
const OTHER_KINDS = {
  s: [{ type: 'string' }, 'string'],
  n: [{ type: 'number' }, 'number'],
  d: [{ type: 'date' }, 'string'],
  u: [{}, 'unknown'],
  e: [{ type: 'string', enum: ['a', 1] }, "'a'"],
  r: [{ type: 'number', required: true }, 'number'],
  rd: [{ type: 'number', required: true, default: 3 }, 'number'],
};

const kindsOf = (kind) => (kind === 'entity' ? ENTITY_KINDS : OTHER_KINDS);
const REQUIRED = new Set(['r']);
const propsOf = (kinds) => Object.fromEntries(Object.entries(kinds).map(([k, [def]]) => [k, def]));

/** Every kind holds `every` (each property kind) and `open` (no properties declared). */
const META = {
  validationMode: 'strict',
  typeSchemas: Object.fromEntries(KNOWLEDGE_TYPES.map(kind => [kind, { every: { propertySchemas: propsOf(kindsOf(kind)) }, open: {} }])),
};

/** Only the first kind declares a type: the others are empty maps in SpaceTypes. */
const ONE_KIND = { typeSchemas: { [KNOWLEDGE_TYPES[0]]: { only: { propertySchemas: { a: { type: 'string' } } } } } };

const IMPORT = "import type { SpaceTypes } from './gen';\nimport type { Equals, Expect, IsOptional, HasIndex, Not } from './assert-types';\n";
const IMPORT_ONE = "import type { SpaceTypes } from './gen-one';\nimport type { Equals, Expect } from './assert-types';\n";

let n = 0;
const expect = (body) => `type _${n++} = Expect<${body}>;`;

/** The usage sources, one per rule, each a list of `Expect` lines. */
function usage() {
  const lines = { kinds: [], required: [], closed: [], stored: [], perKind: [], map: [] };
  for (const kind of KNOWLEDGE_TYPES) {
    const P = at(kind, 'every');
    const S = at(kind, 'every', 'stored');
    const kinds = kindsOf(kind);
    for (const [key, [, member]] of Object.entries(kinds)) {
      lines.kinds.push(expect(`Equals<Required<${P}>[${lit(key)}], ${member}>`));
      lines.required.push(expect(`Equals<IsOptional<${P}, ${lit(key)}>, ${!REQUIRED.has(key)}>`));
      lines.stored.push(expect(`Equals<IsOptional<${S}, ${lit(key)}>, true>`), expect(`Equals<${S}[${lit(key)}], unknown>`));
    }
    lines.closed.push(expect(`Not<HasIndex<${P}>>`), expect(`Equals<keyof ${P}, ${unionOf(Object.keys(kinds))}>`));
    lines.closed.push(`// @ts-expect-error an undeclared key on the strict create contract\nconst _x${n++}: ${P} = { r: ${kind === 'entity' ? "'v'" : '1'}, undeclared: 1 };`);
    lines.stored.push(expect(`HasIndex<${S}>`), expect(`Equals<${S}[string], unknown>`));
    const open = at(kind, 'open');
    const value = kind === 'entity' ? 'string | number | boolean' : 'unknown';
    lines.perKind.push(expect(`HasIndex<${open}>`), expect(`Equals<${open}[string], ${value}>`));
    lines.perKind.push(expect(`Equals<Required<${P}>['u'], ${value}>`), expect(`Equals<Required<${P}>['s'], string>`));
    lines.map.push(expect(`Equals<keyof SpaceTypes[${lit(kind)}], 'every' | 'open'>`));
    lines.map.push(expect(`Equals<keyof SpaceTypes[${lit(kind)}]['every'], 'properties' | 'stored'>`));
  }
  lines.map.push(expect(`Equals<keyof SpaceTypes, ${unionOf(KNOWLEDGE_TYPES)}>`));
  return Object.fromEntries(Object.entries(lines).map(([k, v]) => [`u-${k}`, IMPORT + v.join('\n') + '\n']));
}

function oneKindUsage() {
  const lines = [expect(`Equals<keyof SpaceTypes, ${unionOf(KNOWLEDGE_TYPES)}>`), expect(`Equals<keyof SpaceTypes[${lit(KNOWLEDGE_TYPES[0])}], 'only'>`)];
  for (const kind of KNOWLEDGE_TYPES.slice(1)) lines.push(expect(`Equals<keyof SpaceTypes[${lit(kind)}], never>`));
  return IMPORT_ONE + lines.join('\n') + '\n';
}

let memo;
/** The one program: both generated sources and every usage source, compiled once. */
function compiled() {
  if (memo) return memo;
  const gen = converted(META);
  const one = converted(ONE_KIND);
  const files = { gen: gen.source, 'gen-one': one.source, ...usage(), 'u-one-kind': oneKindUsage() };
  memo = { gen, one, files, result: compileInMemory(files) };
  return memo;
}

/** Asserts `name` compiled clean in the one program. */
function clean(name, why) {
  const { files, result } = compiled();
  assert.deepEqual(result.global, [], 'the program has no global diagnostics');
  assert.equal(result.byFile[name].length, 0, `${why}:\n${withLines(result.byFile[name], files[name])}`);
}

describe('typesOfSpaceMeta: the one export', () => {
  it('is a function of the app entry answering { source, untranslated }, with and without a library', () => {
    converted(META);
    converted(META, { library: [] });
  });

  it('its source compiles under --strict', () => {
    clean('gen', 'the source for a meta with every property kind on every kind compiles');
    clean('gen-one', 'the source for a meta with one kind compiles');
  });
});

describe('every property kind becomes one member type', () => {
  it('string, number, boolean, date as string, untyped per kind, an enum filtered by its type (never when nothing is left)', () => {
    clean('u-kinds', 'a member is not the type its property kind maps to');
  });

  it('an enum its type empties is reported (enum-emptied)', () => {
    assertReported(compiled().gen.untranslated, { reason: 'enum-emptied', kind: 'entity', type: 'every' }, 'enum [1] on a string property');
  });

  it('required without a default is a required member; required with a default, and every other property, optional', () => {
    clean('u-required', 'optionality does not follow required-without-default');
  });
});

describe('the two interfaces per type', () => {
  it('Properties is closed: exactly the declared keys, no index signature, an undeclared key refused', () => {
    clean('u-closed', 'the create contract is not closed');
  });

  it('StoredProperties has every declared member optional and unknown, plus [key: string]: unknown', () => {
    clean('u-stored', 'the stored shape is not open and unknown');
  });

  it('the per-kind value rule: entity values are primitives, the other kinds\' untyped and open values are unknown', () => {
    clean('u-perKind', 'a kind\'s untyped or open member has the wrong value type');
  });
});

describe('the SpaceTypes map', () => {
  it('has one key per knowledge type and maps each real type name to { properties, stored }', () => {
    clean('u-map', 'SpaceTypes does not map the declared types');
  });

  it('a kind with no declared type is an empty map', () => {
    clean('u-one-kind', 'an undeclared kind is not an empty map');
  });
});

describe('the header', () => {
  it('is a leading block comment saying a patch is Partial<...> and that warn and off accept more', () => {
    const { source } = compiled().gen;
    const header = headerOf(source);
    assert.ok(header.startsWith('/*'), `the source starts with a block comment header, got: ${source.slice(0, 200)}`);
    for (const word of ['Partial<', 'strict', 'warn', 'off', 'StoredProperties']) {
      assert.ok(header.includes(word), `the header names ${word}: ${header.slice(0, 600)}`);
    }
  });
});
