/**
 * `spaceMetaFromTypeScript` reads a source whole or refuses it, and every refusal is one reason of the closed list, each with its own
 * row here (Q-687, design v3 items 5 to 8, 10 and 11; D-70; the lenses: data-integrity S1, security S2 to S5, testing S6).
 *
 * ## The rule held
 *
 * A type the reverse direction cannot say exactly is never read as something near it. The answer is `{ ok: false, refusals, more }`, no
 * meta, the list capped at REFUSAL_NAMES_MAX with `more` counting the rest, every detail bounded plain text (peerText). The reasons:
 *
 * - before the compiler runs (the compiler is never asked for a program): `imports-not-read`, `directive-not-read`, `source-too-large`;
 * - from the map: `map-not-found`, `unknown-kind`, `internal-name`;
 * - from a member's type: `null-not-representable`, `never-not-representable`, `untyped-not-read`, and one `<shape>-not-representable`
 *   per shape the design refuses by name (date, object, array, union, method, generic, template literal, branded), and `enum-too-long`;
 * - from the compile: `source-does-not-compile` (with the diagnostic's CODE) and `compiler-failed` (a throw, bounded);
 * - from the server's own check: `server-refuses`.
 *
 * Each row is a one-token change of a source that IS read (a control row), so a refusal is the reason it names and not a side effect. The
 * last case holds UNREPRESENTED_REASONS to the rows: a reason added to the list without a row, or a row naming a reason that is not
 * in the list, fails it.
 *
 * Before the entry exists every row is red for the one reason the first row names.
 *
 * Run: node --test testing/standalone/every-typescript-the-reverse-direction-cannot-read-is-refused-by-name.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  entry, read, sourceOf, CONTROL_SOURCE, assertRead, refusedWith, assertRefusedShape, countingCompiler, propertyOf,
  MEMBER_REFUSALS, REFUSAL_NAMES_MAX, ENUM_LITERAL_MAX, DETAIL_MAX, REAL_TS,
} from './_from-typescript.mjs';

/** The reasons the rows below exercise: held against UNREPRESENTED_REASONS by the last case. */
const exercised = new Set();

/**
 * One refusal row: `source` is refused with `reason`. `precompile` rows also hold that the compiler was never asked for a program
 * (the refusal is the text's, read before compiling).
 */
function refuses(title, reason, source, { precompile = false, options, check } = {}) {
  it(title, async () => {
    const spy = countingCompiler();
    const found = await refusedWith(source, reason, precompile ? { typescript: spy.compiler, ...options } : options);
    exercised.add(reason);
    if (precompile) assert.equal(spy.state.programs, 0, `${reason} is the text's: the compiler was asked for a program`);
    if (check) check(found);
  });
}

const stringUnion = (n, prefix = 'v') => Array.from({ length: n }, (_, i) => JSON.stringify(`${prefix}${i}`)).join(' | ');
const numberUnion = (n) => Array.from({ length: n }, (_, i) => String(i)).join(' | ');

describe('the control source is read', () => {
  it('the entry is built, and a one-member entity type is read', async () => {
    await entry();
    const answer = assertRead(await read(CONTROL_SOURCE), 'the control source');
    assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'name'), { type: 'string', required: true });
  });
});

describe('what is the text\'s to refuse is refused before the compiler runs', () => {
  const importLike = {
    'an import type': "import type { Thing } from './thing';\n",
    'a side-effect import': "import './thing';\n",
    'an export * from': "export * from './thing';\n",
    'an export { } from': "export { thing } from './thing';\n",
    'a /// <reference path>': '/// <reference path="./thing.d.ts" />\n',
    'a /// <reference lib>': '/// <reference lib="dom" />\n',
    'a /// <reference types>': '/// <reference types="node" />\n',
  };
  for (const [what, before] of Object.entries(importLike)) {
    refuses(`${what} is refused imports-not-read`, 'imports-not-read', sourceOf('name: string;', { before }), { precompile: true });
  }

  const directives = {
    'a // @ts-nocheck at the top': { before: '// @ts-nocheck\n', members: 'name: string;' },
    'a // @ts-ignore before a member': { before: '', members: '// @ts-ignore\n name: string;' },
    'a // @ts-expect-error before a member': { before: '', members: '// @ts-expect-error\n name: string;' },
    'a /* @ts-ignore */ comment': { before: '', members: '/* @ts-ignore */ name: string;' },
  };
  for (const [what, { before, members }] of Object.entries(directives)) {
    refuses(`${what} is refused directive-not-read (a source cannot switch off the diagnostics that judge it)`, 'directive-not-read', sourceOf(members, { before }), { precompile: true });
  }

  it('a source over SOURCE_MAX is refused source-too-large without a program, and one of exactly SOURCE_MAX is read', async () => {
    const { SOURCE_MAX } = await entry();
    const room = SOURCE_MAX - CONTROL_SOURCE.length - 2;
    assert.ok(room > 0, 'SOURCE_MAX holds at least the control source');
    const at = `${CONTROL_SOURCE}//${'x'.repeat(room)}`;
    assert.equal(at.length, SOURCE_MAX);
    assertRead(await read(at), 'a source of exactly SOURCE_MAX characters');
    const spy = countingCompiler();
    const found = await refusedWith(`${at}x`, 'source-too-large', { typescript: spy.compiler });
    exercised.add('source-too-large');
    assert.equal(found.length, 1);
    assert.equal(spy.state.programs, 0, 'the size is judged before the compiler is asked for anything');
  });
});

describe('the map is found, and its names are the map\'s to refuse', () => {
  refuses('a source with no SpaceTypes is refused map-not-found', 'map-not-found', sourceOf('name: string;', { map: 'Elsewhere' }));
  refuses('a named map that is not declared is refused map-not-found', 'map-not-found', CONTROL_SOURCE, { options: { map: 'Nope' } });

  it('options.map names another interface, and a type alias is read as an interface is', async () => {
    assertRead(await read(sourceOf('name: string;', { map: 'MyTypes' }), { map: 'MyTypes' }), 'options.map');
    const alias = 'export type SpaceTypes = { "entity": { "thing": { properties: { name: string } } } };\n';
    assertRead(await read(alias), 'a type alias');
  });

  refuses('a kind that is not one of the four is refused unknown-kind', 'unknown-kind', sourceOf('name: string;', { kind: 'banana' }), {
    check: found => assert.ok(found[0].path.includes('banana'), `the path names the kind: ${JSON.stringify(found[0].path)}`),
  });

  for (const name of ['__proto__', 'constructor', 'prototype']) {
    refuses(`${name} as a type name is refused internal-name, before any assignment`, 'internal-name', sourceOf('name: string;', { type: name }), {
      check: found => assert.ok(found[0].path.includes(name), `the path names it: ${JSON.stringify(found[0].path)}`),
    });
    refuses(`${name} as a member name is refused internal-name, before any assignment`, 'internal-name', sourceOf(`${JSON.stringify(name)}: string;`), {
      check: found => assert.ok(found[0].path.includes(name), `the path names it: ${JSON.stringify(found[0].path)}`),
    });
  }

  it('a name every object answers to but that is no internal key (toString) is a member like another, an own property of the result', async () => {
    const answer = assertRead(await read(sourceOf('toString: string; valueOf?: number;', { type: 'hasOwnProperty' })), 'names of Object.prototype');
    const properties = answer.meta.typeSchemas.entity.hasOwnProperty.propertySchemas;
    assert.deepEqual(Object.keys(properties), ['toString', 'valueOf']);
    assert.equal(Object.getPrototypeOf(answer.meta.typeSchemas.entity), Object.prototype, 'the result was not built through a name that replaces a prototype');
  });
});

describe('a member\'s type the reverse direction cannot say exactly is refused by name', () => {
  const members = {
    'null-not-representable': ['a union with null', 'name: string | null;'],
    'never-not-representable': ['never', 'name: never;'],
    'untyped-not-read': ['any', 'name: any;'],
    [MEMBER_REFUSALS.date]: ['a Date', 'name: Date;'],
    [MEMBER_REFUSALS.object]: ['an object type', 'name: { inner: string };'],
    [MEMBER_REFUSALS.array]: ['an array', 'name: string[];'],
    [MEMBER_REFUSALS.union]: ['a union that is not literals of one base', 'name: string | number;'],
    [MEMBER_REFUSALS.method]: ['a method', 'name(): string;'],
    [MEMBER_REFUSALS.generic]: ['a generic reference', 'name: Promise<string>;'],
    [MEMBER_REFUSALS.template]: ['a template literal type', 'name: `x-${string}`;'],
    [MEMBER_REFUSALS.branded]: ['a branded type', "name: string & { readonly __brand: 'id' };"],
  };
  for (const [reason, [what, text]] of Object.entries(members)) {
    refuses(`${what} is refused ${reason}`, reason, sourceOf(text), {
      check: found => assert.ok(found[0].path.includes('name'), `the path names the member: ${JSON.stringify(found[0].path)}`),
    });
  }

  refuses('null alone is refused null-not-representable', 'null-not-representable', sourceOf('name: null;'));
  refuses('an optional null is refused null-not-representable', 'null-not-representable', sourceOf('name?: null;'));
  refuses('unknown on an entity is refused untyped-not-read (an entity member is a primitive)', 'untyped-not-read', sourceOf('name: unknown;', { kind: 'entity' }));

  it('a union of string literals of exactly ENUM_LITERAL_MAX is an enum; one more is refused enum-too-long (string and number)', async () => {
    const atMax = assertRead(await read(sourceOf(`name: ${stringUnion(ENUM_LITERAL_MAX)};`)), 'an enum at the bound');
    assert.equal(propertyOf(atMax, 'entity', 'thing', 'name').enum.length, ENUM_LITERAL_MAX);
    const numbersAtMax = assertRead(await read(sourceOf(`name: ${numberUnion(ENUM_LITERAL_MAX)};`)), 'a number enum at the bound');
    assert.equal(propertyOf(numbersAtMax, 'entity', 'thing', 'name').enum.length, ENUM_LITERAL_MAX);
    await refusedWith(sourceOf(`name: ${stringUnion(ENUM_LITERAL_MAX + 1)};`), 'enum-too-long');
    await refusedWith(sourceOf(`name: ${numberUnion(ENUM_LITERAL_MAX + 1)};`), 'enum-too-long');
    exercised.add('enum-too-long');
  });
});

describe('what the compile and the server say is the answer\'s too', () => {
  refuses('a name that does not exist is refused source-does-not-compile with the diagnostic\'s code (TS2304)', 'source-does-not-compile', sourceOf('name: Zzzqq;'), {
    check: found => assert.equal(found[0].code, 2304, `the code is the compiler's: ${JSON.stringify(found[0])}`),
  });
  refuses('a syntax error is refused source-does-not-compile with a syntactic code (TS1xxx)', 'source-does-not-compile', sourceOf('name: ;'), {
    check: found => assert.ok(found[0].code >= 1000 && found[0].code < 2000, `a syntactic code, got ${found[0].code}`),
  });
  refuses('an unclosed interface is refused source-does-not-compile', 'source-does-not-compile', 'export interface SpaceTypes { "entity": {', {
    check: found => assert.ok(found[0].code >= 1000 && found[0].code < 2000, `a syntactic code, got ${found[0].code}`),
  });
  refuses('an error elsewhere in the source is the source\'s: the whole file is judged', 'source-does-not-compile', sourceOf('name: string;', { after: "export const count: number = 'many';\n" }));
  refuses('an error in what is ignored (stored) is still an error', 'source-does-not-compile', sourceOf('name: string;', { stored: 'other: Zzzqq' }));

  it('a compiler that throws is refused compiler-failed, its message bounded and free of control characters', async () => {
    const message = `boom${String.fromCharCode(7)}\nsecond line ${'x'.repeat(10_000)}`;
    const throwing = { ...REAL_TS, createProgram: () => { throw new Error(message); } };
    const found = await refusedWith(CONTROL_SOURCE, 'compiler-failed', { typescript: throwing });
    exercised.add('compiler-failed');
    assert.match(found[0].detail, /boom/, 'the throw\'s message is the detail');
    assert.ok(found[0].detail.length <= DETAIL_MAX, `bounded: ${found[0].detail.length}`);
  });

  it('a pathological source (parentheses nested far deeper than the parser can follow) is refused compiler-failed, never a rejection or a hang', async () => {
    const { SOURCE_MAX } = await entry();
    const depth = 30_000;
    const source = sourceOf(`name: ${'('.repeat(depth)}string${')'.repeat(depth)};`);
    assert.ok(source.length <= SOURCE_MAX, `precondition: the pathological source (${source.length} characters) is within SOURCE_MAX (${SOURCE_MAX}), so the compiler is what meets it`);
    await refusedWith(source, 'compiler-failed');
    exercised.add('compiler-failed');
  });

  refuses('a member name the server refuses (over 200 characters) is refused server-refuses, with the server\'s words', 'server-refuses', sourceOf(`${JSON.stringify('k'.repeat(201))}: string;`), {
    check: found => assert.ok(found[0].detail.length > 0, 'the detail says what the server refused'),
  });
  refuses('a type name the server refuses (over 200 characters) is refused server-refuses', 'server-refuses', sourceOf('name: string;', { type: 't'.repeat(201) }));
});

describe('the refusal list is whole or nothing, capped and quoted safely', () => {
  it('one bad member refuses the whole source: the good types are not read', async () => {
    const source = `export interface SpaceTypes {\n  "entity": {\n    "good": { properties: { name: string } };\n    "bad": { properties: { when: Date } };\n  };\n}\n`;
    const answer = await read(source);
    await assertRefusedShape(answer, 'one good type, one bad member');
    assert.deepEqual(answer.refusals.map(r => r.reason), [MEMBER_REFUSALS.date]);
    exercised.add(MEMBER_REFUSALS.date);
  });

  it(`${REFUSAL_NAMES_MAX + 15} refusals list ${REFUSAL_NAMES_MAX} and count the other 15 in more; fewer than the cap list all with more 0`, async () => {
    const many = Array.from({ length: REFUSAL_NAMES_MAX + 15 }, (_, i) => `d${i}: Date;`).join(' ');
    const answer = await read(sourceOf(many));
    await assertRefusedShape(answer, 'many dates');
    assert.equal(answer.refusals.length, REFUSAL_NAMES_MAX);
    assert.equal(answer.more, 15);
    assert.ok(answer.refusals.every(r => r.reason === MEMBER_REFUSALS.date));
    const few = await read(sourceOf('d0: Date; d1: Date; d2: Date;'));
    await assertRefusedShape(few, 'three dates');
    assert.equal(few.refusals.length, 3);
    assert.equal(few.more, 0);
  });

  it('a hostile name (a line separator, a bell, 5000 characters) is quoted bounded and escaped in the detail', async () => {
    const separator = String.fromCharCode(0x2028);
    const name = `x${separator}y${String.fromCharCode(7)}z\nw${'q'.repeat(5000)}`;
    // JSON leaves a line separator raw, and a raw one would end a string literal for the scanner: spell it as an escape.
    const escaped = JSON.stringify(name).split(separator).join('\\u2028');
    const answer = await read(sourceOf(`${escaped}: Date;`));
    await assertRefusedShape(answer, 'a hostile member name');
    assert.equal(answer.refusals[0].reason, MEMBER_REFUSALS.date);
  });
});

describe('UNREPRESENTED_REASONS is the list of the reasons these rows name', () => {
  it('every reason in the closed list has a row above, and every row names a reason of the list', async () => {
    const { UNREPRESENTED_REASONS } = await entry();
    assert.deepEqual([...exercised].sort(), [...UNREPRESENTED_REASONS].sort(), 'the rows and the closed list name the same reasons');
    assert.equal(new Set(UNREPRESENTED_REASONS).size, UNREPRESENTED_REASONS.length, 'no reason twice');
  });
});
